package management

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	relay "github.com/bunnya33/codexer/apps/relay"
	"golang.org/x/term"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

func sortedKeys(m map[string]string) []string {
	keys := []string{}
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func command(name string, args ...string) error {
	c := exec.Command(name, args...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}
func output(name string, args ...string) (string, error) {
	b, e := exec.Command(name, args...).Output()
	return strings.TrimSpace(string(b)), e
}
func request(base, path, method, session string, payload any) (relay.M, error) {
	var body io.Reader
	if payload != nil {
		b, e := json.Marshal(payload)
		if e != nil {
			return nil, e
		}
		body = strings.NewReader(string(b))
	}
	r, e := http.NewRequest(method, strings.TrimRight(base, "/")+path, body)
	if e != nil {
		return nil, e
	}
	r.Header.Set("Content-Type", "application/json")
	if session != "" {
		r.Header.Set("Authorization", "Bearer "+session)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	res, e := client.Do(r)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	var result relay.M
	if e = json.NewDecoder(io.LimitReader(res.Body, 8*1024*1024)).Decode(&result); e != nil {
		return nil, e
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %v", res.StatusCode, result["error"])
	}
	return result, nil
}

var promptReader = bufio.NewReader(os.Stdin)

func prompt(label string, secret bool) (string, error) {
	fmt.Print(label)
	if secret && term.IsTerminal(int(os.Stdin.Fd())) {
		b, e := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		return string(b), e
	}
	v, e := promptReader.ReadString('\n')
	return strings.TrimSpace(v), e
}
func account(values map[string]string) relay.M {
	password := values["RELAY_ADMIN_PASSWORD"]
	if b, e := base64.StdEncoding.DecodeString(values["RELAY_ADMIN_PASSWORD_B64"]); e == nil && len(b) > 0 {
		password = string(b)
	}
	return relay.M{"username": values["RELAY_ADMIN_USERNAME"], "password": password}
}
func configPath() string { return relay.EnvDefault("CODEXER_ENV_FILE", "/etc/codexer/relay.env") }
func adminAPI(path, method string, payload any) (relay.M, error) {
	b, e := os.ReadFile(configPath())
	if e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	values := ParseEnv(string(b))
	for _, key := range []string{"RELAY_PORT", "RELAY_ADMIN_USERNAME", "RELAY_ADMIN_PASSWORD", "RELAY_ADMIN_PASSWORD_B64"} {
		if values[key] == "" {
			values[key] = os.Getenv(key)
		}
	}
	if values["RELAY_PORT"] == "" {
		values["RELAY_PORT"] = "8787"
	}
	if values["RELAY_ADMIN_USERNAME"] == "" {
		path := os.Getenv("RELAY_ADMIN_FILE")
		if path != "" {
			if account := relay.ReadJSON(path); account != nil {
				values["RELAY_ADMIN_USERNAME"] = stringValue(account["username"])
				values["RELAY_ADMIN_PASSWORD"] = stringValue(account["password"])
			}
		}
	}
	base := "http://127.0.0.1:" + values["RELAY_PORT"]
	credentials := account(values)
	if credentials["username"] == "" {
		credentials["username"], e = prompt("管理员账号：", false)
		if e != nil {
			return nil, e
		}
		credentials["password"], e = prompt("管理员密码：", true)
		if e != nil {
			return nil, e
		}
	}
	login, e := request(base, "/v1/admin/auth/login", "POST", "", credentials)
	if e != nil {
		return nil, e
	}
	session, _ := login["session"].(string)
	defer request(base, "/v1/auth/logout", "POST", session, nil)
	return request(base, path, method, session, payload)
}
func printJSON(v any) { b, _ := json.MarshalIndent(v, "", "  "); fmt.Println(string(b)) }
func Run(args []string, version string) error {
	if len(args) == 0 {
		return menu(version)
	}
	switch args[0] {
	case "menu":
		return menu(version)
	case "help", "--help":
		fmt.Println("codexer serve | version | health [URL] | users [list|create|password|disable] | start | stop | restart | status | logs | port <端口> | origins <来源列表> | password | info | updater | configure <配置> <旧配置> <访问地址> | migrate-pglite --legacy-release <旧目录> --data-dir <数据目录>")
		return nil
	case "verify":
		if _, e := adminAPI("/v1/me", "GET", nil); e != nil {
			return e
		}
		fmt.Println("管理员登录检查通过。")
		return nil
	case "service-unit":
		fmt.Print(ServiceUnit())
		return nil
	case "configure":
		if len(args) != 4 {
			return errors.New("usage: configure <env> <legacy-env> <public-url>")
		}
		return configureFile(args[1], args[2], args[3])
	case "pm2-field":
		if len(args) != 3 {
			return errors.New("usage: pm2-field <file> <key>")
		}
		b, e := os.ReadFile(args[1])
		if e != nil {
			return e
		}
		var rows []relay.M
		if json.Unmarshal(b, &rows) != nil {
			return errors.New("invalid-pm2-list")
		}
		var found relay.M
		for _, v := range rows {
			if v["name"] == "codexer-relay" {
				if found != nil {
					return errors.New("multiple-legacy-relays")
				}
				found = v
			}
		}
		if found != nil {
			if args[2] == "pm_id" {
				fmt.Print(found["pm_id"])
			} else if m, ok := found["pm2_env"].(map[string]any); ok {
				if v := m[args[2]]; v != nil {
					fmt.Print(v)
				}
			}
		}
		return nil
	case "env-value":
		if len(args) != 3 {
			return errors.New("usage: env-value <file> <key>")
		}
		b, e := os.ReadFile(args[1])
		if e != nil {
			return e
		}
		fmt.Print(ParseEnv(string(b))[args[2]])
		return nil
	case "origin-port":
		if len(args) != 2 {
			return errors.New("usage: origin-port <URL>")
		}
		_, p, e := Origin(args[1], true)
		if e == nil {
			fmt.Print(p)
		}
		return e
	case "migrate-pglite":
		f := flag.NewFlagSet("migrate-pglite", flag.ContinueOnError)
		root := f.String("legacy-release", "", "旧 Node 安装目录")
		data := f.String("data-dir", "", "旧数据库目录")
		if e := f.Parse(args[1:]); e != nil {
			return e
		}
		return MigratePGlite(*root, *data)
	case "updater":
		return ExecuteUpdate()
	case "build-worker":
		if len(args) != 2 {
			return errors.New("invalid-build-worker")
		}
		return BuildWorker(args[1])
	case "health":
		base := ""
		if len(args) > 1 {
			base = args[1]
		}
		if base == "" {
			b, e := os.ReadFile(configPath())
			if e != nil {
				return e
			}
			base = "http://127.0.0.1:" + ParseEnv(string(b))["RELAY_PORT"]
		}
		if !Healthy(base, "", false) {
			return errors.New("service-unavailable")
		}
		fmt.Println("Relay、网页与管理后台检查通过。")
		return nil
	case "start", "stop", "restart":
		if e := command("systemctl", args[0], "codexer-relay.service"); e != nil {
			return e
		}
		if args[0] != "stop" {
			return Run([]string{"health"}, version)
		}
		return nil
	case "status":
		return command("systemctl", "show", "codexer-relay.service", "--property=ActiveState,SubState,MainPID,NRestarts,MemoryCurrent", "--no-pager")
	case "logs":
		return command("journalctl", "-u", "codexer-relay.service", "-n", "100", "-f", "--no-pager")
	case "users":
		return users(args[1:])
	case "password":
		password, e := prompt("新管理员密码：", true)
		if e != nil {
			return e
		}
		me, e := adminAPI("/v1/me", "GET", nil)
		if e != nil {
			return e
		}
		if _, e = adminAPI("/v1/admin/accounts/"+fmt.Sprint(me["userId"])+"/password", "PUT", relay.M{"password": password}); e != nil {
			return e
		}
		source, e := os.ReadFile(configPath())
		if e != nil {
			return e
		}
		values := ParseEnv(string(source))
		credentials := account(values)
		origin := strings.Split(values["RELAY_ALLOWED_ORIGINS"], ",")[0]
		content, e := Configure(string(source), origin, fmt.Sprint(credentials["username"]), password, values["RELAY_ALLOWED_ORIGINS"])
		if e != nil {
			return e
		}
		return os.WriteFile(configPath(), []byte(content), 0640)
	case "port", "origins":
		value := ""
		if len(args) > 1 {
			value = args[1]
		} else {
			var e error
			value, e = prompt("新设置：", false)
			if e != nil {
				return e
			}
		}
		source, e := os.ReadFile(configPath())
		if e != nil {
			return e
		}
		values := ParseEnv(string(source))
		credentials := account(values)
		address := strings.Split(values["RELAY_ALLOWED_ORIGINS"], ",")[0]
		origins := values["RELAY_ALLOWED_ORIGINS"]
		if args[0] == "port" {
			port, e := strconv.Atoi(value)
			if e != nil || port < 1 || port > 65535 {
				return errors.New("invalid-port")
			}
			u, e := url.Parse(address)
			if e != nil {
				return e
			}
			u.Host = u.Hostname() + ":" + fmt.Sprint(port)
			address = u.String()
			origins = ""
		} else {
			origins = value
		}
		content, e := Configure(string(source), address, fmt.Sprint(credentials["username"]), fmt.Sprint(credentials["password"]), origins)
		if e != nil {
			return e
		}
		if e = os.WriteFile(configPath(), []byte(content), 0640); e != nil {
			return e
		}
		if e = Run([]string{"restart"}, version); e != nil {
			os.WriteFile(configPath(), source, 0640)
			command("systemctl", "restart", "codexer-relay.service")
			return e
		}
		fmt.Println("配置已更新：", address)
		return nil
	case "info":
		b, e := os.ReadFile(configPath())
		if e != nil {
			return e
		}
		v := ParseEnv(string(b))
		fmt.Printf("Codexer %s\n访问地址：%s\n配置：%s\n数据：%s\n", version, v["RELAY_ALLOWED_ORIGINS"], configPath(), v["RELAY_DATA_DIR"])
		return nil
	}
	return errors.New("未知命令：运行 codexer help 查看用法")
}
func configureFile(path, legacy, address string) error {
	source, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		source, e = os.ReadFile(legacy)
		if os.IsNotExist(e) {
			source = nil
			e = nil
		}
	}
	if e != nil {
		return e
	}
	values := ParseEnv(string(source))
	credentials := account(values)
	newAccount := false
	if credentials["username"] == "" || credentials["password"] == "" {
		credentials = relay.M{"username": "admin", "password": randomToken()}
		newAccount = true
	}
	content, e := Configure(string(source), address, fmt.Sprint(credentials["username"]), fmt.Sprint(credentials["password"]), values["RELAY_ALLOWED_ORIGINS"])
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0750); e != nil {
		return e
	}
	temp := path + ".new"
	if e = os.WriteFile(temp, []byte(content), 0640); e != nil {
		return e
	}
	if e = os.Rename(temp, path); e != nil {
		return e
	}
	if newAccount {
		fmt.Println("首次管理员账号：", credentials["username"], "密码：", credentials["password"])
	}
	return nil
}
func users(args []string) error {
	if len(args) == 0 {
		for {
			fmt.Println("账号管理：1 查看 2 创建 3 设置密码 4 禁用 0 返回")
			choice, e := prompt("选择：", false)
			if e != nil {
				return e
			}
			if choice == "0" {
				return nil
			}
			action := map[string]string{"1": "list", "2": "create", "3": "password", "4": "disable"}[choice]
			if action != "" {
				if e = users([]string{action}); e != nil {
					fmt.Fprintln(os.Stderr, e)
				}
			}
		}
	}
	method, path := "GET", "/v1/users"
	var payload any
	switch args[0] {
	case "list":
	case "create":
		name := ""
		var e error
		if len(args) > 1 {
			name = args[1]
		} else {
			name, e = prompt("账号名称：", false)
		}
		if e != nil {
			return e
		}
		password, e := prompt("密码：", true)
		if e != nil {
			return e
		}
		method = "POST"
		payload = relay.M{"username": name, "password": password}
	case "password", "disable":
		id := ""
		if len(args) > 1 {
			id = args[1]
		} else {
			var e error
			id, e = prompt("账号 ID：", false)
			if e != nil {
				return e
			}
		}
		path += "/" + url.PathEscape(id)
		if args[0] == "password" {
			password, e := prompt("新密码：", true)
			if e != nil {
				return e
			}
			path += "/password"
			method = "PUT"
			payload = relay.M{"password": password}
		} else {
			confirm, e := prompt("确认禁用？输入 YES：", false)
			if e != nil {
				return e
			}
			if confirm != "YES" {
				return nil
			}
			method = "DELETE"
		}
	default:
		return errors.New("unknown-users-action")
	}
	v, e := adminAPI(path, method, payload)
	if e == nil {
		printJSON(v)
	}
	return e
}
func menu(version string) error {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("交互菜单需要终端；使用 codexer help 查看命令")
	}
	for {
		fmt.Println("Codexer 管理：1 启动 2 停止 3 重启 4 状态 5 日志 6 端口 7 管理员密码 8 账号 9 来源 0 退出")
		choice, e := prompt("选择：", false)
		if e != nil {
			return e
		}
		if choice == "0" {
			return nil
		}
		action := map[string]string{"1": "start", "2": "stop", "3": "restart", "4": "status", "5": "logs", "6": "port", "7": "password", "8": "users", "9": "origins"}[choice]
		if action != "" {
			if e = Run([]string{action}, version); e != nil {
				fmt.Fprintln(os.Stderr, e)
			}
		}
	}
}
func Healthy(base, version string, legacy bool) bool {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	for attempt := 0; attempt < 40; attempt++ {
		ok := true
		for _, path := range []string{"/health", "/", "/admin/"} {
			r, e := client.Get(base + path)
			if e != nil {
				ok = false
				break
			}
			if r.StatusCode != 200 {
				ok = false
			}
			if path == "/health" {
				var m relay.M
				json.NewDecoder(r.Body).Decode(&m)
				if m["ok"] != true || (version != "" && m["version"] != version && !(legacy && m["version"] == nil)) {
					ok = false
				}
			} else if !strings.Contains(r.Header.Get("Content-Type"), "text/html") {
				ok = false
			}
			r.Body.Close()
		}
		if ok {
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}
