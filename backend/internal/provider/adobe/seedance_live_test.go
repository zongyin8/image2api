package adobe

import (
	"context"
	"os"
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

	client := NewClient("", os.Getenv("ADOBE_PROXY_URL"))
	_, meta, err := client.GenerateVideo(
		ctx,
		token,
		"seedance2",
		"A paper boat floating on a calm pond at sunrise, gentle camera movement",
		"16:9",
		4,
		"720p",
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
	t.Logf("Seedance completed; metadata keys: %v", mapKeys(meta))
}

func mapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}
