package service

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/gorhill/cronexpr"
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

func toJSON(ss []string) datatypes.JSON {
	b, _ := json.Marshal(ss)
	return datatypes.JSON(b)
}

func toStringSliceJSON(j datatypes.JSON) []string {
	var ss []string
	_ = json.Unmarshal(j, &ss)
	return ss
}

func formatBeijing(t time.Time) string {
	return t.In(beijingLoc).Format("2006-01-02 15:04（北京时间）")
}

// NextCronTrigger parses a 5-field cron expression (min hour dom month dow,
// e.g. "0 23 * * *" = 23:00 daily) and returns the next occurrence strictly
// after `from`. The expression is interpreted in the process's local timezone,
// which main.go sets to the configured business timezone (Asia/Shanghai).
func NextCronTrigger(expr string, from time.Time) (time.Time, error) {
	ce, err := cronexpr.Parse(expr)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse cron %q: %w", expr, err)
	}
	next := ce.Next(from)
	if next.IsZero() {
		return time.Time{}, fmt.Errorf("cron %q yields no next occurrence after %v", expr, from)
	}
	return next, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
