// Package handlers defines the MCP tool surface: a thin mapping from
// agent-facing tools onto the upstream app-quiz client. Business failures are
// reported as tool-level errors (CallToolResult isError) so the agent can
// read and react to them; transport/panics bubble up as handler errors.
//
// Tool surface (2): save_quiz / save_grading — same names, parameters and
// result wording as the former in-process app-ts quiz tools, so the quiz
// agent's prompt contract is unchanged. The quiz agent authors questions and
// gradings; this server is their only persistence path (the agent never
// touches the quiz tables directly).
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"time"

	"app-quiz-mcp/internal/config"
	"app-quiz-mcp/internal/identity"
	"app-quiz-mcp/internal/logger"
	"app-quiz-mcp/internal/upstream"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Tools wires the upstream client into MCP tool handlers.
type Registry struct {
	client *upstream.Client
	cfg    *config.Config
}

func New(client *upstream.Client, cfg *config.Config) *Registry {
	return &Registry{client: client, cfg: cfg}
}

// Register defines all tools on the MCP server. Every handler goes through
// wrap(), which owns request-id scoping, panic recovery and the per-call log.
func (t *Registry) Register(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("save_quiz",
		mcp.WithDescription("提交生成的整套题目（结构化）。出题完成时必须调用本工具提交，不要用纯文本输出题目。题目会持久化到用户的测验历史。"),
		mcp.WithString("topic", mcp.Required(), mcp.Description("题目主题（最长 200 字符）")),
		mcp.WithArray("questions", mcp.Required(),
			mcp.Description("题目列表，3-8 题为宜，每题含 question/options/answer/explanation"),
			mcp.Items(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"question":    map[string]any{"type": "string", "description": "题干"},
					"options":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "选择题选项；问答/填空题省略"},
					"answer":      map[string]any{"type": "string", "description": "标准答案"},
					"explanation": map[string]any{"type": "string", "description": "答案解析"},
				},
				"required": []string{"question", "answer", "explanation"},
			})),
	), t.wrap("save_quiz", t.saveQuiz))

	s.AddTool(mcp.NewTool("save_grading",
		mcp.WithDescription("提交批改结果（结构化）。批改完成时必须调用本工具提交，批改记录会进入用户的测验历史。"),
		mcp.WithString("quiz_id", mcp.Description("被批改的 quiz_id（若有）")),
		mcp.WithNumber("score", mcp.Required(), mcp.Description("总分 0-100")),
		mcp.WithNumber("total", mcp.Required(), mcp.Description("题目总数")),
		mcp.WithArray("per_question", mcp.Required(),
			mcp.Description("逐题判定列表"),
			mcp.Items(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"index":    map[string]any{"type": "integer", "description": "题号（0 起）"},
					"verdict":  map[string]any{"type": "string", "enum": []string{"correct", "wrong", "partial"}, "description": "判定"},
					"feedback": map[string]any{"type": "string", "description": "该题讲评"},
				},
				"required": []string{"index", "verdict", "feedback"},
			})),
	), t.wrap("save_grading", t.saveGrading))
}

// ── logging / recovery wrapper ──────────────────────────────────────

// wrap decorates one tool handler with the cross-cutting concerns:
//
//   - request id: reused from ctx when present (HTTP middleware); generated
//     per call otherwise (stdio). The id flows into every log line here AND
//     into the upstream X-Request-Id, so one agent action is one trace.
//   - panic recovery: logged with stack, converted to a tool error result.
//   - one structured log line per call: safe args only (ids/flags/sizes,
//     never question text, answers or feedback) + outcome + duration.
func (t *Registry) wrap(name string, h server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (res *mcp.CallToolResult, err error) {
		start := time.Now()
		if logger.FromContext(ctx) == logger.DefaultRequestID {
			ctx = logger.IntoContext(ctx, uuid.NewString())
		}

		defer func() {
			if rec := recover(); rec != nil {
				slog.ErrorContext(ctx, "[QUIZMCP] tool panicked",
					"module", "tool", "tool", name, "panic", rec,
					"stack", string(debug.Stack()))
				res, err = nil, fmt.Errorf("internal panic in tool %s", name)
			}
		}()

		res, err = h(ctx, req)
		attrs := append(safeArgs(req),
			slog.String("module", "tool"),
			slog.String("tool", name),
			slog.Duration("elapsed", time.Since(start)))

		switch {
		case err != nil:
			attrs = append(attrs, slog.String("err", err.Error()))
			slog.LogAttrs(ctx, slog.LevelError, "[QUIZMCP] tool handler failed", attrs...)
		case res != nil && res.IsError:
			attrs = append(attrs, slog.String("err", truncateRunes(firstText(res), 300)))
			slog.LogAttrs(ctx, slog.LevelWarn, "[QUIZMCP] tool call failed", attrs...)
		default:
			slog.LogAttrs(ctx, slog.LevelInfo, "[QUIZMCP] tool call", attrs...)
		}
		return res, err
	}
}

// safeArgs extracts loggable arguments: identifiers, flags and sizes only —
// never the question text, answers or feedback (user data).
func safeArgs(req mcp.CallToolRequest) []slog.Attr {
	args := req.GetArguments()
	attrs := make([]slog.Attr, 0, 6)
	if v, ok := args["quiz_id"].(string); ok {
		attrs = append(attrs, slog.String("quiz_id", v))
	}
	if v, ok := args["topic"].(string); ok {
		attrs = append(attrs, slog.Int("topic_len", len([]rune(v))))
	}
	if v, ok := args["score"].(float64); ok {
		attrs = append(attrs, slog.Int("score", int(v)))
	}
	if v, ok := args["total"].(float64); ok {
		attrs = append(attrs, slog.Int("total", int(v)))
	}
	for _, k := range []string{"questions", "per_question"} {
		if arr, ok := args[k].([]any); ok {
			attrs = append(attrs, slog.Int(k+"_count", len(arr)))
		}
	}
	return attrs
}

// firstText returns the first text block of a tool result ("" when absent).
func firstText(res *mcp.CallToolResult) string {
	if res == nil {
		return ""
	}
	for _, c := range res.Content {
		if tc, ok := c.(mcp.TextContent); ok {
			return tc.Text
		}
	}
	return ""
}

func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// ── handlers ────────────────────────────────────────────────────────

func (t *Registry) notConfigured(ctx context.Context) string {
	if !t.cfg.APIKeySet() {
		return "测验服务未配置上游凭证（QUIZMCP__UPSTREAM__API_KEY），无法执行操作"
	}
	if _, ok := identity.FromContext(ctx); !ok && !t.cfg.UIDSet() {
		return "测验服务未配置用户身份（QUIZMCP__UPSTREAM__UID 或服务模式 X-Uid），无法执行操作"
	}
	return ""
}

type questionInput struct {
	Question    string   `json:"question"`
	Options     []string `json:"options"`
	Answer      string   `json:"answer"`
	Explanation string   `json:"explanation"`
}

type verdictInput struct {
	Index    int    `json:"index"`
	Verdict  string `json:"verdict"`
	Feedback string `json:"feedback"`
}

// decodeArray pulls a JSON-encoded array argument out of the tool arguments
// (mcp-go delivers object/array arguments as []any; strings are tolerated).
func decodeArray(req mcp.CallToolRequest, key string, out any) error {
	raw, ok := req.GetArguments()[key]
	if !ok {
		return fmt.Errorf("缺少 %s", key)
	}
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), out); err != nil {
			return fmt.Errorf("%s 格式错误: %v", key, err)
		}
	case []any:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Errorf("%s 格式错误: %v", key, err)
		}
		if err := json.Unmarshal(b, out); err != nil {
			return fmt.Errorf("%s 格式错误: %v", key, err)
		}
	default:
		return fmt.Errorf("%s 类型错误", key)
	}
	return nil
}

func (t *Registry) saveQuiz(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return errorResult(msg), nil
	}
	topic := strings.TrimSpace(req.GetString("topic", ""))
	if topic == "" {
		return errorResult("缺少 topic：请提供题目主题"), nil
	}
	if len([]rune(topic)) > 200 {
		return errorResult("topic 过长（上限 200 字符）"), nil
	}
	var questions []questionInput
	if err := decodeArray(req, "questions", &questions); err != nil {
		return errorResult(err.Error()), nil
	}
	if len(questions) == 0 || len(questions) > 20 {
		return errorResult("questions 数量须在 1-20 之间"), nil
	}
	for i, q := range questions {
		if strings.TrimSpace(q.Question) == "" || strings.TrimSpace(q.Answer) == "" || strings.TrimSpace(q.Explanation) == "" {
			return errorResult(fmt.Sprintf("第 %d 题缺少题干/答案/解析", i+1)), nil
		}
	}

	quizUUID, err := t.client.CreateQuiz(ctx, upstream.CreateQuizBody{
		UID:       t.actingUID(ctx),
		Title:     topic,
		Questions: toAgentQuestions(questions),
	})
	if err != nil {
		return errorResult(upstreamErr("保存失败", err)), nil
	}
	return textResult(fmt.Sprintf("已生成 %d 道关于「%s」的题目（quiz_id=%s），已提交。向用户报告题数与主题即可，正文已随 artifact 下发。", len(questions), topic, quizUUID)), nil
}

func (t *Registry) saveGrading(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if msg := t.notConfigured(ctx); msg != "" {
		return errorResult(msg), nil
	}
	quizID := strings.TrimSpace(req.GetString("quiz_id", ""))
	score := int(req.GetFloat("score", 0))
	total := int(req.GetFloat("total", 0))
	if score < 0 || score > 100 {
		return errorResult("score 须在 0-100"), nil
	}
	if total <= 0 {
		return errorResult("total 必须为正"), nil
	}
	var perQuestion []verdictInput
	if err := decodeArray(req, "per_question", &perQuestion); err != nil {
		return errorResult(err.Error()), nil
	}
	if len(perQuestion) == 0 {
		return errorResult("per_question 不能为空"), nil
	}
	for _, v := range perQuestion {
		if v.Verdict != "correct" && v.Verdict != "wrong" && v.Verdict != "partial" {
			return errorResult(fmt.Sprintf("无效的判定 %q：只能是 correct/wrong/partial", v.Verdict)), nil
		}
	}

	submissionUUID, err := t.client.SaveGrading(ctx, upstream.CreateGradingBody{
		UID:         t.actingUID(ctx),
		QuizUUID:    quizID,
		Score:       score,
		Total:       total,
		PerQuestion: toAgentVerdicts(perQuestion),
	})
	if err != nil {
		return errorResult(upstreamErr("提交失败", err)), nil
	}
	return textResult(fmt.Sprintf("批改已提交：总分 %d/100（%d/%d 题已评，grading_id=%s）。向用户总结得分与主要失分点。", score, len(perQuestion), total, submissionUUID)), nil
}

func toAgentQuestions(inputs []questionInput) []upstream.AgentQuestion {
	out := make([]upstream.AgentQuestion, len(inputs))
	for i, q := range inputs {
		out[i] = upstream.AgentQuestion{Question: q.Question, Options: q.Options, Answer: q.Answer, Explanation: q.Explanation}
	}
	return out
}

func toAgentVerdicts(inputs []verdictInput) []upstream.AgentVerdict {
	out := make([]upstream.AgentVerdict, len(inputs))
	for i, v := range inputs {
		out[i] = upstream.AgentVerdict{Index: v.Index, Verdict: v.Verdict, Feedback: v.Feedback}
	}
	return out
}

// actingUID resolves the quiz owner for one call: the identity context
// (service mode) wins, else the configured default (bearer clients).
func (t *Registry) actingUID(ctx context.Context) int64 {
	if uid, ok := identity.FromContext(ctx); ok {
		return uid
	}
	return t.cfg.Upstream.UID
}

// upstreamErr renders an upstream failure for the agent: app-quiz's own
// detail (e.g. validation messages) is passed through; 404 keeps the
// no-existence-leak semantics.
func upstreamErr(verb string, err error) string {
	var apiErr *upstream.APIError
	if errors.As(err, &apiErr) {
		switch {
		case apiErr.Status == 404:
			return verb + "：目标不存在或不可访问"
		case apiErr.Status == 401 || apiErr.Status == 403:
			return verb + "：服务鉴权失败，请检查网关凭证配置"
		case apiErr.Status >= 500:
			return verb + "：测验服务暂不可用，请稍后重试"
		default:
			if apiErr.Detail != "" {
				return fmt.Sprintf("%s：%s", verb, apiErr.Detail)
			}
		}
	}
	return fmt.Sprintf("%s：%v", verb, err)
}

func errorResult(msg string) *mcp.CallToolResult {
	return mcp.NewToolResultError(msg)
}

func textResult(msg string) *mcp.CallToolResult {
	return mcp.NewToolResultText(msg)
}
