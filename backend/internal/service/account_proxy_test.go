package service

import (
	"testing"

	"gorm.io/datatypes"
)

func TestNormalizeAccountProxy(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    string
		wantErr bool
	}{
		{name: "empty clears", value: "  ", want: ""},
		{name: "http", value: "http://user:pass@example.test:8080", want: "http://user:pass@example.test:8080"},
		{name: "socks5", value: "socks5://user:pass@example.test:1080", want: "socks5://user:pass@example.test:1080"},
		{name: "socks5h", value: "socks5h://user:pass@example.test:1080", want: "socks5h://user:pass@example.test:1080"},
		{name: "missing host", value: "socks5://", wantErr: true},
		{name: "unsupported", value: "ftp://example.test:21", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeAccountProxy(test.value)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, test.wantErr)
			}
			if got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

func TestPrepareImportMeta(t *testing.T) {
	meta, weight, err := prepareImportMeta(
		datatypes.JSONMap{"pending_check": true, "team_id": "team-1"},
		[]AccountImportOptions{{ProxyURL: " socks5://user:pass@example.test:1080 ", Weight: 25}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if meta["proxy_url"] != "socks5://user:pass@example.test:1080" || meta["team_id"] != "team-1" || weight != 25 {
		t.Fatalf("meta=%v weight=%d", meta, weight)
	}
}
