package service

import (
	"net/url"
	"testing"
	"time"
)

func TestSignedImageURLRoundTrip(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	signed := signImageURL(
		"https://example.invalid/v1/images/evt-123/content?download=1",
		"image:evt-123",
		"test-secret",
		30*time.Minute,
		now,
	)
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("download") != "1" {
		t.Fatalf("existing query was lost: %s", signed)
	}
	if !verifyImageURLSignature(
		"image:evt-123",
		parsed.Query().Get("exp"),
		parsed.Query().Get("sig"),
		"test-secret",
		now,
	) {
		t.Fatal("valid signed URL was rejected")
	}
	if verifyImageURLSignature(
		"image:evt-other",
		parsed.Query().Get("exp"),
		parsed.Query().Get("sig"),
		"test-secret",
		now,
	) {
		t.Fatal("signature was accepted for another event")
	}
	if verifyImageURLSignature(
		"image:evt-123",
		parsed.Query().Get("exp"),
		parsed.Query().Get("sig"),
		"test-secret",
		now.Add(31*time.Minute),
	) {
		t.Fatal("expired signature was accepted")
	}
}

func TestSignedImageURLDisabledWithoutKey(t *testing.T) {
	raw := "/v1/images/evt-123/content"
	if got := signImageURL(raw, "image:evt-123", "", time.Hour, time.Now()); got != raw {
		t.Fatalf("unsigned deployment changed URL: %q", got)
	}
}

func TestStoredImageURLRoundTrip(t *testing.T) {
	signed := SignStoredImageURL("user-1/image name+.png", "test-secret", time.Hour)
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/images/user-1/image name+.png" {
		t.Fatalf("path = %q", parsed.Path)
	}
	if !VerifyStoredImageURL(
		"user-1/image name+.png",
		parsed.Query().Get("exp"),
		parsed.Query().Get("sig"),
		"test-secret",
	) {
		t.Fatal("valid stored image signature was rejected")
	}
	if VerifyStoredImageURL(
		"user-2/image name+.png",
		parsed.Query().Get("exp"),
		parsed.Query().Get("sig"),
		"test-secret",
	) {
		t.Fatal("stored image signature was accepted for another object")
	}
}
