package service

import (
	"testing"

	"backend/internal/model"
)

func TestShouldLogRejectedCoalescesSameUserAndReason(t *testing.T) {
	svc := &V1Service{}
	principal := &APIPrincipal{User: &model.User{ID: "user-1"}}

	if !svc.shouldLogRejected(principal, "v1", "insufficient credits") {
		t.Fatal("first rejection should be logged")
	}
	if svc.shouldLogRejected(principal, "v1", "insufficient credits") {
		t.Fatal("duplicate rejection should be coalesced")
	}
	if !svc.shouldLogRejected(principal, "user", "insufficient credits") {
		t.Fatal("a different request source should have its own audit row")
	}
	if !svc.shouldLogRejected(principal, "v1", "unknown model") {
		t.Fatal("a different reason should have its own audit row")
	}
	other := &APIPrincipal{User: &model.User{ID: "user-2"}}
	if !svc.shouldLogRejected(other, "v1", "insufficient credits") {
		t.Fatal("a different user should have its own audit row")
	}
}
