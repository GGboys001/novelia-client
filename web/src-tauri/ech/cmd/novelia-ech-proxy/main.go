// Novelia ECH 侧车：把本地 HTTP 请求通过 ECH + DoH 转发到受保护的原站域名。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

	ech "cc.novelia/ech"
)

const (
	maxBodyBytes    = 200 << 20
	connectTimeout  = 15_000
	readTimeout     = 60_000
	writeTimeout    = 60_000
	connectAttempts = 2
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

func makeFetchHandler(client *ech.Client, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Novel-Ech-Token") != token {
			http.Error(w, "invalid sidecar token", http.StatusForbidden)
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
			http.Error(w, "encode request headers failed", http.StatusBadRequest)
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
		_ = call.SetConnectAttempts(connectAttempts)

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

func main() {
	token := flag.String("token", "", "local sidecar access token")
	portFlag := flag.Int("port", 0, "listen port (0 picks a free port)")
	noStdinWatch := flag.Bool("no-stdin-watch", false, "keep running without parent stdin")
	flag.Parse()

	if *token == "" {
		fmt.Fprintln(os.Stderr, "missing --token")
		os.Exit(2)
	}

	client := ech.NewClient()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/probe", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Novel-Ech-Token") != *token {
			http.Error(w, "invalid sidecar token", http.StatusForbidden)
			return
		}
		host := r.URL.Query().Get("host")
		if host == "" {
			host = "n.novelia.cc"
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(client.Probe(host)))
	})
	mux.HandleFunc("/fetch", makeFetchHandler(client, *token))

	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(*portFlag))
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen failed:", err)
		os.Exit(1)
	}

	fmt.Printf("PORT=%d\n", listener.Addr().(*net.TCPAddr).Port)
	server := &http.Server{Handler: mux}

	// 父进程通过标准输入保持管道；父进程退出后 stdin EOF，侧车随之退出。
	if !*noStdinWatch {
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
			}
			_ = server.Shutdown(context.Background())
		}()
	}

	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "serve failed:", err)
		os.Exit(1)
	}
}
