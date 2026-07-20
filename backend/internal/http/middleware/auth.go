package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"backend/internal/config"
	"backend/internal/service"
	"github.com/gin-gonic/gin"
)

const currentUserKey = "current_user"
const currentSessionKey = "current_session"

// RequireClusterAdminToken protects the narrow machine-to-machine routes used
// by the cluster console. It is intentionally separate from browser sessions.
func RequireClusterAdminToken(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		expected := strings.TrimSpace(cfg.ClusterAdminToken)
		provided := service.ParseBearer(c.GetHeader("Authorization"))
		if expected == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "invalid cluster admin token"})
			c.Abort()
			return
		}
		c.Next()
	}
}

func RequireSession(auth *service.AuthService, cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		cookieToken := readCookie(c, cfg.SessionCookieName)
		user, session, err := auth.CurrentUserFromRequest(
			c.Request.Context(),
			c.GetHeader("Authorization"),
			cookieToken,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to validate session"})
			c.Abort()
			return
		}
		if user == nil || session == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录或会话已过期"})
			c.Abort()
			return
		}
		refreshSessionCookie(c, cfg, cookieToken)
		c.Set(currentUserKey, user)
		c.Set(currentSessionKey, session)
		c.Next()
	}
}

func RequireAdminSession(auth *service.AuthService, cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		cookieToken := readCookie(c, cfg.SessionCookieName)
		user, session, err := auth.CurrentUserFromRequest(
			c.Request.Context(),
			c.GetHeader("Authorization"),
			cookieToken,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "failed to validate session"})
			c.Abort()
			return
		}
		if user == nil || session == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录或会话已过期"})
			c.Abort()
			return
		}
		if user.Role != "admin" {
			c.JSON(http.StatusForbidden, gin.H{"detail": "需要管理员权限"})
			c.Abort()
			return
		}
		refreshSessionCookie(c, cfg, cookieToken)
		c.Set(currentUserKey, user)
		c.Set(currentSessionKey, session)
		c.Next()
	}
}

// refreshSessionCookie keeps cookie-only browser requests aligned with the
// SPA's authenticated API session. The server-side session already slides
// its TTL on use, but the cookie's Max-Age was frozen at login — so it would
// lapse mid-session and break cookie-only auth (e.g. <img> loads of private
// images) even while the SPA still looks logged in via its Bearer token. Only
// A validated Bearer token is bridged back into the HttpOnly cookie when the
// browser no longer has one.
func refreshSessionCookie(c *gin.Context, cfg *config.Config, cookieToken string) {
	token := service.ParseBearer(c.GetHeader("Authorization"))
	if token == "" {
		token = strings.TrimSpace(cookieToken)
	}
	if token == "" {
		return
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(cfg.SessionCookieName, token, int(cfg.SessionTTL.Seconds()), "/", "", cfg.CookieSecure, true)
}

func readCookie(c *gin.Context, name string) string {
	v, err := c.Cookie(name)
	if err != nil {
		return ""
	}
	return v
}
