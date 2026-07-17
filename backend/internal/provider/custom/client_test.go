package custom

import (
	"net/http"
	"net/url"
	"testing"
)

func TestNewClientUsesConfiguredProxy(t *testing.T) {
	client := NewClient("http://user:pass@proxy.example.test:8080")
	transport, ok := client.http.Transport.(*http.Transport)
	if !ok || transport.Proxy == nil {
		t.Fatal("custom client transport has no proxy")
	}
	got, err := transport.Proxy(&http.Request{URL: &url.URL{Scheme: "https", Host: "upstream.example.test"}})
	if err != nil {
		t.Fatalf("resolve proxy: %v", err)
	}
	if got.String() != "http://user:pass@proxy.example.test:8080" {
		t.Fatalf("proxy = %q", got.String())
	}
}
