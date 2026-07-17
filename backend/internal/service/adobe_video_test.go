package service

import (
	"testing"

	"backend/internal/model"
	"gorm.io/datatypes"
)

func TestResolveAdobeVideoEngineSeedance(t *testing.T) {
	tests := []struct {
		model string
		want  string
	}{
		{model: "seedance-2.0", want: "seedance2"},
		{model: "seedance2", want: "seedance2"},
		{model: "seedance-2.0-fast", want: "seedance2-fast"},
		{model: "seedance2-fast", want: "seedance2-fast"},
	}
	for _, test := range tests {
		t.Run(test.model, func(t *testing.T) {
			got, upstream := resolveAdobeVideoEngine(test.model)
			if got != test.want || upstream != "" {
				t.Fatalf("resolveAdobeVideoEngine(%q) = (%q, %q), want (%q, empty)", test.model, got, upstream, test.want)
			}
		})
	}
}

func TestSeedanceCreditEligible(t *testing.T) {
	items := []model.TokenAccount{
		{ID: "low", Meta: datatypes.JSONMap{"cached_quota_remaining": 10}},
		{ID: "unknown", Meta: datatypes.JSONMap{}},
		{ID: "enough", Meta: datatypes.JSONMap{"cached_quota_remaining": 360}},
		{ID: "paid", Meta: datatypes.JSONMap{"cached_quota_remaining": 13080}},
	}
	got := seedanceCreditEligible(items)
	if len(got) != 2 || got[0].ID != "enough" || got[1].ID != "paid" {
		t.Fatalf("eligible = %#v", got)
	}
}
