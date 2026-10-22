package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8787", "Local HTTP address")
	flag.Parse()
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "blis.lock.json")); err != nil {
		log.Fatal("Run the server from the repository root")
	}
	gate := make(chan struct{}, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		_, err := os.Stat(filepath.Join(root, ".runtime/bin/blis"))
		writeJSON(w, 200, map[string]any{"ready": err == nil, "engine": "BLIS v0.12.0", "defaults": defaultConfig()})
	})
	mux.HandleFunc("POST /api/compare", func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host {
				writeError(w, 403, "Requests must come from this application.")
				return
			}
		}
		if r.Header.Get("Content-Type") != "application/json" {
			writeError(w, 415, "Send application/json.")
			return
		}
		var config Config
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&config); err != nil {
			writeError(w, 400, "Invalid comparison settings: "+err.Error())
			return
		}
		if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
			writeError(w, 400, "Expected one settings object.")
			return
		}
		if err := config.Validate(); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		select {
		case gate <- struct{}{}:
			defer func() { <-gate }()
		default:
			writeError(w, 429, "A simulation is already running. Try again when it finishes.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		result, err := compare(ctx, root, config)
		if err != nil {
			log.Print(err)
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, result)
	})
	mux.Handle("/", http.FileServer(http.Dir(filepath.Join(root, "dist"))))
	server := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	fmt.Printf("llm-d simulator: http://%s\n", *addr)
	log.Fatal(server.ListenAndServe())
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
