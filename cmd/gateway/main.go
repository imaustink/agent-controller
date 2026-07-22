package main

import (
	"log"
	"net/http"
	"os"

	"durable-agents/internal/gateway"
	"durable-agents/internal/temporal"
)

func main() {
	cfg := temporal.ConfigFromEnv()
	listenAddr := os.Getenv("GATEWAY_ADDR")
	if listenAddr == "" {
		listenAddr = ":8080"
	}

	c, err := temporal.NewClient(cfg)
	if err != nil {
		log.Fatalf("dial temporal at %s: %v", cfg.Address, err)
	}
	defer c.Close()

	server := gateway.NewServer(c, cfg.TaskQueue)
	log.Printf("gateway listening on %s: temporal=%s namespace=%s taskQueue=%s",
		listenAddr, cfg.Address, cfg.Namespace, cfg.TaskQueue)
	if err := http.ListenAndServe(listenAddr, server.Handler()); err != nil {
		log.Fatalf("gateway exited: %v", err)
	}
}
