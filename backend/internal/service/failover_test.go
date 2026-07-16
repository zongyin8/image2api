package service

import (
	"errors"
	"fmt"
	"testing"

	"backend/internal/model"
)

func foCfg(id string, weight int) model.ModelConfig {
	return model.ModelConfig{ID: id, Weight: weight}
}

func TestIsFailoverEligible(t *testing.T) {
	eligible := []error{
		ErrNoProviderAccount,
		ErrProviderAuth,
		ErrProviderQuota,
		ErrProviderTemporary,
		fmt.Errorf("dispatch: %w", ErrProviderTemporary), // wrapped still eligible
	}
	for _, e := range eligible {
		if !isFailoverEligible(e) {
			t.Errorf("expected eligible for %v", e)
		}
	}
	notEligible := []error{
		nil,
		ErrUnknownModel,
		ErrUserConcurrencyFull,
		ErrProviderExecution, // generic/content failure — must NOT fail over
		fmt.Errorf("execution: %w", ErrProviderExecution),
		errors.New("insufficient credits"),
	}
	for _, e := range notEligible {
		if isFailoverEligible(e) {
			t.Errorf("expected NOT eligible for %v", e)
		}
	}
}

// primary unavailable → falls over to the next backend and returns its success.
func TestRunWithFailover_SkipsUnavailableUntilSuccess(t *testing.T) {
	group := []model.ModelConfig{foCfg("adobe", 10), foCfg("runway", 5)}
	var tried []string
	res, err := runWithFailover(group, func(c *model.ModelConfig) (map[string]any, error) {
		tried = append(tried, c.ID)
		if c.ID == "adobe" {
			return nil, ErrProviderTemporary
		}
		return map[string]any{"model": c.ID}, nil
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got := fmt.Sprint(tried); got != "[adobe runway]" {
		t.Fatalf("try order = %s, want [adobe runway]", got)
	}
	if res["model"] != "runway" {
		t.Fatalf("served by %v, want runway", res["model"])
	}
}

// a user-level error (not unavailable) stops immediately — no wasted 2nd attempt.
func TestRunWithFailover_StopsOnUserError(t *testing.T) {
	group := []model.ModelConfig{foCfg("adobe", 10), foCfg("runway", 5)}
	insufficient := errors.New("insufficient credits")
	var tried []string
	_, err := runWithFailover(group, func(c *model.ModelConfig) (map[string]any, error) {
		tried = append(tried, c.ID)
		return nil, insufficient
	})
	if !errors.Is(err, insufficient) {
		t.Fatalf("err = %v, want insufficient", err)
	}
	if got := fmt.Sprint(tried); got != "[adobe]" {
		t.Fatalf("try order = %s, want [adobe] only", got)
	}
}

// ErrProviderExecution (generic) must NOT trigger failover.
func TestRunWithFailover_StopsOnExecutionError(t *testing.T) {
	group := []model.ModelConfig{foCfg("adobe", 10), foCfg("runway", 5)}
	var tried []string
	_, err := runWithFailover(group, func(c *model.ModelConfig) (map[string]any, error) {
		tried = append(tried, c.ID)
		return nil, fmt.Errorf("boom: %w", ErrProviderExecution)
	})
	if !errors.Is(err, ErrProviderExecution) {
		t.Fatalf("err = %v, want ErrProviderExecution", err)
	}
	if got := fmt.Sprint(tried); got != "[adobe]" {
		t.Fatalf("try order = %s, want [adobe] only", got)
	}
}

// every backend unavailable → returns the LAST attempt's error after trying all.
func TestRunWithFailover_AllUnavailableReturnsLastErr(t *testing.T) {
	group := []model.ModelConfig{foCfg("adobe", 10), foCfg("runway", 5)}
	var tried []string
	_, err := runWithFailover(group, func(c *model.ModelConfig) (map[string]any, error) {
		tried = append(tried, c.ID)
		if c.ID == "adobe" {
			return nil, ErrProviderTemporary
		}
		return nil, ErrProviderQuota
	})
	if !errors.Is(err, ErrProviderQuota) {
		t.Fatalf("err = %v, want last error ErrProviderQuota", err)
	}
	if got := fmt.Sprint(tried); got != "[adobe runway]" {
		t.Fatalf("try order = %s, want both tried", got)
	}
}

// first backend succeeds → the second is never touched.
func TestRunWithFailover_FirstSuccessShortCircuits(t *testing.T) {
	group := []model.ModelConfig{foCfg("adobe", 10), foCfg("runway", 5)}
	var tried []string
	res, err := runWithFailover(group, func(c *model.ModelConfig) (map[string]any, error) {
		tried = append(tried, c.ID)
		return map[string]any{"model": c.ID}, nil
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got := fmt.Sprint(tried); got != "[adobe]" {
		t.Fatalf("try order = %s, want [adobe] only", got)
	}
	if res["model"] != "adobe" {
		t.Fatalf("served by %v, want adobe", res["model"])
	}
}

func TestFilterAvailableModelGroupSkipsUnavailableBackend(t *testing.T) {
	group := []model.ModelConfig{foCfg("runway", 10), foCfg("adobe", 5)}

	filtered, err := filterAvailableModelGroup(group, func(cfg *model.ModelConfig) (bool, error) {
		return cfg.ID == "adobe", nil
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(filtered) != 1 || filtered[0].ID != "adobe" {
		t.Fatalf("filtered = %v, want adobe only", filtered)
	}
}

func TestFilterAvailableModelGroupKeepsOriginalWhenNoneAvailable(t *testing.T) {
	group := []model.ModelConfig{foCfg("runway", 10), foCfg("adobe", 5)}

	filtered, err := filterAvailableModelGroup(group, func(*model.ModelConfig) (bool, error) {
		return false, nil
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got := fmt.Sprint([]string{filtered[0].ID, filtered[1].ID}); got != "[runway adobe]" {
		t.Fatalf("filtered = %v, want original group", filtered)
	}
}
