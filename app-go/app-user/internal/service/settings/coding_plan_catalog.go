package settings

import (
	"strings"

	"app-user/internal/config"
	settingsdto "app-user/internal/dto/settings"
)

// Providers returns the operator-owned catalog (default.yaml
// settings.coding_plan.providers) for the account editor. It carries no
// secrets; the VIP gate is enforced by the route alongside ListPlans.
func (s *CodingPlanService) Providers() []settingsdto.CodingPlanProvider {
	out := make([]settingsdto.CodingPlanProvider, 0, len(s.providers))
	for _, p := range s.providers {
		out = append(out, settingsdto.CodingPlanProvider{
			Name:             p.Name,
			Label:            p.Label,
			OpenAIBaseURL:    p.OpenAIBaseURL,
			AnthropicBaseURL: p.AnthropicBaseURL,
			ModelsURL:        p.ModelsURL,
			ModelHint:        p.ModelHint,
		})
	}
	return out
}

func (s *CodingPlanService) provider(name string) (config.CodingPlanProviderConfig, bool) {
	key := strings.ToLower(strings.TrimSpace(name))
	idx, ok := s.providerIndex[key]
	if !ok {
		return config.CodingPlanProviderConfig{}, false
	}
	return s.providers[idx], true
}

func trimBaseURL(v string) string {
	return strings.TrimRight(strings.TrimSpace(v), "/")
}

// effectiveBaseURL resolves a stored base URL against the operator catalog:
// legacy OpenCode endpoints (and a protocol switch) map to the current
// protocol-specific base; a truly custom URL is preserved.
func (s *CodingPlanService) effectiveBaseURL(provider, protocol, stored string) string {
	spec, ok := s.provider(provider)
	if !ok {
		return stored
	}
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	current := spec.OpenAIBaseURL
	if protocol == "anthropic" && spec.AnthropicBaseURL != "" {
		current = spec.AnthropicBaseURL
	}
	current = strings.TrimSpace(current)
	if current == "" {
		return stored
	}
	clean := trimBaseURL(stored)
	if clean == "" {
		return current
	}
	for _, legacy := range spec.LegacyBaseURLs {
		if trimBaseURL(legacy) == clean {
			return current
		}
	}
	if trimBaseURL(spec.OpenAIBaseURL) == clean ||
		(spec.AnthropicBaseURL != "" && trimBaseURL(spec.AnthropicBaseURL) == clean) {
		return current
	}
	return stored
}

// modelsURL returns the plan-level model catalog endpoint. OpenCode exposes it
// outside the chat-completions base path; other providers use {base}/models.
func (s *CodingPlanService) modelsURL(provider, protocol, effective string) string {
	spec, ok := s.provider(provider)
	clean := trimBaseURL(effective)
	if ok && strings.TrimSpace(spec.ModelsURL) != "" {
		if trimBaseURL(spec.OpenAIBaseURL) == clean ||
			(spec.AnthropicBaseURL != "" && trimBaseURL(spec.AnthropicBaseURL) == clean) {
			return strings.TrimSpace(spec.ModelsURL)
		}
	}
	return clean + "/models"
}
