package relay

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (s *Server) authorizeProject(p *Principal, device, project string) {
	if p == nil || p.Share != "" || s.Store.SessionHash(p.Hash, "") == nil {
		fail(401, "unauthorized")
	}
	if !s.Store.Owns(device, p) {
		fail(404, "device-not-found")
	}
	row := s.Store.One("SELECT payload FROM catalogs WHERE device_id=$1", device)
	if row != nil {
		for _, v := range list(obj(row["payload"])["projects"]) {
			if obj(v)["id"] == project {
				return
			}
		}
	}
	fail(404, "project-not-in-catalog")
}
func validProjectPath(path string) bool {
	if strings.ContainsAny(path, "\\:") || strings.IndexFunc(path, func(r rune) bool { return r < 32 }) >= 0 || strings.HasPrefix(path, "/") {
		return false
	}
	if path == "" {
		return true
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func (s *Server) requestProject(r *http.Request, p *Principal, fields M) M {
	s.Validate("project", fields)
	if !validProjectPath(str(fields["path"])) {
		fail(400, "project-path-invalid")
	}
	op := str(fields["operation"])
	if op == "search" && (fields["query"] == nil || fields["mode"] == nil) || (fields["offset"] == nil) != (fields["version"] == nil) || op != "file" && fields["offset"] != nil {
		fail(400, "invalid-request")
	}
	device, project := r.PathValue("deviceId"), r.PathValue("projectId")
	pending := &Pending{ID: uuid(), Device: device, Thread: project, Kind: "project", Principal: p, ProjectRequest: fields, Reply: make(chan response, 1)}
	var agent *Peer
	s.lane(device, func() {
		s.authorizeProject(p, device, project)
		agent = s.agent(device)
		if agent == nil {
			fail(409, "device-offline")
		}
		agent.mu.Lock()
		supported := agent.projectFiles
		agent.mu.Unlock()
		if !supported {
			fail(409, "project-files-update-required")
		}
		s.addPending(pending, 12, 4)
		if !agent.Send(M{"type": "project.request", "requestId": pending.ID, "projectId": project, "query": fields}) {
			s.removePending(pending.ID)
			fail(409, "device-offline")
		}
	})
	// The cancellation is bound to this authenticated request, never a caller-supplied id.
	defer agent.Send(M{"type": "project.cancel", "requestId": pending.ID})
	result := s.wait(r.Context(), pending, 15*time.Second)
	s.lane(device, func() { s.authorizeProject(p, device, project) })
	return result
}
func (s *Server) acceptProjectTransfer(device string, m M) {
	s.mu.Lock()
	p := s.pending[str(m["requestId"])]
	s.mu.Unlock()
	if p == nil || p.Kind != "project" || p.Device != device || p.Thread != str(m["projectId"]) {
		return
	}
	if m["result"] == nil {
		code := str(m["code"])
		if code == "" {
			code = "project-directory-unavailable"
		}
		p.Reject(Fault{409, code})
		return
	}
	value := obj(m["result"])
	q := p.ProjectRequest
	valid := m["code"] == nil && value["kind"] == q["operation"] && len(js(value)) <= 512*1024
	if q["operation"] == "file" {
		f := obj(value["file"])
		valid = valid && value["file"] != nil && value["entries"] == nil && value["matches"] == nil
		if q["offset"] == nil {
			valid = valid && f["base64"] == nil && f["offset"] == nil
		} else {
			b, e := base64.StdEncoding.DecodeString(str(f["base64"]))
			expected := min(int64(256*1024), num(f["size"])-num(q["offset"]))
			valid = valid && e == nil && f["offset"] != nil && num(f["offset"]) == num(q["offset"]) && f["version"] == q["version"] && f["base64"] != nil && int64(len(b)) == expected
		}
	} else {
		valid = valid && value["file"] == nil
		if q["operation"] == "list" {
			valid = valid && value["entries"] != nil && value["matches"] == nil
		} else {
			valid = valid && value["matches"] != nil && value["entries"] == nil
		}
		for _, e := range list(value["entries"]) {
			entry := obj(e)
			path := str(entry["path"])
			prefix := str(q["path"])
			if prefix != "" {
				prefix += "/"
			}
			valid = valid && validProjectPath(path) && strings.HasPrefix(path, prefix) && !strings.Contains(strings.TrimPrefix(path, prefix), "/") && strings.TrimPrefix(path, prefix) == str(entry["name"])
		}
		for _, e := range list(value["matches"]) {
			path := str(obj(e)["path"])
			prefix := str(q["path"])
			if prefix != "" {
				prefix += "/"
			}
			valid = valid && validProjectPath(path) && strings.HasPrefix(path, prefix)
		}
	}
	if !valid {
		p.Reject(Fault{502, "invalid-file-response"})
	} else {
		p.Resolve(value)
	}
}
func (s *Server) projectFileRoutes() {
	base := "/v1/devices/{deviceId}/projects/{projectId}/files"
	s.route("POST "+base, "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		return s.requestProject(r, p, body(r))
	})
	s.route("GET "+base+"/content", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		root, err := strconv.Atoi(r.URL.Query().Get("rootIndex"))
		if err != nil {
			fail(400, "invalid-request")
		}
		q := M{"operation": "file", "rootIndex": root, "path": r.URL.Query().Get("path"), "version": r.URL.Query().Get("version"), "offset": int64(0)}
		lease := &Pending{ID: uuid(), Device: r.PathValue("deviceId"), Kind: "transfer", Reply: make(chan response, 1)}
		s.addPending(lease, 4, 2)
		defer s.removePending(lease.ID)
		first := obj(s.requestProject(r, p, q)["file"])
		downloadHeaders(w)
		w.Header().Set("Content-Length", str(first["size"]))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\"download\"; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(str(first["name"])), "'", "%27"))
		w.WriteHeader(200)
		file := first
		for offset := int64(0); offset < num(first["size"]); {
			if file["size"] != first["size"] || file["name"] != first["name"] {
				panic(http.ErrAbortHandler)
			}
			bytes, _ := base64.StdEncoding.DecodeString(str(file["base64"]))
			if _, e := w.Write(bytes); e != nil {
				return nil
			}
			offset += int64(len(bytes))
			if offset < num(first["size"]) {
				func() {
					defer func() {
						if recover() != nil {
							panic(http.ErrAbortHandler)
						}
					}()
					q["offset"] = offset
					file = obj(s.requestProject(r, p, q)["file"])
				}()
			}
		}
		return nil
	})
}
