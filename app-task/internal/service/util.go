package service

import (
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/datatypes"
)

var beijingLoc *time.Location

func init() {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		// fallback: UTC; time/tzdata is embedded so this should not happen
		loc = time.UTC
	}
	beijingLoc = loc
}

// str coerces an any (from JSON/map) to string.
func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// toInt coerces an any (JSON numbers decode as float64) to int.
func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

func toJSON(ss []string) datatypes.JSON {
	b, _ := json.Marshal(ss)
	return datatypes.JSON(b)
}

func toStringSlice(v any) []string {
	if v == nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		out = append(out, fmt.Sprint(x))
	}
	return out
}

func toStringSliceJSON(j datatypes.JSON) []string {
	var ss []string
	_ = json.Unmarshal(j, &ss)
	return ss
}

func formatBeijing(t time.Time) string {
	return t.In(beijingLoc).Format("2006-01-02 15:04（北京时间）")
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
