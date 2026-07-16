package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"backend/internal/config"
	"github.com/gin-gonic/gin"
)

func TestRequireClusterAdminToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name       string
		configured string
		provided   string
		wantStatus int
	}{
		{name: "valid", configured: "cluster-secret", provided: "cluster-secret", wantStatus: http.StatusNoContent},
		{name: "wrong", configured: "cluster-secret", provided: "wrong", wantStatus: http.StatusUnauthorized},
		{name: "disabled", configured: "", provided: "cluster-secret", wantStatus: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := gin.New()
			r.Use(RequireClusterAdminToken(&config.Config{ClusterAdminToken: tt.configured}))
			r.GET("/", func(c *gin.Context) { c.Status(http.StatusNoContent) })
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("Authorization", "Bearer "+tt.provided)
			res := httptest.NewRecorder()
			r.ServeHTTP(res, req)
			if res.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", res.Code, tt.wantStatus)
			}
		})
	}
}
