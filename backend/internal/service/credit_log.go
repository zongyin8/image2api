package service

import (
	"context"
	"log"
	"strings"
	"time"

	"backend/internal/model"
	"backend/internal/repo"

	"github.com/google/uuid"
)

// Credit-log types. `recharge` is reserved for the data migration (go2api
// admin_recharge) — live image2api credit grants use admin/redeem/gift/order.
const (
	CreditLogRecharge = "recharge" // 后台充值(迁移用)
	CreditLogRedeem   = "redeem"   // 兑换码
	CreditLogGift     = "gift"     // 赠送(签到/注册等)
	CreditLogAdmin    = "admin"    // 管理员调整
	CreditLogOrder    = "order"    // 易支付充值到账
)

// CreditLogService is the single accounting helper: every place that INCREASES a
// user's balance calls LogCredit to append one 入账记录 row. It is best-effort —
// a logging failure must never roll back or block the actual credit grant.
type CreditLogService struct {
	logs *repo.CreditLogRepository
}

func NewCreditLogService(logs *repo.CreditLogRepository) *CreditLogService {
	return &CreditLogService{logs: logs}
}

// LogCredit appends one 入账记录. amount is the positive credited amount;
// balanceAfter is the user's balance right after the grant. Best-effort: errors
// are logged, never returned, so callers can `s.creditLogs.LogCredit(...)` inline.
func (s *CreditLogService) LogCredit(ctx context.Context, userID, typ string, amount, balanceAfter float64, title string) {
	if s == nil || s.logs == nil {
		return
	}
	userID = strings.TrimSpace(userID)
	if userID == "" || amount <= 0 {
		return
	}
	entry := &model.CreditLog{
		ID:           "cl-" + uuid.NewString()[:12],
		UserID:       userID,
		Type:         strings.TrimSpace(typ),
		Amount:       amount,
		BalanceAfter: balanceAfter,
		Title:        strings.TrimSpace(title),
		CreatedAt:    time.Now(),
	}
	if err := s.logs.Create(ctx, entry); err != nil {
		log.Printf("credit-log insert failed (user=%s type=%s amount=%.2f): %v", userID, typ, amount, err)
	}
}

// ListByUser returns a page of the caller's 入账记录 (newest first).
func (s *CreditLogService) ListByUser(ctx context.Context, userID string, page, pageSize int) ([]model.CreditLog, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	offset := (page - 1) * pageSize
	return s.logs.ListByUser(ctx, userID, pageSize, offset)
}
