package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestFileDownloadRanges(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789"), 60000)
	version := "test-version"
	for _, tc := range []struct {
		name, header       string
		status, start, end int
	}{
		{"whole", "", 200, 0, len(data) - 1},
		{"block", "bytes=262140-262160", 206, 262140, 262160},
		{"resume", "bytes=524288-", 206, 524288, len(data) - 1},
		{"suffix", "bytes=-17", 206, len(data) - 17, len(data) - 1},
		{"bad", "bytes=600000-", 416, 0, -1},
		{"multi", "bytes=0-1,3-4", 416, 0, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			read := func(_ context.Context, offset int64) M {
				return M{"name": "file.bin", "size": len(data), "version": version, "base64": base64.StdEncoding.EncodeToString(data[offset:min(int(offset)+256*1024, len(data))])}
			}
			r := httptest.NewRequest("GET", "/file", nil)
			r.Header.Set("Range", tc.header)
			w := httptest.NewRecorder()
			serveFileDownload(w, r, read(r.Context(), 0), read)
			if w.Code != tc.status {
				t.Fatalf("status %d", w.Code)
			}
			if !bytes.Equal(w.Body.Bytes(), data[tc.start:tc.end+1]) {
				t.Fatal("wrong bytes")
			}
			if w.Header().Get("Content-Length") != strconv.Itoa(tc.end-tc.start+1) {
				t.Fatal("wrong length")
			}
			if w.Header().Get("Accept-Ranges") != "bytes" {
				t.Fatal("missing ranges")
			}
		})
	}
}

func TestFileDownloadPrefetchOrdersOverlappingReads(t *testing.T) {
	data := bytes.Repeat([]byte("abcdefgh"), 150000)
	readBlock := func(offset int64) M {
		return M{"name": "file.bin", "size": len(data), "version": "v", "base64": base64.StdEncoding.EncodeToString(data[offset:min(offset+256*1024, int64(len(data)))])}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	secondStarted := make(chan struct{})
	var active, maximum atomic.Int32
	read := func(ctx context.Context, offset int64) M {
		n := active.Add(1)
		defer active.Add(-1)
		for old := maximum.Load(); n > old && !maximum.CompareAndSwap(old, n); old = maximum.Load() {
		}
		if offset == 256*1024 {
			select {
			case <-secondStarted:
			case <-ctx.Done():
				panic(ctx.Err())
			}
		}
		if offset == 512*1024 {
			close(secondStarted)
		}
		return readBlock(offset)
	}
	w := httptest.NewRecorder()
	serveFileDownload(w, httptest.NewRequest("GET", "/file", nil).WithContext(ctx), readBlock(0), read)
	if !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatal("out-of-order reads changed downloaded bytes")
	}
	if maximum.Load() != 2 {
		t.Fatalf("prefetch concurrency %d", maximum.Load())
	}
}

type fileDownloadWriter struct {
	*httptest.ResponseRecorder
	write func([]byte) (int, error)
}

func (w fileDownloadWriter) Write(data []byte) (int, error) { return w.write(data) }

func TestFileDownloadCancelsPrefetchWhenClientWriteFails(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started := make(chan struct{})
	var reads, cancelled atomic.Int32
	read := func(ctx context.Context, _ int64) M {
		if reads.Add(1) == 2 {
			close(started)
		}
		<-ctx.Done()
		cancelled.Add(1)
		panic(ctx.Err())
	}
	w := fileDownloadWriter{httptest.NewRecorder(), func([]byte) (int, error) {
		select {
		case <-started:
		case <-ctx.Done():
			t.Error("prefetch did not start")
		}
		return 0, errors.New("client disconnected")
	}}
	first := M{"name": "file.bin", "size": 1024 * 1024, "version": "v", "base64": base64.StdEncoding.EncodeToString(make([]byte, 256*1024))}
	serveFileDownload(w, httptest.NewRequest("GET", "/file", nil).WithContext(ctx), first, read)
	if cancelled.Load() != 2 {
		t.Fatalf("left %d reads running", 2-cancelled.Load())
	}
}

func TestFileDownloadAbortsOnPrefetchFailureOrChangedFile(t *testing.T) {
	for _, mode := range []string{"error", "version", "short"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			first := M{"name": "file.bin", "size": 1024 * 1024, "version": "v", "base64": base64.StdEncoding.EncodeToString(make([]byte, 256*1024))}
			read := func(ctx context.Context, offset int64) M {
				if offset != 256*1024 {
					<-ctx.Done()
					panic(ctx.Err())
				}
				if mode == "error" {
					panic(Fault{409, "file-changed"})
				}
				value := clone(first)
				// clone normalizes JSON numbers; retain the first block's size type.
				value["size"] = first["size"]
				if mode == "version" {
					value["version"] = "new"
				} else {
					value["base64"] = "eA=="
				}
				return value
			}
			defer func() {
				if recover() != http.ErrAbortHandler {
					t.Error("must abort incomplete response")
				}
			}()
			serveFileDownload(httptest.NewRecorder(), httptest.NewRequest("GET", "/file", nil).WithContext(ctx), first, read)
			t.Error("invalid prefetch was accepted")
		})
	}
}

func TestFileDownloadHeadAndIfRange(t *testing.T) {
	first := M{"name": "empty.txt", "size": 0, "version": "v", "base64": ""}
	read := func(context.Context, int64) M { t.Fatal("unexpected further read"); return nil }
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, "/file", nil)
		serveFileDownload(w, r, first, read)
		if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "0" {
			t.Fatal("empty response")
		}
	}
	first = M{"name": "file.txt", "size": 3, "version": "v", "base64": base64.StdEncoding.EncodeToString([]byte("abc"))}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/file", nil)
	r.Header.Set("Range", "bytes=1-2")
	r.Header.Set("If-Range", `"old"`)
	serveFileDownload(w, r, first, read)
	if w.Code != 200 || w.Body.String() != "abc" {
		t.Fatal("stale If-Range must return the whole file")
	}
}
