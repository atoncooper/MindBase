// DashScope ASR via the Higress gateway's native passthrough — port of the
// RESTful path in app/services/asr.py (offline async Transcription only;
// the realtime Recognition WebSocket protocol is deliberately not ported in
// v1, so short audio also goes through Transcription for uniformity).
//
// Endpoint derivation (parity with providers.gateway_native_base_urls):
//
//	root = ai_gateway.base_url minus "/v1"
//	http = root + "/api/v1"   (services / tasks / uploads)
package asr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"app-bili/internal/config"
)

type Transcriber struct {
	cfg      *config.Config
	http     *http.Client
	policyMu sync.Mutex
	policy   map[string]map[string]any // reusable upload certificate (per model)
}

func NewTranscriber(cfg *config.Config) *Transcriber {
	return &Transcriber{
		cfg:  cfg,
		http: &http.Client{Timeout: 60 * time.Second},
	}
}

// httpBase derives the gateway-native HTTP base from the OpenAI-style base.
// 幂等修复：BaseURL 为空时回退默认 —— 旧实现回退值已含 /api/v1 却又无条件
// 再拼一次，产生 /api/v1/api/v1（404），所有 DashScope 调用（转写提交/任务
// 轮询/上传策略）全部失败 → 转写永远为空。
func (t *Transcriber) httpBase() string {
	base := strings.TrimRight(strings.TrimSpace(t.cfg.ASR.BaseURL), "/")
	if base == "" {
		return "https://dashscope.aliyuncs.com/api/v1"
	}
	if strings.HasSuffix(base, "/api/v1") {
		return base
	}
	return strings.TrimSuffix(base, "/v1") + "/api/v1"
}

func (t *Transcriber) do(ctx context.Context, method, url string, body io.Reader, contentType string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.cfg.ASR.APIKey)
	req.Header.Set("User-Agent", "mindbase-app-bili/1.0")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := t.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("dashscope %s: HTTP %d: %s", url, resp.StatusCode, truncate(string(data), 300))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// UploadLocal uploads a local file to DashScope's temporary OSS and returns
// the oss:// URL (parity with OssUtils.upload). The certificate is reused.
func (t *Transcriber) UploadLocal(ctx context.Context, model, filePath string) (string, error) {
	t.policyMu.Lock()
	cert := t.policy[model]
	t.policyMu.Unlock()

	if cert == nil {
		q := fmt.Sprintf("%s/uploads?action=getPolicy&model=%s", t.httpBase(), model)
		var payload struct {
			Output map[string]any `json:"output"`
		}
		if err := t.do(ctx, http.MethodGet, q, nil, "", &payload); err != nil {
			return "", fmt.Errorf("get upload policy: %w", err)
		}
		if payload.Output == nil {
			return "", fmt.Errorf("upload policy empty")
		}
		cert = payload.Output
		t.policyMu.Lock()
		t.policy[model] = cert
		t.policyMu.Unlock()
	}

	getStr := func(k string) string {
		v, _ := cert[k].(string)
		return v
	}
	uploadHost := getStr("upload_host")
	uploadDir := getStr("upload_dir")
	if uploadHost == "" || uploadDir == "" {
		return "", fmt.Errorf("upload policy missing host/dir")
	}

	key := uploadDir + "/" + filepath.Base(filePath)
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for field, value := range map[string]string{
		"OSSAccessKeyId":         getStr("oss_access_key_id"),
		"Signature":              getStr("signature"),
		"policy":                 getStr("policy"),
		"key":                    key,
		"x-oss-object-acl":       getStr("x_oss_object_acl"),
		"x-oss-forbid-overwrite": getStr("x_oss_forbid_overwrite"),
		"success_action_status":  "200",
	} {
		_ = w.WriteField(field, value)
	}
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	part, err := w.CreateFormFile("file", filepath.Base(filePath))
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, f); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadHost, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	resp, err := t.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return "", fmt.Errorf("oss upload: HTTP %d: %s", resp.StatusCode, truncate(string(data), 300))
	}
	return "oss://" + key, nil
}

// TranscribeURL submits an offline async transcription task and polls it to
// completion. url may be a public https URL or an oss:// URL.
func (t *Transcriber) TranscribeURL(ctx context.Context, audioURL string) (string, error) {
	model := t.cfg.ASR.TranscribeModel
	payload := map[string]any{
		"model": model,
		"input": map[string]any{"file_urls": []string{audioURL}},
	}
	if strings.Contains(model, "paraformer") {
		payload["parameters"] = map[string]any{"language_hints": []string{"zh", "en"}}
	}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		t.httpBase()+"/services/audio/asr/transcription", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+t.cfg.ASR.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-DashScope-Async", "enable")
	resp, err := t.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("submit transcription: HTTP %d: %s", resp.StatusCode, truncate(string(data), 300))
	}
	var submitted struct {
		TaskID string `json:"task_id"`
		Output struct {
			TaskID string `json:"task_id"`
		} `json:"output"`
	}
	if err := json.Unmarshal(data, &submitted); err != nil {
		return "", err
	}
	taskID := submitted.TaskID
	if taskID == "" {
		taskID = submitted.Output.TaskID
	}
	if taskID == "" {
		return "", fmt.Errorf("transcription submit returned no task_id")
	}

	// Poll.
	interval := time.Duration(t.cfg.ASR.PollIntervalMS) * time.Millisecond
	if interval <= 0 {
		interval = 1500 * time.Millisecond
	}
	timeout := time.Duration(t.cfg.ASR.TranscribeTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 600 * time.Second
	}
	deadline := time.Now().Add(timeout)
	var output map[string]any
	for {
		if time.Now().After(deadline) {
			return "", fmt.Errorf("transcription task %s timed out", taskID)
		}
		var envelope struct {
			Output map[string]any `json:"output"`
		}
		if err := t.do(ctx, http.MethodGet, t.httpBase()+"/tasks/"+taskID, nil, "", &envelope); err == nil && envelope.Output != nil {
			output = envelope.Output
		}
		if output != nil {
			switch status, _ := output["task_status"].(string); status {
			case "SUCCEEDED", "FAILED":
				goto done
			}
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
done:
	if status, _ := output["task_status"].(string); status == "FAILED" {
		msg, _ := output["status_message"].(string)
		return "", fmt.Errorf("transcription task %s failed: %s", taskID, msg)
	}
	results, _ := output["results"].([]any)
	for _, r := range results {
		item, _ := r.(map[string]any)
		sub, _ := item["subtask_status"].(string)
		turl, _ := item["transcription_url"].(string)
		if sub == "SUCCEEDED" && turl != "" {
			return t.downloadTranscription(ctx, turl)
		}
	}
	return "", fmt.Errorf("transcription task %s returned no valid result", taskID)
}

// downloadTranscription fetches the result JSON and joins the transcripts.
func (t *Transcriber) downloadTranscription(ctx context.Context, resultURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resultURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := t.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return "", err
	}
	var payload struct {
		Transcripts []struct {
			Text      string `json:"text"`
			Sentences []struct {
				Text string `json:"text"`
			} `json:"sentences"`
		} `json:"transcripts"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", err
	}
	var b strings.Builder
	for i, tr := range payload.Transcripts {
		if i > 0 {
			b.WriteByte('\n')
		}
		if tr.Text != "" {
			b.WriteString(tr.Text)
			continue
		}
		for j, s := range tr.Sentences {
			if j > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(s.Text)
		}
	}
	return b.String(), nil
}

// TranscribeLocal routes a local file: upload → TranscribeURL. Long-audio
// chunking lives in the service layer (needs ffmpeg + concurrency config).
func (t *Transcriber) TranscribeLocal(ctx context.Context, filePath string) (string, error) {
	ossURL, err := t.UploadLocal(ctx, t.cfg.ASR.TranscribeModel, filePath)
	if err != nil {
		return "", err
	}
	return t.TranscribeURL(ctx, ossURL)
}

// ProbeAudioURL checks whether DashScope can realistically fetch the URL:
// HEAD first, then a 1-byte Range GET (parity with content_fetcher probing).
func ProbeAudioURL(ctx context.Context, client *http.Client, audioURL string) bool {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, audioURL, nil)
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 400 {
			return true
		}
	}
	req, _ = http.NewRequestWithContext(ctx, http.MethodGet, audioURL, nil)
	req.Header.Set("Range", "bytes=0-0")
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent
	}
	return false
}
