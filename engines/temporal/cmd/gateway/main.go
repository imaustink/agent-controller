package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/qdrant/go-client/qdrant"
	"k8s.io/client-go/dynamic"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/gateway"
	"github.com/controller-agent/temporal-engine/internal/kubeconfig"
	"github.com/controller-agent/temporal-engine/internal/llm"
	"github.com/controller-agent/temporal-engine/internal/rbac"
	"github.com/controller-agent/temporal-engine/internal/temporal"
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

	// Caller-supplied tools (ADR 0035). Optional: without a store, a caller
	// sending more tools than the planner budget gets truncation instead of
	// relevance ranking — and a caller sending few (the common case) is
	// unaffected either way, since the store is not consulted at all below the
	// top-K threshold.
	if store, prune, err := startCallerToolStore(ctx); err != nil {
		log.Printf("caller-tool ranking disabled (%v); large tool arrays will be truncated", err)
	} else {
		opts = append(opts, gateway.WithCallerTools(store, callerToolTopK()))
		go prune()
	}

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

const (
	// callerToolRetention is how long an unused definition survives. Qdrant has
	// no TTL, so without pruning the collection accumulates every definition
	// any caller ever sent, including every intermediate edit of a schema.
	callerToolRetention = 30 * 24 * time.Hour
	// callerToolPruneInterval is deliberately slow: this reclaims disk, not
	// correctness, and an over-eager sweep would only force re-embedding of
	// definitions still in occasional use.
	callerToolPruneInterval = 6 * time.Hour
)

func callerToolTopK() int {
	if raw := os.Getenv("AGENT_CALLER_TOOL_TOP_K"); raw != "" {
		if k, err := strconv.Atoi(raw); err == nil && k > 0 {
			return k
		}
		log.Printf("ignoring invalid AGENT_CALLER_TOOL_TOP_K=%q", raw)
	}
	return 0 // let the server's own default stand
}

// startCallerToolStore opens the caller-tool collection and returns it plus a
// blocking prune loop.
//
// Its OWN collection, never the catalog's: a caller's ephemeral, unauthorized
// definitions must not enter another caller's candidate set, the no-match
// fallback's catalog sweep, or a sub-agent's toolRefs resolution.
func startCallerToolStore(ctx context.Context) (*callertools.QdrantStore, func(), error) {
	qdrantHost := os.Getenv("QDRANT_HOST")
	apiKey := os.Getenv("OPENAI_API_KEY")
	if qdrantHost == "" || apiKey == "" {
		return nil, nil, fmt.Errorf("QDRANT_HOST and OPENAI_API_KEY are both required")
	}
	port := 6334
	if raw := os.Getenv("QDRANT_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid QDRANT_PORT: %w", err)
		}
		port = parsed
	}

	client, err := qdrant.NewClient(&qdrant.Config{Host: qdrantHost, Port: port})
	if err != nil {
		return nil, nil, fmt.Errorf("dial qdrant at %s:%d: %w", qdrantHost, port, err)
	}
	collection := os.Getenv("AGENT_QDRANT_CALLER_TOOL_COLLECTION")
	if collection == "" {
		collection = os.Getenv("QDRANT_COLLECTION_PREFIX") + "caller_tools"
	}
	embedder := llm.NewEmbedder(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		getenv("OPENAI_EMBED_MODEL", llm.DefaultEmbedModel),
	)
	store := callertools.NewQdrantStore(client, collection, embedder, llm.DefaultEmbedDims)
	if err := store.EnsureCollection(ctx); err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	log.Printf("caller-tool store enabled: qdrant=%s:%d collection=%s", qdrantHost, port, collection)

	prune := func() {
		ticker := time.NewTicker(callerToolPruneInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				removed, err := store.Prune(ctx, int64(callerToolRetention.Seconds()))
				if err != nil {
					log.Printf("caller-tool prune failed: %v", err)
					continue
				}
				if removed > 0 {
					log.Printf("caller-tool prune reclaimed %d definitions", removed)
				}
			}
		}
	}
	return store, prune, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
