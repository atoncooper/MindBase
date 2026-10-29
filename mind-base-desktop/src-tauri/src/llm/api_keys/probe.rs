//! Connectivity probes: model-list auth checks and egress-proxy reachability.

use std::time::{Duration, Instant};

use serde::Serialize;

use super::proxy::{egress_agents, http_agent, normalize_proxy_addr};

/// Wall-clock cap for one connectivity probe.
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Outcome of one connectivity probe, safe to hand to the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub provider: String,
    pub ok: bool,
    /// Round-trip latency in milliseconds.
    pub latency_ms: u64,
    /// The exact URL that was probed (no secret material).
    pub endpoint: String,
    /// HTTP status when the server answered; `None` on transport failure.
    pub http_status: Option<u16>,
    /// Number of models the endpoint advertised, when it answered 200.
    pub model_count: Option<usize>,
    /// Human-readable conclusion in Chinese for the settings UI.
    pub detail: String,
    /// Whether the configured ASR model was found in the advertised list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asr_model_ok: Option<bool>,
    /// End-to-end transcription probe note (ASR only, consumes quota).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asr_note: Option<String>,
    /// End-to-end embedding probe note (embedding only, one tiny call).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_note: Option<String>,
}

/// Map one HTTP status to (verdict, human detail).
fn describe_status(status: u16, model_count: Option<usize>) -> (bool, String) {
    match status {
        200 => (
            true,
            match model_count {
                Some(count) => format!("密钥有效，端点返回 {count} 个可用模型"),
                None => "密钥有效".to_string(),
            },
        ),
        401 | 403 => (false, "鉴权失败：API Key 无效或已过期".to_string()),
        404 => (false, "端点不存在：请检查 Base URL 是否正确".to_string()),
        429 => (false, "请求过于频繁或额度受限（HTTP 429）".to_string()),
        code if (500..600).contains(&code) => (
            false,
            format!("提供方服务端错误（HTTP {code}），请稍后重试"),
        ),
        code => (false, format!("意外的 HTTP 状态码 {code}")),
    }
}

/// One GET `<endpoint>/models` with Bearer auth.
///
/// Returns the HTTP status plus the advertised model count when the body was
/// parseable JSON. Transport failures (DNS / connect / timeout) become `Err`;
/// the key never appears in any error text.
pub(super) fn request_models(
    agent: &ureq::Agent,
    url: &str,
    key: &str,
    protocol: crate::llm::ai_providers::ApiProtocol,
) -> Result<(u16, Option<Vec<String>>), String> {
    let request = agent.get(url).set("Accept", "application/json");
    let request = match protocol {
        crate::llm::ai_providers::ApiProtocol::OpenAiCompletions => {
            request.set("Authorization", &format!("Bearer {key}"))
        }
        crate::llm::ai_providers::ApiProtocol::AnthropicMessages => request
            .set("x-api-key", key)
            .set("anthropic-version", "2023-06-01")
            // 兼容网关（MiniMax / Kimi Coding 等）常读 Bearer 头；官方 API 忽略它。
            .set("Authorization", &format!("Bearer {key}")),
    };
    match request.call() {
        Ok(resp) => {
            let status = resp.status();
            let ids = resp.into_string().ok().and_then(|body| {
                let value: serde_json::Value = serde_json::from_str(&body).ok()?;
                let array = value
                    .get("data")
                    .or_else(|| value.get("models"))
                    .and_then(|items| items.as_array())?;
                Some(
                    array
                        .iter()
                        .filter_map(|item| {
                            item.get("id").and_then(|id| id.as_str()).map(str::to_string)
                        })
                        .collect::<Vec<_>>(),
                )
            });
            Ok((status, ids))
        }
        Err(ureq::Error::Status(code, _)) => Ok((code, None)),
        Err(ureq::Error::Transport(transport)) => Err(transport.to_string()),
    }
}

/// Probe through the configured egress route; on transport errors retry
/// once via the fallback (direct) — same resilience rule as before, now
/// sourced from the user's proxy setting instead of the environment.
pub(super) fn run_probe(
    provider: String,
    url: String,
    key: String,
    protocol: crate::llm::ai_providers::ApiProtocol,
) -> Result<ProviderTestResult, String> {
    let started = Instant::now();
    let (primary, fallback) = egress_agents(PROBE_TIMEOUT, &url)?;
    let outcome = request_models(&primary, &url, &key, protocol).or_else(|first_err| {
        let fallback = fallback.ok_or_else(|| first_err.clone())?;
        request_models(&fallback, &url, &key, protocol)
            .map_err(|retry_err| format!("{first_err}; fallback: {retry_err}"))
    });

    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok((status, ids)) => {
            let model_count = ids.map(|list| list.len());
            let (ok, detail) = describe_status(status, model_count);
            Ok(ProviderTestResult {
                provider,
                ok,
                latency_ms,
                endpoint: url,
                http_status: Some(status),
                model_count,
                detail,
                asr_model_ok: None,
                asr_note: None,
                embedding_note: None,
            })
        }
        Err(transport_err) => Ok(ProviderTestResult {
            provider,
            ok: false,
            latency_ms,
            endpoint: url,
            http_status: None,
            model_count: None,
            detail: format!("网络错误，无法连接端点：{transport_err}"),
            asr_model_ok: None,
            asr_note: None,
            embedding_note: None,
        }),
    }
}

/// Outcome of probing the user-configured egress proxy, safe for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    /// Round-trip latency in milliseconds.
    pub latency_ms: u64,
    /// HTTP status when the request succeeded end-to-end; `None` on failure.
    pub http_status: Option<u16>,
    /// Human-readable conclusion in Chinese for the settings UI.
    pub detail: String,
}

/// Target used to verify the proxy end-to-end. api.github.com/zen answers
/// 200 through any healthy proxy (and is the destination users most often
/// need the proxy for). Deliberately a single https target: some
/// rule-based / captive proxies 404 plain-http probe hosts like
/// msftconnecttest, which would read as a false failure.
const PROXY_TEST_HTTPS_URL: &str = "https://api.github.com/zen";

const PROXY_TEST_TIMEOUT: Duration = Duration::from_secs(10);

fn probe_via_proxy(addr: &str, target: &str) -> ProxyTestResult {
    let started = Instant::now();
    let outcome = http_agent(PROXY_TEST_TIMEOUT, Some(addr)).and_then(|agent| {
        match agent
            .get(target)
            .set("User-Agent", "mindbase-desktop")
            .call()
        {
            Ok(resp) => Ok(resp.status()),
            Err(ureq::Error::Status(code, _)) => Ok(code),
            Err(ureq::Error::Transport(transport)) => Err(transport.to_string()),
        }
    });
    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(status) => {
            let ok = (200..300).contains(&status);
            let detail = if ok {
                format!("代理可用（HTTP {status}，耗时 {latency_ms}ms）")
            } else {
                format!("代理已连通，但目标返回 HTTP {status}")
            };
            ProxyTestResult {
                ok,
                latency_ms,
                http_status: Some(status),
                detail,
            }
        }
        Err(err) => ProxyTestResult {
            ok: false,
            latency_ms,
            http_status: None,
            detail: format!("代理不可达，请确认代理软件已启动：{err}"),
        },
    }
}

/// Validate the addresses entered in the proxy settings card and probe one
/// of them end-to-end. The https address wins when both are set; with only
/// the http address set, that one is probed against the same https target —
/// matching the routing rule where a single filled address serves both
/// schemes. Probing verifies that the proxy app is reachable AND that it
/// forwards. Blocking IO stays on a worker thread.
#[tauri::command]
pub async fn test_proxy(
    proxy_http: Option<String>,
    proxy_https: Option<String>,
) -> Result<ProxyTestResult, String> {
    let http_addr = match proxy_http.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => Some(normalize_proxy_addr(value)?),
    };
    let https_addr = match proxy_https.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => Some(normalize_proxy_addr(value)?),
    };
    let addr = match (https_addr, http_addr) {
        (Some(https), _) => https,
        (None, Some(http)) => http,
        (None, None) => return Err("请先填写至少一个代理地址".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || probe_via_proxy(&addr, PROXY_TEST_HTTPS_URL))
        .await
        .map_err(|err| format!("probe task failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_classification_covers_common_cases() {
        let (ok, _) = describe_status(200, Some(42));
        assert!(ok);
        assert!(!describe_status(401, None).0);
        assert!(!describe_status(403, None).0);
        assert!(!describe_status(404, None).0);
        assert!(!describe_status(503, None).0);
    }
}
