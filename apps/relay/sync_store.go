package relay

import (
	"context"
	"database/sql"
	"time"
)

func (s *Store) Snapshot(id string) M {
	if s.q == s.DB {
		options := &sql.TxOptions{ReadOnly: true}
		if !s.SQLite {
			options.Isolation = sql.LevelRepeatableRead
		}
		tx, e := s.DB.BeginTx(context.Background(), options)
		if e != nil {
			panic(e)
		}
		defer tx.Rollback()
		t := &Store{DB: s.DB, q: tx, SQLite: s.SQLite, Metrics: s.Metrics}
		m := t.Snapshot(id)
		if e = tx.Commit(); e != nil {
			panic(e)
		}
		return m
	}

	r := s.One("SELECT payload FROM snapshots WHERE device_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)", id)
	if r == nil {
		return nil
	}
	m := obj(r["payload"])
	threads := M{}
	for _, t := range s.Q("SELECT thread_id,payload FROM snapshot_threads WHERE device_id=$1", id) {
		threads[str(t["thread_id"])] = t["payload"]
	}
	m["threads"] = threads
	return m
}
func (s *Store) SaveSnapshot(m M) {
	sanitize(m)
	s.Tx(func(t *Store) {
		id := str(m["deviceId"])
		t.Q("SELECT id FROM devices WHERE id=$1 FOR UPDATE", id)
		before := t.Snapshot(id)
		if before != nil && before["epoch"] == m["epoch"] && num(before["lastSeq"]) > num(m["lastSeq"]) {
			fail(409, "stale-snapshot")
		}
		head := clone(m)
		delete(head, "threads")
		t.Q("INSERT INTO snapshots(device_id,epoch,seq,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(device_id) DO UPDATE SET epoch=EXCLUDED.epoch,seq=EXCLUDED.seq,payload=EXCLUDED.payload", id, m["epoch"], m["lastSeq"], js(head))
		t.Q("DELETE FROM snapshot_threads WHERE device_id=$1", id)
		for tid, v := range obj(m["threads"]) {
			t.WriteThread(id, tid, obj(v))
		}
		t.Completions(before, m)
	})
}
func (s *Store) WriteThread(id, thread string, payload M) {
	s.Q("INSERT INTO snapshot_threads(device_id,thread_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(device_id,thread_id) DO UPDATE SET payload=EXCLUDED.payload", id, thread, js(payload))
}
func (s *Store) SaveEvent(e M) {
	start := time.Now()
	defer func() {
		e := recover()
		s.Metrics.Observe("events", start, e != nil)
		if e != nil {
			panic(e)
		}
	}()
	sanitize(e)
	s.Tx(func(t *Store) {
		id := str(e["deviceId"])
		row := t.One("SELECT payload FROM snapshots WHERE device_id=$1 FOR UPDATE", id)
		if row == nil {
			fail(409, "sequence-gap")
		}
		head := obj(row["payload"])
		if head["epoch"] != e["epoch"] || num(e["seq"]) != num(head["lastSeq"])+1 {
			fail(409, "sequence-gap")
		}
		before := clone(head)
		before["threads"] = M{}
		change := obj(e["change"])
		kind := str(change["type"])
		if kind == "thread.updated" {
			thread := obj(change["thread"])
			tid := str(thread["id"])
			previous := t.One("SELECT payload FROM snapshot_threads WHERE device_id=$1 AND thread_id=$2", id, tid)
			if previous != nil {
				obj(before["threads"])[tid] = previous["payload"]
			} else if num(t.One("SELECT COUNT(*) AS total FROM snapshot_threads WHERE device_id=$1", id)["total"]) >= 20 {
				fail(400, "thread-limit")
			}
			t.WriteThread(id, tid, thread)
		} else if kind == "thread.removed" {
			t.Q("DELETE FROM snapshot_threads WHERE device_id=$1 AND thread_id=$2", id, change["threadId"])
		} else if kind == "runtime.status" {
			runtime := obj(head["runtime"])
			runtime["connected"] = change["connected"]
			if change["kind"] != nil {
				runtime["kind"] = change["kind"]
			}
		}
		head["generatedAt"] = e["timestamp"]
		head["lastSeq"] = e["seq"]
		t.Q("INSERT INTO events(device_id,epoch,seq,payload,created_at) VALUES($1,$2,$3,$4::jsonb,$5)", id, e["epoch"], e["seq"], js(e), now())
		t.Q("UPDATE snapshots SET seq=$2,payload=$3::jsonb WHERE device_id=$1", id, e["seq"], js(head))
		after := clone(head)
		after["threads"] = M{}
		if kind == "thread.updated" {
			obj(after["threads"])[str(obj(change["thread"])["id"])] = change["thread"]
		}
		t.Completions(before, after)
	})
}
func (s *Store) Replay(id, epoch string, seq int64) ([]M, bool) {
	head := s.One("SELECT epoch,seq FROM snapshots WHERE device_id=$1", id)
	if head == nil || str(head["epoch"]) != epoch || seq > num(head["seq"]) {
		return nil, false
	}
	if seq == num(head["seq"]) {
		return []M{}, true
	}
	rows := s.Q("SELECT seq,payload FROM events WHERE device_id=$1 AND epoch=$2 AND seq>$3 ORDER BY seq LIMIT 1000", id, epoch, seq)
	if int64(len(rows)) != num(head["seq"])-seq {
		return nil, false
	}
	out := []M{}
	for i, r := range rows {
		if num(r["seq"]) != seq+int64(i)+1 {
			return nil, false
		}
		out = append(out, obj(r["payload"]))
	}
	return out, true
}
func (s *Store) Command(device, id string) M {
	return s.One("SELECT payload_hash,status,result FROM commands WHERE device_id=$1 AND id=$2", device, id)
}
func (s *Store) Finish(result M) bool {
	return s.One("UPDATE commands SET status=$3,result=$4::jsonb WHERE device_id=$1 AND id=$2 AND status='pending' RETURNING id", result["deviceId"], result["commandId"], result["status"], js(result)) != nil
}
func (s *Store) Image(device, thread, id string, uploaded bool) M {
	r := s.One("SELECT payload FROM images WHERE device_id=$1 AND thread_id=$2 AND id=$3 AND (expires_at IS NULL OR expires_at>$4) AND ($5=FALSE OR uploaded=TRUE) AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)", device, thread, id, now(), uploaded)
	if r == nil {
		return nil
	}
	return obj(r["payload"])
}
func (s *Store) SaveImage(device, thread, id string, image M, uploaded bool) {
	b := imageBytes(image)
	total := num(s.One("SELECT COALESCE(SUM(bytes),0) AS total FROM images WHERE device_id=$1 AND NOT(thread_id=$2 AND id=$3)", device, thread, id)["total"])
	if total+int64(len(b)) > 128*1024*1024 {
		fail(413, "image-storage-full")
	}
	ttl := int64(604800000)
	if uploaded {
		ttl = 86400000
	}
	s.Q("INSERT INTO images(device_id,thread_id,id,payload,bytes,uploaded,expires_at,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT(device_id,thread_id,id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=CASE WHEN images.expires_at IS NULL THEN NULL ELSE EXCLUDED.expires_at END", device, thread, id, js(image), len(b), uploaded, now()+ttl, now())
}
