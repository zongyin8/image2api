package adobe

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLiveSeedance2(t *testing.T) {
	if os.Getenv("ADOBE_SEEDANCE_LIVE") != "1" {
		t.Skip("set ADOBE_SEEDANCE_LIVE=1 to run the paid Adobe test")
	}
	token := strings.TrimSpace(os.Getenv("ADOBE_ACCESS_TOKEN"))
	if token == "" {
		t.Fatal("ADOBE_ACCESS_TOKEN is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	engine := strings.TrimSpace(os.Getenv("ADOBE_SEEDANCE_ENGINE"))
	if engine == "" {
		engine = "seedance2"
	}
	if engine != "seedance2" && engine != "seedance2-fast" {
		t.Fatalf("unsupported ADOBE_SEEDANCE_ENGINE %q", engine)
	}
	ratio := strings.TrimSpace(os.Getenv("ADOBE_SEEDANCE_RATIO"))
	if ratio == "" {
		ratio = "16:9"
	}
	resolution := strings.TrimSpace(os.Getenv("ADOBE_SEEDANCE_RESOLUTION"))
	if resolution == "" {
		resolution = "720p"
	}
	duration := 4
	if raw := strings.TrimSpace(os.Getenv("ADOBE_SEEDANCE_DURATION")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			t.Fatalf("invalid ADOBE_SEEDANCE_DURATION %q", raw)
		}
		duration = parsed
	}
	prompt := strings.TrimSpace(os.Getenv("ADOBE_SEEDANCE_PROMPT"))
	if prompt == "" {
		prompt = "A paper boat floating on a calm pond at sunrise, gentle camera movement"
	}

	client := NewClient("", os.Getenv("ADOBE_PROXY_URL"))
	_, meta, err := client.GenerateVideo(
		ctx,
		token,
		engine,
		prompt,
		ratio,
		duration,
		resolution,
		"",
		"",
		nil,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stringValue(meta["video_url"])) == "" {
		t.Fatalf("Seedance completed without a video URL; metadata keys: %v", mapKeys(meta))
	}
	t.Logf("%s completed; metadata keys: %v", engine, mapKeys(meta))
}

func mapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}
