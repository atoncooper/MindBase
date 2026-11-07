package utils

// StrPtr returns a pointer to s (nil-safe helper for optional wire fields).
func StrPtr(s string) *string { return &s }

// IntPtr returns a pointer to i.
func IntPtr(i int) *int { return &i }

// BoolPtr returns a pointer to b.
func BoolPtr(b bool) *bool { return &b }

// DerefStr dereferences p, returning "" for nil.
func DerefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// DerefInt dereferences p, returning 0 for nil.
func DerefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// DerefBool dereferences p, returning false for nil.
func DerefBool(p *bool) bool { return p != nil && *p }

// DerefInt64 dereferences p, returning 0 for nil.
func DerefInt64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
