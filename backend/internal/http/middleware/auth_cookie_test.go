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

func TestRefreshSessionCookieBearerOverridesStaleCookie(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("GET", "/admin/api/images", nil)
	ctx.Request.Header.Set("Authorization", "Bearer current-session")

	refreshSessionCookie(ctx, &config.Config{
		SessionCookieName: "vivid_session",
		SessionTTL:        24 * time.Hour,
	}, "stale-session")

	setCookie := recorder.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "vivid_session=current-session") {
		t.Fatalf("Set-Cookie = %q, want current Bearer session", setCookie)
	}
	if strings.Contains(setCookie, "stale-session") {
		t.Fatalf("Set-Cookie kept stale session: %q", setCookie)
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
