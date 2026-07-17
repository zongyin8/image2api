package adobe

import "testing"

func TestBuildVideoPayloadSeedance2(t *testing.T) {
	payload := BuildVideoPayload(
		"seedance2",
		"A paper boat floating on a calm pond at sunrise, gentle camera movement",
		"16:9",
		4,
		"720p",
		"",
		"",
		nil,
	)

	if got := payload["modelId"]; got != "seedance" {
		t.Fatalf("modelId = %v, want seedance", got)
	}
	if got := payload["modelVersion"]; got != "seedance_2.0" {
		t.Fatalf("modelVersion = %v, want seedance_2.0", got)
	}
	if got := payload["duration"]; got != 4 {
		t.Fatalf("duration = %v, want 4", got)
	}
	if got := payload["generateAudio"]; got != false {
		t.Fatalf("generateAudio = %v, want false", got)
	}

	size, ok := payload["size"].(map[string]any)
	if !ok || size["width"] != 1280 || size["height"] != 720 {
		t.Fatalf("size = %#v, want 1280x720", payload["size"])
	}
	settings, ok := payload["generationSettings"].(map[string]any)
	if !ok || settings["aspectRatio"] != "16:9" {
		t.Fatalf("generationSettings = %#v, want aspectRatio 16:9", payload["generationSettings"])
	}
	metadata, ok := payload["generationMetadata"].(map[string]any)
	if !ok || metadata["module"] != "text2video" || metadata["submodule"] != "ff-video-generate" {
		t.Fatalf("generationMetadata = %#v", payload["generationMetadata"])
	}

	for _, disallowed := range []string{"fps", "n", "model", "modelSpecificPayload", "referenceBlobs"} {
		if _, exists := payload[disallowed]; exists {
			t.Fatalf("Seedance payload unexpectedly contains %q", disallowed)
		}
	}
}

func TestBuildVideoPayloadSeedance2Fast(t *testing.T) {
	payload := BuildVideoPayload("seedance2-fast", "test", "9:16", 4, "480p", "", "", nil)
	if got := payload["modelVersion"]; got != "seedance_2.0_fast" {
		t.Fatalf("modelVersion = %v, want seedance_2.0_fast", got)
	}
	size := payload["size"].(map[string]any)
	if size["width"] != 640 || size["height"] != 480 {
		t.Fatalf("size = %#v, want 640x480", size)
	}
	settings := payload["generationSettings"].(map[string]any)
	if settings["aspectRatio"] != "9:16" {
		t.Fatalf("generationSettings = %#v, want aspectRatio 9:16", settings)
	}
}

func TestBuildVideoPayloadSeedance2Frames(t *testing.T) {
	payload := BuildVideoPayload("seedance2", "test", "16:9", 4, "720p", "frame", "", []string{"first", "last", "ignored"})
	refs, ok := payload["referenceBlobs"].([]any)
	if !ok || len(refs) != 2 {
		t.Fatalf("referenceBlobs = %#v, want two frames", payload["referenceBlobs"])
	}
	first := refs[0].(map[string]any)
	last := refs[1].(map[string]any)
	if first["id"] != "first" || first["usage"] != "frame" || first["order"] != 1 {
		t.Fatalf("first frame = %#v", first)
	}
	if last["id"] != "last" || last["usage"] != "frame" || last["order"] != 2 {
		t.Fatalf("last frame = %#v", last)
	}
	metadata := payload["generationMetadata"].(map[string]any)
	if metadata["module"] != "image2video" {
		t.Fatalf("generationMetadata = %#v, want image2video", metadata)
	}
}
