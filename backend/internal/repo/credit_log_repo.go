package repo

import (
	"context"

	"backend/internal/model"
	"gorm.io/gorm"
)

type CreditLogRepository struct{ db *gorm.DB }

func NewCreditLogRepository(db *gorm.DB) *CreditLogRepository {
	return &CreditLogRepository{db: db}
}

func (r *CreditLogRepository) Create(ctx context.Context, entry *model.CreditLog) error {
	return r.db.WithContext(ctx).Create(entry).Error
}

// ListByUser returns one user's 入账记录, newest first, with pagination + total.
func (r *CreditLogRepository) ListByUser(ctx context.Context, userID string, limit, offset int) ([]model.CreditLog, int64, error) {
	var out []model.CreditLog
	var total int64
	q := r.db.WithContext(ctx).Model(&model.CreditLog{}).Where("user_id = ?", userID)
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		limit = 20
	}
	err := q.Order("created_at desc, id desc").Limit(limit).Offset(offset).Find(&out).Error
	return out, total, err
}
