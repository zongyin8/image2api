package adobe

import (
	"encoding/base64"
	"testing"
)

func testAdobeJWT(payload string) string {
	return "e30." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
}

func TestIsAuthenticatedAdobeToken(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    bool
	}{
		{name: "adobe user", payload: `{"user_id":"ABC123@AdobeID"}`, want: true},
		{name: "guest", payload: `{"sub":"123@GuestID"}`, want: false},
		{name: "missing identity", payload: `{"client_id":"clio-playground-web"}`, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isAuthenticatedAdobeToken(testAdobeJWT(test.payload)); got != test.want {
				t.Fatalf("isAuthenticatedAdobeToken() = %v, want %v", got, test.want)
			}
		})
	}
}
