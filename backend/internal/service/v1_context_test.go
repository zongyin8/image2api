package service

import (
	"context"
	"testing"
)

func TestImageWorkContextCancellationPolicy(t *testing.T) {
	requestCtx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := imageWorkContext(requestCtx, "v1").Err(); err == nil {
		t.Fatal("v1 work context should preserve request cancellation")
	}
	if err := imageWorkContext(requestCtx, "user").Err(); err != nil {
		t.Fatalf("user work context should outlive request: %v", err)
	}
	if err := imageWorkContext(requestCtx, "admin").Err(); err != nil {
		t.Fatalf("admin work context should outlive request: %v", err)
	}
}
