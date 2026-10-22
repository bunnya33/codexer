package relay

import "testing"

func TestPreviewShareSourceCanonicalization(t *testing.T) {
	for _, test := range []struct{ input, source, origin, entry string }{
		{"http://localhost:80#section", "http://127.0.0.1/", "http://localhost", "/"},
		{"https://127.0.0.1:443/demo?q=1#section", "https://127.0.0.1/demo?q=1", "https://127.0.0.1", "/demo?q=1"},
		{"http://[::1]:80/demo", "http://[::1]/demo", "http://[::1]", "/demo"},
		{"https://[::1]:443/", "https://[::1]/", "https://[::1]", "/"},
		{"http://[::1]:5173/demo", "http://[::1]:5173/demo", "http://[::1]:5173", "/demo"},
	} {
		t.Run(test.input, func(t *testing.T) {
			source, origin, entry := shareSource("server", test.input)
			if source != test.source || origin != test.origin || entry != test.entry {
				t.Fatalf("got %q %q %q; want %q %q %q", source, origin, entry, test.source, test.origin, test.entry)
			}
		})
	}
}
