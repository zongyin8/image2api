package chatgpt

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPollBudgetLeavesRoomForFailover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	if got := pollBudget(ctx); got > 210*time.Second || got < 209*time.Second {
		t.Fatalf("pollBudget() = %v, want approximately 210s", got)
	}
}

func TestPollTimeoutIsTemporary(t *testing.T) {
	_, _, err := (&Client{}).pollForImage(
		context.Background(), nil, "token", "conversation",
		nil, nil, nil, false, 0,
	)

	if !errors.Is(err, ErrTemporaryUpstream) {
		t.Fatalf("pollForImage() error = %v, want ErrTemporaryUpstream", err)
	}
}
