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

func TestConversationImageStarted(t *testing.T) {
	tests := []struct {
		name    string
		message map[string]any
		started bool
	}{
		{name: "async task type", message: map[string]any{"metadata": map[string]any{"async_task_type": "image_gen"}}, started: true},
		{name: "multi stream", message: map[string]any{"metadata": map[string]any{"image_gen_multi_stream": true}}, started: true},
		{name: "tool role", message: map[string]any{"author": map[string]any{"role": "tool"}}, started: true},
		{name: "image recipient", message: map[string]any{"author": map[string]any{"role": "assistant"}, "recipient": "t2uay3k"}, started: true},
		{name: "ordinary assistant", message: map[string]any{"author": map[string]any{"role": "assistant"}}, started: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conversation := map[string]any{"mapping": map[string]any{"node": map[string]any{"message": tt.message}}}
			if got := conversationImageStarted(conversation); got != tt.started {
				t.Fatalf("conversationImageStarted() = %v, want %v", got, tt.started)
			}
		})
	}
}
