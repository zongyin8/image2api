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

func TestParseImageSizeOnlySelectsAspectRatio(t *testing.T) {
	tests := []struct {
		name string
		size string
		want string
	}{
		{name: "square", size: "1024x1024", want: "1:1"},
		{name: "landscape", size: "1536x1024", want: "3:2"},
		{name: "portrait", size: "1024x1536", want: "2:3"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRatio, gotResolution := parseImageSize(tt.size, "", "")
			if gotRatio != tt.want {
				t.Fatalf("ratio = %q, want %q", gotRatio, tt.want)
			}
			if gotResolution != "" {
				t.Fatalf("size unexpectedly selected resolution %q", gotResolution)
			}
		})
	}
}

func TestParseImageSizePreservesExplicitResolution(t *testing.T) {
	ratio, resolution := parseImageSize("1536x1024", "", "4K")
	if ratio != "3:2" || resolution != "4K" {
		t.Fatalf("got ratio=%q resolution=%q, want 3:2 and 4K", ratio, resolution)
	}
}

func TestResolveImageShapeKeepsSizeAndQualityIndependent(t *testing.T) {
	item := &model.ModelConfig{Prices: datatypes.JSONMap{
		"1K": float64(1), "2K": float64(2), "4K": float64(4),
	}}
	ratio, resolution := resolveImageShape(item, "1536x1024", "", "", "high")
	if ratio != "3:2" || resolution != "4K" {
		t.Fatalf("got ratio=%q resolution=%q, want 3:2 and 4K", ratio, resolution)
	}
}

func TestResolveImageShapePreservesPlaygroundResolution(t *testing.T) {
	item := &model.ModelConfig{Prices: datatypes.JSONMap{
		"1K": float64(1), "2K": float64(2), "4K": float64(4),
	}}
	ratio, resolution := resolveImageShape(item, "1024x1536", "", "2K", "high")
	if ratio != "2:3" || resolution != "2K" {
		t.Fatalf("got ratio=%q resolution=%q, want 2:3 and explicit 2K", ratio, resolution)
	}
}
