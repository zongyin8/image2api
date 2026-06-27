// Package grok implements the Grok (grok.com / xAI) provider client. Auth is the
// website "sso" session cookie (a JWT whose only claim is a session_id — no exp,
// no refresh: when the session dies upstream the account is simply dead, never
// renewed). grok.com gates requests with an x-statsig-id header; the web app's
// value is just a base64-encoded fake JS TypeError string, which the upstream
// accepts — so we spoof it the same way (no Cloudflare clearance needed). Uses
// tls-client so the JA3/JA4 fingerprint matches Chrome.
package grok

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"strconv"
	"strings"

	http "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"github.com/google/uuid"
)

const (
	apiBase   = "https://grok.com"
	origin    = "https://grok.com"
	userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
	// fullCredits is the weekly grant — UI shows "100 满额".
	fullCredits = 100
)

var (
	ErrAuth              = errors.New("grok auth failed")
	ErrQuotaExhausted    = errors.New("grok quota exhausted")
	ErrTemporaryUpstream = errors.New("grok upstream temporary error")
)

type Client struct {
	proxy string
}

func NewClient(proxy string) *Client {
	return &Client{proxy: strings.TrimSpace(proxy)}
}

func (c *Client) SetProxy(proxy string) {
	c.proxy = strings.TrimSpace(proxy)
}

// IsGrokToken reports whether a JWT looks like a Grok website "sso" cookie: a
// payload whose ONLY claim is "session_id". That disambiguates it from a runway
// token (id + sso claims) or a chatgpt token (openai.com claims).
func IsGrokToken(token string) bool {
	claims := decodeJWTPayload(token)
	if len(claims) == 0 {
		return false
	}
	if _, ok := claims["session_id"]; !ok {
		return false
	}
	// Reject tokens that ALSO carry other-provider markers.
	for k := range claims {
		if k == "session_id" {
			continue
		}
		if k == "sso" || k == "id" || strings.HasPrefix(k, "https://api.openai.com/") {
			return false
		}
	}
	return true
}

// SessionIDFromToken returns the sso session id (for dedup / display).
func SessionIDFromToken(token string) string {
	return strings.TrimSpace(stringValue(decodeJWTPayload(token)["session_id"]))
}

// ExtractAccountInfo returns the free (no-network) account view. grok sso has no
// email/exp claim, so identity falls back to the session id.
func ExtractAccountInfo(token string) map[string]any {
	sid := SessionIDFromToken(token)
	return map[string]any{
		"email":      emptyStringNil(sid),
		"session_id": emptyStringNil(sid),
		"expires_at": nil,
	}
}

// FetchCreditsBalance reads the account's live credit balance via the billing
// gRPC-web endpoint GetGrokCreditsConfig (empty request). The response carries
// the remaining credits (field 1, a float32) and the weekly reset timestamp
// (field 5). A 401/403 maps to ErrAuth (the session is dead). Returns the
// normalized map the TokenService quota plumbing expects.
func (c *Client) FetchCreditsBalance(ctx context.Context, token string) (map[string]any, error) {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return unknownBalance("empty token"), nil
	}
	client, err := c.newTLSClient()
	if err != nil {
		return nil, err
	}
	// gRPC-web empty message frame: 1-byte flag + 4-byte length (both zero).
	body := []byte{0, 0, 0, 0, 0}
	req, err := http.NewRequest(http.MethodPost, apiBase+"/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req = req.WithContext(ctx)
	c.applyHeaders(req, token, map[string]string{
		"content-type": "application/grpc-web+proto",
		"x-grpc-web":   "1",
		"accept":       "application/grpc-web+proto",
	})

	resp, err := client.Do(req)
	if err != nil {
		return unknownBalance("network: " + err.Error()), nil
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, ErrAuth
	}
	if resp.StatusCode != 200 {
		return unknownBalance(fmt.Sprintf("http %d: %s", resp.StatusCode, clip(raw, 160))), nil
	}

	// GetGrokCreditsConfig field #1 is the credits USED this period (not remaining):
	// an exhausted account reads 100, a fresh one reads ~0. Remaining = 100 - used.
	used, reset, ok := parseCreditsConfig(raw)
	if !ok {
		return unknownBalance("unparsable credits config"), nil
	}
	if used < 0 {
		used = 0
	}
	if used > fullCredits {
		used = fullCredits
	}
	remaining := fullCredits - used
	return map[string]any{
		"remaining":   remaining,
		"used":        used,
		"total":       fullCredits,
		"reset_after": emptyStringNil(reset),
		"unknown":     false,
		"error":       nil,
	}, nil
}

// FetchSession reads the account profile via GET /api/auth/session and returns
// (email, userID). A 401/403 means the sso session is dead → ErrAuth.
func (c *Client) FetchSession(ctx context.Context, token string) (email, userID string, err error) {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return "", "", ErrAuth
	}
	client, err := c.newTLSClient()
	if err != nil {
		return "", "", err
	}
	req, err := http.NewRequest(http.MethodGet, apiBase+"/api/auth/session", nil)
	if err != nil {
		return "", "", err
	}
	req = req.WithContext(ctx)
	c.applyHeaders(req, token, nil)
	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrTemporaryUpstream, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return "", "", ErrAuth
	}
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("%w: session http %d", ErrTemporaryUpstream, resp.StatusCode)
	}
	var body struct {
		Session struct {
			Email  string `json:"email"`
			UserID string `json:"userId"`
		} `json:"session"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", "", fmt.Errorf("%w: session non-json", ErrTemporaryUpstream)
	}
	return strings.TrimSpace(body.Session.Email), strings.TrimSpace(body.Session.UserID), nil
}

// statsigID mirrors grok2api's _statsig_id: base64 of a fake JS TypeError string.
// The upstream's anti-bot check accepts this spoofed value.
func statsigID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 5)
	for i := range b {
		b[i] = charset[rand.IntN(len(charset))]
	}
	msg := fmt.Sprintf("x1:TypeError: Cannot read properties of null (reading 'children['%s']')", string(b))
	return base64.StdEncoding.EncodeToString([]byte(msg))
}

// applyHeaders sets the browser-like header set + sso cookie + spoofed statsig id.
// extra overrides/adds per-request headers (e.g. content-type).
func (c *Client) applyHeaders(req *http.Request, token string, extra map[string]string) {
	h := http.Header{
		"accept":            {"*/*"},
		"accept-language":   {"en-US,en;q=0.9"},
		"content-type":      {"application/json"},
		"origin":            {origin},
		"referer":           {origin + "/"},
		"user-agent":        {userAgent},
		"x-statsig-id":      {statsigID()},
		"x-xai-request-id":  {uuid.NewString()},
		"sec-ch-ua":         {`"Chromium";v="133", "Not(A:Brand";v="99"`},
		"sec-ch-ua-mobile":  {"?0"},
		"sec-ch-ua-platform": {`"Windows"`},
		"sec-fetch-dest":    {"empty"},
		"sec-fetch-mode":    {"cors"},
		"sec-fetch-site":    {"same-origin"},
		"cookie":            {"sso=" + token + "; sso-rw=" + token},
	}
	for k, v := range extra {
		h[k] = []string{v}
	}
	h[http.HeaderOrderKey] = []string{
		"accept", "accept-language", "content-type", "origin", "referer",
		"user-agent", "x-statsig-id", "x-xai-request-id", "x-grpc-web",
		"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
		"sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "cookie",
	}
	req.Header = h
}

func (c *Client) newTLSClient() (tlsclient.HttpClient, error) {
	options := []tlsclient.HttpClientOption{
		tlsclient.WithTimeoutSeconds(120),
		tlsclient.WithClientProfile(profiles.Chrome_133),
		tlsclient.WithRandomTLSExtensionOrder(),
	}
	if c.proxy != "" {
		options = append(options, tlsclient.WithProxyUrl(c.proxy))
	}
	return tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), options...)
}

// --- gRPC-web / protobuf decoding for GetGrokCreditsConfig ---

// parseCreditsConfig extracts (remaining credits, reset RFC3339-ish unix string)
// from the gRPC-web framed protobuf. Layout (reverse-engineered):
//
//	frame: 1-byte flag + 4-byte big-endian length + payload
//	payload: field 1 (message) {
//	  field 1: float32  -> remaining credits
//	  field 5: message  { field 1: varint -> reset unix seconds }
//	}
func parseCreditsConfig(buf []byte) (remaining int, resetUnix string, ok bool) {
	for len(buf) >= 5 {
		flag := buf[0]
		ln := int(buf[1])<<24 | int(buf[2])<<16 | int(buf[3])<<8 | int(buf[4])
		buf = buf[5:]
		if ln > len(buf) {
			break
		}
		payload := buf[:ln]
		buf = buf[ln:]
		if flag&0x80 != 0 { // trailer frame (grpc-status), skip
			continue
		}
		// payload: expect field 1 (wire type 2) wrapping the config message.
		fn, wt, val, rest, good := readField(payload)
		if !good || fn != 1 || wt != 2 {
			continue
		}
		rem, reset, found := scanConfigMessage(val)
		_ = rest
		if found {
			return rem, reset, true
		}
	}
	return 0, "", false
}

func scanConfigMessage(msg []byte) (remaining int, resetUnix string, ok bool) {
	var remF float32
	haveRem := false
	for len(msg) > 0 {
		fn, wt, val, rest, good := readField(msg)
		if !good {
			break
		}
		msg = rest
		switch {
		case fn == 1 && wt == 5: // float32 remaining credits
			remF = float32FromLE(val)
			haveRem = true
		case fn == 5 && wt == 2: // reset timestamp message { #1 varint=seconds }
			if sec, sok := firstVarint(val); sok {
				resetUnix = strconv.FormatInt(sec, 10)
			}
		}
	}
	if haveRem {
		return int(remF), resetUnix, true
	}
	return 0, resetUnix, false
}

// readField reads one protobuf field: returns (fieldNum, wireType, value, rest, ok).
// For wt 2 value is the length-delimited bytes; wt 5 the 4 LE bytes; wt 0 the
// raw varint bytes; wt 1 the 8 bytes.
func readField(b []byte) (fn int, wt int, val []byte, rest []byte, ok bool) {
	tag, n := readVarint(b)
	if n == 0 {
		return 0, 0, nil, b, false
	}
	b = b[n:]
	fn = int(tag >> 3)
	wt = int(tag & 7)
	switch wt {
	case 0:
		_, m := readVarint(b)
		if m == 0 {
			return 0, 0, nil, b, false
		}
		return fn, wt, b[:m], b[m:], true
	case 1:
		if len(b) < 8 {
			return 0, 0, nil, b, false
		}
		return fn, wt, b[:8], b[8:], true
	case 2:
		ln, m := readVarint(b)
		if m == 0 || int(ln) > len(b)-m {
			return 0, 0, nil, b, false
		}
		return fn, wt, b[m : m+int(ln)], b[m+int(ln):], true
	case 5:
		if len(b) < 4 {
			return 0, 0, nil, b, false
		}
		return fn, wt, b[:4], b[4:], true
	default:
		return 0, 0, nil, b, false
	}
}

func firstVarint(b []byte) (int64, bool) {
	fn, wt, val, _, ok := readField(b)
	if !ok || fn != 1 || wt != 0 {
		return 0, false
	}
	v, _ := readVarint(val)
	return int64(v), true
}

func readVarint(b []byte) (uint64, int) {
	var v uint64
	var s uint
	for i := 0; i < len(b); i++ {
		v |= uint64(b[i]&0x7f) << s
		if b[i]&0x80 == 0 {
			return v, i + 1
		}
		s += 7
	}
	return 0, 0
}

func float32FromLE(b []byte) float32 {
	if len(b) < 4 {
		return 0
	}
	bits := uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
	return math.Float32frombits(bits)
}

// --- small helpers (mirror the other provider clients) ---

func decodeJWTPayload(token string) map[string]any {
	parts := strings.Split(strings.TrimSpace(strings.TrimPrefix(token, "Bearer ")), ".")
	if len(parts) < 2 {
		return map[string]any{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return out
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

func emptyStringNil(v string) any {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return v
}

func unknownBalance(reason string) map[string]any {
	return map[string]any{
		"remaining": nil, "used": nil, "total": nil,
		"unknown": true, "error": reason,
	}
}

func clip(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		return s[:n]
	}
	return s
}
