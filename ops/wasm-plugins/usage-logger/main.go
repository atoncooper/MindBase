// usage-logger — Higress Wasm 插件（plan/1.0.11 M4 自研样板）
//
// 职责：在 AI 路由上把请求归因元数据（x-uid / X-Request-Id / path / model）
// 异步 POST 给主 app 的 /internal/ai-usage，落 ai_gateway_usage 表，
// 构成网关侧账本，与 backend 的 credential_usage 每日对账。
//
// v0 边界（诚实声明）：
// - 上报发生在请求头阶段（fire-and-forget，不暂停主链路）——此时响应 usage
//   尚不存在，token 数为 0；token 级网关账本由 ai-statistics 指标 +
//   backend 双账本对账承接，SSE body 解析留 v1（需缓冲响应体，成本高）。
// - 无 X-Request-Id 的请求不上报（无法与 backend 记账关联）。
// - 沙箱内没有 DB 连接：落库只能经 HTTP（本插件即此模式）。
//
// 配置（WasmPlugin defaultConfig / 控制台插件配置）：
//   {"backendHost": "backend", "backendPort": 8000, "endpoint": "/internal/ai-usage",
//    "pathPrefix": "/v1/", "timeoutMs": 3000}
package main

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm/types"
	"github.com/tidwall/gjson"

	"github.com/higress-group/wasm-go/pkg/log"
	"github.com/higress-group/wasm-go/pkg/wrapper"
)

func main() {}

func init() {
	wrapper.SetCtx(
		"usage-logger",
		wrapper.ParseConfig(parseConfig),
		wrapper.ProcessRequestHeaders(onHttpRequestHeaders),
	)
}

type UsageLoggerConfig struct {
	client     wrapper.HttpClient
	endpoint   string
	pathPrefix string
	timeoutMs  uint32
}

func parseConfig(json gjson.Result, config *UsageLoggerConfig) error {
	host := json.Get("backendHost").String()
	if host == "" {
		return fmt.Errorf("backendHost is required")
	}
	port := json.Get("backendPort").Int()
	if port == 0 {
		port = 8000
	}
	config.client = wrapper.NewClusterClient(wrapper.FQDNCluster{FQDN: host, Port: port})
	config.endpoint = json.Get("endpoint").String()
	if config.endpoint == "" {
		config.endpoint = "/internal/ai-usage"
	}
	config.pathPrefix = json.Get("pathPrefix").String()
	if config.pathPrefix == "" {
		config.pathPrefix = "/v1/"
	}
	config.timeoutMs = uint32(json.Get("timeoutMs").Int())
	if config.timeoutMs == 0 {
		config.timeoutMs = 3000
	}
	return nil
}

func onHttpRequestHeaders(ctx wrapper.HttpContext, config UsageLoggerConfig) types.Action {
	path, err := proxywasm.GetHttpRequestHeader(":path")
	if err != nil || !strings.HasPrefix(path, config.pathPrefix) {
		return types.ActionContinue
	}
	requestId, _ := proxywasm.GetHttpRequestHeader("X-Request-Id")
	if requestId == "" {
		// 无关联键：上报了也对不了账，直接放行
		return types.ActionContinue
	}
	uid, _ := proxywasm.GetHttpRequestHeader("x-uid")
	model, _ := proxywasm.GetHttpRequestHeader("x-higress-llm-model")
	if model == "" {
		model, _ = proxywasm.GetHttpRequestHeader(":authority")
	}

	body := fmt.Sprintf(
		`{"request_id":%q,"uid":%s,"model":%q,"purpose":"gateway","prompt_tokens":0,"completion_tokens":0,"status":"request"}`,
		requestId, orNull(uid), model,
	)
	headers := [][2]string{
		{"Content-Type", "application/json"},
	}
	err = config.client.Post(config.endpoint, headers, []byte(body), func(statusCode int, responseHeaders http.Header, responseBody []byte) {
		if statusCode >= 300 {
			log.Warnf("[usage-logger] report failed: status=%d body=%s", statusCode, string(responseBody))
		}
	}, config.timeoutMs)
	if err != nil {
		// 上报失败绝不影响主链路
		log.Warnf("[usage-logger] callout error: %v", err)
	}
	// fire-and-forget：不暂停主请求（POST 结果只进日志）
	return types.ActionContinue
}

func orNull(v string) string {
	if v == "" {
		return "null"
	}
	return v
}
