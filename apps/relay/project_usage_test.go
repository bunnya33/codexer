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

func TestThreadUsageContractAndLegacyPreview(t *testing.T) {
	_, s, _, device := fixture(t)
	thread := M{"id": "thread", "title": "Chat", "cwd": nil, "status": "idle", "activeFlags": []any{},
		"ownerAvailable": true, "truncated": false, "revision": 1, "activeTurnId": nil,
		"updatedAt": 1, "turns": []any{}, "requests": []any{}, "tokenUsage": nil}
	message := M{"type": "device.event", "event": M{"protocolVersion": 1, "deviceId": device,
		"epoch": "epoch", "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": thread}}}
	s.Validate("device", message)
	usage := M{"totalTokens": 2000, "recordedTokens": 1200, "totalKnown": true, "partial": false,
		"models": []any{M{"model": "gpt-5.3-codex", "totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 500, "outputTokens": 200}}}
	thread["usage"] = usage
	s.Validate("device", message)
	for _, key := range []string{"totalKnown", "totalTokens", "models"} {
		invalid := clone(usage)
		switch key {
		case "totalKnown":
			invalid[key] = "yes"
		case "totalTokens":
			invalid[key] = -1
		case "models":
			invalid[key] = []any{M{"model": nil, "totalTokens": 1, "inputTokens": 1, "cachedInputTokens": 2, "outputTokens": 0}}
		}
		thread["usage"] = invalid
		expectFault(t, "invalid-message", func() { s.Validate("device", message) })
	}
}

func TestSubAgentUsageContractAndLegacyPreview(t *testing.T) {
	_, s, _, device := fixture(t)
	agent := M{"threadId": "child", "parentThreadId": "parent", "status": "completed", "statusSource": "activity"}
	thread := M{"id": "parent", "title": "Chat", "cwd": nil, "status": "idle", "activeFlags": []any{},
		"ownerAvailable": true, "truncated": false, "revision": 1, "activeTurnId": nil,
		"updatedAt": 1, "turns": []any{}, "requests": []any{}, "tokenUsage": nil, "subAgents": []any{agent}}
	message := M{"type": "device.event", "event": M{"protocolVersion": 1, "deviceId": device,
		"epoch": "epoch", "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": thread}}}
	s.Validate("device", message) // Old agents still omit child usage.
	usage := M{"totalTokens": 2000, "recordedTokens": 1200, "totalKnown": true, "partial": true,
		"models": []any{M{"model": "gpt-5.3-codex", "totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 500, "outputTokens": 200}}}
	agent["usage"] = usage
	s.Validate("device", message)
	for _, key := range []string{"totalTokens", "models"} {
		invalid := clone(usage)
		if key == "totalTokens" {
			invalid[key] = -1
		} else {
			invalid[key] = []any{M{"model": nil, "totalTokens": 1, "inputTokens": 1, "cachedInputTokens": 2, "outputTokens": 0}}
		}
		agent["usage"] = invalid
		expectFault(t, "invalid-message", func() { s.Validate("device", message) })
	}
}
