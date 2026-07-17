package handler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backend/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type V1Handler struct {
	v1 *service.V1Service
}

func NewV1Handler(v1 *service.V1Service) *V1Handler {
	return &V1Handler{v1: v1}
}

func (h *V1Handler) Models(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}
	_ = principal

	items, err := h.v1.ListModels(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to load models"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"object": "list",
		"data":   items,
	})
}

// ImageGenerations — OpenAI POST /v1/images/generations (text-to-image only).
// Accepts exactly OpenAI's fields; size→aspect ratio and quality→resolution tier
// are mapped server-side. Returns {created, data:[{b64_json}]}.
func (h *V1Handler) ImageGenerations(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}

	var body struct {
		Model          string `json:"model"`
		Prompt         string `json:"prompt"`
		N              int    `json:"n"`
		Size           string `json:"size"`
		Quality        string `json:"quality"`
		ResponseFormat string `json:"response_format"`
		Background     string `json:"background"`
		OutputFormat   string `json:"output_format"`
		User           string `json:"user"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request body"})
		return
	}

	resp, err := h.v1.PrepareImageRequest(c.Request.Context(), principal, service.V1ImageRequest{
		Model:          body.Model,
		Prompt:         body.Prompt,
		N:              body.N,
		Size:           body.Size,
		Quality:        body.Quality,
		ResponseFormat: body.ResponseFormat,
		BaseURL:        requestBaseURL(c),
	})
	if err != nil {
		h.writeV1Error(c, err, resp)
		return
	}
	c.JSON(http.StatusOK, openaiImageResponse(resp))
}

type chatCompletionRequest struct {
	Model      string        `json:"model"`
	Prompt     string        `json:"prompt"`
	Messages   []chatMessage `json:"messages"`
	Modalities []string      `json:"modalities"`
	N          int           `json:"n"`
	Size       string        `json:"size"`
	Quality    string        `json:"quality"`
	Stream     bool          `json:"stream"`
}

type chatMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// ChatCompletions preserves the legacy image-via-chat contract used by older
// mobile clients. image2api does not provide general text chat through this
// route; the selected model must resolve to an enabled image model.
func (h *V1Handler) ChatCompletions(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}

	var body chatCompletionRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request body"})
		return
	}
	prompt, refs := chatImageInputs(body)
	if prompt == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "messages or prompt is required"})
		return
	}
	if strings.TrimSpace(body.Model) == "" {
		body.Model = "gpt-image-2"
	}
	if body.N == 0 {
		body.N = 1
	}
	if body.N < 1 || body.N > 4 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "n must be between 1 and 4"})
		return
	}

	request := service.V1ImageRequest{
		Model:           body.Model,
		Prompt:          prompt,
		N:               body.N,
		Size:            body.Size,
		Quality:         body.Quality,
		ResponseFormat:  "b64_json",
		ReferenceImages: refs,
		BaseURL:         requestBaseURL(c),
	}
	if !body.Stream {
		resp, genErr := h.v1.PrepareImageRequest(c.Request.Context(), principal, request)
		if genErr != nil {
			h.writeV1Error(c, genErr, resp)
			return
		}
		c.JSON(http.StatusOK, chatCompletionResponse(body.Model, chatImageMarkdown(resp)))
		return
	}

	h.streamChatImage(c, principal, request)
}

type chatImageResult struct {
	response map[string]any
	err      error
}

func (h *V1Handler) streamChatImage(c *gin.Context, principal *service.APIPrincipal, request service.V1ImageRequest) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Status(http.StatusOK)

	id := "chatcmpl-" + uuid.NewString()
	created := time.Now().Unix()
	writeChatSSE(c, chatCompletionChunk(id, request.Model, created, gin.H{"role": "assistant", "content": ""}, nil))
	c.Writer.Flush()

	ctx := c.Request.Context()
	resultCh := make(chan chatImageResult, 1)
	go func() {
		resp, err := h.v1.PrepareImageRequest(ctx, principal, request)
		resultCh <- chatImageResult{response: resp, err: err}
	}()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = io.WriteString(c.Writer, ": keep-alive\n\n")
			c.Writer.Flush()
		case result := <-resultCh:
			if result.err != nil {
				writeChatSSE(c, gin.H{"error": gin.H{"message": result.err.Error(), "type": "image_generation_error"}})
			} else {
				writeChatSSE(c, chatCompletionChunk(id, request.Model, created, gin.H{"content": chatImageMarkdown(result.response)}, nil))
				finish := "stop"
				writeChatSSE(c, chatCompletionChunk(id, request.Model, created, gin.H{}, &finish))
			}
			_, _ = io.WriteString(c.Writer, "data: [DONE]\n\n")
			c.Writer.Flush()
			return
		}
	}
}

func writeChatSSE(c *gin.Context, value any) {
	payload, _ := json.Marshal(value)
	_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
}

func chatCompletionChunk(id, model string, created int64, delta gin.H, finish *string) gin.H {
	var finishReason any
	if finish != nil {
		finishReason = *finish
	}
	return gin.H{
		"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
		"choices": []gin.H{{"index": 0, "delta": delta, "finish_reason": finishReason}},
	}
}

func chatCompletionResponse(model, content string) gin.H {
	return gin.H{
		"id": "chatcmpl-" + uuid.NewString(), "object": "chat.completion",
		"created": time.Now().Unix(), "model": model,
		"choices": []gin.H{{
			"index": 0, "message": gin.H{"role": "assistant", "content": content}, "finish_reason": "stop",
		}},
		"usage": gin.H{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
	}
}

func chatImageInputs(body chatCompletionRequest) (string, []string) {
	prompts := make([]string, 0, len(body.Messages)+1)
	directPrompt := strings.TrimSpace(body.Prompt)
	if directPrompt != "" {
		prompt := directPrompt
		prompts = append(prompts, prompt)
	}
	refs := []string{}
	for _, message := range body.Messages {
		if !strings.EqualFold(strings.TrimSpace(message.Role), "user") {
			continue
		}
		var text string
		if json.Unmarshal(message.Content, &text) == nil {
			if text = strings.TrimSpace(text); directPrompt == "" && text != "" {
				prompts = append(prompts, text)
			}
			continue
		}
		var parts []map[string]any
		if json.Unmarshal(message.Content, &parts) != nil {
			continue
		}
		for _, part := range parts {
			typ := strings.ToLower(strings.TrimSpace(fmt.Sprint(part["type"])))
			switch typ {
			case "text", "input_text":
				text := strings.TrimSpace(firstString(part["text"], part["input_text"]))
				if directPrompt == "" && text != "" {
					prompts = append(prompts, text)
				}
			case "image_url", "input_image", "image":
				if ref := dataURLBase64(firstString(part["image_url"], part["url"], part["image"])); ref != "" {
					refs = append(refs, ref)
				}
			}
		}
	}
	return strings.Join(prompts, "\n"), refs
}

func firstString(values ...any) string {
	for _, value := range values {
		switch v := value.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return v
			}
		case map[string]any:
			if text := firstString(v["url"], v["image_url"], v["data"]); text != "" {
				return text
			}
		}
	}
	return ""
}

func dataURLBase64(value string) string {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "data:image/") {
		return ""
	}
	header, data, ok := strings.Cut(value, ",")
	if !ok || !strings.Contains(strings.ToLower(header), ";base64") {
		return ""
	}
	return strings.TrimSpace(data)
}

func chatImageMarkdown(response map[string]any) string {
	items := make([]map[string]any, 0, 1)
	switch data := response["data"].(type) {
	case []map[string]any:
		items = append(items, data...)
	case []any:
		for _, raw := range data {
			if item, ok := raw.(map[string]any); ok {
				items = append(items, item)
			}
		}
	}
	markdown := make([]string, 0, len(items))
	for i, item := range items {
		if b64 := strings.TrimSpace(fmt.Sprint(item["b64_json"])); b64 != "" && b64 != "<nil>" {
			markdown = append(markdown, fmt.Sprintf("![image_%d](data:image/png;base64,%s)", i+1, b64))
			continue
		}
		if url := strings.TrimSpace(fmt.Sprint(item["url"])); url != "" && url != "<nil>" {
			markdown = append(markdown, fmt.Sprintf("![image_%d](%s)", i+1, url))
		}
	}
	if len(markdown) == 0 {
		return "Image generation completed."
	}
	return strings.Join(markdown, "\n\n")
}

// ImageEdits — OpenAI POST /v1/images/edits (image-to-image). multipart/form-data
// only: image / image[] file uploads (+ optional mask), prompt, model, n, size,
// quality. Files become reference images. Returns {created, data:[{b64_json}]}.
func (h *V1Handler) ImageEdits(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}
	var request service.V1ImageRequest
	contentType := strings.ToLower(c.GetHeader("Content-Type"))
	if strings.HasPrefix(contentType, "application/json") {
		var body map[string]any
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid JSON body"})
			return
		}
		refs, refErr := jsonImageReferences(body)
		if refErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": refErr.Error()})
			return
		}
		request = service.V1ImageRequest{
			Model:           stringFromAny(body["model"]),
			Prompt:          stringFromAny(body["prompt"]),
			N:               intFromAny(body["n"]),
			Size:            stringFromAny(body["size"]),
			Quality:         stringFromAny(body["quality"]),
			ResponseFormat:  stringFromAny(body["response_format"]),
			ReferenceImages: refs,
			BaseURL:         requestBaseURL(c),
		}
	} else {
		if !strings.HasPrefix(contentType, "multipart/form-data") {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "images/edits requires multipart/form-data or application/json"})
			return
		}
		if err := c.Request.ParseMultipartForm(64 << 20); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid multipart form"})
			return
		}
		refs := readMultipartImages(c, "image", "image[]")
		request = service.V1ImageRequest{
			Model:           c.PostForm("model"),
			Prompt:          c.PostForm("prompt"),
			N:               intFromAny(c.PostForm("n")),
			Size:            c.PostForm("size"),
			Quality:         c.PostForm("quality"),
			ResponseFormat:  c.PostForm("response_format"),
			ReferenceImages: refs,
			BaseURL:         requestBaseURL(c),
		}
	}
	if len(request.ReferenceImages) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "images/edits requires at least one image"})
		return
	}
	if request.Model == "" || request.Model == "<nil>" {
		request.Model = "gpt-image-2"
	}
	resp, err := h.v1.PrepareImageRequest(c.Request.Context(), principal, request)
	if err != nil {
		h.writeV1Error(c, err, resp)
		return
	}
	c.JSON(http.StatusOK, openaiImageResponse(resp))
}

func intFromAny(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case json.Number:
		n, _ := strconv.Atoi(v.String())
		return n
	default:
		n, _ := strconv.Atoi(strings.TrimSpace(fmt.Sprint(value)))
		return n
	}
}

func stringFromAny(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func jsonImageReferences(body map[string]any) ([]string, error) {
	refs := []string{}
	for _, key := range []string{"images", "image", "image_url"} {
		if value, ok := body[key]; ok {
			if err := appendJSONImageReferences(&refs, value); err != nil {
				return nil, err
			}
		}
	}
	return refs, nil
}

func appendJSONImageReferences(out *[]string, value any) error {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return nil
		}
		if strings.HasPrefix(strings.ToLower(text), "data:image/") {
			encoded := dataURLBase64(text)
			if encoded == "" {
				return errors.New("invalid data image URL")
			}
			*out = append(*out, encoded)
			return nil
		}
		if strings.HasPrefix(strings.ToLower(text), "http://") || strings.HasPrefix(strings.ToLower(text), "https://") {
			return errors.New("remote image_url is not supported; use a data URL or base64")
		}
		*out = append(*out, text)
		return nil
	case []any:
		for _, item := range v {
			if err := appendJSONImageReferences(out, item); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		if source, ok := v["source"].(map[string]any); ok && strings.EqualFold(fmt.Sprint(source["type"]), "base64") {
			return appendJSONImageReferences(out, source["data"])
		}
		for _, key := range []string{"b64_json", "base64", "image_url", "url"} {
			if item, ok := v[key]; ok {
				return appendJSONImageReferences(out, item)
			}
		}
		return errors.New("image reference must include image_url, b64_json, or base64")
	default:
		return errors.New("invalid image reference")
	}
}

// CreateVideo — OpenAI POST /v1/videos. Creates an async job and returns the
// video object immediately ({id, status:"queued"}). Accepts JSON {model, prompt,
// seconds, size} or multipart (with an input_reference file). size→ratio+
// resolution, seconds→duration.
func (h *V1Handler) CreateVideo(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}
	var modelID, prompt, seconds, size string
	var refs []string
	if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/form-data") {
		if err := c.Request.ParseMultipartForm(64 << 20); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid multipart form"})
			return
		}
		modelID = c.PostForm("model")
		prompt = c.PostForm("prompt")
		seconds = c.PostForm("seconds")
		size = c.PostForm("size")
		refs = readMultipartImages(c, "input_reference", "input_reference[]")
	} else {
		var body struct {
			Model   string          `json:"model"`
			Prompt  string          `json:"prompt"`
			Seconds json.RawMessage `json:"seconds"`
			Size    string          `json:"size"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request body"})
			return
		}
		modelID, prompt, size = body.Model, body.Prompt, body.Size
		seconds = rawToString(body.Seconds)
	}
	duration := strings.TrimSpace(seconds)
	if duration != "" && !strings.HasSuffix(duration, "s") {
		duration += "s"
	}
	aspect, resolution := videoSizeToInternal(size)
	resp, err := h.v1.StartVideoJob(c.Request.Context(), principal, service.V1VideoRequest{
		Model:           modelID,
		Prompt:          prompt,
		Duration:        duration,
		AspectRatio:     aspect,
		Resolution:      resolution,
		ReferenceImages: refs,
		BaseURL:         requestBaseURL(c),
	})
	if err != nil {
		h.writeV1Error(c, err, nil)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// GetVideo — OpenAI GET /v1/videos/{id}. Returns the job status object.
func (h *V1Handler) GetVideo(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}
	resp, err := h.v1.VideoJob(c.Request.Context(), principal, c.Param("id"))
	if err != nil {
		h.writeV1Error(c, err, nil)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// GetVideoContent — OpenAI GET /v1/videos/{id}/content. Streams the rendered mp4
// by proxying the stored upstream URL (downloaded on demand, never persisted).
func (h *V1Handler) GetVideoContent(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}
	body, contentType, err := h.v1.OpenVideoContent(c.Request.Context(), principal, c.Param("id"))
	if err != nil {
		h.writeV1Error(c, err, nil)
		return
	}
	defer body.Close()
	c.Header("Content-Type", contentType)
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, body)
}

// GetImageContent — GET /v1/images/{id}/content. Streams a no-store image by
// proxying its stored (possibly auth-gated) upstream URL. Never persisted.
func (h *V1Handler) GetImageContent(c *gin.Context) {
	var principal *service.APIPrincipal
	if !h.v1.VerifyImageContentSignature(c.Param("id"), c.Query("exp"), c.Query("sig")) {
		var err error
		principal, err = h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
		if err != nil {
			h.writeAuthError(c, err)
			return
		}
	}
	body, contentType, err := h.v1.OpenImageContent(c.Request.Context(), principal, c.Param("id"))
	if err != nil {
		h.writeV1Error(c, err, nil)
		return
	}
	defer body.Close()
	c.Header("Content-Type", contentType)
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, body)
}

// readMultipartImages reads the given file fields and returns each as base64.
func readMultipartImages(c *gin.Context, keys ...string) []string {
	var out []string
	form := c.Request.MultipartForm
	if form == nil {
		return out
	}
	for _, key := range keys {
		for _, fh := range form.File[key] {
			f, e := fh.Open()
			if e != nil {
				continue
			}
			b, _ := io.ReadAll(io.LimitReader(f, 20<<20+1))
			f.Close()
			if len(b) > 0 {
				out = append(out, base64.StdEncoding.EncodeToString(b))
			}
		}
	}
	return out
}

// rawToString accepts OpenAI's `seconds` whether sent as a JSON string or number.
func rawToString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return strings.Trim(string(raw), `"`)
}

// videoSizeToInternal maps OpenAI's "WxH" size to our aspect ratio + resolution
// tier (height ≥1080 → 1080p, else 720p).
func videoSizeToInternal(size string) (ratio, resolution string) {
	var w, h int
	if s := strings.TrimSpace(strings.ToLower(size)); s != "" {
		_, _ = fmt.Sscanf(s, "%dx%d", &w, &h)
	}
	if w == 0 || h == 0 {
		return "16:9", "720p"
	}
	// The "p" resolution is the SHORT edge (720p = 1280×720, 1080p = 1920×1080),
	// so a standard 1280×720 must read as 720p — not 1080p off the long edge.
	resolution = "720p"
	if min(w, h) >= 1080 {
		resolution = "1080p"
	}
	return guessRatioWH(w, h), resolution
}

func guessRatioWH(w, h int) string {
	if w == h {
		return "1:1"
	}
	r := float64(w) / float64(h)
	cands := []struct {
		name string
		v    float64
	}{{"16:9", 16.0 / 9}, {"9:16", 9.0 / 16}, {"4:3", 4.0 / 3}, {"3:4", 3.0 / 4}, {"1:1", 1}}
	best, bestD := "16:9", 1e9
	for _, cd := range cands {
		d := r - cd.v
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = cd.name, d
		}
	}
	return best
}

// openaiImageResponse strips our rich internal map down to OpenAI's image shape.
func openaiImageResponse(m map[string]any) gin.H {
	out := gin.H{"created": m["created"]}
	if d, ok := m["data"]; ok && d != nil {
		out["data"] = d
	} else {
		out["data"] = []any{}
	}
	return out
}

func (h *V1Handler) writeAuthError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrMissingAPIKey):
		c.JSON(http.StatusUnauthorized, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrInvalidAPIKey):
		c.JSON(http.StatusUnauthorized, gin.H{"detail": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to validate api key"})
	}
}

func (h *V1Handler) writeV1Error(c *gin.Context, err error, payload map[string]any) {
	switch {
	case errors.Is(err, service.ErrUnknownModel):
		c.JSON(http.StatusNotFound, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrUnsupportedParams), errors.Is(err, service.ErrBannedPrompt):
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrInsufficientFunds):
		c.JSON(http.StatusPaymentRequired, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrReferenceTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrNoProviderAccount):
		c.JSON(http.StatusServiceUnavailable, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrProviderAuth):
		c.JSON(http.StatusServiceUnavailable, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrProviderQuota):
		// Match the Python contract: provider quota exhaustion maps to 401
		// (QuotaExhaustedError is handled alongside AuthError in routes.py).
		c.JSON(http.StatusUnauthorized, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrProviderTemporary):
		c.JSON(http.StatusServiceUnavailable, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrConcurrencyFull), errors.Is(err, service.ErrUserConcurrencyFull):
		c.JSON(http.StatusTooManyRequests, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrVideoJobNotFound):
		c.JSON(http.StatusNotFound, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrVideoNotReady):
		c.JSON(http.StatusConflict, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrProviderUnsupported):
		c.JSON(http.StatusNotImplemented, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrProviderExecution):
		c.JSON(http.StatusBadGateway, gin.H{"detail": err.Error()})
	case errors.Is(err, service.ErrGenerationPending):
		c.JSON(http.StatusNotImplemented, payload)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
	}
}

// requestBaseURL derives the scheme+host of the inbound request so the service
// layer can build absolute, directly-downloadable output URLs. Honors
// X-Forwarded-Proto (reverse-proxy / TLS termination) before falling back to
// the connection's TLS state. Returns "" when the host is unknown, which makes
// the service fall back to a relative path.
func requestBaseURL(c *gin.Context) string {
	host := c.Request.Host
	if host == "" {
		return ""
	}
	scheme := "http"
	if proto := strings.TrimSpace(c.GetHeader("X-Forwarded-Proto")); proto != "" {
		scheme = strings.ToLower(strings.Split(proto, ",")[0])
	} else if c.Request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + host
}
