// catalog-sync watches agent-controller's Tool/Skill/Agent CRs and mirrors
// them into the Qdrant catalog collections used by the retrieval activities.
// It runs alongside the worker but is deliberately not workflow code:
// catalog maintenance is background sync, independent of any turn.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"k8s.io/client-go/dynamic"

	"durable-agents/internal/catalog"
	"durable-agents/internal/kubeconfig"
	"durable-agents/internal/llm"
	"durable-agents/internal/vectorstore"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY is required (embeddings)")
	}
	embedder := llm.NewEmbedder(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		getenv("OPENAI_EMBED_MODEL", llm.DefaultEmbedModel),
	)

	qdrantHost := getenv("QDRANT_HOST", "127.0.0.1")
	qdrantPort, err := strconv.Atoi(getenv("QDRANT_PORT", "6334"))
	if err != nil {
		log.Fatalf("invalid QDRANT_PORT: %v", err)
	}
	client, collections, err := vectorstore.OpenCollections(ctx, qdrantHost, qdrantPort, embedder, llm.DefaultEmbedDims, os.Getenv("QDRANT_COLLECTION_PREFIX"))
	if err != nil {
		log.Fatalf("open qdrant collections: %v", err)
	}
	defer client.Close()

	kubeConfig, err := kubeconfig.Load()
	if err != nil {
		log.Fatalf("load kube config: %v", err)
	}
	dynamicClient, err := dynamic.NewForConfig(kubeConfig)
	if err != nil {
		log.Fatalf("build dynamic client: %v", err)
	}

	namespace := getenv("CATALOG_NAMESPACE", "controller-agent")
	log.Printf("catalog-sync starting: namespace=%s qdrant=%s:%d", namespace, qdrantHost, qdrantPort)

	indexer := catalog.NewIndexer(collections)
	if err := catalog.RunWatch(ctx, dynamicClient, namespace, indexer); err != nil {
		log.Fatalf("catalog watch exited: %v", err)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
