package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"app-note/internal/model"
	"app-note/internal/repo"

	"github.com/google/uuid"
)

// newUUID returns a random (v4) UUID string — parity with Python uuid4.
func newUUID() string { return uuid.NewString() }

// newShareToken returns a 43-char URL-safe token — parity with Python
// secrets.token_urlsafe(32) (32 random bytes, base64url, no padding).
func newShareToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ContentHash — sha256 hex digest of the markdown body (dirty-check key).
func ContentHash(contentMD string) string {
	sum := sha256.Sum256([]byte(contentMD))
	return fmt.Sprintf("%x", sum)
}

// runeLen counts unicode code points — Python's len(str) semantics
// (content_length is a character count, not a byte count).
func runeLen(s string) int { return utf8.RuneCountInString(s) }

// DiffRatio is the cheap character-level diff ratio (Levenshtein-free port
// of NoteService._diff_ratio): length delta + same-position sample,
// normalized by the longer string. Operates on runes for parity.
func DiffRatio(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	maxLen := len(ra)
	if len(rb) > maxLen {
		maxLen = len(rb)
	}
	if maxLen == 0 {
		return 0.0
	}
	lenDiff := len(ra) - len(rb)
	if lenDiff < 0 {
		lenDiff = -lenDiff
	}
	if float64(lenDiff)/float64(maxLen) >= RevisionDiffRatio {
		return float64(lenDiff) / float64(maxLen)
	}
	minLen := len(ra)
	if len(rb) < minLen {
		minLen = len(rb)
	}
	diffs := lenDiff
	for i := 0; i < minLen; i++ {
		if ra[i] != rb[i] {
			diffs++
		}
	}
	return float64(diffs) / float64(maxLen)
}

// defaultTitle mirrors the Python backend: empty title → "无标题".
func defaultTitle(title string) string {
	if title == "" {
		return "无标题"
	}
	return title
}

// NaiveUTC renders a time the way the Python backend (FastAPI/pydantic)
// serialized its naive-UTC datetimes: ISO-8601 without a zone suffix,
// microseconds only when non-zero ("2026-10-04T12:34:56" /
// "2026-10-04T12:34:56.789012"). The frontend echoes updated_at back as the
// If-Match header, so the format must round-trip byte-compatibly.
type NaiveUTC struct{ time.Time }

// MarshalJSON implements the wire format (naive UTC).
func (t NaiveUTC) MarshalJSON() ([]byte, error) {
	return json.Marshal(FormatNaiveUTC(t.Time))
}

// FormatNaiveUTC renders the Python-compatible naive-UTC ISO string.
func FormatNaiveUTC(t time.Time) string {
	u := t.UTC()
	if u.Nanosecond() == 0 {
		return u.Format("2006-01-02T15:04:05")
	}
	return u.Format("2006-01-02T15:04:05.") + fmt.Sprintf("%06d", u.Nanosecond()/1000)
}

// ── Response DTOs (wire shapes, snake_case parity) ───────────────────

// MetaView mirrors NoteMetaResponse — list item, no content.
type MetaView struct {
	UUID          string   `json:"uuid"`
	Title         string   `json:"title"`
	TargetType    string   `json:"target_type"`
	TargetID      string   `json:"target_id"`
	ContentLength int      `json:"content_length"`
	IsPinned      bool     `json:"is_pinned"`
	RevisionCount int      `json:"revision_count"`
	CreatedAt     NaiveUTC `json:"created_at"`
	UpdatedAt     NaiveUTC `json:"updated_at"`
}

// NoteDetail mirrors NoteDetailResponse (meta + content + anchors + share).
type NoteDetail struct {
	MetaView
	ContentMD      string       `json:"content_md"`
	Anchors        []AnchorView `json:"anchors"`
	ShareToken     *string      `json:"share_token"`
	ShareExpiresAt *NaiveUTC    `json:"share_expires_at"`
}

// AnchorView mirrors NoteAnchorResponse.
type AnchorView struct {
	ID        int      `json:"id"`
	BlockID   string   `json:"block_id"`
	Position  int      `json:"position"`
	Label     *string  `json:"label"`
	CreatedAt NaiveUTC `json:"created_at"`
}

// ShareView mirrors NoteShareResponse.
type ShareView struct {
	ShareToken string    `json:"share_token"`
	ShareURL   string    `json:"share_url"`
	ExpiresAt  *NaiveUTC `json:"expires_at"`
}

// RevisionView mirrors the list shape the frontend consumes
// (revision_id / revision_note / created_at — content_md deliberately
// excluded, matching the Python list projection).
type RevisionView struct {
	RevisionID   string   `json:"revision_id"`
	RevisionNote *string  `json:"revision_note"`
	CreatedAt    NaiveUTC `json:"created_at"`
}

// SharedView mirrors NoteSharedView (public, no auth).
type SharedView struct {
	Title      string   `json:"title"`
	ContentMD  string   `json:"content_md"`
	TargetType string   `json:"target_type"`
	TargetID   string   `json:"target_id"`
	SharedAt   NaiveUTC `json:"shared_at"`
	ViewCount  int      `json:"view_count"`
}

// metaView converts a model row to its wire shape.
func metaView(n model.Note) MetaView {
	return MetaView{
		UUID:          n.UUID,
		Title:         n.Title,
		TargetType:    n.TargetType,
		TargetID:      n.TargetID,
		ContentLength: n.ContentLength,
		IsPinned:      n.IsPinned,
		RevisionCount: n.RevisionCount,
		CreatedAt:     NaiveUTC{n.CreatedAt},
		UpdatedAt:     NaiveUTC{n.UpdatedAt},
	}
}

func anchorView(a model.NoteAnchor) AnchorView {
	return AnchorView{
		ID:        a.ID,
		BlockID:   a.BlockID,
		Position:  a.Position,
		Label:     a.Label,
		CreatedAt: NaiveUTC{a.CreatedAt},
	}
}

// ParseUTC parses the datetime shapes the Python backend produced/accepted
// (ISO-8601, tolerant of a trailing 'Z' and of no-fraction strings) into a
// UTC time.
func ParseUTC(s string) (time.Time, error) {
	normalized := strings.Replace(strings.TrimSpace(s), "Z", "+00:00", 1)
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999-07:00",
	} {
		if t, err := time.Parse(layout, normalized); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid datetime: %q", s)
}

// naivePtr converts *time.Time to *NaiveUTC.
func naivePtr(t *time.Time) *NaiveUTC {
	if t == nil {
		return nil
	}
	return &NaiveUTC{*t}
}

func revisionView(r repo.RevisionMeta) RevisionView {
	return RevisionView{
		RevisionID:   r.RevisionID,
		RevisionNote: r.RevisionNote,
		CreatedAt:    NaiveUTC{r.CreatedAt},
	}
}
