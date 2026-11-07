package relay

import "testing"

func TestProjectUsageContractAndLegacyCatalog(t *testing.T) {
	_, s, _, device := fixture(t)
	catalog := M{"protocolVersion": 1, "deviceId": device, "generatedAt": now(),
		"projects": []any{M{"id": "p", "name": "Project", "roots": []any{}, "position": 0, "updatedAt": 1}},
		"threads":  []any{}}
	message := M{"type": "device.catalog", "catalog": catalog}
	s.Validate("device", message) // Older agents omit usage entirely.
	usage := M{"totalTokens": 1200, "recordedTokens": 1200, "totalThreads": 2, "knownThreads": 2, "partial": false,
		"models": []any{M{"model": "gpt-5.3-codex", "totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 800, "outputTokens": 200}}}
	obj(list(catalog["projects"])[0])["usage"] = usage
	catalog["unassignedUsage"] = clone(usage)
	s.Validate("device", message)
	for _, key := range []string{"knownThreads", "totalTokens", "models"} {
		invalid := clone(usage)
		switch key {
		case "knownThreads":
			invalid[key] = 3
		case "totalTokens":
			invalid[key] = -1
		case "models":
			invalid[key] = []any{M{"model": nil, "totalTokens": 1, "inputTokens": 1, "cachedInputTokens": 2, "outputTokens": 0}}
		}
		catalog["unassignedUsage"] = invalid
		expectFault(t, "invalid-message", func() { s.Validate("device", message) })
	}
}
