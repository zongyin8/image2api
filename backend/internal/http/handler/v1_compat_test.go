package handler

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestChatImageInputs(t *testing.T) {
	body := chatCompletionRequest{
		Model: "gpt-image-2",
		Messages: []chatMessage{{
			Role: "user",
			Content: json.RawMessage(`[
                {"type":"text","text":"draw a lighthouse"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,YWJj"}}
            ]`),
		}},
	}
	prompt, refs := chatImageInputs(body)
	if prompt != "draw a lighthouse" {
		t.Fatalf("prompt = %q", prompt)
	}
	if len(refs) != 1 || refs[0] != "YWJj" {
		t.Fatalf("refs = %#v", refs)
	}
}

func TestChatImageInputsIgnoresAssistantContent(t *testing.T) {
	body := chatCompletionRequest{Messages: []chatMessage{
		{Role: "assistant", Content: json.RawMessage(`"old result"`)},
		{Role: "user", Content: json.RawMessage(`"new prompt"`)},
	}}
	prompt, _ := chatImageInputs(body)
	if prompt != "new prompt" {
		t.Fatalf("prompt = %q", prompt)
	}
}

func TestChatImageInputsPrefersDirectPrompt(t *testing.T) {
	body := chatCompletionRequest{
		Prompt:   "direct prompt",
		Messages: []chatMessage{{Role: "user", Content: json.RawMessage(`"message prompt"`)}},
	}
	prompt, _ := chatImageInputs(body)
	if prompt != "direct prompt" {
		t.Fatalf("prompt = %q", prompt)
	}
}

func TestChatImageMarkdown(t *testing.T) {
	content := chatImageMarkdown(map[string]any{
		"data": []map[string]any{{"b64_json": "YWJj"}, {"url": "https://example.invalid/image.png"}},
	})
	if !strings.Contains(content, "data:image/png;base64,YWJj") {
		t.Fatalf("missing base64 image: %q", content)
	}
	if !strings.Contains(content, "https://example.invalid/image.png") {
		t.Fatalf("missing URL image: %q", content)
	}
}

func TestJSONImageReferences(t *testing.T) {
	refs, err := jsonImageReferences(map[string]any{
		"images": []any{
			"data:image/png;base64,YWJj",
			map[string]any{"b64_json": "ZGVm"},
			map[string]any{"source": map[string]any{"type": "base64", "data": "Z2hp"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"YWJj", "ZGVm", "Z2hp"}; !reflect.DeepEqual(refs, want) {
		t.Fatalf("refs = %#v, want %#v", refs, want)
	}
}

func TestJSONImageReferencesRejectsRemoteURL(t *testing.T) {
	_, err := jsonImageReferences(map[string]any{"image_url": "https://example.invalid/image.png"})
	if err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("err = %v", err)
	}
}
