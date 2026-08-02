package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"k8s.io/client-go/dynamic"

	"durable-agents/internal/catalog"
	"durable-agents/internal/gateway"
	"durable-agents/internal/kubeconfig"
	"durable-agents/internal/rbac"
	"durable-agents/internal/temporal"
)

func main() {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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

	opts := []gateway.Option{}

	// Deterministic event dispatch (ADR 0024). Optional: without cluster
	// access every /invoke turn simply goes through ordinary retrieval, which
	// is exactly the behaviour before IntegrationRoute existed. A chat-only
	// deployment, or local dev with no cluster, needs none of this.
	if os.Getenv("INTEGRATION_ROUTES") != "false" {
		if routes, err := startRouteWatch(ctx); err != nil {
			log.Printf("integration routes disabled (%v); every /invoke turn will use retrieval", err)
		} else {
			opts = append(opts, gateway.WithRoutes(routes))
		}
	}

	// The shared secret with integration-gateway. Unset is a supported (and
	// loudly announced) weaker mode, so that upgrading a deployment does not
	// silently break it.
	senderSecret := os.Getenv("GATEWAY_SENDER_ASSERTION_SECRET")
	rbac.WarnIfSenderAssertionUnset(senderSecret)
	opts = append(opts, gateway.WithSenderAssertionSecret(senderSecret))

	server := gateway.NewServer(c, cfg.TaskQueue, resolver, opts...)
	log.Printf("gateway listening on %s: temporal=%s namespace=%s taskQueue=%s",
		listenAddr, cfg.Address, cfg.Namespace, cfg.TaskQueue)
	if err := http.ListenAndServe(listenAddr, server.Handler()); err != nil {
		log.Fatalf("gateway exited: %v", err)
	}
}

// startRouteWatch brings up the IntegrationRoute table and returns once its
// initial list has been indexed, so the first /invoke after startup routes
// against a populated table rather than racing it.
func startRouteWatch(ctx context.Context) (*catalog.RouteRegistry, error) {
	kubeConfig, err := kubeconfig.Load()
	if err != nil {
		return nil, fmt.Errorf("load kube config: %w", err)
	}
	dynamicClient, err := dynamic.NewForConfig(kubeConfig)
	if err != nil {
		return nil, fmt.Errorf("build dynamic client: %w", err)
	}

	namespace := os.Getenv("CATALOG_NAMESPACE")
	if namespace == "" {
		namespace = "controller-agent"
	}

	routes := catalog.NewRouteRegistry()
	ready := make(chan error, 1)
	go func() {
		ready <- catalog.RunRouteWatch(ctx, dynamicClient, namespace, routes)
	}()

	// RunRouteWatch blocks for the life of the process, so "ready" is the
	// absence of an early error rather than a return. A watch that cannot
	// even establish fails fast here instead of quietly never routing.
	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("route watch exited immediately")
	case <-time.After(routeWatchStartupGrace):
		return routes, nil
	}
}

// routeWatchStartupGrace is how long to let the informer's initial list land
// before serving. Long enough to cover the cache-sync poll period, short
// enough that a cluster-less dev run is not held up.
const routeWatchStartupGrace = 2 * time.Second
