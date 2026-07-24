package service

import (
	"testing"
	"time"

	"backend/internal/model"
)

func nodeCfg(id string, weight, concurrency int) model.TokenAccount {
	return model.TokenAccount{ID: id, Weight: weight, Concurrency: concurrency}
}

func TestCustomLoadRatio(t *testing.T) {
	inflight := map[string]int64{"a": 2, "b": 0}
	if r := customLoadRatio(nodeCfg("a", 0, 4), inflight); r != 0.5 {
		t.Fatalf("a load = %v, want 0.5", r)
	}
	if r := customLoadRatio(nodeCfg("b", 0, 4), inflight); r != 0 {
		t.Fatalf("b load = %v, want 0", r)
	}
	// concurrency 0 → treated as 1
	if r := customLoadRatio(nodeCfg("c", 0, 0), map[string]int64{"c": 3}); r != 3 {
		t.Fatalf("c load = %v, want 3 (cap defaults to 1)", r)
	}
}

// least-busy node first: n2 (0/2) < n3 (1/2) < n1 (2/2).
func TestOrderCustomByLoad_LeastBusyFirst(t *testing.T) {
	s := &V1Service{}
	nodes := []model.TokenAccount{nodeCfg("n1", 0, 2), nodeCfg("n2", 0, 2), nodeCfg("n3", 0, 2)}
	s.orderCustomByLoad(nodes, map[string]int64{"n1": 2, "n2": 0, "n3": 1})
	got := []string{nodes[0].ID, nodes[1].ID, nodes[2].ID}
	want := []string{"n2", "n3", "n1"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v (least-busy first)", got, want)
		}
	}
}

// equal load → higher weight first, then id.
func TestOrderCustomByLoad_WeightThenID(t *testing.T) {
	s := &V1Service{}
	nodes := []model.TokenAccount{nodeCfg("b", 5, 1), nodeCfg("a", 5, 1), nodeCfg("c", 10, 1)}
	s.orderCustomByLoad(nodes, map[string]int64{})
	got := []string{nodes[0].ID, nodes[1].ID, nodes[2].ID}
	want := []string{"c", "a", "b"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

// load beats weight: a busy high-weight node yields to an idle low-weight one.
func TestOrderCustomByLoad_LoadBeatsWeight(t *testing.T) {
	s := &V1Service{}
	nodes := []model.TokenAccount{nodeCfg("hi", 100, 1), nodeCfg("lo", 1, 1)}
	s.orderCustomByLoad(nodes, map[string]int64{"hi": 1, "lo": 0}) // hi=1.0, lo=0
	if nodes[0].ID != "lo" {
		t.Fatalf("first = %s, want lo (idle beats busy-but-high-weight)", nodes[0].ID)
	}
}

func TestCustomDownCooldown(t *testing.T) {
	s := &V1Service{}
	if s.isCustomDown("x") {
		t.Fatal("fresh node should not be down")
	}
	s.markCustomDown("x")
	if !s.isCustomDown("x") {
		t.Fatal("marked node should be down")
	}
	// simulate expiry
	s.customDown.Store("x", time.Now().Add(-time.Second))
	if s.isCustomDown("x") {
		t.Fatal("expired cooldown should clear")
	}
}
