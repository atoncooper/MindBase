package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"app-user/internal/config"
	settingsdto "app-user/internal/dto/settings"
	"app-user/internal/infra/security"
	"app-user/internal/model/settings"
	settingsservice "app-user/internal/service/settings"
)

func TestMaskCodingPlanKey(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"short":             "****",
		"sk-1234567890abcd": "sk-****abcd",
		"12345678":          "****",
		"123456789":         "123****6789",
	}
	for in, want := range cases {
		if got := settingsdto.MaskCodingPlanKey(in); got != want {
			t.Errorf("MaskCodingPlanKey(%q) = %q, want %q", in, got, want)
		}
	}
	// The mask must never expose the whole key.
	full := "sk-very-secret-value-9876"
	if strings.Contains(settingsdto.MaskCodingPlanKey(full), "secret") {
		t.Fatal("mask leaked the middle of the key")
	}
}

func TestCodingPlanValidation(t *testing.T) {
	if _, err := settingsservice.NormalizeCodingPlanProvider("OpenCode"); err != nil {
		t.Errorf("provider case-insensitive: %v", err)
	}
	if _, err := settingsservice.NormalizeCodingPlanProvider("openai"); err == nil {
		t.Error("unknown provider must be rejected")
	}
	if _, err := settingsservice.NormalizeCodingPlanProtocol("ANTHROPIC"); err != nil {
		t.Errorf("protocol case-insensitive: %v", err)
	}
	if _, err := settingsservice.NormalizeCodingPlanProtocol("grpc"); err == nil {
		t.Error("unknown protocol must be rejected")
	}
	if got, err := settingsservice.NormalizeCodingPlanBaseURL("https://api.example.com/v1/"); err != nil || got != "https://api.example.com/v1" {
		t.Errorf("base url normalization = %q, %v", got, err)
	}
	for _, bad := range []string{"", "ftp://x", "https://", "https://user:pw@api.example.com", "https://api.example.com?x=1"} {
		if _, err := settingsservice.NormalizeCodingPlanBaseURL(bad); err == nil {
			t.Errorf("base url %q must be rejected", bad)
		}
	}
	if got, err := settingsservice.NormalizeCodingPlanModel("  "); err != nil || got != "" {
		t.Errorf("empty model is optional (chat picks it): %q %v", got, err)
	}
	if _, err := settingsservice.NormalizeCodingPlanAPIKey(" ", true); err == nil {
		t.Error("create requires an api key")
	}
	if key, err := settingsservice.NormalizeCodingPlanAPIKey(" ", false); err != nil || key != "" {
		t.Errorf("patch empty key should be allowed: %q %v", key, err)
	}
	if label, err := settingsservice.NormalizeCodingPlanLabel("", "kimi"); err != nil || label != "kimi" {
		t.Errorf("empty label should default to provider: %q %v", label, err)
	}
}

func TestSanitizeProbeDetailRedactsKey(t *testing.T) {
	body := strings.NewReader("{\"error\":{\"message\":\"invalid key sk-secret-12345\"}}")
	got := settingsservice.SanitizeProbeDetail(body, "sk-secret-12345")
	if strings.Contains(got, "sk-secret-12345") {
		t.Fatalf("detail leaked the api key: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Fatalf("detail should redact the key: %q", got)
	}
	if strings.ContainsAny(got, "\n\r\t") {
		t.Fatalf("detail should be single-line: %q", got)
	}
}

func TestCodingPlanProbeOpenAIModels(t *testing.T) {
	var authHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q, want /v1/models", r.URL.Path)
		}
		authHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4o"},{"id":"o3"}]}`))
	}))
	defer srv.Close()

	res := settingsservice.ProbeCodingPlan(context.Background(), srv.Client(), "openai", srv.URL+"/v1", "gpt-4o", "sk-test")
	if !res.OK {
		t.Fatalf("probe failed: %+v", res)
	}
	if len(res.Models) != 2 || res.Models[0] != "gpt-4o" {
		t.Fatalf("models = %v", res.Models)
	}
	if authHeader != "Bearer sk-test" {
		t.Fatalf("authorization = %q", authHeader)
	}
}

func TestCodingPlanProbeAnthropicFallsBackToChat(t *testing.T) {
	var modelsKey, chatKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			modelsKey = r.Header.Get("x-api-key")
			http.Error(w, "not found", http.StatusNotFound)
		case "/v1/messages":
			chatKey = r.Header.Get("x-api-key")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"id":"msg_1"}`))
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}
	}))
	defer srv.Close()

	res := settingsservice.ProbeCodingPlan(context.Background(), srv.Client(), "anthropic", srv.URL+"/v1", "claude-sonnet", "sk-ant")
	if !res.OK {
		t.Fatalf("chat fallback should succeed: %+v", res)
	}
	if modelsKey != "sk-ant" || chatKey != "sk-ant" {
		t.Fatalf("keys = %q / %q", modelsKey, chatKey)
	}
}

func TestCodingPlanProbeFailureIsSanitized(t *testing.T) {
	const key = "sk-super-secret-key"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key ` + key + `"}}`))
	}))
	defer srv.Close()

	res := settingsservice.ProbeCodingPlan(context.Background(), srv.Client(), "openai", srv.URL, "gpt-4o", key)
	if res.OK {
		t.Fatal("probe must fail")
	}
	if strings.Contains(res.Message, key) {
		t.Fatalf("failure message leaked the key: %q", res.Message)
	}
	if !strings.Contains(res.Message, "HTTP 401") {
		t.Fatalf("failure message should carry status: %q", res.Message)
	}
}

func TestMembershipClientTierAndCache(t *testing.T) {
	var calls int32
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		gotPath = r.URL.Path
		gotKey = r.Header.Get("apikey")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"uid": 42, "tier": "SVIP", "active": true,
		})
	}))
	defer srv.Close()

	client := settingsservice.NewMembershipClient(config.AppPayConfig{BaseURL: srv.URL, Key: "consumer-key"})
	tier, err := client.Tier(context.Background(), 42)
	if err != nil || tier != settingsservice.TierSVIP {
		t.Fatalf("tier = %q, %v", tier, err)
	}
	if gotPath != "/internal/pay/membership/42" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotKey != "consumer-key" {
		t.Fatalf("apikey = %q", gotKey)
	}
	if _, err := client.Tier(context.Background(), 42); err != nil {
		t.Fatalf("cached tier: %v", err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected one upstream call, got %d", calls)
	}
}

func TestMembershipClientBaseAlreadyInternalPay(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"uid": 7, "tier": "VIP", "active": true})
	}))
	defer srv.Close()

	client := settingsservice.NewMembershipClient(config.AppPayConfig{BaseURL: srv.URL + "/internal/pay/"})
	if tier, err := client.Tier(context.Background(), 7); err != nil || tier != settingsservice.TierVIP {
		t.Fatalf("tier = %q, %v", tier, err)
	}
	if gotPath != "/internal/pay/membership/7" {
		t.Fatalf("path = %q", gotPath)
	}
}

func TestMembershipClientFailClosed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "pay down", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := settingsservice.NewMembershipClient(config.AppPayConfig{BaseURL: srv.URL, Key: "k"})
	if _, err := client.Tier(context.Background(), 1); err == nil {
		t.Fatal("non-200 membership lookup must error (fail-closed)")
	}

	freeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"uid": 1, "tier": nil, "active": false})
	}))
	defer freeSrv.Close()
	freeClient := settingsservice.NewMembershipClient(config.AppPayConfig{BaseURL: freeSrv.URL})
	if tier, err := freeClient.Tier(context.Background(), 1); err != nil || tier != settingsservice.TierFree {
		t.Fatalf("inactive membership = %q, %v", tier, err)
	}
}

func TestRequireVIP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/2") {
			_ = json.NewEncoder(w).Encode(map[string]any{"uid": 2, "tier": "VIP", "active": true})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"uid": 1, "tier": nil, "active": false})
	}))
	defer srv.Close()

	membership := settingsservice.NewMembershipClient(config.AppPayConfig{BaseURL: srv.URL})
	if err := settingsservice.RequireVIPTier(context.Background(), membership, 1); !errors.Is(err, settingsservice.ErrCodingPlanVIPOnly) {
		t.Fatalf("free user error = %v", err)
	}
	if err := settingsservice.RequireVIPTier(context.Background(), membership, 2); err != nil {
		t.Fatalf("vip user rejected: %v", err)
	}

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer down.Close()
	downMembership := settingsservice.NewMembershipClient(config.AppPayConfig{BaseURL: down.URL})
	if err := settingsservice.RequireVIPTier(context.Background(), downMembership, 2); !errors.Is(err, settingsservice.ErrMembershipUnavailable) {
		t.Fatalf("unavailable membership error = %v", err)
	}
}

func TestCodingPlanDTOMasksKey(t *testing.T) {
	cipher, err := security.NewCipher("")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	const key = "sk-1234567890abcdef"
	enc, err := cipher.Encrypt(key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	dto := settingsservice.BuildCodingPlanDTO(cipher, &model.CodingPlan{ID: 1, UID: 9, Provider: "custom", Protocol: "openai", BaseURL: "https://x", APIKeyEnc: enc})
	if dto.APIKeyMasked == key || strings.Contains(dto.APIKeyMasked, "1234567890") {
		t.Fatalf("view leaked key: %q", dto.APIKeyMasked)
	}
	if dto.APIKeyMasked != "sk-****cdef" {
		t.Fatalf("mask = %q", dto.APIKeyMasked)
	}
}
