package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"

	"durable-agents/internal/gateway"
	"durable-agents/internal/rbac"
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

	// Identity: static token map (dev-grade, like upstream's default).
	// AGENT_DEFAULT_SUBJECT/_ROLES give tokenless callers an identity —
	// leave unset to fail closed to no capabilities.
	var fallback *rbac.Identity
	if subject := os.Getenv("AGENT_DEFAULT_SUBJECT"); subject != "" {
		fallback = &rbac.Identity{Subject: subject}
		if roles := os.Getenv("AGENT_DEFAULT_ROLES"); roles != "" {
			fallback.Roles = strings.Split(roles, ",")
		}
	}
	resolver, err := rbac.NewStaticResolver(os.Getenv("STATIC_IDENTITIES"), fallback)
	if err != nil {
		log.Fatalf("build identity resolver: %v", err)
	}

	server := gateway.NewServer(c, cfg.TaskQueue, resolver)
	log.Printf("gateway listening on %s: temporal=%s namespace=%s taskQueue=%s",
		listenAddr, cfg.Address, cfg.Namespace, cfg.TaskQueue)
	if err := http.ListenAndServe(listenAddr, server.Handler()); err != nil {
		log.Fatalf("gateway exited: %v", err)
	}
}
