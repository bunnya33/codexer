package relay

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"strings"
)

const MaxServerUpdateBytes int64 = 256 * 1024 * 1024

// Inspect the complete archive without executing or extracting uploaded code.
// The privileged updater repeats this check on its own snapshot.
func InspectServerUpdateArchive(filename, version, targetOS, arch string) error {
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return errors.New("invalid-server-bundle")
	}
	defer gz.Close()
	limited := &io.LimitedReader{R: gz, N: 600*1024*1024 + 1}
	tr := tar.NewReader(limited)
	seen := map[string]bool{}
	var manifest M
	var recorded string
	var total int64
	binary := false
	for count := 0; ; count++ {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil || count > 100000 {
			return errors.New("invalid-server-bundle")
		}
		name := strings.TrimSuffix(h.Name, "/")
		if name == "" || path.Clean(name) != name || strings.ContainsAny(name, "\\\x00") || (name != "codexer" && !strings.HasPrefix(name, "codexer/")) || seen[name] {
			return errors.New("unsafe-archive-path")
		}
		seen[name] = true
		if h.Typeflag == tar.TypeDir {
			continue
		}
		if h.Typeflag != tar.TypeReg || h.Size < 0 || h.Size > MaxServerUpdateBytes {
			return errors.New("unsafe-archive-entry")
		}
		total += h.Size
		if total > 512*1024*1024 {
			return errors.New("invalid-server-bundle")
		}
		switch name {
		case "codexer/server-bundle.json":
			if h.Size > 4096 {
				return errors.New("invalid-server-bundle")
			}
			data, e := io.ReadAll(tr)
			if e != nil || json.Unmarshal(data, &manifest) != nil {
				return errors.New("invalid-server-bundle")
			}
		case "codexer/VERSION":
			if h.Size > 100 {
				return errors.New("invalid-server-bundle")
			}
			data, e := io.ReadAll(tr)
			if e != nil {
				return errors.New("invalid-server-bundle")
			}
			recorded = strings.TrimSpace(string(data))
		case "codexer/codexer":
			binary = h.Size >= 1024*1024
		}
		if _, e = io.Copy(io.Discard, tr); e != nil {
			return errors.New("invalid-server-bundle")
		}
	}
	if _, err = io.Copy(io.Discard, limited); err != nil || limited.N <= 0 {
		return errors.New("invalid-server-bundle")
	}
	if !binary || recorded != version || manifest["kind"] != "codexer-server-bundle" || manifest["runtime"] != "go" || manifest["version"] != version || manifest["os"] != targetOS || manifest["arch"] != arch {
		return errors.New("invalid-server-bundle")
	}
	return nil
}
