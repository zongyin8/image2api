package middleware

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"backend/internal/config"
	"github.com/gin-gonic/gin"
)

func TestRefreshSessionCookieFromBearerToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("GET", "/admin/api/images", nil)
	ctx.Request.Header.Set("Authorization", "Bearer browser-session")

	refreshSessionCookie(ctx, &config.Config{
		SessionCookieName: "vivid_session",
		SessionTTL:        24 * time.Hour,
		CookieSecure:      true,
	}, "")

	setCookie := recorder.Header().Get("Set-Cookie")
	for _, want := range []string{"vivid_session=browser-session", "HttpOnly", "Secure", "SameSite=Lax"} {
		if !strings.Contains(setCookie, want) {
			t.Fatalf("Set-Cookie = %q, want it to contain %q", setCookie, want)
		}
	}
}

func TestRefreshSessionCookieDoesNothingWithoutSessionToken(t *testing.T) {
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("GET", "/admin/api/images", nil)

	refreshSessionCookie(ctx, &config.Config{
		SessionCookieName: "vivid_session",
		SessionTTL:        24 * time.Hour,
	}, "")

	if got := recorder.Header().Get("Set-Cookie"); got != "" {
		t.Fatalf("unexpected Set-Cookie: %q", got)
	}
}
