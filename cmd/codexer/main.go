package main

import (
	"context"
	"fmt"
	relay "github.com/bunnya33/codexer/apps/relay"
	"github.com/bunnya33/codexer/internal/management"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

var version = "0.3.1-dev"

func main() {
	defer func() {
		if e := recover(); e != nil {
			message := "operation-failed"
			if f, ok := e.(relay.Fault); ok {
				message = f.Code
			}
			fmt.Fprintln(os.Stderr, message)
			os.Exit(1)
		}
	}()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version":
			fmt.Println(version)
			return
		case "serve":
		default:
			if e := management.Run(os.Args[1:], version); e != nil {
				fmt.Fprintln(os.Stderr, e)
				os.Exit(1)
			}
			return
		}
	}
	if e := serve(); e != nil {
		log.Print(e)
		os.Exit(1)
	}
}
func serve() error {
	management.LoadEnv(relay.EnvDefault("CODEXER_ENV_FILE", "infra/.env"), false)
	dir := relay.EnvDefault("RELAY_DATA_DIR", ".local/relay")
	database := os.Getenv("DATABASE_URL")
	if database == "" && relay.LegacyData(dir) {
		if _, e := os.Stat(filepath.Join(dir, "relay.sqlite")); e != nil {
			return fmt.Errorf("旧 PostgreSQL 数据需要先迁移：codexer migrate-pglite --legacy-release 旧程序目录 --data-dir %s", dir)
		}
	}
	store, e := relay.Open(database, dir)
	if e != nil {
		return e
	}
	defer store.Close()
	adminFile := relay.EnvDefault("RELAY_ADMIN_FILE", ".local/relay-admin-account.secret")
	if e = store.Bootstrap(adminFile, os.Getenv("RELAY_ADMIN_USERNAME"), relay.AdminEnvPassword()); e != nil {
		return e
	}
	key := []byte(nil)
	if raw := os.Getenv("RELAY_WEIXIN_KEY"); raw != "" {
		key, e = management.DecodeKey(raw)
		if e != nil {
			return e
		}
	}
	s, e := relay.New(store, relay.Options{Version: version, DataDir: dir, WebRoot: os.Getenv("RELAY_WEB_DIR"), AdminRoot: os.Getenv("RELAY_ADMIN_DIR"), UpdateDir: relay.EnvDefault("RELAY_UPDATE_DIR", "/var/lib/codexer-updater/inbox"), UpdateStatus: os.Getenv("RELAY_UPDATE_STATUS"), Origins: relay.SplitOrigins(os.Getenv("RELAY_ALLOWED_ORIGINS")), Weixin: os.Getenv("RELAY_WEIXIN_ENABLED") != "false", WeixinKey: key})
	if e != nil {
		return e
	}
	host := relay.EnvDefault("RELAY_HOST", "127.0.0.1")
	port, e := strconv.Atoi(relay.EnvDefault("RELAY_PORT", "8787"))
	if e != nil || port < 0 || port > 65535 {
		return fmt.Errorf("invalid-port")
	}
	listener, e := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if e != nil {
		s.Close()
		return e
	}
	httpServer := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		<-signals
		s.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpServer.Shutdown(ctx)
	}()
	log.Printf("Codexer %s 已启动：http://%s，数据库 %s，管理员凭据 %s", version, listener.Addr(), map[bool]string{true: "PostgreSQL", false: "SQLite"}[database != ""], adminFile)
	e = httpServer.Serve(listener)
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
