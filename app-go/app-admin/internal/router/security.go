package router

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// ipAllowlistMiddleware gates the admin surface by the TCP peer address.
// Forwarded headers are deliberately ignored here: a spoofed X-Forwarded-For
// must never widen the network allowlist. Health probes are exempt so container
// / cluster probes keep working. An empty list leaves network policy to
// loopback binding, firewall, VPN, or the cluster.
func ipAllowlistMiddleware(entries []string) gin.HandlerFunc {
	networks, parseErr := parseIPAllowlist(entries)
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/health" || len(entries) == 0 {
			c.Next()
			return
		}
		if parseErr != nil {
			detail(c, http.StatusServiceUnavailable, "security policy unavailable")
			c.Abort()
			return
		}
		ip := net.ParseIP(peerIP(c))
		if ip == nil || !ipInNetworks(ip, networks) {
			detail(c, http.StatusForbidden, "client IP not allowed")
			c.Abort()
			return
		}
		c.Next()
	}
}

// parseIPAllowlist turns the allowlist into networks (a bare IP becomes a /32
// or /128).
func parseIPAllowlist(entries []string) ([]*net.IPNet, error) {
	return parseIPNetworks(entries)
}

// parseTrustedProxies turns the configured reverse-proxy list into networks.
// An empty list means no proxy is trusted, so every forwarded header is
// ignored and the TCP peer address is the client address.
func parseTrustedProxies(entries []string) ([]*net.IPNet, error) {
	return parseIPNetworks(entries)
}

func parseIPNetworks(entries []string) ([]*net.IPNet, error) {
	networks := make([]*net.IPNet, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if ip := net.ParseIP(entry); ip != nil {
			if v4 := ip.To4(); v4 != nil {
				networks = append(networks, &net.IPNet{IP: v4, Mask: net.CIDRMask(32, 32)})
			} else {
				networks = append(networks, &net.IPNet{IP: ip, Mask: net.CIDRMask(128, 128)})
			}
			continue
		}
		_, network, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, err
		}
		networks = append(networks, network)
	}
	return networks, nil
}

// peerIP is the TCP peer address with forwarded headers deliberately ignored.
// A RemoteAddr without a port is returned unchanged so direct test requests and
// unusual transports still work.
func peerIP(c *gin.Context) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		return c.Request.RemoteAddr
	}
	return host
}

func ipInNetworks(ip net.IP, networks []*net.IPNet) bool {
	for _, network := range networks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// trustedPeer reports whether the request came from one of the configured
// reverse proxies.
func trustedPeer(c *gin.Context, trusted []*net.IPNet) bool {
	if len(trusted) == 0 {
		return false
	}
	ip := net.ParseIP(peerIP(c))
	return ip != nil && ipInNetworks(ip, trusted)
}

// clientIP resolves the real client address. Forwarded headers are only read
// when the TCP peer is a trusted proxy; the right-most non-trusted
// X-Forwarded-For entry is the address that entered the proxy chain, so
// anything a client prepends itself is skipped. Without a usable XFF the
// X-Real-IP header is tried, and the peer address is the final fallback.
func clientIP(c *gin.Context, trusted []*net.IPNet) string {
	peer := peerIP(c)
	if !trustedPeer(c, trusted) {
		return peer
	}
	if forwarded := c.GetHeader("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := net.ParseIP(strings.TrimSpace(parts[i]))
			if candidate == nil {
				continue
			}
			if ipInNetworks(candidate, trusted) {
				continue
			}
			return candidate.String()
		}
	}
	if realIP := net.ParseIP(strings.TrimSpace(c.GetHeader("X-Real-IP"))); realIP != nil {
		return realIP.String()
	}
	return peer
}

// forwardedProto returns the first X-Forwarded-Proto value when it is http or
// https.
func forwardedProto(c *gin.Context) string {
	value := c.GetHeader("X-Forwarded-Proto")
	if i := strings.IndexByte(value, ','); i >= 0 {
		value = value[:i]
	}
	switch proto := strings.ToLower(strings.TrimSpace(value)); proto {
	case "http", "https":
		return proto
	}
	return ""
}

// requestOrigin reconstructs the origin the browser actually used. Behind a
// trusted proxy the forwarded scheme + host win; otherwise the transport and
// Host header are authoritative. Returns "" when the result is not a valid
// origin.
func requestOrigin(c *gin.Context, trusted []*net.IPNet) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	host := c.Request.Host
	if trustedPeer(c, trusted) {
		if proto := forwardedProto(c); proto != "" {
			scheme = proto
		}
		if forwardedHost := c.GetHeader("X-Forwarded-Host"); forwardedHost != "" {
			if i := strings.IndexByte(forwardedHost, ','); i >= 0 {
				forwardedHost = forwardedHost[:i]
			}
			if forwardedHost = strings.TrimSpace(forwardedHost); forwardedHost != "" {
				host = forwardedHost
			}
		}
	}
	normalized, ok := normalizeOrigin(scheme + "://" + host)
	if !ok {
		return ""
	}
	return normalized
}

// secureCookie reports whether the session cookie may carry the Secure flag:
// either this process terminated TLS, or a trusted proxy says the browser used
// HTTPS. A forwarded header from an untrusted peer proves nothing.
func secureCookie(c *gin.Context, trusted []*net.IPNet) bool {
	if c.Request.TLS != nil {
		return true
	}
	return trustedPeer(c, trusted) && forwardedProto(c) == "https"
}

// corsMiddleware is also the browser CSRF origin gate. Cross-origin requests
// require an exact configured origin; same-origin requests are allowed. Unsafe
// methods require an Origin header, so cross-site form/fetch writes cannot rely
// only on the SameSite cookie attribute. Behind a trusted proxy the origin is
// compared against the forwarded scheme/host, matching what the browser sees.
func corsMiddleware(allowOrigins []string, trusted []*net.IPNet) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowOrigins))
	for _, origin := range allowOrigins {
		if normalized, ok := normalizeOrigin(origin); ok {
			allowed[normalized] = true
		}
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		method := c.Request.Method
		if origin == "" {
			if method == "OPTIONS" || isUnsafeMethod(method) {
				detail(c, http.StatusForbidden, "origin required")
				c.Abort()
				return
			}
			c.Next()
			return
		}

		normalized, valid := normalizeOrigin(origin)
		if !valid {
			detail(c, http.StatusForbidden, "origin not allowed")
			c.Abort()
			return
		}
		sameOrigin := normalized == requestOrigin(c, trusted)
		if !sameOrigin && !allowed[normalized] {
			detail(c, http.StatusForbidden, "origin not allowed")
			c.Abort()
			return
		}

		if !sameOrigin {
			setCORSHeaders(c, normalized)
		}
		if method == "OPTIONS" {
			if !validPreflight(c) {
				detail(c, http.StatusForbidden, "preflight request not allowed")
				c.Abort()
				return
			}
			if sameOrigin {
				setCORSHeaders(c, normalized)
			}
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func normalizeOrigin(value string) (string, bool) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		u.User != nil || u.Opaque != "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host), true
}

func isUnsafeMethod(method string) bool {
	switch method {
	case "POST", "PUT", "PATCH", "DELETE":
		return true
	default:
		return false
	}
}

func validPreflight(c *gin.Context) bool {
	requestedMethod := strings.ToUpper(strings.TrimSpace(c.GetHeader("Access-Control-Request-Method")))
	switch requestedMethod {
	case "GET", "POST", "DELETE": // DELETE: /api/console/users/:id
	default:
		return false
	}
	for _, header := range strings.Split(c.GetHeader("Access-Control-Request-Headers"), ",") {
		switch strings.ToLower(strings.TrimSpace(header)) {
		case "", "authorization", "content-type", "x-request-id", "x-device-id":
		default:
			return false
		}
	}
	return true
}

func setCORSHeaders(c *gin.Context, origin string) {
	c.Header("Access-Control-Allow-Origin", origin)
	c.Header("Access-Control-Allow-Credentials", "true")
	c.Header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id, X-Device-Id")
	c.Header("Access-Control-Max-Age", "600")
	c.Header("Vary", "Origin")
}
