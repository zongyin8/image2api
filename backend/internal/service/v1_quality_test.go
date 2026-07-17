package service

import (
	"testing"

	"backend/internal/model"
	"gorm.io/datatypes"
)

func TestResolutionForQuality(t *testing.T) {
	item := &model.ModelConfig{Prices: datatypes.JSONMap{
		"1K": float64(1), "2K": float64(2), "4K": float64(4),
	}}
	tests := map[string]string{
		"low": "1K", "medium": "2K", "high": "4K", "auto": "1K", "": "1K",
	}
	for quality, want := range tests {
		if got := resolutionForQuality(item, quality); got != want {
			t.Fatalf("quality %q: got %q, want %q", quality, got, want)
		}
	}
}

func TestResolutionForQualityClampsToPricedTiers(t *testing.T) {
	item := &model.ModelConfig{Prices: datatypes.JSONMap{
		"2K": float64(2), "4K": float64(4),
	}}
	if got := resolutionForQuality(item, "low"); got != "2K" {
		t.Fatalf("low = %q, want 2K", got)
	}
	if got := resolutionForQuality(item, "high"); got != "4K" {
		t.Fatalf("high = %q, want 4K", got)
	}
}
