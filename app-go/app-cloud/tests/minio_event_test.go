package tests

import (
	"testing"

	"app-cloud/internal/service"
)

func TestParseUploadObjectKey(t *testing.T) {
	cases := []struct {
		key     string
		wantUID int64
		wantID  string
		ok      bool
	}{
		{
			key:     "233830818118639616/815cd747-0032-7c63-8634-c200d2176c92/file.txt",
			wantUID: 233830818118639616,
			wantID:  "815cd747-0032-7c63-8634-c200d2176c92",
			ok:      true,
		},
		{key: "avators/233830818118639616/a.jpg", ok: false},
		{key: "_edge-test/probe.txt", ok: false},
		{key: "0/815cd747-0032-7c63-8634-c200d2176c92/file.txt", ok: false},
		{key: "42/not-a-uuid/file.txt", ok: false},
	}
	for _, c := range cases {
		uid, id, ok := service.ParseUploadObjectKey(c.key)
		if ok != c.ok || uid != c.wantUID || id != c.wantID {
			t.Fatalf("ParseUploadObjectKey(%q) = (%d,%q,%v), want (%d,%q,%v)",
				c.key, uid, id, ok, c.wantUID, c.wantID, c.ok)
		}
	}
}

func TestParseDeadlineMember(t *testing.T) {
	cases := []struct {
		member  string
		wantUID int64
		wantID  string
		ok      bool
	}{
		{
			member:  "233830818118639616:847060b0-0032-7720-b203-02c74b132173",
			wantUID: 233830818118639616,
			wantID:  "847060b0-0032-7720-b203-02c74b132173",
			ok:      true,
		},
		{member: "233830818118639616", ok: false},
		{member: "0:847060b0-0032-7720-b203-02c74b132173", ok: false},
		{member: "uid:not-a-uuid", ok: false},
	}
	for _, c := range cases {
		uid, id, ok := service.ParseDeadlineMember(c.member)
		if ok != c.ok || uid != c.wantUID || id != c.wantID {
			t.Fatalf("ParseDeadlineMember(%q) = (%d,%q,%v), want (%d,%q,%v)",
				c.member, uid, id, ok, c.wantUID, c.wantID, c.ok)
		}
	}
}
