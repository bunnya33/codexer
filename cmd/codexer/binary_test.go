package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStandaloneBinaryWithEmbeddedPages(t *testing.T) {
	source := os.Getenv("CODEXER_TEST_BINARY")
	if source == "" {
		t.Skip("set CODEXER_TEST_BINARY after a production build")
	}
	if runtime.GOOS == "windows" {
		t.Skip("server releases target Linux and macOS")
	}
	data, e := os.ReadFile(source)
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "codexer")
	if e = os.WriteFile(binary, data, 0755); e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	env := []string{}
	for _, v := range os.Environ() {
		key := strings.SplitN(v, "=", 2)[0]
		if key != "PATH" && key != "DATABASE_URL" && !strings.HasPrefix(key, "RELAY_") && !strings.HasPrefix(key, "CODEXER_") {
			env = append(env, v)
		}
	}
	env = append(env, "PATH="+dir, "CODEXER_ENV_FILE="+filepath.Join(dir, "absent.env"), "RELAY_HOST=127.0.0.1", fmt.Sprintf("RELAY_PORT=%d", port), "RELAY_DATA_DIR="+filepath.Join(dir, "data"), "RELAY_ADMIN_FILE="+filepath.Join(dir, "admin.secret"), "RELAY_ADMIN_USERNAME=binary-admin", "RELAY_ADMIN_PASSWORD=binary-test-password-12345", "RELAY_WEIXIN_ENABLED=false")
	var command *exec.Cmd
	var output bytes.Buffer
	stop := func() {
		if command == nil {
			return
		}
		command.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- command.Wait() }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			command.Process.Kill()
			<-done
			t.Error("binary did not shut down")
		}
		command = nil
	}
	t.Cleanup(stop)
	start := func() {
		output.Reset()
		command = exec.Command(binary, "serve")
		command.Dir = dir
		command.Env = env
		command.Stdout = &output
		command.Stderr = &output
		if e := command.Start(); e != nil {
			t.Fatal(e)
		}
		client := &http.Client{Timeout: time.Second}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			res, e := client.Get(base + "/health")
			if e == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					return
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		stop()
		t.Fatalf("standalone startup failed: %s", output.String())
	}
	request := func(method, path, session string, payload any) map[string]any {
		t.Helper()
		var body io.Reader
		if payload != nil {
			b, _ := json.Marshal(payload)
			body = bytes.NewReader(b)
		}
		r, _ := http.NewRequest(method, base+path, body)
		r.Header.Set("Content-Type", "application/json")
		if session != "" {
			r.Header.Set("Authorization", "Bearer "+session)
		}
		res, e := (&http.Client{Timeout: 3 * time.Second}).Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("%s status %d", path, res.StatusCode)
		}
		var m map[string]any
		if e = json.NewDecoder(res.Body).Decode(&m); e != nil {
			t.Fatal(e)
		}
		return m
	}
	versionOutput, err := exec.Command(binary, "version").Output()
	if err != nil {
		t.Fatal(err)
	}
	releaseVersion := strings.TrimSpace(string(versionOutput))
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(releaseVersion) {
		t.Fatal("not a production binary")
	}
	start()
	if request("GET", "/health", "", nil)["version"] != releaseVersion {
		t.Fatal("release version")
	}
	for _, path := range []string{"/", "/admin/"} {
		res, e := http.Get(base + path)
		if e != nil {
			t.Fatal(e)
		}
		html, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Type"), "text/html") {
			t.Fatal("embedded page")
		}
		for _, match := range regexp.MustCompile(`(?:src|href)="([^"]+\.(?:js|css))"`).FindAllStringSubmatch(string(html), -1) {
			asset := match[1]
			if strings.HasPrefix(asset, "http") {
				continue
			}
			if !strings.HasPrefix(asset, "/") {
				asset = path + asset
			}
			r, e := http.Get(base + asset)
			if e != nil {
				t.Fatal(e)
			}
			n, _ := io.Copy(io.Discard, r.Body)
			r.Body.Close()
			if r.StatusCode != 200 || n == 0 {
				t.Fatalf("embedded resource %s", asset)
			}
		}
	}
	admin := request("POST", "/v1/admin/auth/login", "", map[string]any{"username": "binary-admin", "password": "binary-test-password-12345"})["session"].(string)
	request("POST", "/v1/users", admin, map[string]any{"username": "binary-user", "password": "binary-user-password-12345"})
	login := func() map[string]any {
		return request("POST", "/v1/agents/login", "", map[string]any{"username": "binary-user", "password": "binary-user-password-12345", "installationId": "12345678-1234-1234-1234-123456789abc", "name": "PC", "platform": "darwin"})
	}
	device := login()["deviceId"]
	stop()
	start()
	if login()["deviceId"] != device {
		t.Fatal("identity not persisted")
	}
	for _, args := range [][]string{{"health", base}, {"verify"}} {
		c := exec.Command(binary, args...)
		c.Dir = dir
		c.Env = env
		if b, e := c.CombinedOutput(); e != nil {
			t.Fatalf("native management %v: %s", args, b)
		}
	}
	if _, e := os.Stat(filepath.Join(dir, "node_modules")); !os.IsNotExist(e) {
		t.Fatal("unexpected runtime dependencies")
	}
}
