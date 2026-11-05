package utils

// Additional pure, domain-specific helpers shared by the drive's service
// layer: folder path labels, mirrored folder names and uuid generation. They
// live here so they can be unit-tested (and reused) without exporting service
// internals.

import (
	"crypto/rand"
	"fmt"
	"strings"
	"time"

	"app-cloud/internal/model"
)

// FolderRelativePath returns the path label of folderID relative to rootID:
// "a/b" for a descendant folder, "" for the shared root itself. Defensive
// against dangling parents / cycles (bounded hops; a chain that never reaches
// the root reads as root-level rather than as a partial path).
func FolderRelativePath(byID map[int64]model.CloudFolder, rootID, folderID int64) string {
	if folderID == rootID {
		return ""
	}
	var parts []string
	cur, ok := byID[folderID]
	reachedRoot := false
	for hops := 0; ok && hops < 64; hops++ {
		if cur.ID == rootID {
			reachedRoot = true
			break
		}
		parts = append(parts, cur.Name)
		if cur.ParentID == nil {
			break // not a descendant of the root
		}
		cur, ok = byID[*cur.ParentID]
	}
	if !reachedRoot {
		return "" // dangling chain / corrupted tree — treat as root-level
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, "/")
}

// RefFolderNameMaxBytes — cloud_folders.name is varchar(200); keep room for
// the "-引用(N)" suffix (UTF-8 byte truncation, rune-safe).
const RefFolderNameMaxBytes = 200 - 16

// RefFolderName rune-safe truncates a mirrored folder name to the folder
// column limit without splitting a multi-byte rune.
func RefFolderName(name string, maxBytes int) string {
	for len(name) > maxBytes {
		runes := []rune(name)
		name = string(runes[:len(runes)-1])
	}
	return name
}

// UUID7 generates a time-ordered UUIDv7 string per RFC 9562: 48-bit unix-ms
// timestamp + version 7 + 12 random bits (rand_a) + variant 10 + 62 random
// bits (rand_b). Uuids are opaque keys (DB unique key, MinIO object path);
// nothing parses their internals, so the bit layout is chosen for correctness
// rather than any historical formatting quirk.
func UUID7() (string, error) {
	const uuid7EpochMS = int64(1577836800000) // 2020-01-01T00:00:00Z
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	r := uint64(0)
	for _, by := range b {
		r = r<<8 | uint64(by)
	}
	ts := uint64(time.Now().UnixMilli()-uuid7EpochMS) & 0xFFFFFFFFFFFF
	timeLow := ts & 0xFFFFFFFF
	timeMid := (ts >> 32) & 0xFFFF
	timeHi := ((ts >> 48) & 0xFFF) | 0x7000 | uint64((r>>52)&0xFFF)
	clockSeq := 0x8000 | uint64((r>>48)&0x3FFF)
	node := r & 0xFFFFFFFFFFFF
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", timeLow, timeMid, timeHi, clockSeq, node), nil
}
