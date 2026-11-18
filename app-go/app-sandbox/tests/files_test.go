package tests

import (
	"strings"
	"testing"

	"app-sandbox/internal/service"
)

func TestSliceFileContentOffsetsAndHasMore(t *testing.T) {
	data := []byte("alpha\nbeta\ngamma\n")
	first, offset, next, more := service.SliceFileContent(data, 0, 6)
	if first != "alpha\n" || offset != 0 || next != 6 || !more {
		t.Fatalf("first = %q offset=%d next=%d more=%v", first, offset, next, more)
	}
	second, offset2, next2, more2 := service.SliceFileContent(data, next, 5)
	if second != "beta\n" || offset2 != 6 || next2 != 11 || !more2 {
		t.Fatalf("second = %q offset=%d next=%d more=%v", second, offset2, next2, more2)
	}
	last, _, lastNext, more3 := service.SliceFileContent(data, next2, 64)
	if last != "gamma\n" || lastNext != int64(len(data)) || more3 {
		t.Fatalf("last = %q next=%d more=%v", last, lastNext, more3)
	}
}

func TestSliceFileContentUTF8Boundaries(t *testing.T) {
	data := []byte("中文abc")
	// Offset 1 lands inside the first rune; the slice must start at rune boundary.
	content, offset, _, _ := service.SliceFileContent(data, 1, 3)
	if offset != 3 || !strings.HasPrefix(content, "文") {
		t.Fatalf("content = %q offset=%d", content, offset)
	}
}
