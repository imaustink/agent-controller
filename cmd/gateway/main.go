package main

import (
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"durable-agents/internal/gateway"
	"durable-agents/internal/temporal"
)

func main() {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

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

	// Tool-Job callbacks land on their own listener so it can stay
	// cluster-internal while the chat facade is exposed.
	if secret := os.Getenv("AGENT_CALLBACK_SECRET"); secret != "" {
		callbackAddr := os.Getenv("CALLBACK_ADDR")
		if callbackAddr == "" {
			callbackAddr = ":8081"
		}
		callback := gateway.NewCallbackServer(c, secret)
		go func() {
			log.Printf("callback bridge listening on %s", callbackAddr)
			if err := http.ListenAndServe(callbackAddr, callback.Handler()); err != nil {
				log.Fatalf("callback bridge exited: %v", err)
			}
		}()
	} else {
		log.Printf("AGENT_CALLBACK_SECRET not set; callback bridge disabled")
	}

	server := gateway.NewServer(c, cfg.TaskQueue)
	log.Printf("gateway listening on %s: temporal=%s namespace=%s taskQueue=%s",
		listenAddr, cfg.Address, cfg.Namespace, cfg.TaskQueue)
	if err := http.ListenAndServe(listenAddr, server.Handler()); err != nil {
		log.Fatalf("gateway exited: %v", err)
	}
}
