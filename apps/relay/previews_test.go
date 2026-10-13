package relay

import (
	"crypto/tls"
	"html"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestPreviewPolicyAllowsScopedResourcesBehindHTTPSProxy(t *testing.T) {
	token := strings.Repeat("a", 64)
	for _, host := range []string{"127.0.0.1:8787", "relay.example", "relay.example:8443", "[::1]:8787"} {
		for _, tlsEnabled := range []bool{false, true} {
			r := httptest.NewRequest("GET", "/v1/previews/"+token+"/", nil)
			r.Host = host
			if tlsEnabled {
				r.TLS = &tls.ConnectionState{}
			}
			r.Header.Set("X-Forwarded-Proto", "https")
			r.Header.Set("X-Forwarded-Host", "untrusted.example; script-src *")
			local := previewAssetSources(r, token)
			document := previewDocument("<html><head></head></html>", "test", nil, local)
			meta := regexp.MustCompile(`<meta http-equiv="Content-Security-Policy" content="([^"]*)">`).FindStringSubmatch(document)
			if len(meta) != 2 {
				t.Fatal("missing escaped document policy")
			}
			policies := []string{previewResponseCSP(local), html.UnescapeString(meta[1])}
			for i, policy := range policies {
				directives := map[string][]string{}
				for _, directive := range strings.Split(policy, ";") {
					fields := strings.Fields(directive)
					if len(fields) > 0 {
						directives[fields[0]] = fields[1:]
					}
				}
				resources := []string{"script-src", "style-src", "connect-src"}
				if i == 1 {
					resources = append(resources, "img-src", "font-src", "media-src", "base-uri", "form-action")
				}
				for _, directive := range resources {
					for _, scheme := range []string{"http", "https"} {
						want := scheme + "://" + host + "/v1/previews/" + token + "/"
						if !slices.Contains(directives[directive], want) {
							t.Fatalf("policy %d %s cannot load %s", i, directive, want)
						}
					}
				}
				for _, source := range strings.Fields(policy) {
					if strings.Contains(source, host) && !strings.HasSuffix(strings.TrimSuffix(source, ";"), "/v1/previews/"+token+"/") {
						t.Fatalf("unscoped Relay source %q", source)
					}
				}
				if strings.Contains(policy, "untrusted.example") || strings.Contains(policy, "allow-same-origin") || strings.Contains(policy, "allow-top-navigation") {
					t.Fatal("preview isolation weakened")
				}
			}
			if !strings.Contains(policies[0], "sandbox allow-scripts allow-forms;") {
				t.Fatal("missing opaque response sandbox")
			}
		}
	}
}

func TestPreviewPolicyRejectsHostAndTokenInjection(t *testing.T) {
	for _, host := range []string{"relay.example;script-src *", "relay.example/path", "user@relay.example", "relay.example?x", "relay.example#x", `relay.example"><script>`, "*.example", "relay.example\n", ""} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = host
		expectFault(t, "invalid-request", func() { previewAssetSources(r, strings.Repeat("a", 64)) })
	}
	r := httptest.NewRequest("GET", "http://relay.example/", nil)
	expectFault(t, "invalid-request", func() { previewAssetSources(r, "../other") })
}
