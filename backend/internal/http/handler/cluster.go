package handler

import (
	"net/http"
	"strings"
	"time"

	"backend/internal/model"
	"backend/internal/repo"
	"backend/internal/service"
	"github.com/gin-gonic/gin"
)

type ClusterHandler struct {
	nodes *repo.ClusterNodeRepository
}

func NewClusterHandler(nodes *repo.ClusterNodeRepository) *ClusterHandler {
	return &ClusterHandler{nodes: nodes}
}

// Report — POST /admin/api/cluster/nodes/report (machine token). A headless
// worker node pushes its status here; we upsert its row (stamping last_seen).
func (h *ClusterHandler) Report(c *gin.Context) {
	var report service.NodeReport
	if err := c.ShouldBindJSON(&report); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid report body"})
		return
	}
	if strings.TrimSpace(report.NodeID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "node_id is required"})
		return
	}
	node := &model.ClusterNode{
		NodeID:        strings.TrimSpace(report.NodeID),
		BaseURL:       strings.TrimSpace(report.BaseURL),
		Healthy:       true,
		PoolAvailable: report.PoolAvailable,
		PoolTotal:     report.PoolTotal,
		InFlight:      report.InFlight,
		CPUPercent:    report.CPUPercent,
		MemUsedMB:     report.MemUsedMB,
		MemTotalMB:    report.MemTotalMB,
		DiskUsedGB:    report.DiskUsedGB,
		DiskTotalGB:   report.DiskTotalGB,
		Version:       report.Version,
	}
	if err := h.nodes.Upsert(c.Request.Context(), node); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to store report"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Nodes — GET /admin/api/cluster-nodes (admin session). Feeds the cluster panel.
// A node whose last heartbeat is older than NodeStaleWindow is reported offline.
func (h *ClusterHandler) Nodes(c *gin.Context) {
	items, err := h.nodes.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to list nodes"})
		return
	}
	now := time.Now()
	out := make([]gin.H, 0, len(items))
	for _, n := range items {
		online := n.Healthy && now.Sub(n.LastSeen) <= service.NodeStaleWindow
		out = append(out, gin.H{
			"node_id":            n.NodeID,
			"base_url":           n.BaseURL,
			"online":             online,
			"healthy":            n.Healthy,
			"pool_available":     n.PoolAvailable,
			"pool_total":         n.PoolTotal,
			"in_flight":          n.InFlight,
			"cpu_percent":        n.CPUPercent,
			"mem_used_mb":        n.MemUsedMB,
			"mem_total_mb":       n.MemTotalMB,
			"disk_used_gb":       n.DiskUsedGB,
			"disk_total_gb":      n.DiskTotalGB,
			"version":            n.Version,
			"last_error":         n.LastError,
			"last_seen":          n.LastSeen,
			"seconds_since_seen": int(now.Sub(n.LastSeen).Seconds()),
		})
	}
	c.JSON(http.StatusOK, gin.H{"object": "list", "data": out})
}
