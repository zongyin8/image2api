package repo

import (
	"context"
	"errors"
	"time"

	"backend/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ClusterNodeRepository struct {
	db *gorm.DB
}

func NewClusterNodeRepository(db *gorm.DB) *ClusterNodeRepository {
	return &ClusterNodeRepository{db: db}
}

// Upsert writes a node's freshly reported status, stamping LastSeen/UpdatedAt to
// now. On conflict (same node_id) every field except created_at is overwritten,
// so a node's row always reflects its latest heartbeat.
func (r *ClusterNodeRepository) Upsert(ctx context.Context, node *model.ClusterNode) error {
	now := time.Now()
	node.LastSeen = now
	node.UpdatedAt = now
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "node_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"base_url", "ip_addr", "provision_url", "healthy",
			"pool_available", "pool_limited", "pool_dead", "pool_total", "in_flight",
			"cpu_percent", "mem_used_mb", "mem_total_mb", "disk_used_gb", "disk_total_gb",
			"version", "last_error", "last_seen", "updated_at",
		}),
	}).Create(node).Error
}

// Get returns a single node by id (nil, nil when absent) — used by the control
// plane's management proxy to resolve a node's provisioner URL.
func (r *ClusterNodeRepository) Get(ctx context.Context, nodeID string) (*model.ClusterNode, error) {
	var item model.ClusterNode
	err := r.db.WithContext(ctx).First(&item, "node_id = ?", nodeID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// Delete drops a node row (decommissioned/zombie). It reappears if the node
// starts reporting again.
func (r *ClusterNodeRepository) Delete(ctx context.Context, nodeID string) (int64, error) {
	res := r.db.WithContext(ctx).Delete(&model.ClusterNode{}, "node_id = ?", nodeID)
	return res.RowsAffected, res.Error
}

// SetDisplayName sets a friendly name (node_id stays the machine identity, and
// isn't overwritten by heartbeat upserts).
func (r *ClusterNodeRepository) SetDisplayName(ctx context.Context, nodeID, name string) error {
	return r.db.WithContext(ctx).Model(&model.ClusterNode{}).
		Where("node_id = ?", nodeID).
		Update("display_name", name).Error
}

// List returns all known nodes, freshest heartbeat first.
func (r *ClusterNodeRepository) List(ctx context.Context) ([]model.ClusterNode, error) {
	var items []model.ClusterNode
	if err := r.db.WithContext(ctx).
		Order("last_seen desc").
		Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

// ByBaseURL returns a lookup keyed by BaseURL, for the dispatcher to join node
// status onto a custom account row (token_accounts.meta.base_url). A node with a
// blank base_url is skipped (it can't be matched to a dispatch target anyway).
func (r *ClusterNodeRepository) ByBaseURL(ctx context.Context) (map[string]model.ClusterNode, error) {
	items, err := r.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]model.ClusterNode, len(items))
	for _, item := range items {
		if item.BaseURL == "" {
			continue
		}
		out[item.BaseURL] = item
	}
	return out, nil
}

// PruneStale removes nodes not seen for longer than olderThan — a node that was
// decommissioned (and stops reporting) eventually drops off the panel instead of
// lingering forever as permanently-offline.
func (r *ClusterNodeRepository) PruneStale(ctx context.Context, olderThan time.Duration) (int64, error) {
	cutoff := time.Now().Add(-olderThan)
	res := r.db.WithContext(ctx).
		Where("last_seen < ?", cutoff).
		Delete(&model.ClusterNode{})
	return res.RowsAffected, res.Error
}
