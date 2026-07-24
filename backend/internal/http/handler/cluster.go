package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"backend/internal/model"
	"backend/internal/repo"
	"backend/internal/service"
	"github.com/gin-gonic/gin"
)

type ClusterHandler struct {
	nodes        *repo.ClusterNodeRepository
	provisionKey string
	client       *http.Client
}

func NewClusterHandler(nodes *repo.ClusterNodeRepository, provisionKey string) *ClusterHandler {
	return &ClusterHandler{
		nodes:        nodes,
		provisionKey: provisionKey,
		client:       &http.Client{Timeout: 30 * time.Second},
	}
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
		IPAddr:        strings.TrimSpace(report.IPAddr),
		ProvisionURL:  strings.TrimSpace(report.ProvisionURL),
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
			"ip_addr":            n.IPAddr,
			"has_provisioner":    n.ProvisionURL != "",
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

// proxyAllowPrefixes whitelists the node provisioner paths the panel may call.
// Everything else is refused so this can't become an open relay into a node.
var proxyAllowPrefixes = []string{"/api/register", "/api/accounts", "/api/system/metrics"}

func allowedProxyPath(p string) bool {
	if p == "" || strings.Contains(p, "..") || p == "/api/system/restart" {
		return false
	}
	for _, pre := range proxyAllowPrefixes {
		if p == pre || strings.HasPrefix(p, pre) {
			return true
		}
	}
	return false
}

type proxyRequest struct {
	NodeID   string          `json:"node_id"`
	Method   string          `json:"method"`
	Path     string          `json:"path"`
	JSONBody json.RawMessage `json:"json_body"`
}

// Proxy — POST /admin/api/cluster/proxy (admin session). Forwards a management
// call to a node's provisioner, injecting the shared provisioner bearer so the
// node key never reaches the browser (mirrors the legacy console's cluster_proxy).
// Only whitelisted /api/... paths are allowed. The node's raw response is passed
// through verbatim (status + body).
func (h *ClusterHandler) Proxy(c *gin.Context) {
	var req proxyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid proxy request"})
		return
	}
	if !allowedProxyPath(req.Path) {
		c.JSON(http.StatusForbidden, gin.H{"detail": "path not allowed"})
		return
	}
	node, err := h.nodes.Get(c.Request.Context(), strings.TrimSpace(req.NodeID))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "lookup failed"})
		return
	}
	if node == nil || strings.TrimSpace(node.ProvisionURL) == "" {
		c.JSON(http.StatusNotFound, gin.H{"detail": "node has no provisioner endpoint"})
		return
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	url := strings.TrimRight(strings.TrimSpace(node.ProvisionURL), "/") + req.Path
	var body io.Reader
	if len(req.JSONBody) > 0 {
		body = bytes.NewReader(req.JSONBody)
	}
	preq, err := http.NewRequestWithContext(c.Request.Context(), method, url, body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "bad upstream request"})
		return
	}
	if h.provisionKey != "" {
		preq.Header.Set("Authorization", "Bearer "+h.provisionKey)
	}
	if body != nil {
		preq.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.client.Do(preq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "node unreachable"})
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	c.Data(resp.StatusCode, ct, raw)
}
