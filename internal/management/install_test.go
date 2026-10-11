package management

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func installerShellFunction(t *testing.T, name string) string {
	t.Helper()
	script, err := os.ReadFile("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(script), name+"() {\n")
	if start < 0 {
		t.Fatal("installer runtime selector missing")
	}
	end := strings.Index(string(script[start:]), "\n}\n")
	if end < 0 {
		t.Fatal("installer runtime selector incomplete")
	}
	return string(script[start : start+end+3])
}

func TestInstallerSelectsBinaryWithoutBuildTools(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux installer requires Bash")
	}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("Bash unavailable")
	}
	chmod, err := exec.LookPath("chmod")
	if err != nil {
		t.Fatal(err)
	}
	selector := installerShellFunction(t, "select_runtime")
	for _, test := range []struct {
		name, want                             string
		binary, marker, source, tools, symlink bool
	}{
		{name: "permissions lost", binary: true, marker: true},
		{name: "single binary without marker", binary: true},
		{name: "bundle priority over source", binary: true, source: true, tools: true},
		{name: "missing bundle executable", marker: true, source: true, tools: true, want: "发布包缺少 codexer"},
		{name: "incomplete directory", want: "没有 codexer 执行文件或完整源码"},
		{name: "actual source without tools", source: true, want: "当前目录是源码"},
		{name: "actual source with tools", source: true, tools: true},
		{name: "binary symlink", binary: true, symlink: true, want: "不能是符号链接"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "release with spaces")
			toolsDir := t.TempDir()
			if err := os.MkdirAll(dir, 0755); err != nil {
				t.Fatal(err)
			}
			write := func(name string, mode os.FileMode) {
				t.Helper()
				p := filepath.Join(dir, name)
				if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, []byte("fixture"), mode); err != nil {
					t.Fatal(err)
				}
			}
			if test.binary {
				write("codexer", 0644)
			}
			if test.symlink {
				if err := os.Rename(filepath.Join(dir, "codexer"), filepath.Join(dir, "target")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("target", filepath.Join(dir, "codexer")); err != nil {
					t.Fatal(err)
				}
			}
			if test.marker {
				write("server-bundle.json", 0644)
			}
			if test.source {
				for _, name := range []string{"package.json", "go.mod", "cmd/codexer/main.go", "scripts/build-server.mjs"} {
					write(name, 0644)
				}
			}
			if err := os.Symlink(chmod, filepath.Join(toolsDir, "chmod")); err != nil {
				t.Fatal(err)
			}
			calls := filepath.Join(dir, "calls")
			if test.tools {
				for _, name := range []string{"go", "node", "npm"} {
					stub := "#!/bin/bash\nprintf '%s\\n' '" + name + "' >>\"$TEST_CALL_LOG\"\n"
					if err := os.WriteFile(filepath.Join(toolsDir, name), []byte(stub), 0755); err != nil {
						t.Fatal(err)
					}
				}
			}
			program := "set -Eeuo pipefail\nsource_dir=$TEST_RELEASE_DIR\nfail() { printf '%s\\n' \"$*\" >&2; exit 1; }\n" + selector + "\nselect_runtime\nprintf '%s\\n' \"$binary\"\n"
			cmd := exec.Command(bash, "--noprofile", "--norc", "-c", program)
			cmd.Env = []string{"PATH=" + toolsDir, "TEST_RELEASE_DIR=" + dir, "TEST_CALL_LOG=" + calls}
			output, err := cmd.CombinedOutput()
			if test.want != "" {
				if err == nil || !strings.Contains(string(output), test.want) {
					t.Fatalf("want %q failure, got %s (%v)", test.want, output, err)
				}
			} else if err != nil {
				t.Fatalf("runtime selection failed: %s (%v)", output, err)
			} else {
				selected := filepath.Join(dir, "codexer")
				if !test.binary {
					selected = filepath.Join(dir, "dist/codexer")
				}
				if strings.TrimSpace(string(output)) != selected {
					t.Fatalf("selected wrong runtime: %s", output)
				}
				if test.binary {
					info, err := os.Stat(selected)
					if err != nil || info.Mode().Perm() != 0755 {
						t.Fatal("binary execute permissions not restored")
					}
				}
			}
			buildCalls, _ := os.ReadFile(calls)
			if test.source && test.tools && !test.binary && test.want == "" {
				if string(buildCalls) != "npm\nnpm\n" {
					t.Fatalf("source build not invoked: %s", buildCalls)
				}
			} else if len(buildCalls) != 0 {
				t.Fatalf("unexpected build tool invocation: %s", buildCalls)
			}
		})
	}
}

func TestInstallerPreservesExistingCredentialsOnlyWhenHealthy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux installer requires Bash")
	}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("Bash unavailable")
	}
	verification := installerShellFunction(t, "verify_installation")
	for _, test := range []struct {
		name, healthExit, verifyExit, output string
		ok, stale                            bool
	}{
		{name: "authenticated", healthExit: "0", verifyExit: "0", output: "管理员登录检查通过。", ok: true},
		{name: "healthy existing password", healthExit: "0", verifyExit: "1", output: "HTTP 401: invalid-credentials", ok: true, stale: true},
		{name: "forbidden", healthExit: "0", verifyExit: "1", output: "HTTP 403: admin-required"},
		{name: "server failure", healthExit: "0", verifyExit: "1", output: "HTTP 500: server-error"},
		{name: "different unauthorized failure", healthExit: "0", verifyExit: "1", output: "HTTP 401: unauthorized"},
		{name: "configuration failure", healthExit: "0", verifyExit: "1", output: "configuration unreadable"},
		{name: "unhealthy service", healthExit: "1", verifyExit: "0", output: "管理员登录检查通过。"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "codexer")
			config := filepath.Join(dir, "relay.env")
			calls := filepath.Join(dir, "calls")
			original := []byte("existing credentials must remain unchanged\n")
			if err := os.WriteFile(config, original, 0600); err != nil {
				t.Fatal(err)
			}
			stub := `#!/bin/bash
printf '%s\n' "$1" >>"$TEST_CALL_LOG"
case "$1" in
  health)
    [[ $2 == http://127.0.0.1:30303 ]] || exit 20
    [[ $TEST_HEALTH_EXIT == 0 ]] && printf 'Relay、网页与管理后台检查通过。\n'
    exit "$TEST_HEALTH_EXIT" ;;
  verify)
    [[ $CODEXER_ENV_FILE == "$TEST_CONFIG" ]] || exit 21
    printf '%s\n' "$TEST_VERIFY_OUTPUT"
    exit "$TEST_VERIFY_EXIT" ;;
  *) exit 22 ;;
esac
`
			if err := os.WriteFile(binary, []byte(stub), 0755); err != nil {
				t.Fatal(err)
			}
			program := "set -Eeuo pipefail\nbinary=$TEST_BINARY\nconfig_file=$TEST_CONFIG\nport=30303\n" + verification + "\nverify_installation\n"
			cmd := exec.Command(bash, "--noprofile", "--norc", "-c", program)
			cmd.Env = []string{"PATH=" + dir, "TEST_BINARY=" + binary, "TEST_CONFIG=" + config, "TEST_CALL_LOG=" + calls, "TEST_HEALTH_EXIT=" + test.healthExit, "TEST_VERIFY_EXIT=" + test.verifyExit, "TEST_VERIFY_OUTPUT=" + test.output}
			output, err := cmd.CombinedOutput()
			if (err == nil) != test.ok {
				t.Fatalf("unexpected verification result: %s (%v)", output, err)
			}
			if test.stale && (!strings.Contains(string(output), "使用后台当前账号密码") || strings.Contains(string(output), "管理员登录检查通过")) {
				t.Fatal("stale credentials must be reported without claiming authentication succeeded")
			}
			steps, _ := os.ReadFile(calls)
			want := "health\nverify\n"
			if test.healthExit != "0" {
				want = "health\n"
			}
			if string(steps) != want {
				t.Fatalf("verification order: %s", steps)
			}
			current, err := os.ReadFile(config)
			if err != nil || string(current) != string(original) {
				t.Fatal("verification modified credentials")
			}
		})
	}
}
