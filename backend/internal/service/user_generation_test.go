package service

import (
	"testing"

	"backend/internal/model"
)

func TestShapeJobEventIncludesRefundState(t *testing.T) {
	item := &model.EventLog{
		ID:       "evt-refunded",
		Status:   "failed",
		Cost:     5,
		Refunded: true,
	}

	got := shapeJobEvent(item, nil)
	if got["cost"] != float64(5) {
		t.Fatalf("cost = %#v, want 5", got["cost"])
	}
	if got["refunded"] != true {
		t.Fatalf("refunded = %#v, want true", got["refunded"])
	}
}
