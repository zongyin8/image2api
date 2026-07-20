package handler

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestClientIPPrefersTrustedRealIPOverSpoofedForwardedFor(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("POST", "/admin/api/auth/register", nil)
	ctx.Request.Header.Set("X-Real-IP", "121.27.234.204")
	ctx.Request.Header.Set("X-Forwarded-For", "8.8.8.8, 121.27.234.204")

	if got := clientIP(ctx); got != "121.27.234.204" {
		t.Fatalf("clientIP = %q", got)
	}
}

func TestRegistrationLimitSpecs(t *testing.T) {
	specs := registrationLimitSpecs("121.27.234.204")
	if len(specs) != 2 {
		t.Fatalf("spec count = %d", len(specs))
	}
	if specs[0].limit != 1 || specs[0].window != 10*time.Minute {
		t.Fatalf("short limit = %#v", specs[0])
	}
	if specs[1].limit != 3 || specs[1].window != 24*time.Hour {
		t.Fatalf("daily limit = %#v", specs[1])
	}
}
