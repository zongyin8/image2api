package chatgpt

import "testing"

func TestContainsAsyncMarker(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    bool
	}{
		{name: "async", payload: `{"metadata":{"image_gen_async":true}}`, want: true},
		{name: "multi stream", payload: `{"metadata":{"image_gen_multi_stream":true}}`, want: true},
		{name: "task id", payload: `{"metadata":{"image_gen_task_id":"task-1"}}`, want: true},
		{name: "async ux", payload: `{"metadata":{"trigger_async_ux":true}}`, want: true},
		{name: "ordinary message", payload: `{"metadata":{"model_slug":"gpt-image-2"}}`, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := containsAsyncMarker(tt.payload); got != tt.want {
				t.Fatalf("containsAsyncMarker() = %v, want %v", got, tt.want)
			}
		})
	}
}
