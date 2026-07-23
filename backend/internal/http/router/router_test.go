package router

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAllowLocalFileV1Origin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		path   string
		want   bool
	}{
		{name: "standalone v1 client", origin: "null", path: "/v1/images/generations", want: true},
		{name: "admin remains blocked", origin: "null", path: "/admin/api/auth/login", want: false},
		{name: "unconfigured web origin", origin: "https://example.com", path: "/v1/images/generations", want: false},
		{name: "v1 prefix boundary", origin: "null", path: "/v1", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest("OPTIONS", tt.path, nil)
			if got := allowLocalFileV1Origin(ctx, tt.origin); got != tt.want {
				t.Fatalf("allowLocalFileV1Origin(%q, %q) = %v, want %v", tt.origin, tt.path, got, tt.want)
			}
		})
	}
}
