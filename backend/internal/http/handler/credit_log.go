package handler

import (
	"net/http"

	"backend/internal/service"
	"github.com/gin-gonic/gin"
)

type CreditLogHandler struct {
	logs *service.CreditLogService
}

func NewCreditLogHandler(logs *service.CreditLogService) *CreditLogHandler {
	return &CreditLogHandler{logs: logs}
}

// List returns the CALLER's own 入账记录 (积分流水,仅入账), newest first.
// GET /admin/api/credit-logs?page=&page_size=
func (h *CreditLogHandler) List(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录或会话已过期"})
		return
	}

	page := parseInt(c.Query("page"), 1)
	pageSize := parseInt(c.Query("page_size"), 20)
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	items, total, err := h.logs.ListByUser(c.Request.Context(), user.ID, page, pageSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to load credit logs"})
		return
	}

	data := make([]gin.H, 0, len(items))
	for _, item := range items {
		data = append(data, gin.H{
			"type":          item.Type,
			"amount":        item.Amount,
			"balance_after": item.BalanceAfter,
			"title":         item.Title,
			"created_at":    unixSec(item.CreatedAt),
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"data":      data,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}
