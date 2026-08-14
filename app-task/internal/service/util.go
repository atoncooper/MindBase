package service

import (
	"encoding/json"
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

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
