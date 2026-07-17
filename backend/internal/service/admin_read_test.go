package service

import "testing"

func TestGeneratedOutputKind(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{name: "user/image.png", want: "image"},
		{name: "user/video.mp4", want: "video"},
		{name: "user/image.png.thumb.jpg", want: ""},
		{name: "user/video.mp4.last.jpg", want: ""},
		{name: "user/task-ref-1.png", want: ""},
		{name: "user/readme.txt", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := generatedOutputKind(tt.name); got != tt.want {
				t.Fatalf("generatedOutputKind(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}
