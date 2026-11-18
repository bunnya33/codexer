package relay

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxOTABundleBytes = 128 << 20

var otaUpdateID = regexp.MustCompile(`^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$`)

type otaRelease struct {
	ID             string    `json:"id"`
	CreatedAt      time.Time `json:"createdAt"`
	RuntimeVersion string    `json:"runtimeVersion"`
	Platform       string    `json:"platform"`
	Label          string    `json:"label,omitempty"`
	RelayURL       string    `json:"relayUrl,omitempty"`
}

type otaAssetReference struct {
	URL  string
	Hash string
}

type otaManifest struct {
	otaRelease
	LaunchAsset otaAssetReference
	Assets      []otaAssetReference
	Metadata    struct {
		RelayUpdateURL string
		ReleaseLabel   string
	}
}

func otaReleaseInfo(update otaSignedManifest, platform, runtime string) (otaManifest, bool) {
	var manifest otaManifest
	if json.Unmarshal(update.Manifest, &manifest) != nil ||
		!otaUpdateID.MatchString(manifest.ID) || manifest.CreatedAt.IsZero() || manifest.RuntimeVersion != runtime {
		return otaManifest{}, false
	}
	manifest.Platform = platform
	manifest.Label = manifest.Metadata.ReleaseLabel
	manifest.RelayURL = manifest.Metadata.RelayUpdateURL
	return manifest, true
}

func otaActiveRelease(root *os.Root, version, platform, runtime string) (otaRelease, error) {
	file, err := root.Open(filepath.Join(version, platform, runtime+".json"))
	if err != nil {
		return otaRelease{}, err
	}
	defer file.Close()
	update, err := readOTASignedManifest(file)
	manifest, valid := otaReleaseInfo(update, platform, runtime)
	_, sigErr := update.signatureBytes()
	if err != nil || !valid || sigErr != nil {
		return otaRelease{}, fs.ErrInvalid
	}
	return manifest.otaRelease, nil
}

func otaPlatform(platform string) bool {
	return platform == "android" || platform == "ios"
}

func (s *Server) adminMobileOTARoutes(directory, version string) {
	const endpoint = "/v1/admin/mobile-ota"
	var write sync.Mutex
	s.route("GET "+endpoint, "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		releases := []otaRelease{}
		invalid := 0
		root, err := os.OpenRoot(directory)
		if errors.Is(err, fs.ErrNotExist) {
			return M{"relayVersion": version, "releases": releases, "invalid": invalid}
		}
		if err != nil {
			fail(500, "ota-storage-error")
		}
		defer root.Close()
		for _, platform := range []string{"android", "ios"} {
			folder, err := root.Open(filepath.Join(version, platform))
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				fail(500, "ota-storage-error")
			}
			entries, err := folder.ReadDir(-1)
			folder.Close()
			if err != nil {
				fail(500, "ota-storage-error")
			}
			for _, entry := range entries {
				runtime, ok := strings.CutSuffix(entry.Name(), ".json")
				if !ok || !otaRuntime.MatchString(runtime) || !entry.Type().IsRegular() {
					continue
				}
				release, err := otaActiveRelease(root, version, platform, runtime)
				switch {
				case errors.Is(err, fs.ErrNotExist):
					// A concurrent filesystem publisher may have removed the manifest.
				case errors.Is(err, fs.ErrInvalid):
					invalid++
				case err != nil:
					fail(500, "ota-storage-error")
				default:
					releases = append(releases, release)
				}
			}
		}
		return M{"relayVersion": version, "releases": releases, "invalid": invalid}
	})
	s.route("PUT "+endpoint, "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if !write.TryLock() {
			fail(409, "ota-busy")
		}
		defer write.Unlock()
		if r.ContentLength > maxOTABundleBytes {
			fail(413, "ota-too-large")
		}
		if !s.beginJob() {
			fail(503, "relay-closing")
		}
		defer s.wg.Done()
		upload := http.MaxBytesReader(w, r.Body, maxOTABundleBytes)
		defer upload.Close()
		stop := context.AfterFunc(s.ctx, func() { upload.Close() })
		defer stop()
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(10 * time.Minute))
		defer controller.SetReadDeadline(time.Time{})
		if os.MkdirAll(directory, 0o755) != nil {
			fail(500, "ota-storage-error")
		}
		staging, err := os.MkdirTemp(directory, ".upload-")
		if err != nil {
			fail(500, "ota-storage-error")
		}
		defer os.RemoveAll(staging)
		bundle := readOTAUpload(upload, staging, version)

		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		s.principal(r, "admin")
		if r.Context().Err() != nil || s.ctx.Err() != nil {
			fail(400, "ota-incomplete")
		}
		root, err := os.OpenRoot(directory)
		if err != nil {
			fail(500, "ota-storage-error")
		}
		defer root.Close()
		active, err := otaActiveRelease(root, version, bundle.Platform, bundle.RuntimeVersion)
		if err != nil && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, fs.ErrInvalid) {
			fail(500, "ota-storage-error")
		}
		if err == nil && !bundle.CreatedAt.After(active.CreatedAt) {
			if active.ID != bundle.ID || !bundle.CreatedAt.Equal(active.CreatedAt) {
				fail(409, "ota-not-newer")
			}
			file, err := root.Open(bundle.path)
			if err != nil {
				fail(409, "ota-changed")
			}
			current, err := io.ReadAll(io.LimitReader(file, maxOTAManifestBytes+1))
			file.Close()
			if err != nil || !bytes.Equal(current, bundle.signed) {
				fail(409, "ota-not-newer")
			}
		}
		if root.MkdirAll("assets", 0o755) != nil || root.MkdirAll(filepath.Dir(bundle.path), 0o755) != nil {
			fail(500, "ota-storage-error")
		}
		stage := filepath.Base(staging)
		for asset := range bundle.assets {
			if root.Rename(filepath.Join(stage, asset), filepath.Join("assets", asset)) != nil {
				fail(500, "ota-storage-error")
			}
		}
		// Rename the signed manifest last. Existing asset URLs remain available.
		if root.Rename(filepath.Join(stage, "manifest.json"), bundle.path) != nil {
			fail(500, "ota-storage-error")
		}
		return M{"release": bundle.otaRelease}
	})
	s.route("DELETE "+endpoint+"/{platform}/{runtime}/{id}", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		platform, runtime, id := r.PathValue("platform"), r.PathValue("runtime"), r.PathValue("id")
		if !otaPlatform(platform) || !otaRuntime.MatchString(runtime) || !otaUpdateID.MatchString(id) {
			fail(400, "invalid-ota-package")
		}
		if !write.TryLock() {
			fail(409, "ota-busy")
		}
		defer write.Unlock()
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		s.principal(r, "admin")
		root, err := os.OpenRoot(directory)
		if errors.Is(err, fs.ErrNotExist) {
			fail(409, "ota-changed")
		}
		if err != nil {
			fail(500, "ota-storage-error")
		}
		defer root.Close()
		release, err := otaActiveRelease(root, version, platform, runtime)
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrInvalid) || err == nil && release.ID != id {
			fail(409, "ota-changed")
		}
		if err != nil || root.Remove(filepath.Join(version, platform, runtime+".json")) != nil {
			fail(500, "ota-storage-error")
		}
		return M{"ok": true}
	})
}

type otaUpload struct {
	otaRelease
	path   string
	signed []byte
	assets map[string]bool
}

func otaUploadReadFailure(err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fail(413, "ota-too-large")
	}
	fail(400, "ota-incomplete")
}

func readOTAUpload(upload io.Reader, staging, version string) otaUpload {
	compressed, err := gzip.NewReader(bufio.NewReader(upload))
	if err != nil {
		otaUploadReadFailure(err)
	}
	defer compressed.Close()
	expanded := &io.LimitedReader{R: compressed, N: maxOTABundleBytes + 1}
	archive := tar.NewReader(expanded)
	bundle := otaUpload{assets: map[string]bool{}}
	var cert []byte
	var platform, runtime string
	for entries := 0; ; entries++ {
		header, err := archive.Next()
		if expanded.N == 0 || entries > 4096 {
			fail(413, "ota-too-large")
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			otaUploadReadFailure(err)
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size <= 0 {
			fail(400, "invalid-ota-package")
		}
		parts := strings.Split(header.Name, "/")
		switch {
		case header.Name == "certificate.pem" && cert == nil && header.Size <= 32*1024:
			cert, err = io.ReadAll(archive)
		case len(parts) == 3 && otaRelayVersion.MatchString(parts[0]) && otaPlatform(parts[1]) && bundle.signed == nil && header.Size <= maxOTAManifestBytes:
			if parts[0] != version {
				fail(409, "ota-relay-version")
			}
			var ok bool
			runtime, ok = strings.CutSuffix(parts[2], ".json")
			if !ok || !otaRuntime.MatchString(runtime) {
				fail(400, "invalid-ota-package")
			}
			platform = parts[1]
			bundle.signed, err = io.ReadAll(archive)
		case len(parts) == 2 && parts[0] == "assets" && otaAsset.MatchString(parts[1]) && !bundle.assets[parts[1]]:
			saveOTAAsset(archive, staging, parts[1])
			bundle.assets[parts[1]] = true
		default:
			fail(400, "invalid-ota-package")
		}
		if err != nil {
			otaUploadReadFailure(err)
		}
	}
	// Finish validating the gzip stream even after tar reaches its end marker.
	_, err = io.Copy(io.Discard, expanded)
	if expanded.N == 0 {
		fail(413, "ota-too-large")
	}
	if err != nil {
		otaUploadReadFailure(err)
	}
	var update otaSignedManifest
	if json.Unmarshal(bundle.signed, &update) != nil {
		fail(400, "invalid-ota-package")
	}
	manifest, valid := otaReleaseInfo(update, platform, runtime)
	if !valid || len(manifest.Label) > 120 || !validOTAAssets(manifest, version, bundle.assets) {
		fail(400, "invalid-ota-package")
	}
	if !verifyOTAUploadSignature(cert, update) {
		fail(400, "invalid-ota-signature")
	}
	if os.WriteFile(filepath.Join(staging, "manifest.json"), bundle.signed, 0o644) != nil {
		fail(500, "ota-storage-error")
	}
	bundle.otaRelease = manifest.otaRelease
	bundle.path = filepath.Join(version, platform, runtime+".json")
	return bundle
}

func saveOTAAsset(input io.Reader, staging, expected string) {
	file, err := os.OpenFile(filepath.Join(staging, expected), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		fail(500, "ota-storage-error")
	}
	digest := sha256.New()
	_, err = io.Copy(file, io.TeeReader(input, digest))
	closeErr := file.Close()
	var writeErr *os.PathError
	if errors.As(err, &writeErr) || closeErr != nil {
		fail(500, "ota-storage-error")
	}
	if err != nil {
		otaUploadReadFailure(err)
	}
	if expected != hex.EncodeToString(digest.Sum(nil)) {
		fail(400, "invalid-ota-assets")
	}
}

func validOTAAssets(manifest otaManifest, version string, assets map[string]bool) bool {
	relay, err := url.Parse(manifest.RelayURL)
	if err != nil || (relay.Scheme != "https" && relay.Scheme != "http") || relay.Hostname() == "" ||
		relay.User != nil || relay.EscapedPath() != "/v1/mobile-ota/manifest" ||
		relay.RawQuery != "relayVersion="+version || relay.Fragment != "" {
		return false
	}
	used := map[string]bool{}
	for _, asset := range append(manifest.Assets, manifest.LaunchAsset) {
		digest, err := base64.RawURLEncoding.DecodeString(asset.Hash)
		if err != nil || len(digest) != sha256.Size {
			return false
		}
		hash := hex.EncodeToString(digest)
		expected := relay.Scheme + "://" + relay.Host + "/v1/mobile-ota/assets/" + hash
		if asset.URL != expected || !assets[hash] {
			return false
		}
		used[hash] = true
	}
	return len(used) == len(assets)
}

func verifyOTAUploadSignature(certificate []byte, update otaSignedManifest) bool {
	block, _ := pem.Decode(certificate)
	signature, err := update.signatureBytes()
	if err != nil || block == nil || block.Type != "CERTIFICATE" {
		return false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return false
	}
	key, ok := cert.PublicKey.(*rsa.PublicKey)
	digest := sha256.Sum256(update.Manifest)
	return ok && rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature) == nil
}
