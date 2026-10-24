package router

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// ipAllowlistMiddleware gates the admin surface by the TCP peer address (or
// Gin's derived client address; trusted proxies are disabled in New). Health
// probes are exempt so container / cluster probes keep working. An empty list
// leaves network policy to loopback binding, firewall, VPN, or the cluster.
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
		ip := net.ParseIP(c.ClientIP())
		for _, network := range networks {
			if ip != nil && network.Contains(ip) {
				c.Next()
				return
			}
		}
		detail(c, http.StatusForbidden, "client IP not allowed")
		c.Abort()
	}
}

func parseIPAllowlist(entries []string) ([]*net.IPNet, error) {
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

// corsMiddleware is also the browser CSRF origin gate. Cross-origin requests
// require an exact configured origin; same-origin requests are allowed. Unsafe
// methods require an Origin header, so cross-site form/fetch writes cannot rely
// only on the SameSite cookie attribute.
func corsMiddleware(allowOrigins []string) gin.HandlerFunc {
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
		sameOrigin := normalized == requestOrigin(c)
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

func requestOrigin(c *gin.Context) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	normalized, ok := normalizeOrigin(scheme + "://" + c.Request.Host)
	if !ok {
		return ""
	}
	return normalized
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
	case "GET", "POST":
	default:
		return false
	}
	for _, header := range strings.Split(c.GetHeader("Access-Control-Request-Headers"), ",") {
		switch strings.ToLower(strings.TrimSpace(header)) {
		case "", "authorization", "content-type", "x-request-id":
		default:
			return false
		}
	}
	return true
}

func setCORSHeaders(c *gin.Context, origin string) {
	c.Header("Access-Control-Allow-Origin", origin)
	c.Header("Access-Control-Allow-Credentials", "true")
	c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
	c.Header("Access-Control-Max-Age", "600")
	c.Header("Vary", "Origin")
}
