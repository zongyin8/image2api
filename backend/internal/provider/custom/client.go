// Package custom implements a generic OpenAI-compatible upstream client. A
// "custom" model forwards generation to any OpenAI-compatible API: the upstream
// base_url + api_key live on a custom account (pool="custom"), the upstream model
// name on the model config (UpstreamModel). Calls go DIRECT (no tls-client, no
// proxy) — the upstream is a normal API with no anti-bot.
package custom

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrAuth              = errors.New("custom upstream auth failed")
	ErrQuotaExhausted    = errors.New("custom upstream quota exhausted")
	ErrTemporaryUpstream = errors.New("custom upstream temporary error")
)

type Client struct{}

func NewClient() *Client { return &Client{} }

// sanitizeErr strips the upstream URL/host from a network error so a user's
// private upstream URL never leaks into the event log / API response.
func sanitizeErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "context deadline exceeded"), strings.Contains(s, "Client.Timeout"), strings.Contains(s, "timeout"):
		return "request timeout"
	case strings.Contains(s, "connection refused"):
		return "connection refused"
	case strings.Contains(s, "no such host"), strings.Contains(s, "dial tcp"), strings.Contains(s, "lookup "):
		return "cannot reach upstream"
	case strings.Contains(s, "tls"), strings.Contains(s, "TLS"), strings.Contains(s, "certificate"):
		return "TLS error"
	case strings.Contains(s, "EOF"), strings.Contains(s, "reset by peer"), strings.Contains(s, "broken pipe"):
		return "connection reset"
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return strings.ToLower(ue.Op) + " upstream failed"
	}
	return "upstream request failed"
}

func httpClient() *http.Client { return &http.Client{Timeout: 10 * time.Minute} }

// GenerateImage calls the upstream OpenAI image API. With reference images it
// uses /v1/images/edits (multipart); otherwise /v1/images/generations. Returns
// the raw image bytes (decoded from b64_json, or downloaded from url).
func (c *Client) GenerateImage(ctx context.Context, baseURL, apiKey, model, prompt, size, quality string, refs [][]byte, downloadResult bool) ([]byte, string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || apiKey == "" {
		return nil, "", ErrAuth
	}
	var req *http.Request
	var err error
	if len(refs) > 0 {
		body := &bytes.Buffer{}
		w := multipart.NewWriter(body)
		_ = w.WriteField("model", model)
		_ = w.WriteField("prompt", prompt)
		// Ask the upstream for a URL (not base64) so we can pass it through directly.
		_ = w.WriteField("response_format", "url")
		if size != "" {
			_ = w.WriteField("size", size)
		}
		for i, r := range refs {
			fw, e := w.CreateFormFile("image[]", fmt.Sprintf("ref_%d.png", i+1))
			if e != nil {
				return nil, "", e
			}
			_, _ = fw.Write(r)
		}
		_ = w.Close()
		req, err = http.NewRequest(http.MethodPost, baseURL+"/v1/images/edits", body)
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("Content-Type", w.FormDataContentType())
	} else {
		payload := map[string]any{"model": model, "prompt": prompt, "n": 1, "response_format": "url"}
		if size != "" {
			payload["size"] = size
		}
		if quality != "" {
			payload["quality"] = quality
		}
		raw, _ := json.Marshal(payload)
		req, err = http.NewRequest(http.MethodPost, baseURL+"/v1/images/generations", bytes.NewReader(raw))
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %s", ErrTemporaryUpstream, sanitizeErr(err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if e := mapStatus(resp.StatusCode, body); e != nil {
		return nil, "", e
	}
	return imageFromResponse(ctx, body, downloadResult)
}

// GenerateVideo drives the upstream Sora-style async video API:
// POST /v1/videos → poll GET /v1/videos/{id} → GET /v1/videos/{id}/content.
// When downloadResult is false it returns the upstream content URL instead.
func (c *Client) GenerateVideo(ctx context.Context, baseURL, apiKey, model, prompt, size string, seconds int, downloadResult bool) ([]byte, string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || apiKey == "" {
		return nil, "", ErrAuth
	}
	payload := map[string]any{"model": model, "prompt": prompt}
	if size != "" {
		payload["size"] = size
	}
	if seconds > 0 {
		payload["seconds"] = fmt.Sprintf("%d", seconds)
	}
	raw, _ := json.Marshal(payload)
	created, err := c.doJSON(ctx, http.MethodPost, baseURL+"/v1/videos", apiKey, raw)
	if err != nil {
		return nil, "", err
	}
	jobID := strings.TrimSpace(stringValue(created["id"]))
	if jobID == "" {
		return nil, "", fmt.Errorf("%w: video create missing id", ErrTemporaryUpstream)
	}
	// Poll until terminal.
	for {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		job, err := c.doJSON(ctx, http.MethodGet, baseURL+"/v1/videos/"+jobID, apiKey, nil)
		if err != nil {
			if errors.Is(err, ErrTemporaryUpstream) {
				if sleepCtx(ctx, 5*time.Second) != nil {
					return nil, "", ctx.Err()
				}
				continue
			}
			return nil, "", err
		}
		switch strings.ToLower(strings.TrimSpace(stringValue(job["status"]))) {
		case "completed", "succeeded", "success":
			contentURL := baseURL + "/v1/videos/" + jobID + "/content"
			if !downloadResult {
				return nil, contentURL, nil
			}
			data, err := c.download(ctx, contentURL, apiKey)
			if err != nil {
				return nil, "", err
			}
			return data, contentURL, nil
		case "failed", "error", "canceled", "cancelled":
			reason := stringValue(job["error"])
			if isCreditError(reason) {
				return nil, "", fmt.Errorf("%w: %s", ErrTemporaryUpstream, clip([]byte(reason), 160))
			}
			return nil, "", fmt.Errorf("custom: video %s", clip([]byte(reason), 160))
		}
		if sleepCtx(ctx, 5*time.Second) != nil {
			return nil, "", ctx.Err()
		}
	}
}

// GenerateMediaVideo drives the media-task protocol used by the Jimeng relay:
// upload reference images, create a task, poll it, then return or download the
// final video URL. The upstream may return either relative or absolute URLs.
func (c *Client) GenerateMediaVideo(ctx context.Context, baseURL, apiKey, model, prompt, aspectRatio string, seconds int, refs [][]byte, downloadResult bool) ([]byte, string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || apiKey == "" {
		return nil, "", ErrAuth
	}

	images := make([]string, 0, len(refs))
	for i, ref := range refs {
		uploaded, err := c.uploadMedia(ctx, baseURL, apiKey, ref, i)
		if err != nil {
			return nil, "", err
		}
		images = append(images, uploaded)
	}

	params := map[string]any{
		"duration":     seconds,
		"aspect_ratio": aspectRatio,
	}
	if len(images) > 0 {
		params["images"] = images
	}
	payload := map[string]any{
		"model":  model,
		"prompt": prompt,
		"params": params,
	}
	raw, _ := json.Marshal(payload)
	created, err := c.doJSON(ctx, http.MethodPost, baseURL+"/v1/media/generate", apiKey, raw)
	if err != nil {
		return nil, "", err
	}
	taskID := strings.TrimSpace(stringValue(created["task_id"]))
	if taskID == "" {
		return nil, "", fmt.Errorf("%w: media create missing task_id", ErrTemporaryUpstream)
	}

	for {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		statusURL := baseURL + "/v1/media/status?task_id=" + url.QueryEscape(taskID)
		job, err := c.doJSON(ctx, http.MethodGet, statusURL, apiKey, nil)
		if err != nil {
			if errors.Is(err, ErrTemporaryUpstream) {
				if sleepCtx(ctx, 5*time.Second) != nil {
					return nil, "", ctx.Err()
				}
				continue
			}
			return nil, "", err
		}
		state := strings.ToLower(strings.TrimSpace(stringValue(job["state"])))
		switch state {
		case "success":
			videoURL := strings.TrimSpace(stringValue(job["video_url"]))
			if videoURL == "" {
				videoURL = strings.TrimSpace(stringValue(job["result_url"]))
			}
			videoURL = resolveMediaURL(baseURL, videoURL)
			if videoURL == "" {
				return nil, "", fmt.Errorf("%w: media task succeeded without video url", ErrTemporaryUpstream)
			}
			if !downloadResult {
				return nil, videoURL, nil
			}
			data, err := c.downloadMedia(ctx, baseURL, videoURL, apiKey)
			if err != nil {
				return nil, "", err
			}
			return data, videoURL, nil
		case "failed":
			reason := strings.TrimSpace(stringValue(job["error"]))
			if isCreditError(reason) {
				return nil, "", fmt.Errorf("%w: %s", ErrQuotaExhausted, clip([]byte(reason), 160))
			}
			return nil, "", fmt.Errorf("custom: media task failed: %s", clip([]byte(reason), 160))
		}
		if sleepCtx(ctx, 5*time.Second) != nil {
			return nil, "", ctx.Err()
		}
	}
}

func (c *Client) downloadMedia(ctx context.Context, baseURL, videoURL, apiKey string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, videoURL, nil)
	base, baseErr := url.Parse(baseURL)
	target, targetErr := url.Parse(videoURL)
	if baseErr == nil && targetErr == nil && strings.EqualFold(base.Host, target.Host) {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrTemporaryUpstream, sanitizeErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: download %d", ErrTemporaryUpstream, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("%w: empty download", ErrTemporaryUpstream)
	}
	return data, nil
}

func (c *Client) uploadMedia(ctx context.Context, baseURL, apiKey string, data []byte, index int) (string, error) {
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	fw, err := w.CreateFormFile("file", fmt.Sprintf("reference_%d.png", index+1))
	if err != nil {
		return "", err
	}
	if _, err := fw.Write(data); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/media/upload", body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrTemporaryUpstream, sanitizeErr(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if e := mapStatus(resp.StatusCode, raw); e != nil {
		return "", e
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("%w: media upload non-json", ErrTemporaryUpstream)
	}
	uploaded := strings.TrimSpace(stringValue(out["url"]))
	if uploaded == "" {
		return "", fmt.Errorf("%w: media upload missing url", ErrTemporaryUpstream)
	}
	return uploaded, nil
}

func resolveMediaURL(baseURL, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if u.IsAbs() {
		return u.String()
	}
	base, err := url.Parse(strings.TrimRight(baseURL, "/") + "/")
	if err != nil {
		return ""
	}
	return base.ResolveReference(u).String()
}

func (c *Client) doJSON(ctx context.Context, method, url, apiKey string, body []byte) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return nil, err
	}
	req = req.WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrTemporaryUpstream, sanitizeErr(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if e := mapStatus(resp.StatusCode, raw); e != nil {
		return nil, e
	}
	var out map[string]any
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("%w: non-json: %s", ErrTemporaryUpstream, clip(raw, 120))
	}
	return out, nil
}

func (c *Client) download(ctx context.Context, url, apiKey string) ([]byte, error) {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req = req.WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrTemporaryUpstream, sanitizeErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: download %d", ErrTemporaryUpstream, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("%w: empty download", ErrTemporaryUpstream)
	}
	return data, nil
}

// imageBytesFromResponse extracts image bytes from an OpenAI images response:
// data[0].b64_json (preferred) or data[0].url (downloaded).
// imageFromResponse parses an OpenAI image response and returns the upstream URL.
// We always request response_format=url, so the response must carry a URL — a
// base64-only response is treated as an error (no base64 pass-through). With
// downloadResult=false the URL is returned directly (no download).
func imageFromResponse(ctx context.Context, body []byte, downloadResult bool) ([]byte, string, error) {
	var out struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil || len(out.Data) == 0 {
		return nil, "", fmt.Errorf("%w: bad image response: %s", ErrTemporaryUpstream, clip(body, 160))
	}
	url := strings.TrimSpace(out.Data[0].URL)
	if url == "" {
		return nil, "", fmt.Errorf("%w: image response had no url (upstream ignored response_format=url)", ErrTemporaryUpstream)
	}
	if !downloadResult {
		return nil, url, nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %s", ErrTemporaryUpstream, sanitizeErr(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	return raw, url, err
}

func mapStatus(status int, body []byte) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == 401 || status == 403:
		return fmt.Errorf("%w: %d %s", ErrAuth, status, clip(body, 160))
	case status == 429:
		// Custom upstreams have NO "quota exhausted" lock — a 429 is just rate
		// limiting, treated as a temporary error (fail over, account stays active).
		return fmt.Errorf("%w: 429 %s", ErrTemporaryUpstream, clip(body, 160))
	case status >= 500:
		return fmt.Errorf("%w: %d %s", ErrTemporaryUpstream, status, clip(body, 160))
	default:
		if isCreditError(string(body)) {
			return fmt.Errorf("%w: %s", ErrTemporaryUpstream, clip(body, 160))
		}
		return fmt.Errorf("custom: %d %s", status, clip(body, 160))
	}
}

func isCreditError(s string) bool {
	s = strings.ToLower(s)
	return strings.Contains(s, "insufficient") || strings.Contains(s, "quota") ||
		strings.Contains(s, "credit") || strings.Contains(s, "balance")
}

func stringValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case nil:
		return ""
	default:
		b, _ := json.Marshal(x)
		return strings.TrimSpace(string(b))
	}
}

func clip(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		return s[:n]
	}
	return s
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
