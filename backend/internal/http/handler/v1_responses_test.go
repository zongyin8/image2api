package handler

import (
	"testing"
)

func TestResponseImageTool(t *testing.T) {
	tool, ok := responseImageTool(responsesRequest{Tools: []map[string]any{{
		"type": "image_generation", "quality": "high",
	}}})
	if !ok || tool["quality"] != "high" {
		t.Fatalf("tool = %#v, ok = %v", tool, ok)
	}
}

func TestResponseImageInputs(t *testing.T) {
	prompt, refs := responseImageInputs([]any{
		map[string]any{"role": "assistant", "content": "ignore this"},
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "input_text", "text": "draw a bridge"},
			map[string]any{"type": "input_image", "image_url": "data:image/png;base64,YWJj"},
		}},
	})
	if prompt != "draw a bridge" {
		t.Fatalf("prompt = %q", prompt)
	}
	if len(refs) != 1 || refs[0] != "YWJj" {
		t.Fatalf("refs = %#v", refs)
	}
}

func TestResponseOutputItems(t *testing.T) {
	items := responseOutputItems("draw", map[string]any{
		"data": []map[string]any{{"b64_json": "YWJj"}},
	})
	if len(items) != 1 || items[0]["type"] != "image_generation_call" || items[0]["result"] != "YWJj" {
		t.Fatalf("items = %#v", items)
	}
}
