package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"backend/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type responsesRequest struct {
	Model        string           `json:"model"`
	Input        any              `json:"input"`
	Instructions any              `json:"instructions"`
	Tools        []map[string]any `json:"tools"`
	ToolChoice   any              `json:"tool_choice"`
	Stream       bool             `json:"stream"`
}

// Responses supports the image_generation tool contract. General text/tool
// execution remains outside image2api's scope and fails explicitly.
func (h *V1Handler) Responses(c *gin.Context) {
	principal, err := h.v1.Authenticate(c.Request.Context(), c.GetHeader("Authorization"))
	if err != nil {
		h.writeAuthError(c, err)
		return
	}
	var body responsesRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request body"})
		return
	}
	tool, ok := responseImageTool(body)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "image2api responses supports only the image_generation tool"})
		return
	}
	prompt, refs := responseImageInputs(body.Input)
	if prompt == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "input text is required"})
		return
	}
	model := strings.TrimSpace(body.Model)
	if model == "" {
		model = "gpt-image-2"
	}
	request := service.V1ImageRequest{
		Model:           model,
		Prompt:          prompt,
		N:               1,
		Size:            stringFromAny(tool["size"]),
		Quality:         stringFromAny(tool["quality"]),
		ResponseFormat:  "b64_json",
		ReferenceImages: refs,
		BaseURL:         requestBaseURL(c),
	}
	if !body.Stream {
		resp, genErr := h.v1.PrepareImageRequest(c.Request.Context(), principal, request)
		if genErr != nil {
			h.writeV1Error(c, genErr, resp)
			return
		}
		c.JSON(http.StatusOK, responseObject(model, prompt, resp))
		return
	}
	h.streamResponseImage(c, principal, request, prompt)
}

func responseImageTool(body responsesRequest) (map[string]any, bool) {
	for _, tool := range body.Tools {
		if strings.EqualFold(strings.TrimSpace(fmt.Sprint(tool["type"])), "image_generation") {
			return tool, true
		}
	}
	if choice, ok := body.ToolChoice.(map[string]any); ok && strings.EqualFold(strings.TrimSpace(fmt.Sprint(choice["type"])), "image_generation") {
		return choice, true
	}
	return nil, false
}

func responseImageInputs(value any) (string, []string) {
	texts := []string{}
	refs := []string{}
	collectResponseInput(value, &texts, &refs)
	return strings.Join(texts, "\n"), refs
}

func collectResponseInput(value any, texts, refs *[]string) {
	switch v := value.(type) {
	case string:
		if text := strings.TrimSpace(v); text != "" {
			*texts = append(*texts, text)
		}
	case []any:
		for _, item := range v {
			collectResponseInput(item, texts, refs)
		}
	case map[string]any:
		role := strings.ToLower(strings.TrimSpace(fmt.Sprint(v["role"])))
		if role != "" && role != "<nil>" && role != "user" {
			return
		}
		typ := strings.ToLower(strings.TrimSpace(fmt.Sprint(v["type"])))
		switch typ {
		case "input_text", "text":
			if text := strings.TrimSpace(firstString(v["text"], v["input_text"])); text != "" {
				*texts = append(*texts, text)
			}
			return
		case "input_image", "image_url", "image":
			if ref := dataURLBase64(firstString(v["image_url"], v["url"], v["image"])); ref != "" {
				*refs = append(*refs, ref)
			}
			return
		}
		if content, ok := v["content"]; ok {
			collectResponseInput(content, texts, refs)
		}
	}
}

func responseOutputItems(prompt string, response map[string]any) []gin.H {
	items := []gin.H{}
	var data []map[string]any
	switch rows := response["data"].(type) {
	case []map[string]any:
		data = rows
	case []any:
		for _, raw := range rows {
			if row, ok := raw.(map[string]any); ok {
				data = append(data, row)
			}
		}
	}
	for _, row := range data {
		if b64 := strings.TrimSpace(fmt.Sprint(row["b64_json"])); b64 != "" && b64 != "<nil>" {
			items = append(items, gin.H{
				"id": "ig_" + uuid.NewString(), "type": "image_generation_call",
				"status": "completed", "result": b64, "revised_prompt": prompt,
			})
		}
	}
	return items
}

func responseObject(model, prompt string, response map[string]any) gin.H {
	return gin.H{
		"id": "resp_" + uuid.NewString(), "object": "response", "created_at": time.Now().Unix(),
		"status": "completed", "error": nil, "incomplete_details": nil, "model": model,
		"output": responseOutputItems(prompt, response), "parallel_tool_calls": false,
		"usage": gin.H{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
	}
}

func (h *V1Handler) streamResponseImage(c *gin.Context, principal *service.APIPrincipal, request service.V1ImageRequest, prompt string) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Status(http.StatusOK)

	responseID := "resp_" + uuid.NewString()
	created := time.Now().Unix()
	writeResponseSSE(c, gin.H{"type": "response.created", "response": gin.H{
		"id": responseID, "object": "response", "created_at": created, "status": "in_progress",
		"error": nil, "incomplete_details": nil, "model": request.Model, "output": []any{}, "parallel_tool_calls": false,
	}})
	c.Writer.Flush()

	ctx := c.Request.Context()
	resultCh := make(chan chatImageResult, 1)
	go func() {
		resp, err := h.v1.PrepareImageRequest(ctx, principal, request)
		resultCh <- chatImageResult{response: resp, err: err}
	}()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = io.WriteString(c.Writer, ": keep-alive\n\n")
			c.Writer.Flush()
		case result := <-resultCh:
			if result.err != nil {
				writeResponseSSE(c, gin.H{"type": "error", "error": gin.H{"message": result.err.Error()}})
			} else {
				items := responseOutputItems(prompt, result.response)
				for index, item := range items {
					writeResponseSSE(c, gin.H{"type": "response.output_item.done", "output_index": index, "item": item})
				}
				writeResponseSSE(c, gin.H{"type": "response.completed", "response": gin.H{
					"id": responseID, "object": "response", "created_at": created, "status": "completed",
					"error": nil, "incomplete_details": nil, "model": request.Model, "output": items,
					"parallel_tool_calls": false, "usage": gin.H{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
				}})
			}
			_, _ = io.WriteString(c.Writer, "data: [DONE]\n\n")
			c.Writer.Flush()
			return
		}
	}
}

func writeResponseSSE(c *gin.Context, value any) {
	payload, _ := json.Marshal(value)
	_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
}
