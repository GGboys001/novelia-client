// Package mobile 把 ECH 传输以 gomobile AAR 的形式提供给 Android 客户端，
// 并在应用进程内暴露一个仅监听 127.0.0.1 的 /fetch 代理。
package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"

	ech "cc.novelia/ech"
)

const (
	// 与 Rust 端约定的本地桥接端口和访问令牌。
	BridgePort  = 43111
	BridgeToken = "novelia-ech-bridge-v1"

	maxBodyBytes   = 200 << 20
	connectTimeout = 15_000
	readTimeout    = 60_000
	writeTimeout   = 60_000
	attempts       = 2
)

type memoryUpload struct {
	data   []byte
	offset int
}

func (u *memoryUpload) ReadChunk(maxBytes int) ([]byte, error) {
	if u.offset >= len(u.data) {
		return nil, nil
	}
	end := u.offset + maxBytes
	if end > len(u.data) {
		end = len(u.data)
	}
	chunk := u.data[u.offset:end]
	u.offset = end
	return chunk, nil
}

func (u *memoryUpload) Close() {}

func skippedHeader(name string) bool {
	switch strings.ToLower(name) {
	case "host", "content-length", "connection", "keep-alive", "proxy-authenticate",
		"proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
		"x-novel-ech-url", "x-novel-ech-token":
		return true
	}
	return false
}

func fetchHandler(client *ech.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Novel-Ech-Token") != BridgeToken {
			http.Error(w, "invalid bridge token", http.StatusForbidden)
			return
		}
		target := r.Header.Get("X-Novel-Ech-Url")
		if target == "" {
			http.Error(w, "missing target url", http.StatusBadRequest)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		if err != nil {
			http.Error(w, "read request body failed", http.StatusBadRequest)
			return
		}

		headers := make(map[string][]string)
		for name, values := range r.Header {
			if skippedHeader(name) {
				continue
			}
			headers[name] = values
		}
		headersJSON, err := json.Marshal(headers)
		if err != nil {
			http.Error(w, "encode headers failed", http.StatusBadRequest)
			return
		}

		var upload ech.Upload
		if len(body) > 0 {
			upload = &memoryUpload{data: body}
		}
		call, err := client.NewCall(
			r.Method,
			target,
			string(headersJSON),
			upload,
			int64(len(body)),
			connectTimeout,
			readTimeout,
			writeTimeout,
		)
		if err != nil {
			http.Error(w, "prepare ECH call failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		_ = call.SetConnectAttempts(attempts)

		reply, err := call.Execute()
		if err != nil {
			http.Error(w, "ECH upstream failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer call.Cancel()

		responseHeaders := make(map[string][]string)
		_ = json.Unmarshal([]byte(reply.HeadersJSON()), &responseHeaders)
		for name, values := range responseHeaders {
			if skippedHeader(name) || strings.EqualFold(name, "content-length") {
				continue
			}
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}

		w.WriteHeader(reply.StatusCode())
		flusher, _ := w.(http.Flusher)
		for {
			chunk, err := call.Read(65536)
			if err != nil {
				return
			}
			if len(chunk) == 0 {
				return
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

var (
	once     sync.Once
	server   *http.Server
	startErr error
)

// Start 启动进程内 ECH 代理并返回监听端口；失败返回 0。可重复调用。
func Start() int {
	once.Do(func() {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", BridgePort))
		if err != nil {
			startErr = err
			return
		}

		client := ech.NewClient()
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("ok"))
		})
		mux.HandleFunc("/fetch", fetchHandler(client))
		server = &http.Server{Handler: mux}
		go func() {
			_ = server.Serve(listener)
		}()
	})

	if startErr != nil {
		return 0
	}
	return BridgePort
}

// Stop 关闭本地 ECH 代理。通常由系统在进程结束时回收。
func Stop() {
	if server != nil {
		_ = server.Shutdown(context.Background())
	}
}
