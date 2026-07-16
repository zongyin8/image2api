package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func signImageURL(rawURL, resource, key string, ttl time.Duration, now time.Time) string {
	if strings.TrimSpace(rawURL) == "" || strings.TrimSpace(key) == "" || ttl <= 0 {
		return rawURL
	}
	expires := now.Add(ttl).Unix()
	signature := imageURLSignature(resource, expires, key)
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	query.Set("exp", strconv.FormatInt(expires, 10))
	query.Set("sig", signature)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func verifyImageURLSignature(resource, expiresRaw, signature, key string, now time.Time) bool {
	if strings.TrimSpace(resource) == "" || strings.TrimSpace(key) == "" || strings.TrimSpace(signature) == "" {
		return false
	}
	expires, err := strconv.ParseInt(strings.TrimSpace(expiresRaw), 10, 64)
	if err != nil || expires < now.Unix() {
		return false
	}
	expected, err := hex.DecodeString(imageURLSignature(resource, expires, key))
	if err != nil {
		return false
	}
	provided, err := hex.DecodeString(strings.TrimSpace(signature))
	if err != nil {
		return false
	}
	return hmac.Equal(provided, expected)
}

func imageURLSignature(resource string, expires int64, key string) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(resource))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write([]byte(strconv.FormatInt(expires, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}
