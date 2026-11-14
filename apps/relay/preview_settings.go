package relay

import "net/http"

const previewSettingsSchema = `CREATE TABLE IF NOT EXISTS preview_settings(id INTEGER PRIMARY KEY CHECK(id=1),max_preview_mib INTEGER NOT NULL CHECK(max_preview_mib BETWEEN 1 AND 128));
INSERT INTO preview_settings(id,max_preview_mib) VALUES(1,32) ON CONFLICT(id) DO NOTHING;
`

func (s *Store) PreviewSettings() M {
	return M{"maxPreviewMiB": num(s.One("SELECT max_preview_mib FROM preview_settings WHERE id=1")["max_preview_mib"])}
}
func (s *Server) previewMaxBytes() int64 {
	return num(s.Store.PreviewSettings()["maxPreviewMiB"]) * 1024 * 1024
}
func (s *Server) previewFileInfo(info M) M {
	result := make(M, len(info)+1)
	for key, value := range info {
		result[key] = value
	}
	result["previewMaxBytes"] = s.previewMaxBytes()
	return result
}
func (s *Server) checkFilePreview(r *http.Request, info M) {
	if r.URL.Query().Get("preview") == "1" && num(info["size"]) > s.previewMaxBytes() {
		fail(413, "file-preview-too-large")
	}
}
func (s *Server) previewSettingsRoutes() {
	s.route("GET /v1/admin/preview-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		return s.Store.PreviewSettings()
	})
	s.route("PUT /v1/admin/preview-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		value := body(r)
		n, ok := value["maxPreviewMiB"].(float64)
		if !ok || len(value) != 1 || n < 1 || n > 128 || n != float64(int(n)) {
			fail(400, "invalid-preview-settings")
		}
		s.Store.Q("UPDATE preview_settings SET max_preview_mib=$1 WHERE id=1", int(n))
		w.Header().Set("Cache-Control", "no-store")
		return s.Store.PreviewSettings()
	})
}
