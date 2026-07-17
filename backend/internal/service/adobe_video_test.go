package service

import "testing"

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
