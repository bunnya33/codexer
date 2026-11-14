package relay

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

// The file's version is bound by the caller before headers are sent. Range
// requests use the same authorized Agent reads as a full download.
func serveFileDownload(w http.ResponseWriter, r *http.Request, first M, read func(context.Context, int64) M) {
	size := num(first["size"])
	rangeHeader := r.Header.Get("Range")
	etag := `"` + str(first["version"]) + `"`
	if r.Method == "HEAD" || r.Header.Get("If-Range") != "" && r.Header.Get("If-Range") != etag {
		rangeHeader = ""
	}
	start, end, partial, valid := audioRange(rangeHeader, size)
	downloadHeaders(w)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\"download\"; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(str(first["name"])), "'", "%27"))
	if !valid {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	status := http.StatusOK
	if partial {
		status = http.StatusPartialContent
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	}
	length := int64(0)
	if size > 0 {
		length = end - start + 1
	}
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	if r.Method == "HEAD" || size == 0 {
		w.WriteHeader(status)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	file := first
	if start != 0 {
		file = read(ctx, start)
	}
	w.WriteHeader(status)
	defer func() {
		if recover() != nil {
			panic(http.ErrAbortHandler)
		}
	}()
	type block struct {
		file    M
		failure any
	}
	// At most two authorized Agent reads are in flight per download. This
	// preserves the existing four-per-device pending limit for two downloads,
	// and bounds read-ahead to 512 KiB (plus JSON/Base64 overhead).
	pending := map[int64]<-chan block{}
	const chunkBytes int64 = 256 * 1024
	prefetch := func(offset int64) {
		if offset > end || ctx.Err() != nil {
			return
		}
		if _, exists := pending[offset]; exists {
			return
		}
		result := make(chan block, 1)
		pending[offset] = result
		workers.Add(1)
		go func() {
			defer workers.Done()
			value := block{}
			defer func() {
				value.failure = recover()
				result <- value
			}()
			value.file = read(ctx, offset)
		}()
	}
	for offset := start; offset <= end; {
		if ctx.Err() != nil {
			return
		}
		if file["size"] != first["size"] || file["name"] != first["name"] || file["version"] != first["version"] {
			panic(http.ErrAbortHandler)
		}
		data, err := base64.StdEncoding.DecodeString(str(file["base64"]))
		if err != nil || int64(len(data)) != min(chunkBytes, size-offset) {
			panic(http.ErrAbortHandler)
		}
		if int64(len(data)) > end-offset+1 {
			data = data[:end-offset+1]
		}
		prefetch(offset + chunkBytes)
		prefetch(offset + 2*chunkBytes)
		if _, err = w.Write(data); err != nil {
			return
		}
		offset += int64(len(data))
		if offset <= end {
			select {
			case value := <-pending[offset]:
				delete(pending, offset)
				if value.failure != nil {
					panic(value.failure)
				}
				file = value.file
			case <-ctx.Done():
				return
			}
		}
	}
}
