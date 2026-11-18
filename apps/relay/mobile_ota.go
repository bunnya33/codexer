package relay

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

var otaRuntime = regexp.MustCompile(`^[a-f0-9]{40}$`)
var otaAsset = regexp.MustCompile(`^[a-f0-9]{64}$`)
var otaRelayVersion = regexp.MustCompile(`^[0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10}$`)

const maxOTAManifestBytes = 1024 * 1024

type otaSignedManifest struct {
	Manifest  json.RawMessage
	Signature string
}

func readOTASignedManifest(file io.Reader) (otaSignedManifest, error) {
	var update otaSignedManifest
	err := json.NewDecoder(io.LimitReader(file, maxOTAManifestBytes)).Decode(&update)
	if err == nil && len(update.Manifest) == 0 {
		err = errors.New("missing OTA manifest")
	}
	return update, err
}

func (update otaSignedManifest) signatureBytes() ([]byte, error) {
	signature, err := base64.StdEncoding.DecodeString(update.Signature)
	if err != nil || len(signature) < 256 || len(signature) > 1024 {
		return nil, errors.New("invalid OTA signature")
	}
	return signature, nil
}

func (s *Server) mobileOTARoutes() {
	version := s.Options.Version
	if s.Options.DataDir == "" || !otaRelayVersion.MatchString(version) {
		return
	}
	root := filepath.Join(s.Options.DataDir, "mobile-ota")
	s.adminMobileOTARoutes(root, version)
	s.mux.HandleFunc("GET /v1/mobile-ota/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, M{"relayVersion": version})
	})
	s.mux.HandleFunc("GET /v1/mobile-ota/manifest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Expo-Protocol-Version", "1")
		w.Header().Set("Expo-SFV-Version", "0")
		w.Header().Add("Vary", "Expo-Platform, Expo-Runtime-Version")
		platform := r.Header.Get("Expo-Platform")
		runtime := r.Header.Get("Expo-Runtime-Version")
		if r.URL.Query().Get("relayVersion") != version ||
			(platform != "ios" && platform != "android") || !otaRuntime.MatchString(runtime) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		file, err := os.OpenInRoot(root, filepath.Join(version, platform, runtime+".json"))
		if errors.Is(err, fs.ErrNotExist) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if err != nil {
			fail(500, "server-error")
		}
		defer file.Close()
		update, err := readOTASignedManifest(file)
		if err != nil {
			fail(500, "server-error")
		}
		signature, err := update.signatureBytes()
		if err != nil {
			fail(500, "server-error")
		}
		w.Header().Set("Content-Type", "application/expo+json")
		w.Header().Set("Expo-Signature", `sig="`+base64.StdEncoding.EncodeToString(signature)+`", keyid="root", alg="rsa-v1_5-sha256"`)
		_, _ = w.Write(update.Manifest)
	})
	s.mux.HandleFunc("GET /v1/mobile-ota/assets/{hash}", func(w http.ResponseWriter, r *http.Request) {
		hash := r.PathValue("hash")
		if !otaAsset.MatchString(hash) {
			http.NotFound(w, r)
			return
		}
		file, err := os.OpenInRoot(root, filepath.Join("assets", hash))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("ETag", `"`+hash+`"`)
		http.ServeContent(w, r, hash, info.ModTime(), file)
	})
}
