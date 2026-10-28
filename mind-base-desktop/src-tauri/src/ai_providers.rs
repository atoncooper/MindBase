//! AI 提供方目录（模型配置的唯一事实来源）。
//!
//! 参考 DeepSeek Harness 的 provider 数据（@earendil-works/pi-ai 的
//! providers/data/*.json）：每个提供方声明 id / 显示名 / 分组 / 协议 /
//! 默认端点 / 默认模型 / 推荐模型列表。前端「模型配置」页与后端校验、
//! 端点解析、测试连接都读这一张表，避免多处硬编码漂移。
//!
//! 协议只有两种：
//! - openai-completions：/chat/completions + Bearer（绝大多数编程套餐）
//! - anthropic-messages：/v1/messages + x-api-key（Claude / MiniMax / Kimi 编程套餐）

use serde::Serialize;

/// 提供方使用的 HTTP 协议族。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ApiProtocol {
    OpenAiCompletions,
    AnthropicMessages,
}


/// 一个提供方的静态描述。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDef {
    pub id: &'static str,
    pub label: &'static str,
    /// 分组 id：coding / official / aggregator / purpose。
    pub group: &'static str,
    /// 分组中文名，前端分组标题直接使用。
    pub group_label: &'static str,
    pub protocol: ApiProtocol,
    pub protocol_label: &'static str,
    /// 官方默认 Base URL（可被用户覆盖；custom 为空表示必须手填）。
    pub default_base: &'static str,
    /// 未配置模型时使用的默认模型；空 = 必须显式配置。
    pub default_model: &'static str,
    /// 推荐模型（设置页 datalist + 模型选择）。
    pub models: &'static [&'static str],
    /// 是否可用于对话（决定能否设为默认 / 出现在对话提供方菜单）。
    pub chat: bool,
    /// 一句话说明（分组里的辅助文案）。
    pub hint: &'static str,
}

/// 全部提供方。顺序即设置页展示顺序。
pub(crate) const PROVIDERS: &[ProviderDef] = &[
    // ── 编程套餐（Coding Plans）────────────────────────────────────────
    ProviderDef {
        id: "deepseek",
        label: "DeepSeek（官方）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://api.deepseek.com",
        default_model: "deepseek-chat",
        models: &["deepseek-chat", "deepseek-reasoner"],
        chat: true,
        hint: "DeepSeek 官方 API，按 token 计费。",
    },
    ProviderDef {
        id: "zai",
        label: "GLM 编程套餐（国际站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://api.z.ai/api/coding/paas/v4",
        default_model: "glm-4.7",
        models: &["glm-4.7", "glm-5-turbo", "glm-5.2", "glm-5.2-highspeed"],
        chat: true,
        hint: "智谱 GLM Coding Plan（api.z.ai），按套餐额度计费。",
    },
    ProviderDef {
        id: "zai-coding-cn",
        label: "GLM 编程套餐（国内站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://open.bigmodel.cn/api/coding/paas/v4",
        default_model: "glm-5.3",
        models: &["glm-5.3", "glm-5.3-flash", "glm-4.6v"],
        chat: true,
        hint: "智谱 GLM Coding Plan（open.bigmodel.cn），国内直连。",
    },
    ProviderDef {
        id: "kimi-coding",
        label: "Kimi 编程套餐",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::AnthropicMessages,
        protocol_label: "Anthropic 协议",
        default_base: "https://api.kimi.com/coding",
        default_model: "k3",
        models: &["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
        chat: true,
        hint: "Moonshot Kimi for Coding 套餐，走 Anthropic 兼容端点。",
    },
    ProviderDef {
        id: "minimax",
        label: "MiniMax 编程套餐（国际站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::AnthropicMessages,
        protocol_label: "Anthropic 协议",
        default_base: "https://api.minimax.io/anthropic",
        default_model: "MiniMax-M2.7",
        models: &["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3"],
        chat: true,
        hint: "MiniMax 编程套餐，Anthropic 兼容端点。",
    },
    ProviderDef {
        id: "minimax-cn",
        label: "MiniMax 编程套餐（国内站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::AnthropicMessages,
        protocol_label: "Anthropic 协议",
        default_base: "https://api.minimaxi.com/anthropic",
        default_model: "MiniMax-M2.7",
        models: &["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3"],
        chat: true,
        hint: "MiniMax 国内站编程套餐，Anthropic 兼容端点。",
    },
    ProviderDef {
        id: "qwen-token-plan",
        label: "Qwen Token 套餐（国际站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen3.6-flash",
        models: &["qwen3.6-flash", "deepseek-v4.1-flash", "glm-5.2", "kimi-k2.7-code"],
        chat: true,
        hint: "阿里云 Token 套餐（新加坡节点），OpenAI 兼容。",
    },
    ProviderDef {
        id: "qwen-token-plan-cn",
        label: "Qwen Token 套餐（国内站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen3.6-flash",
        models: &["qwen3.6-flash", "deepseek-v4.1-flash", "glm-5.2", "kimi-k2.7-code"],
        chat: true,
        hint: "阿里云 Token 套餐（北京节点），OpenAI 兼容。",
    },
    ProviderDef {
        id: "xiaomi-token-plan",
        label: "小米 Token 套餐（AMS）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://token-plan-ams.xiaomimimo.com/v1",
        default_model: "mimo-v2.6-pro",
        models: &["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro"],
        chat: true,
        hint: "小米 MiMo Token 套餐（阿姆斯特丹节点）。",
    },
    ProviderDef {
        id: "xiaomi-token-plan-cn",
        label: "小米 Token 套餐（国内站）",
        group: "coding",
        group_label: "编程套餐",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://token-plan-cn.xiaomimimo.com/v1",
        default_model: "mimo-v2.6-pro",
        models: &["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro"],
        chat: true,
        hint: "小米 MiMo Token 套餐（国内节点）。",
    },
    // ── 官方 API ──────────────────────────────────────────────────────
    ProviderDef {
        id: "anthropic",
        label: "Anthropic Claude",
        group: "official",
        group_label: "官方 API",
        protocol: ApiProtocol::AnthropicMessages,
        protocol_label: "Anthropic 协议",
        default_base: "https://api.anthropic.com",
        default_model: "claude-sonnet-4-5",
        models: &["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
        chat: true,
        hint: "Anthropic 官方 API（Claude Code 同源的 Anthropic 协议）。",
    },
    ProviderDef {
        id: "openai",
        label: "OpenAI",
        group: "official",
        group_label: "官方 API",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://api.openai.com/v1",
        default_model: "gpt-4.1",
        models: &["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o4-mini"],
        chat: true,
        hint: "OpenAI 官方 API。",
    },
    ProviderDef {
        id: "moonshotai",
        label: "Moonshot / Kimi（国际站）",
        group: "official",
        group_label: "官方 API",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://api.moonshot.ai/v1",
        default_model: "kimi-k2.6",
        models: &["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
        chat: true,
        hint: "Moonshot 开放平台（国际站），OpenAI 兼容。",
    },
    ProviderDef {
        id: "moonshotai-cn",
        label: "Moonshot / Kimi（国内站）",
        group: "official",
        group_label: "官方 API",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://api.moonshot.cn/v1",
        default_model: "kimi-k2.6",
        models: &["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
        chat: true,
        hint: "Moonshot 开放平台（国内站），OpenAI 兼容。",
    },
    // ── 聚合 / 兼容端点 ───────────────────────────────────────────────
    ProviderDef {
        id: "dashscope",
        label: "DashScope（通义百炼）",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen-flash",
        models: &["qwen-max", "qwen-plus", "qwen-turbo", "qwen-flash", "deepseek-v3", "deepseek-r1"],
        chat: true,
        hint: "阿里云百炼兼容模式；ASR / 向量化未配置时回退此密钥。",
    },
    ProviderDef {
        id: "openrouter",
        label: "OpenRouter",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://openrouter.ai/api/v1",
        default_model: "",
        models: &[
            "openai/gpt-4o",
            "anthropic/claude-sonnet-4.5",
            "google/gemini-2.0-flash-001",
            "deepseek/deepseek-chat",
        ],
        chat: true,
        hint: "聚合多家模型；必须显式配置模型。",
    },
    ProviderDef {
        id: "opencode",
        label: "OpenCode Zen（OpenAI 兼容）",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://opencode.ai/zen/v1",
        default_model: "glm-5.3",
        models: &[
            "glm-5.3",
            "glm-5.2",
            "deepseek-v4.1-flash",
            "deepseek-v4-pro",
            "kimi-k2.7-code",
            "kimi-k3",
            "mimo-v2.5-pro",
            "big-pickle",
        ],
        chat: true,
        hint: "OpenCode Zen 订阅（OpenAI 兼容端点），按套餐额度计费。",
    },
    ProviderDef {
        id: "opencode-claude",
        label: "OpenCode Zen（Claude 协议）",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::AnthropicMessages,
        protocol_label: "Anthropic 协议",
        default_base: "https://opencode.ai/zen",
        default_model: "claude-sonnet-4-5",
        models: &[
            "claude-sonnet-4-5",
            "claude-opus-5-5",
            "claude-haiku-4-5",
            "claude-fable-5",
        ],
        chat: true,
        hint: "OpenCode Zen 的 Claude 模型走 Anthropic 兼容端点。",
    },
    ProviderDef {
        id: "opencode-go",
        label: "OpenCode Go（OpenAI 兼容）",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://opencode.ai/zen/go/v1",
        default_model: "glm-5.3",
        models: &[
            "glm-5.3",
            "deepseek-v4.1-flash",
            "kimi-k2.7-code",
            "kimi-k3",
            "mimo-v2.5-pro",
            "longcat-2.0",
            "hy4-preview",
        ],
        chat: true,
        hint: "OpenCode Go 订阅（性价档，OpenAI 兼容端点）。",
    },
    ProviderDef {
        id: "opencode-go-claude",
        label: "OpenCode Go（Claude 协议）",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::AnthropicMessages,
        protocol_label: "Anthropic 协议",
        default_base: "https://opencode.ai/zen/go",
        default_model: "claude-haiku-5-5",
        models: &[
            "claude-haiku-5-5",
            "minimax-m3",
            "qwen3.8-max",
            "qwen3.8-flash",
        ],
        chat: true,
        hint: "OpenCode Go 的 Claude 兼容模型走 Anthropic 端点。",
    },
    ProviderDef {
        id: "custom",
        label: "自定义 OpenAI 兼容端点",
        group: "aggregator",
        group_label: "聚合 / 兼容端点",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "",
        default_model: "",
        models: &[],
        chat: true,
        hint: "任意 OpenAI 兼容网关：填写 Base URL（含 /v1）与模型名。",
    },
    // ── 用途槽 ────────────────────────────────────────────────────────
    ProviderDef {
        id: "asr",
        label: "ASR 语音转写",
        group: "purpose",
        group_label: "用途槽",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://dashscope.aliyuncs.com/api/v1",
        default_model: "",
        models: &[
            "paraformer-realtime-v2",
            "paraformer-realtime-v1",
            "paraformer-v2",
            "paraformer-v1",
            "sensevoice-v1",
        ],
        chat: false,
        hint: "视频入库时的语音转文字；Base URL 以 wss:// 开头走实时流式。",
    },
    ProviderDef {
        id: "embedding",
        label: "向量化 Embedding",
        group: "purpose",
        group_label: "用途槽",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "",
        models: &[
            "text-embedding-v4",
            "text-embedding-v3",
            "text-embedding-v2",
            "openai/text-embedding-3-small",
            "openai/text-embedding-3-large",
        ],
        chat: false,
        hint: "知识库检索向量化；留空回退 DashScope 密钥。",
    },
    ProviderDef {
        id: "ocr",
        label: "OCR 文字识别",
        group: "purpose",
        group_label: "用途槽",
        protocol: ApiProtocol::OpenAiCompletions,
        protocol_label: "OpenAI 兼容",
        default_base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "",
        models: &["qwen-vl-ocr", "qwen-vl-ocr-latest"],
        chat: false,
        hint: "图片 / PDF 文字识别；留空回退 DashScope 密钥。",
    },
];

/// 按 id 查表（大小写不敏感由调用方先归一化）。
pub(crate) fn find(id: &str) -> Option<&'static ProviderDef> {
    PROVIDERS.iter().find(|entry| entry.id == id)
}

/// 是否为已知提供方。
pub(crate) fn is_known(id: &str) -> bool {
    find(id).is_some()
}

/// 官方默认 Base URL；未知提供方返回空串。
pub(crate) fn default_base(id: &str) -> &'static str {
    find(id).map(|entry| entry.default_base).unwrap_or_default()
}

/// 该提供方使用的协议；未知提供方按 OpenAI 兼容处理。
pub(crate) fn protocol_of(id: &str) -> ApiProtocol {
    find(id)
        .map(|entry| entry.protocol)
        .unwrap_or(ApiProtocol::OpenAiCompletions)
}

/// 可用于对话的提供方 id（顺序即自动选择优先级）。
pub(crate) fn chat_ids() -> impl Iterator<Item = &'static str> {
    PROVIDERS
        .iter()
        .filter(|entry| entry.chat)
        .map(|entry| entry.id)
}

/// 该提供方是否为对话类（决定能否设为默认）。
pub(crate) fn is_chat(id: &str) -> bool {
    find(id).is_some_and(|entry| entry.chat)
}
