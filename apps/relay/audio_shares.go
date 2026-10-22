package relay

import (
	"html"
	"net/http"
	"strconv"
)

func (s *Server) sharedAudioRequest(r *http.Request, row M) (*http.Request, *Principal) {
	r = r.Clone(r.Context())
	r.SetPathValue("deviceId", str(row["device_id"]))
	r.SetPathValue("threadId", str(row["thread_id"]))
	p := &Principal{ID: str(row["user_id"]), Kind: "user", Share: r.PathValue("key")}
	return r, p
}

func (s *Server) sharedAudioHTTP(w http.ResponseWriter, r *http.Request) {
	s.sharedAudio(w, r, false)
}

func (s *Server) sharedAudioDownload(w http.ResponseWriter, r *http.Request) {
	s.sharedAudio(w, r, true)
}

func (s *Server) sharedAudio(w http.ResponseWriter, r *http.Request, download bool) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	row := s.Store.PublicPreviewShare(r.PathValue("key"))
	if row == nil || row["kind"] != "audio" {
		fail(410, "preview-share-disabled")
	}
	r, p := s.sharedAudioRequest(r, row)
	// Do not freeze an expiry in a context: extending the durable grant must
	// leave listeners connected. Shared pending leases enforce the current expiry.
	s.serveAudio(w, r, &AudioPlayback{Device: str(row["device_id"]), Thread: str(row["thread_id"]), Path: str(row["source"]), Principal: p, Download: download, ctx: s.ctx})
}

func (s *Server) sharedAudioPage(w http.ResponseWriter, r *http.Request, row M) string {
	r, p := s.sharedAudioRequest(r, row)
	info := s.requestTransfer(r, p, "file", M{"path": row["source"]})
	if audioMIME(str(info["name"])) == "" {
		fail(400, "unsupported-audio")
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	name := html.EscapeString(str(info["name"]))
	source := "/share/" + p.Share + "/audio"
	remaining := strconv.FormatInt(max(int64(0), num(row["expires_at"])-now()), 10)
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>音频分享</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f3f6fa;color:#1e293b;font:15px system-ui}.card{width:100%;max-width:560px;padding:28px;border:1px solid #dde5ee;border-radius:16px;background:white}h1{font-size:22px;overflow-wrap:anywhere;margin:0 0 12px}p{color:#64748b;line-height:1.7}audio{width:100%;margin:16px 0}a{color:#176b91}.download{display:inline-block;padding:10px 16px;margin:0 12px 8px 0;border-radius:8px;background:#176b91;color:white;text-decoration:none}#error{color:#b42318}</style></head><body><main class="card"><h1>` + name + `</h1><p>分享的音频</p><audio controls preload="metadata" src="` + source + `"></audio><p id="error" role="alert" hidden>音频暂不可用，请确认电脑在线、源文件仍可访问且分享未到期。</p><p>可播放、暂停或拖动进度。电脑需保持在线。</p><p id="expiry"></p><a class="download" href="` + "/share/" + p.Share + "/download" + `" download>下载音频</a><a href="">重新加载</a></main><script>const a=document.querySelector('audio'),expires=Date.now()+` + remaining + `;document.querySelector('#expiry').textContent='到期时间：'+new Date(expires).toLocaleString();a.addEventListener('error',()=>{document.querySelector('#error').hidden=false});function checkExpiry(){const left=expires-Date.now();if(left<=0){a.pause();a.removeAttribute('src');a.load();location.reload();return}setTimeout(checkExpiry,Math.min(left,2147483647))}checkExpiry();addEventListener('pageshow',()=>{if(Date.now()>=expires)checkExpiry()});</script></body></html>`
}
