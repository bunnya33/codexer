package relay

import (
	"io/fs"
	"net/http"
	"strings"
)

// Only static PDF.js application assets are served here. PDF bytes use the
// existing authenticated file transfer; all rendering/search runs on clients.
func (s *Server) documentRoutes() {
	s.mux.HandleFunc("GET /v1/document-runtime/{path...}", func(w http.ResponseWriter, r *http.Request) {
		path := r.PathValue("path")
		if !fs.ValidPath(path) || !(path == "viewer.js" || strings.HasPrefix(path, "cmaps/") || strings.HasPrefix(path, "standard_fonts/") || strings.HasPrefix(path, "wasm/")) {
			http.NotFound(w, r)
			return
		}
		assets, _ := fs.Sub(bundled, "assets/documents")
		if assets == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFileFS(w, r, assets, path)
	})
}
