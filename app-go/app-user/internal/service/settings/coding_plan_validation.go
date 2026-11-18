package settings

import (
	"net/url"
	"strings"
)

// ── validation ───────────────────────────────────────────────────────

// supportedCodingPlanProviders keeps provider identifiers stable for the stored
// rows and lets the UI offer common coding-plan subscriptions without a schema
// change (provider is a varchar(32) slug).
var supportedCodingPlanProviders = map[string]bool{
	"opencode":     true,
	"opencode_zen": true,
	"opencode_go":  true,
	"kimi":         true,
	"glm":          true,
	"minimax":      true,
	"qwen":         true,
	"deepseek":     true,
	"custom":       true,
}

func NormalizeCodingPlanProvider(raw string) (string, error) {
	p := strings.ToLower(strings.TrimSpace(raw))
	if supportedCodingPlanProviders[p] {
		return p, nil
	}
	return "", codingPlanInvalid("provider 不在支持列表中")
}

func NormalizeCodingPlanProtocol(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "openai":
		return "openai", nil
	case "anthropic":
		return "anthropic", nil
	default:
		return "", codingPlanInvalid("protocol 必须是 openai 或 anthropic")
	}
}

func NormalizeCodingPlanLabel(raw, provider string) (string, error) {
	label := strings.TrimSpace(raw)
	if label == "" {
		label = provider
	}
	if len([]rune(label)) > maxCodingPlanLabel {
		return "", codingPlanInvalid("名称不能超过 %d 个字符", maxCodingPlanLabel)
	}
	return label, nil
}

func NormalizeCodingPlanBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", codingPlanInvalid("请填写 base_url")
	}
	if len(value) > maxCodingPlanBaseURL {
		return "", codingPlanInvalid("base_url 过长")
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", codingPlanInvalid("base_url 必须是合法的 http(s) 地址")
	}
	if u.User != nil {
		return "", codingPlanInvalid("base_url 不能包含用户名或密码")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", codingPlanInvalid("base_url 不能包含查询参数或片段")
	}
	return strings.TrimRight(value, "/"), nil
}

// NormalizeCodingPlanModel accepts an empty value: the concrete model is
// chosen from the chat dialog (GET .../{id}/models) and sent per turn, so the
// stored value is only an optional preferred/default model.
func NormalizeCodingPlanModel(raw string) (string, error) {
	model := strings.TrimSpace(raw)
	if len([]rune(model)) > maxCodingPlanModel {
		return "", codingPlanInvalid("model 过长")
	}
	return model, nil
}

func NormalizeCodingPlanAPIKey(raw string, required bool) (string, error) {
	key := strings.TrimSpace(raw)
	if key == "" {
		if required {
			return "", codingPlanInvalid("请填写 api_key")
		}
		return "", nil
	}
	if len(key) > maxCodingPlanAPIKey {
		return "", codingPlanInvalid("api_key 过长")
	}
	return key, nil
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
