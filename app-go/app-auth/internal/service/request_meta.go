package service

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// DeviceMeta — structured device metadata for the user_device table.
// Parsing is a light heuristic over the User-Agent (the Python side used
// ua_parser; the fields are best-effort display metadata only).
type DeviceMeta struct {
	DeviceType     *string
	DeviceName     *string
	OS             *string
	OSVersion      *string
	Browser        *string
	BrowserVersion *string
}

// DeriveDeviceID builds the stable anonymous fingerprint from headers —
// identical formula to the Python get_device_id (sha256(ua|lang)[:16]).
func DeriveDeviceID(userAgent, acceptLanguage string) string {
	raw := userAgent + "|" + acceptLanguage
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])[:16]
}

// ClientIP extracts the real client IP respecting reverse-proxy headers.
func ClientIP(xForwardedFor, xRealIP, remoteAddr string) string {
	if xff := strings.TrimSpace(xForwardedFor); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if rip := strings.TrimSpace(xRealIP); rip != "" {
		return rip
	}
	if i := strings.LastIndex(remoteAddr, ":"); i > 0 {
		return remoteAddr[:i]
	}
	return remoteAddr
}

var genericDeviceFamilies = map[string]bool{"other": true, "spider": true, "desktop": true, "": true}

// ExtractDeviceMeta parses a User-Agent into structured device metadata.
type uaParsed struct {
	osFamily, osMajor, osMinor string
	uaFamily, uaMajor, uaMinor string
	deviceFamily               string
}

// ExtractDeviceMeta parses the User-Agent into device metadata (light
// heuristic parser; best-effort metadata only).
func ExtractDeviceMeta(ua string) DeviceMeta {
	empty := DeviceMeta{}
	if strings.TrimSpace(ua) == "" {
		return empty
	}
	p := parseUA(ua)

	osVersion := p.osMajor
	if p.osMajor != "" && p.osMinor != "" {
		osVersion = p.osMajor + "." + p.osMinor
	}
	browserVersion := p.uaMajor
	if p.uaMajor != "" && p.uaMinor != "" {
		browserVersion = p.uaMajor + "." + p.uaMinor
	}

	lower := strings.ToLower(ua)
	var deviceType string
	switch {
	case strings.Contains(lower, "iphone") || strings.Contains(lower, "android") && strings.Contains(lower, "mobile"):
		deviceType = "mobile"
	case strings.Contains(lower, "ipad"):
		deviceType = "tablet"
	case strings.Contains(lower, "android"):
		deviceType = "mobile"
	default:
		deviceType = "desktop"
	}

	var deviceName *string
	if p.deviceFamily != "" && !genericDeviceFamilies[strings.ToLower(p.deviceFamily)] {
		deviceName = &p.deviceFamily
	}

	os, osv := strPtr(p.osFamily), strPtr(osVersion)
	br, brv := strPtr(p.uaFamily), strPtr(browserVersion)
	dt := &deviceType
	return DeviceMeta{
		DeviceType: dt, DeviceName: deviceName,
		OS: os, OSVersion: osv, Browser: br, BrowserVersion: brv,
	}
}

func strPtr(s string) *string { return &s }

// parseUA — small heuristic UA parser (no external dependency): detects the
// common OS and browser families and their major versions.
func parseUA(ua string) uaParsed {
	p := uaParsed{}
	osRules := []struct{ token, family string }{
		// most-specific first: iOS tokens must win over the "Mac OS X" that
		// iOS UAs also contain
		{"iphone", "iOS"}, {"ipad", "iOS"},
		{"windows nt 10", "Windows"}, {"windows nt 6.3", "Windows"},
		{"windows nt 6.2", "Windows"}, {"windows nt 6.1", "Windows"},
		{"mac os x", "Mac OS X"},
		{"android", "Android"}, {"linux", "Linux"},
	}
	lower := strings.ToLower(ua)
	for _, r := range osRules {
		if idx := strings.Index(lower, r.token); idx >= 0 {
			p.osFamily = r.family
			p.osMajor, p.osMinor = versionAfter(ua, idx+len(r.token))
			break
		}
	}
	// order matters: Edge/OPR/Chrome/Safari/Firefox
	brRules := []struct{ token, family string }{
		{"edg/", "Edge"}, {"edge/", "Edge"}, {"opr/", "Opera"}, {"opera ", "Opera"},
		{"firefox/", "Firefox"}, {"chrome/", "Chrome"}, {"safari/", "Safari"},
	}
	for _, r := range brRules {
		if idx := strings.Index(lower, r.token); idx >= 0 {
			p.uaFamily = r.family
			major, minor := versionAfter(ua, idx+len(r.token))
			p.uaMajor, p.uaMinor = major, minor
			break
		}
	}
	if p.uaFamily == "Safari" {
		// Safari version lives in "Version/x.y"
		if idx := strings.Index(lower, "version/"); idx >= 0 {
			p.uaMajor, p.uaMinor = versionAfter(ua, idx+len("version/"))
		}
	}
	p.deviceFamily = deviceFamily(ua)
	return p
}

// versionAfter extracts "major.minor" digits starting at pos.
func versionAfter(s string, pos int) (string, string) {
	if pos < 0 || pos >= len(s) {
		return "", ""
	}
	rest := s[pos:]
	start := -1
	for i := 0; i < len(rest); i++ {
		if rest[i] >= '0' && rest[i] <= '9' {
			start = i
			break
		}
	}
	if start < 0 {
		return "", ""
	}
	rest = rest[start:]
	major := rest
	if i := strings.IndexFunc(rest, func(r rune) bool { return r < '0' || r > '9' }); i >= 0 {
		major = rest[:i]
		rest = rest[i:]
	} else {
		return major, ""
	}
	minor := ""
	if strings.HasPrefix(rest, ".") {
		rest = rest[1:]
		minor = rest
		if i := strings.IndexFunc(rest, func(r rune) bool { return r < '0' || r > '9' }); i >= 0 {
			minor = rest[:i]
		}
	}
	return major, minor
}

// deviceFamily derives iPhone/iPad/Android/Windows-PC style family names.
func deviceFamily(ua string) string {
	lower := strings.ToLower(ua)
	switch {
	case strings.Contains(lower, "iphone"):
		return "iPhone"
	case strings.Contains(lower, "ipad"):
		return "iPad"
	case strings.Contains(lower, "android"):
		return "Android Device"
	case strings.Contains(lower, "windows"):
		return "Windows PC"
	case strings.Contains(lower, "mac os"):
		return "Mac"
	default:
		return ""
	}
}
