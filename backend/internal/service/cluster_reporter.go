package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"backend/internal/config"
	"backend/internal/repo"
)

// NodeReport is the payload a headless worker node pushes to the control plane.
// It's also the shape the control plane's report endpoint decodes. PoolAvailable
// is the count of accounts that can currently serve a generation (the dispatcher
// skips a node reporting 0), InFlight the node's own in-progress jobs.
type NodeReport struct {
	NodeID        string  `json:"node_id"`
	BaseURL       string  `json:"base_url"`
	PoolAvailable int     `json:"pool_available"`
	PoolTotal     int     `json:"pool_total"`
	InFlight      int     `json:"in_flight"`
	CPUPercent    float64 `json:"cpu_percent"`
	MemUsedMB     int     `json:"mem_used_mb"`
	MemTotalMB    int     `json:"mem_total_mb"`
	Version       string  `json:"version"`
}

// ClusterReporter periodically pushes this node's status to the control plane.
// It only runs on a headless worker node (NodeID + ControlPlaneURL configured);
// the control plane itself never reports.
type ClusterReporter struct {
	cfg    *config.Config
	tokens *repo.TokenRepository
	events *repo.EventRepository
	client *http.Client
}

func NewClusterReporter(cfg *config.Config, tokens *repo.TokenRepository, events *repo.EventRepository) *ClusterReporter {
	return &ClusterReporter{
		cfg:    cfg,
		tokens: tokens,
		events: events,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Enabled reports whether this process is configured to act as a reporting node.
func (r *ClusterReporter) Enabled() bool {
	return strings.TrimSpace(r.cfg.NodeID) != "" && strings.TrimSpace(r.cfg.ControlPlaneURL) != ""
}

const clusterReportInterval = 15 * time.Second

// NodeStaleWindow bounds how long a node's last heartbeat stays trusted. Past
// this, the panel shows it offline and the dispatcher skips it. Sized at 4×
// the report interval so a couple of dropped heartbeats don't flap it offline.
const NodeStaleWindow = 60 * time.Second

// Run pushes status every clusterReportInterval until ctx is cancelled. The first
// report fires immediately so a freshly-started node appears on the panel without
// waiting a full interval.
func (r *ClusterReporter) Run(ctx context.Context) {
	if !r.Enabled() {
		return
	}
	ticker := time.NewTicker(clusterReportInterval)
	defer ticker.Stop()
	if err := r.reportOnce(ctx); err != nil {
		log.Printf("cluster reporter: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.reportOnce(ctx); err != nil {
				log.Printf("cluster reporter: %v", err)
			}
		}
	}
}

func (r *ClusterReporter) reportOnce(ctx context.Context) error {
	report := r.collect(ctx)
	body, _ := json.Marshal(report)
	url := strings.TrimRight(strings.TrimSpace(r.cfg.ControlPlaneURL), "/") + "/admin/api/cluster/nodes/report"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(r.cfg.ClusterAdminToken))
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &reportError{status: resp.StatusCode}
	}
	return nil
}

type reportError struct{ status int }

func (e *reportError) Error() string { return "control plane rejected report: " + http.StatusText(e.status) }

// collect computes this node's current status from its own DB. PoolAvailable is
// accounts that can serve a generation now (active, not dead, not image-limited);
// InFlight is the sum of in-progress jobs across accounts.
func (r *ClusterReporter) collect(ctx context.Context) NodeReport {
	report := NodeReport{
		NodeID:  strings.TrimSpace(r.cfg.NodeID),
		BaseURL: strings.TrimSpace(r.cfg.NodeBaseURL),
		Version: "image2api",
	}
	if tokens, err := r.tokens.List(ctx); err == nil {
		for _, t := range tokens {
			if t.Dead {
				continue
			}
			report.PoolTotal++
			if t.Status == "active" && !t.ImageLimited {
				report.PoolAvailable++
			}
		}
	}
	if inflight, err := r.events.InFlightByAccount(ctx); err == nil {
		var sum int64
		for _, n := range inflight {
			sum += n
		}
		report.InFlight = int(sum)
	}
	return report
}
