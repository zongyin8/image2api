package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/internal/service"
	"github.com/gin-gonic/gin"
)

func TestWriteV1ErrorUsesChineseInsufficientCreditsMessage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)

	(&V1Handler{}).writeV1Error(ctx, service.ErrInsufficientFunds, nil)

	if recorder.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusPaymentRequired)
	}
	if body := recorder.Body.String(); body != "{\"detail\":\"积分不足\"}" {
		t.Fatalf("body = %s", body)
	}
}
