package relay

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestLegacyAgentPolicyMigration(t *testing.T) {
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, "relay.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("CREATE TABLE auth_settings(id INTEGER PRIMARY KEY, idle_timeout_minutes INTEGER NOT NULL); INSERT INTO auth_settings VALUES(1,60)")
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	store, err := Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	settings := store.AuthSettings()
	if num(settings["idleTimeoutMinutes"]) != 60 || num(settings["agentSessionDays"]) != 7 {
		t.Fatalf("migration changed policy: %v", settings)
	}
	store.UpdateAuthSettings(M{"agentSessionDays": int64(0)})
	store.Close()
	store, err = Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if num(store.AuthSettings()["agentSessionDays"]) != 0 {
		t.Fatal("reopening reset the nonexpiring policy")
	}
}
