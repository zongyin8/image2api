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
	nodes             *repo.ClusterNodeRepository
	tokens            *repo.TokenRepository
	provisionKey      string
	clusterAdminToken string
	client            *http.Client
}

func NewClusterHandler(nodes *repo.ClusterNodeRepository, tokens *repo.TokenRepository, provisionKey, clusterAdminToken string) *ClusterHandler {
	return &ClusterHandler{
		nodes:             nodes,
		tokens:            tokens,
		provisionKey:      provisionKey,
		clusterAdminToken: clusterAdminToken,
		client:            &http.Client{Timeout: 30 * time.Second},
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
		PoolLimited:   report.PoolLimited,
		PoolDead:      report.PoolDead,
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
		dn := n.DisplayName
		if dn == "" {
			dn = n.NodeID
		}
		out = append(out, gin.H{
			"node_id":            n.NodeID,
			"display_name":       dn,
			"base_url":           n.BaseURL,
			"ip_addr":            n.IPAddr,
			"has_provisioner":    n.ProvisionURL != "",
			"online":             online,
			"healthy":            n.Healthy,
			"pool_available":     n.PoolAvailable,
			"pool_limited":       n.PoolLimited,
			"pool_dead":          n.PoolDead,
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

// Remove — DELETE /admin/api/cluster-nodes/:id. Drops a node row (a
// decommissioned/zombie node). It reappears if it starts reporting again.
func (h *ClusterHandler) Remove(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "node id required"})
		return
	}
	if _, err := h.nodes.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "delete failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Rename — PATCH /admin/api/cluster-nodes/:id {display_name}. Sets a friendly
// display name; node_id stays the machine identity.
func (h *ClusterHandler) Rename(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	var body struct {
		DisplayName string `json:"display_name"`
	}
	_ = c.ShouldBindJSON(&body)
	if err := h.nodes.SetDisplayName(c.Request.Context(), id, strings.TrimSpace(body.DisplayName)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "rename failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ===== node-local account API (machine token) — this backend's own token pool.
// The panel reaches it on a node via the control plane's forward endpoints.

// NodeAccounts — GET /admin/api/cluster/accounts?pool= (machine token). Lists
// this backend's token accounts (value never returned) for the panel.
func (h *ClusterHandler) NodeAccounts(c *gin.Context) {
	items, err := h.tokens.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "list failed"})
		return
	}
	pool := strings.TrimSpace(c.Query("pool"))
	out := make([]gin.H, 0, len(items))
	for _, t := range items {
		if pool != "" && t.Pool != pool {
			continue
		}
		status := "正常"
		switch {
		case t.Dead:
			status = "已死"
		case t.ImageLimited:
			status = "限流"
		case t.Status != "active":
			status = t.Status
		}
		out = append(out, gin.H{
			"id": t.ID, "pool": t.Pool, "email": t.AccountEmail, "status": status,
			"dead": t.Dead, "image_limited": t.ImageLimited,
			"success": t.SuccessTotal, "fail": t.FailTotal, "last_used": t.LastUsedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// NodeAccountsDelete — DELETE /admin/api/cluster/accounts {ids:[...]} (machine token).
func (h *ClusterHandler) NodeAccountsDelete(c *gin.Context) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "ids required"})
		return
	}
	n, err := h.tokens.DeleteByIDs(c.Request.Context(), body.IDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "delete failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": n})
}

// forwardToNodeBackend proxies to a node's OWN backend cluster API (bearer =
// shared cluster admin token) — for panel actions needing node DB data (accounts)
// which live on the backend, not the provisioner.
func (h *ClusterHandler) forwardToNodeBackend(c *gin.Context, nodeID, method, path string, body []byte) {
	node, err := h.nodes.Get(c.Request.Context(), strings.TrimSpace(nodeID))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "lookup failed"})
		return
	}
	if node == nil || strings.TrimSpace(node.BaseURL) == "" {
		c.JSON(http.StatusNotFound, gin.H{"detail": "node has no base_url"})
		return
	}
	url := strings.TrimRight(strings.TrimSpace(node.BaseURL), "/") + path
	var rd io.Reader
	if len(body) > 0 {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), method, url, rd)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "bad request"})
		return
	}
	req.Header.Set("Authorization", "Bearer "+h.clusterAdminToken)
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "node unreachable"})
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	c.Data(resp.StatusCode, "application/json", raw)
}

// NodeAccountsProxy — GET /admin/api/cluster-nodes/:id/accounts (admin session).
func (h *ClusterHandler) NodeAccountsProxy(c *gin.Context) {
	p := "/admin/api/cluster/accounts"
	if pool := strings.TrimSpace(c.Query("pool")); pool != "" {
		p += "?pool=" + pool
	}
	h.forwardToNodeBackend(c, c.Param("id"), http.MethodGet, p, nil)
}

// NodeAccountsRemoveProxy — DELETE /admin/api/cluster-nodes/:id/accounts (admin session).
func (h *ClusterHandler) NodeAccountsRemoveProxy(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	h.forwardToNodeBackend(c, c.Param("id"), http.MethodDelete, "/admin/api/cluster/accounts", body)
}
