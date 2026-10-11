package management

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

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
	script, err := os.ReadFile("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(script), "select_runtime() {\n")
	if start < 0 {
		t.Fatal("installer runtime selector missing")
	}
	end := strings.Index(string(script[start:]), "\n}\n")
	if end < 0 {
		t.Fatal("installer runtime selector incomplete")
	}
	selector := string(script[start : start+end+3])
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
