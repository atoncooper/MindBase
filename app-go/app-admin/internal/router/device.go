// Device fingerprint helpers. The browser sends a random per-profile
// identifier in X-Device-Id; the server never stores or logs it verbatim, only
// a SHA-256 fingerprint that binds a login session to the device that created
// it.
package router

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// deviceIDHeader carries the client-generated device identifier.
const deviceIDHeader = "X-Device-Id"

// devicePrefixLen bounds how much of the fingerprint lands in audit details.
const devicePrefixLen = 12

// errDeviceID is returned when the header is missing or malformed. The HTTP
// boundary maps it to 400 with exactly this message.
var errDeviceID = errors.New("X-Device-Id header required (16-128 chars A-Za-z0-9_-)")

var deviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// deviceFingerprint derives the server-side fingerprint for this request.
//
//	off    — no header required, empty fingerprint (binding disabled)
//	id     — sha256("v1|" + device id)
//	strict — sha256("v1|" + device id + "|" + User-Agent + "|" + first
//	         Accept-Language tag), so replaying a stolen id alone is not enough
//
// Both enabled modes reject a missing / malformed header with errDeviceID.
func deviceFingerprint(c *gin.Context, mode string) (string, error) {
	if mode == "" || mode == "off" {
		return "", nil
	}
	deviceID := strings.TrimSpace(c.GetHeader(deviceIDHeader))
	if !deviceIDPattern.MatchString(deviceID) {
		return "", errDeviceID
	}
	material := "v1|" + deviceID
	if mode == "strict" {
		material += "|" + c.Request.UserAgent() + "|" + firstLanguageTag(c.GetHeader("Accept-Language"))
	}
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:]), nil
}

// devicePrefix returns the displayable prefix of a fingerprint for audit
// details and comparisons; the full hash never leaves the session row.
func devicePrefix(fingerprint string) string {
	if len(fingerprint) > devicePrefixLen {
		return fingerprint[:devicePrefixLen]
	}
	return fingerprint
}

// firstLanguageTag isolates the primary tag of an Accept-Language header:
// "zh-CN,zh;q=0.9,en;q=0.8" -> "zh-CN". Quality factors and the fallback list
// are noise for a fingerprint and are dropped.
func firstLanguageTag(header string) string {
	for _, part := range strings.Split(header, ",") {
		tag := strings.TrimSpace(part)
		if i := strings.IndexByte(tag, ';'); i >= 0 {
			tag = strings.TrimSpace(tag[:i])
		}
		if tag != "" {
			return tag
		}
	}
	return ""
}
