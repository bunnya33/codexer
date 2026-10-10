package management

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	relay "github.com/bunnya33/codexer/apps/relay"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func randomToken() string {
	b := make([]byte, 18)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Only the first upgrade reads the old PGlite format using that installation's
// existing driver. The running server and all subsequent upgrades are native Go.
const legacyExport = `import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const {PGlite}=await import(pathToFileURL(join(process.argv[1],'node_modules/@electric-sql/pglite/dist/index.js')).href);
const db=new PGlite(process.argv[2]);await db.waitReady;
const tables=['users','devices','snapshots','snapshot_threads','catalogs','events','commands','sessions','tickets','auth_settings','images','weixin_bindings','weixin_targets','weixin_thread_notifications','weixin_outbox','weixin_inbox'];
for(const table of tables){const exists=await db.query('SELECT 1 FROM information_schema.tables WHERE table_name=$1',[table]);if(!exists.rows.length)continue;let offset=0;while(true){const {rows}=await db.query('SELECT * FROM '+table+' ORDER BY 1 LIMIT 10 OFFSET $1',[offset]);for(const row of rows)process.stdout.write(JSON.stringify({table,row})+'\n');if(rows.length<10)break;offset+=rows.length;}}
await db.close();`

func MigratePGlite(root, dir string) (err error) {
	if root == "" || dir == "" || !relay.LegacyData(dir) {
		return errors.New("需要指定旧安装目录和 PGlite 数据目录，并先停止旧服务")
	}
	root, _ = filepath.Abs(root)
	dir, _ = filepath.Abs(dir)
	if _, e := os.Stat(filepath.Join(root, "node_modules/@electric-sql/pglite/dist/index.js")); e != nil {
		return errors.New("找不到旧安装的 PGlite 驱动；请保留旧版本 node_modules 完成一次性迁移")
	}
	target := filepath.Join(dir, "relay.sqlite")
	if _, e := os.Stat(target); e == nil {
		return errors.New("SQLite 数据库已存在，拒绝覆盖")
	}
	backup := dir + ".pglite-backup-" + time.Now().UTC().Format("20060102T150405Z")
	if e := copyTree(dir, backup); e != nil {
		return e
	}
	fmt.Fprintln(os.Stderr, "旧数据库已备份：", backup)
	temp, e := os.MkdirTemp(filepath.Dir(dir), ".sqlite-migration-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	store, e := relay.Open("", temp)
	if e != nil {
		return e
	}
	defer store.Close()
	c := exec.Command("node", "--input-type=module", "-e", legacyExport, root, backup)
	stdout, e := c.StdoutPipe()
	if e != nil {
		return e
	}
	c.Stderr = io.Discard
	if e = c.Start(); e != nil {
		return e
	}
	defer func() {
		if p := recover(); p != nil {
			c.Process.Kill()
			c.Wait()
			err = errors.New("旧数据导入失败，原数据和备份保留")
		}
	}()
	counts := map[string]int{}
	counts = importLegacyRows(store, stdout, c.Wait)
	store.Q("PRAGMA wal_checkpoint(TRUNCATE)")
	if e = store.Close(); e != nil {
		return e
	}
	if e = os.Rename(filepath.Join(temp, "relay.sqlite"), target); e != nil {
		return e
	}
	os.Chmod(target, 0600)
	fmt.Fprintln(os.Stderr, "迁移完成，账号、设备、会话、图片和微信设置已保留：", counts)
	return nil
}
func copyTree(source, target string) error {
	info, e := os.Lstat(source)
	if e != nil {
		return e
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() && !info.Mode().IsRegular() {
		return errors.New("unsafe-source-entry")
	}
	if info.IsDir() {
		if e = os.Mkdir(target, 0700); e != nil {
			return e
		}
		entries, e := os.ReadDir(source)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			if e = copyTree(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())); e != nil {
				return e
			}
		}
		return nil
	}
	src, e := os.Open(source)
	if e != nil {
		return e
	}
	defer src.Close()
	dst, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(dst, src)
	closeErr := dst.Close()
	if e != nil {
		return e
	}
	return closeErr
}

// One transaction validates every exported row before the new file is installed.
func importLegacyRows(store *relay.Store, rows io.Reader, verify func() error) map[string]int {
	counts := map[string]int{}
	store.Tx(func(t *relay.Store) {
		scanner := bufio.NewScanner(rows)
		scanner.Buffer(make([]byte, 65536), 16*1024*1024)
		allowed := map[string]map[string]bool{}
		for _, table := range []string{"users", "devices", "snapshots", "snapshot_threads", "catalogs", "events", "commands", "sessions", "tickets", "auth_settings", "images", "weixin_bindings", "weixin_targets", "weixin_thread_notifications", "weixin_outbox", "weixin_inbox"} {
			columns := map[string]bool{}
			for _, r := range t.Q("PRAGMA table_info(" + table + ")") {
				columns[fmt.Sprint(r["name"])] = true
			}
			allowed[table] = columns
		}
		for scanner.Scan() {
			var entry struct {
				Table string  `json:"table"`
				Row   relay.M `json:"row"`
			}
			if json.Unmarshal(scanner.Bytes(), &entry) != nil || allowed[entry.Table] == nil {
				panic(errors.New("invalid-export"))
			}
			if entry.Table == "sessions" && entry.Row["last_active_at"] == nil {
				entry.Row["last_active_at"] = max(float64(0), entry.Row["expires_at"].(float64)-604800000)
			}
			names, params, values := []string{}, []string{}, []any{}
			for name, value := range entry.Row {
				if !allowed[entry.Table][name] {
					continue
				}
				if name == "payload" || name == "result" {
					if value != nil {
						b, _ := json.Marshal(value)
						value = string(b)
					}
				}
				if number, ok := value.(float64); ok {
					value = int64(number)
				}
				names = append(names, name)
				params = append(params, fmt.Sprintf("$%d", len(values)+1))
				values = append(values, value)
			}
			conflict := ""
			if entry.Table == "auth_settings" {
				conflict = " ON CONFLICT(id) DO NOTHING"
			}
			t.Q("INSERT INTO "+entry.Table+"("+strings.Join(names, ",")+") VALUES("+strings.Join(params, ",")+")"+conflict, values...)
			if entry.Table == "auth_settings" {
				t.Q("UPDATE auth_settings SET idle_timeout_minutes=$1 WHERE id=1", entry.Row["idle_timeout_minutes"])
			}
			counts[entry.Table]++
		}
		if e := scanner.Err(); e != nil {
			panic(e)
		}
		if e := verify(); e != nil {
			panic(e)
		}
		for _, r := range t.Q("SELECT device_id,payload FROM snapshots") {
			m, _ := r["payload"].(map[string]any)
			if threads, ok := m["threads"].(map[string]any); ok {
				for id, v := range threads {
					t.WriteThread(fmt.Sprint(r["device_id"]), id, v.(map[string]any))
				}
				delete(m, "threads")
				b, _ := json.Marshal(m)
				t.Q("UPDATE snapshots SET payload=$2 WHERE device_id=$1", r["device_id"], string(b))
			}
		}
		t.Q("UPDATE commands SET status='unknown',result=json_object('deviceId',device_id,'commandId',id,'status','unknown','code','relay-restarted') WHERE status='pending'")
	})
	return counts
}
