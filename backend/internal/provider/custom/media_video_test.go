package custom

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateMediaVideoUploadsPollsAndResolvesRelativeURL(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q", got)
		}
		switch r.URL.Path {
		case "/v1/media/upload":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			data, _ := io.ReadAll(file)
			if string(data) != "reference-image" {
				t.Fatalf("uploaded data = %q", data)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"url": "/uploads/reference.png"})
		case "/v1/media/generate":
			var body struct {
				Model  string `json:"model"`
				Prompt string `json:"prompt"`
				Params struct {
					Duration    int      `json:"duration"`
					AspectRatio string   `json:"aspect_ratio"`
					Images      []string `json:"images"`
				} `json:"params"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Model != "video-v1" || body.Prompt != "test prompt" || body.Params.Duration != 10 || body.Params.AspectRatio != "16:9" {
				t.Fatalf("unexpected generate body: %+v", body)
			}
			if len(body.Params.Images) != 1 || body.Params.Images[0] != "/uploads/reference.png" {
				t.Fatalf("images = %#v", body.Params.Images)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": 42, "task_status": "PENDING"})
		case "/v1/media/status":
			if r.URL.Query().Get("task_id") != "42" {
				t.Fatalf("task_id = %q", r.URL.Query().Get("task_id"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id": 42, "state": "success", "is_final": true,
				"result_url": "/uploads/video.mp4",
			})
		case "/uploads/video.mp4":
			_, _ = w.Write([]byte("video-bytes"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	data, videoURL, err := NewClient().GenerateMediaVideo(
		context.Background(), server.URL, "test-key", "video-v1", "test prompt",
		"16:9", 10, [][]byte{[]byte("reference-image")}, true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "video-bytes" {
		t.Fatalf("data = %q", data)
	}
	if videoURL != server.URL+"/uploads/video.mp4" {
		t.Fatalf("videoURL = %q", videoURL)
	}
}

func TestResolveMediaURL(t *testing.T) {
	tests := map[string]string{
		"/uploads/video.mp4":            "https://example.com/uploads/video.mp4",
		"uploads/video.mp4":             "https://example.com/api/uploads/video.mp4",
		"https://cdn.example/video.mp4": "https://cdn.example/video.mp4",
	}
	for input, want := range tests {
		if got := resolveMediaURL("https://example.com/api", input); got != want {
			t.Errorf("resolveMediaURL(%q) = %q, want %q", input, got, want)
		}
	}
	if got := resolveMediaURL("https://example.com", strings.TrimSpace("")); got != "" {
		t.Fatalf("empty URL resolved to %q", got)
	}
}

func TestDownloadMediaDoesNotLeakKeyToAnotherHost(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Fatalf("authorization leaked to result host: %q", got)
		}
		_, _ = w.Write([]byte("video"))
	}))
	defer target.Close()

	data, err := NewClient().downloadMedia(context.Background(), "https://upstream.example", target.URL, "secret-key")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "video" {
		t.Fatalf("data = %q", data)
	}
}
