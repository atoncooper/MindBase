package service

import (
	"testing"

	"app-cloud/internal/model"
)

// folderRelativePath — public folder-share payloads label every file with its
// path relative to the shared folder root ("a/b"; "" = root level).
func TestFolderRelativePath(t *testing.T) {
	mk := func(id int64, parent *int64, name string) model.CloudFolder {
		return model.CloudFolder{ID: id, ParentID: parent, Name: name}
	}
	p := func(v int64) *int64 { return &v }
	byID := map[int64]model.CloudFolder{
		1: mk(1, nil, "root"),
		2: mk(2, p(1), "a"),
		3: mk(3, p(2), "b"),
		4: mk(4, p(1), "sibling"),
		5: mk(5, p(999), "dangling"), // parent NOT in the map
		6: mk(6, p(6), "loop"),       // self-parent cycle — bounded hops
	}
	cases := []struct {
		root, folder int64
		want         string
	}{
		{1, 1, ""},        // the shared root itself
		{1, 2, "a"},       // direct child
		{1, 3, "a/b"},     // nested
		{1, 4, "sibling"}, // other child of root
		{2, 2, ""},        // nested share: root of that share
		{2, 3, "b"},       // nested share: relative to THAT root
		{1, 5, ""},        // dangling parent — defensive root-level
		{1, 6, ""},        // cycle — bounded hops, defensive root-level
	}
	for _, tc := range cases {
		if got := folderRelativePath(byID, tc.root, tc.folder); got != tc.want {
			t.Fatalf("folderRelativePath(root=%d, folder=%d) = %q, want %q", tc.root, tc.folder, got, tc.want)
		}
	}
}

// Mirror folder names must respect the varchar(200) column without splitting
// a multi-byte rune (Chinese folder names are common).
func TestRefFolderNameTruncation(t *testing.T) {
	long := ""
	for len(long) < 300 {
		long += "文件夹" // 9 bytes per repetition
	}
	got := refFolderName(long, refFolderNameBytes)
	if len(got) > refFolderNameBytes {
		t.Fatalf("truncated to %d bytes, want <= %d", len(got), refFolderNameBytes)
	}
	// truncate to a rune boundary: appending is safe, splitting is not
	for _, r := range []string{"文件夹", "a", "b"} {
		if string([]rune(got)) != got {
			t.Fatalf("truncation split a multi-byte rune")
		}
		_ = r
	}
	if refFolderName("短名", refFolderNameBytes) != "短名" {
		t.Fatal("short passthrough broken")
	}
	if refFolderName("", refFolderNameBytes) != "" {
		t.Fatal("empty passthrough broken")
	}
}

// LegalAck is a backend-enforced gate: the sentinel must exist and stay the
// exact user-facing copy the contract pins (plan/1.0.16 §四: 422 文案).
func TestLegalAckErrorCopy(t *testing.T) {
	if ErrLegalAckRequired.Error() != "请先阅读并同意分享规范" {
		t.Fatalf("legalAck copy drifted: %q", ErrLegalAckRequired.Error())
	}
}

// Ref invalidation copy is the uniform wire detail (404「引用已失效」).
func TestRefDeadErrorCopy(t *testing.T) {
	if ErrRefDead.Error() != "引用已失效" {
		t.Fatalf("ref-dead copy drifted: %q", ErrRefDead.Error())
	}
}
