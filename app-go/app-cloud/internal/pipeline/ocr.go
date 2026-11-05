package pipeline

// Vision OCR — images, screenshots and image-only (scanned) PDFs are read by a
// vision model through the same OpenAI-compatible gateway as embedding and
// summary. This file owns the gateway call, its retry policy and the error
// taxonomy that lets the orchestrator distinguish "permanently unsupported"
// (no OCR configured, unusable media, nothing readable) from "temporarily
// failed" (gateway/timeout) — only the latter is worth retrying.
//
// Pure gateway adapter: no orchestration, no Mongo, no Milvus.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"app-cloud/internal/circuit"
	"app-cloud/internal/config"
)

// Permanent OCR outcomes. Every one of these means "the same file will never
// produce text on a retry", so the orchestrator maps them to
// vector_status=not_supported instead of failed.
var (
	// ErrOCRDisabled — OCR is switched off or the gateway is not configured.
	ErrOCRDisabled = errors.New("OCR 未启用或未配置")
	// ErrOCRUnsupportedImage — the media cannot be sent to the vision model.
	ErrOCRUnsupportedImage = errors.New("图片格式不支持 OCR")
	// ErrOCRNoContent — OCR ran but the images contained no readable text.
	ErrOCRNoContent = errors.New("图片中未识别到文字")
	// ErrImageTooLarge — one image exceeds the configured byte limit.
	ErrImageTooLarge = errors.New("图片超过 OCR 大小限制")
)

// ocrPrompt is the instruction sent with every image. The output is plain
// text in reading order so it can be chunked and embedded directly.
const ocrPrompt = "请提取图片中的全部文字内容，按原始阅读顺序输出，不要添加解释"

// ocrMaxAttempts = the first call plus up to two retries. Only transient
// failures (transport, 429, 5xx, auth/route blips, unparsable completion) are
// retried; unusable media and HTTP 4xx class errors fail immediately.
const ocrMaxAttempts = 3

// OCRImage is one image handed to the vision model.
type OCRImage struct {
	Data     []byte
	MimeType string
}

// OCRClient calls the gateway's OpenAI-compatible /chat/completions with an
// image data URL part. Guarded by a circuit breaker so a dead gateway fails
// fast instead of burning every worker on timeouts.
type OCRClient struct {
	cfg    config.OCRConfig
	base   string
	apiKey string
	client *http.Client
	br     *circuit.Breaker
}

// NewOCRClient builds the OCR caller from the shared Higress connection
// (embedding base URL + gateway key). OCR has no separate provider credentials.
func NewOCRClient(cfg config.OCRConfig, emb config.EmbeddingConfig) *OCRClient {
	timeout := time.Duration(cfg.TimeoutSecs) * time.Second
	if timeout <= 0 {
		timeout = time.Duration(config.DefaultOCRTimeoutSecs) * time.Second
	}
	return &OCRClient{
		cfg:    cfg,
		base:   strings.TrimRight(strings.TrimSpace(emb.BaseURL), "/"),
		apiKey: strings.TrimSpace(emb.APIKey),
		client: &http.Client{
			Timeout:   timeout,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		},
		br: circuit.New(5, 30*time.Second),
	}
}

// Enabled reports whether OCR should run at all: the stage must be on, a model
// configured, and the resolved gateway connection complete. A nil client is
// not enabled.
func (o *OCRClient) Enabled() bool {
	return o != nil && o.cfg.Enabled && strings.TrimSpace(o.cfg.Model) != "" &&
		o.base != "" && o.apiKey != ""
}

// ModelName extends the resolved model name for logging/attribution.
func (o *OCRClient) ModelName() string {
	if o == nil {
		return ""
	}
	return o.cfg.Model
}

// MaxImageBytes is the per-image byte limit (0 when unset).
func (o *OCRClient) MaxImageBytes() int64 {
	if o == nil {
		return 0
	}
	return o.cfg.MaxImageBytes
}

// MaxPDFPages bounds how many pages of a scanned PDF are inspected.
func (o *OCRClient) MaxPDFPages() int {
	if o == nil {
		return 0
	}
	return o.cfg.MaxPDFPages
}

// MaxImages bounds how many embedded images of a scanned PDF are OCR'd.
func (o *OCRClient) MaxImages() int {
	if o == nil {
		return 0
	}
	return o.cfg.MaxImages
}

// Recognize runs OCR for one image and returns the extracted text.
func (o *OCRClient) Recognize(ctx context.Context, img OCRImage) (string, error) {
	if !o.Enabled() {
		return "", ErrOCRDisabled
	}
	if len(img.Data) == 0 {
		return "", ErrOCRNoContent
	}
	if max := o.MaxImageBytes(); max > 0 && int64(len(img.Data)) > max {
		return "", fmt.Errorf("%w: %d bytes > limit %d", ErrImageTooLarge, len(img.Data), max)
	}
	mime := NormalizeImageMime(img.MimeType, img.Data)
	if mime == "" {
		return "", fmt.Errorf("%w: %q", ErrOCRUnsupportedImage, img.MimeType)
	}
	if !o.br.Allow() {
		// Downstream trip: fail fast — the durable outbox retries later.
		return "", fmt.Errorf("%w: OCR 网关", circuit.ErrOpen)
	}

	var lastErr error
	emptyOnly := true
	for attempt := 1; attempt <= ocrMaxAttempts; attempt++ {
		text, status, err := o.once(ctx, mime, img.Data)
		if err == nil && strings.TrimSpace(text) == "" {
			// A completion without text is model behaviour, not a dead
			// gateway: retryable but breaker-neutral.
			err = errEmptyOCRCompletion
			status = -1
		}
		if err == nil {
			o.br.OnSuccess()
			return strings.TrimSpace(text), nil
		}
		lastErr = err
		if !errors.Is(err, errEmptyOCRCompletion) {
			emptyOnly = false
		}
		permanent := o.classifyPermanent(err, status)
		if !permanent {
			o.br.OnFailure()
		}
		if permanent {
			return "", o.permanentError(err, status)
		}
		if attempt == ocrMaxAttempts {
			if emptyOnly {
				// Nothing readable on every attempt — a permanent verdict,
				// not a transient model hiccup.
				return "", fmt.Errorf("%w: %v", ErrOCRNoContent, lastErr)
			}
			return "", lastErr
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
		}
	}
	return "", lastErr
}

// classifyPermanent maps a failed attempt to the permanent taxonomy. status 0
// = transport failure; -1 = completion body without usable text; HTTP status
// otherwise.
func (o *OCRClient) classifyPermanent(err error, status int) bool {
	if errors.Is(err, ErrOCRUnsupportedImage) || errors.Is(err, ErrImageTooLarge) {
		return true
	}
	switch status {
	case http.StatusBadRequest, http.StatusUnsupportedMediaType, http.StatusUnprocessableEntity:
		return true
	case http.StatusRequestEntityTooLarge:
		return true
	default:
		return false
	}
}

// errEmptyOCRCompletion marks a successful HTTP response whose completion had
// no text. Retryable, but a permanent no-content verdict once retries run out.
var errEmptyOCRCompletion = errors.New("OCR 返回空内容")

// permanentError decorates a permanent gateway rejection with the taxonomy
// sentinel the orchestrator maps to vector_status=not_supported.
func (o *OCRClient) permanentError(err error, status int) error {
	if status == http.StatusRequestEntityTooLarge {
		return fmt.Errorf("%w: %v", ErrImageTooLarge, err)
	}
	return fmt.Errorf("%w: %v", ErrOCRUnsupportedImage, err)
}

type ocrContentPart struct {
	Type  string `json:"type"`
	Text  string `json:"text,omitempty"`
	Image *struct {
		URL string `json:"url"`
	} `json:"image_url,omitempty"`
}

type ocrChatRequest struct {
	Model       string           `json:"model"`
	Messages    []ocrChatMessage `json:"messages"`
	Temperature float64          `json:"temperature"`
}

type ocrChatMessage struct {
	Role    string           `json:"role"`
	Content []ocrContentPart `json:"content"`
}

type ocrChatResponse struct {
	Choices []struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// once performs a single gateway call. status 0 = transport error, -1 reserved
// for a response we could not read (handled by the caller).
func (o *OCRClient) once(ctx context.Context, mime string, data []byte) (string, int, error) {
	dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
	reqBody := ocrChatRequest{
		Model: o.cfg.Model,
		Messages: []ocrChatMessage{{
			Role: "user",
			Content: []ocrContentPart{
				{Type: "text", Text: ocrPrompt},
				{Type: "image_url", Image: &struct {
					URL string `json:"url"`
				}{URL: dataURL}},
			},
		}},
		Temperature: 0,
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.base+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("OCR 传输失败: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return "", resp.StatusCode, err
	}
	if resp.StatusCode != http.StatusOK {
		return "", resp.StatusCode, fmt.Errorf("OCR http %d: %.200s", resp.StatusCode, string(body))
	}
	var out ocrChatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return "", -1, fmt.Errorf("OCR 响应解析失败: %w", err)
	}
	if out.Error != nil && strings.TrimSpace(out.Error.Message) != "" {
		return "", -1, fmt.Errorf("OCR 网关错误: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return "", -1, errors.New("OCR 响应缺少 choices")
	}
	return ocrMessageText(out.Choices[0].Message.Content), resp.StatusCode, nil
}

// ocrMessageText accepts both completion shapes seen from OpenAI-compatible
// gateways: a plain string, or an array of content parts carrying "text".
func ocrMessageText(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(trimmed, &parts); err != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Text != "" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// imageMimeByExt maps the supported image extensions to their MIME type.
var imageMimeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".gif":  "image/gif",
}

// ocrSupportedMime lists media the vision gateway accepts. TIFF/JP2 are
// deliberately absent: the gateway rejects them, so they stay unsupported
// instead of burning retries.
var ocrSupportedMime = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/bmp":  true,
	"image/gif":  true,
}

// imageExt returns the lowercase extension with the leading dot ("" when the
// name has none).
func imageExt(name string) string {
	i := strings.LastIndex(name, ".")
	if i < 0 || i == len(name)-1 {
		return ""
	}
	ext := strings.ToLower(name[i:])
	if strings.ContainsAny(ext, "/\\ ") {
		return ""
	}
	return ext
}

// IsImageFile reports whether the file should go through the image OCR path:
// an image/* MIME or one of the supported image extensions.
func IsImageFile(mimeType, filename string) bool {
	m := strings.ToLower(strings.TrimSpace(mimeType))
	if strings.HasPrefix(m, "image/") {
		return true
	}
	_, ok := imageMimeByExt[imageExt(filename)]
	return ok
}

// isVideoMime reports whether the file is a video (text comes from ASR).
func isVideoMime(mimeType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(mimeType)), "video/")
}

// isPDFFile reports whether the file is a PDF (declared type or extension).
func isPDFFile(mimeType, filename string) bool {
	m := strings.ToLower(strings.TrimSpace(mimeType))
	return m == "application/pdf" || imageExt(strings.ToLower(filename)) == ".pdf"
}

// NormalizeImageMime returns the MIME type to send to the gateway, preferring
// a usable declared type and falling back to extension / content sniffing.
// Empty result = the media is not OCR-able.
func NormalizeImageMime(mimeType string, data []byte) string {
	m := strings.ToLower(strings.TrimSpace(mimeType))
	if i := strings.Index(m, ";"); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	if ocrSupportedMime[m] {
		return m
	}
	if len(data) > 0 {
		sniffed := strings.ToLower(http.DetectContentType(data))
		if i := strings.Index(sniffed, ";"); i >= 0 {
			sniffed = strings.TrimSpace(sniffed[:i])
		}
		if ocrSupportedMime[sniffed] {
			return sniffed
		}
	}
	return ""
}

// IsPermanentOCRError reports whether an OCR failure means "a retry cannot
// help" — those map to vector_status=not_supported instead of failed.
func IsPermanentOCRError(err error) bool {
	return errors.Is(err, ErrOCRDisabled) || errors.Is(err, ErrOCRUnsupportedImage) ||
		errors.Is(err, ErrOCRNoContent) || errors.Is(err, ErrImageTooLarge)
}

// ocrResultLabel buckets an OCR error for the metrics counter.
func ocrResultLabel(err error) string {
	if IsPermanentOCRError(err) {
		return "unsupported"
	}
	return "error"
}

// PDFImageMime maps pdfcpu's file-type labels to MIME types; "" means the
// extracted image cannot be sent to the vision model.
func PDFImageMime(fileType string) string {
	switch strings.ToLower(strings.TrimSpace(fileType)) {
	case "jpg", "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	default:
		return ""
	}
}
