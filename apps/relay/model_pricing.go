package relay

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const modelPricingSchema = `CREATE TABLE IF NOT EXISTS model_pricing(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL,catalog TEXT NOT NULL);
INSERT INTO model_pricing(id,revision,catalog) VALUES(1,'','') ON CONFLICT(id) DO NOTHING;
`

//go:embed protocol/default-model-pricing.json
var defaultModelPricing json.RawMessage

var defaultPricingRevision = pricingRevision("default", defaultModelPricing)

func pricingRevision(kind string, raw []byte) string {
	return fmt.Sprintf("%s-%x", kind, sha256.Sum256(raw))
}

func storedPricingRevision(revision string) string {
	if revision == defaultPricingRevision {
		return ""
	}
	return revision
}

func (s *Store) modelPricing(since string) M {
	query := "SELECT revision,catalog AS pricing_json FROM model_pricing WHERE id=1"
	var row M
	if since == "" {
		row = s.One(query)
	} else {
		row = s.One(query+" AND revision<>$1", storedPricingRevision(since))
	}
	if row == nil {
		return nil
	}
	if str(row["revision"]) == "" {
		return M{"revision": defaultPricingRevision, "catalog": defaultModelPricing}
	}
	return M{"revision": row["revision"], "catalog": json.RawMessage(str(row["pricing_json"]))}
}

func (s *Server) modelPricingRoutes() {
	s.route("GET /v1/admin/model-pricing", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		return s.Store.modelPricing("")
	})
	s.route("PUT /v1/admin/model-pricing", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		const maxBytes = 128 * 1024
		data, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
		if len(data) > maxBytes {
			fail(413, "request-too-large")
		}
		var request M
		if err != nil || json.Unmarshal(data, &request) != nil || request == nil || s.schemas["modelPricing"].Validate(request) != nil {
			fail(400, "invalid-model-pricing")
		}
		catalog := obj(request["catalog"])
		if _, err := time.Parse(time.DateOnly, str(catalog["asOf"])); err != nil {
			fail(400, "invalid-model-pricing")
		}
		if source := str(catalog["source"]); source != "" {
			u, err := url.Parse(source)
			if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
				fail(400, "invalid-model-pricing")
			}
		}
		seen := map[string]bool{}
		for _, model := range list(catalog["models"]) {
			id := str(obj(model)["id"])
			if seen[id] {
				fail(400, "duplicate-model-rate")
			}
			seen[id] = true
		}
		raw := json.RawMessage(js(catalog))
		revision := pricingRevision("saved", raw)
		if s.Store.One("UPDATE model_pricing SET revision=$1,catalog=$2 WHERE id=1 AND revision=$3 RETURNING id", revision, string(raw), storedPricingRevision(str(request["revision"]))) == nil {
			fail(409, "model-pricing-conflict")
		}
		w.Header().Set("Cache-Control", "no-store")
		return M{"revision": revision, "catalog": raw}
	})
}
