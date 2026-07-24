package service

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// UpscaleService talks to a node-local ESPCN super-res microservice (the
// `upscaler` container: POST /upscale?scale=2|4 with header X-Upscale-Token,
// body = image bytes → upscaled PNG). Only headless worker nodes configure it;
// the control plane leaves UPSCALE_ENDPOINT empty and never upscales.
type UpscaleService struct {
	endpoint string
	token    string
	client   *http.Client
}

// NewUpscaleService returns nil when endpoint is empty (upscaling disabled), so
// callers can treat a nil service as "no upscale".
func NewUpscaleService(endpoint, token string, timeout time.Duration) *UpscaleService {
	if strings.TrimSpace(endpoint) == "" {
		return nil
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &UpscaleService{
		endpoint: strings.TrimRight(strings.TrimSpace(endpoint), "/"),
		token:    strings.TrimSpace(token),
		client:   &http.Client{Timeout: timeout},
	}
}

// Upscale sends image bytes to the ESPCN service and returns the upscaled bytes.
func (u *UpscaleService) Upscale(ctx context.Context, data []byte, scale int) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		u.endpoint+"/upscale?scale="+strconv.Itoa(scale), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Upscale-Token", u.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("upscale status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}
