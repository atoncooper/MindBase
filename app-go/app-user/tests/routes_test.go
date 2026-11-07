package tests

import (
	"sort"
	"testing"

	"app-user/internal/config"
	authrouter "app-user/internal/router/auth"
	bilirouter "app-user/internal/router/bili"
	settingsrouter "app-user/internal/router/settings"

	"github.com/gin-gonic/gin"
)

// TestRouteParity pins the merged route surface per listener. These are the
// exact routes the three pre-merge services served; a lost or renamed route
// would break the frontend even though the process changed.
func TestRouteParity(t *testing.T) {
	authEngine := authrouter.New(authrouter.Deps{Cfg: &config.AuthConfig{}})
	biliEngine := bilirouter.New(bilirouter.Deps{Cfg: &config.BiliConfig{}})
	settingsEngine := settingsrouter.New(settingsrouter.Deps{Cfg: &config.SettingsConfig{}})

	cases := []struct {
		name   string
		target string
		engine *gin.Engine
		want   []string
	}{
		{"auth", "8006", authEngine, []string{
			"GET /health",
			"GET /metrics",
			"GET /debug/latency",
			"GET /internal/auth/verify",
			"GET /internal/auth/user/:uid",
			"GET /auth/features",
			"GET /auth/captcha",
			"GET /auth/qrcode",
			"GET /auth/qrcode/poll/:qrcode_key",
			"GET /auth/wechat/qrcode",
			"POST /auth/wechat/login",
			"POST /auth/login",
			"GET /auth/attest/challenge",
			"POST /auth/attest",
			"POST /auth/register/email/send-code",
			"POST /auth/register/email",
			"POST /auth/phone/send-code",
			"POST /auth/phone/login",
			"POST /auth/password/reset-request",
			"POST /auth/password/reset",
			"GET /auth/me",
			"DELETE /auth/token",
			"GET /auth/tokens",
			"DELETE /auth/tokens",
			"DELETE /auth/tokens/:session_id",
			"GET /auth/profile",
			"PATCH /auth/profile",
			"POST /auth/password/set",
			"PATCH /auth/password",
			"PUT /auth/email",
			"DELETE /auth/email",
			"POST /auth/email/send-code",
			"POST /auth/email/verify",
			"PUT /auth/phone",
			"DELETE /auth/phone",
			"POST /auth/phone/verify",
			"GET /auth/devices",
			"GET /auth/security",
			"POST /auth/wechat/bind",
		}},
		{"bili", "8010", biliEngine, []string{
			"GET /health",
			"GET /internal/bili/scope",
			"GET /internal/bili/owns",
			"GET /favorites/v2/list",
			"POST /favorites/v2/sync",
			"PATCH /favorites/v2/:folder_id/selected",
			"DELETE /favorites/v2/:folder_id",
			"GET /favorites/v2/video/:bvid/pages",
			"GET /favorites/v2/media/:media_id/videos",
			"POST /knowledge/folders/sync",
			"POST /knowledge/build",
			"GET /knowledge/build/active",
			"GET /knowledge/build/status/:task_id",
			"GET /asr/content",
			"POST /asr/create",
			"POST /asr/update",
			"POST /asr/reasr",
			"GET /asr/status/:task_id",
			"GET /asr/versions",
		}},
		{"settings", "8015", settingsEngine, []string{
			"GET /health",
			"GET /preferences",
			"PATCH /preferences",
			"POST /avatar/upload",
			"GET /avatar/file/*object_key",
		}},
	}
	for _, tc := range cases {
		got := make([]string, 0, len(tc.engine.Routes()))
		for _, r := range tc.engine.Routes() {
			got = append(got, r.Method+" "+r.Path)
		}
		sort.Strings(got)
		want := append([]string(nil), tc.want...)
		sort.Strings(want)
		if len(got) != len(want) {
			t.Fatalf("%s (%s): got %d routes, want %d\ngot: %v", tc.name, tc.target, len(got), len(want), got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s (%s): route mismatch at %d: got %q, want %q", tc.name, tc.target, i, got[i], want[i])
			}
		}
	}
}
