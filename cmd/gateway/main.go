package main

import (
	"log"
	"net/http"
	"os"

	"go.temporal.io/sdk/client"

	"durable-agents/internal/gateway"
)

func main() {
	temporalAddress := getenv("TEMPORAL_ADDRESS", "127.0.0.1:7233")
	temporalNamespace := getenv("TEMPORAL_NAMESPACE", "default")
	taskQueue := getenv("TASK_QUEUE", "durable-agents")
	listenAddr := getenv("GATEWAY_ADDR", ":8080")

	c, err := client.Dial(client.Options{
		HostPort:  temporalAddress,
		Namespace: temporalNamespace,
	})
	if err != nil {
		log.Fatalf("dial temporal at %s: %v", temporalAddress, err)
	}
	defer c.Close()

	server := gateway.NewServer(c, taskQueue)
	log.Printf("gateway listening on %s: temporal=%s namespace=%s taskQueue=%s",
		listenAddr, temporalAddress, temporalNamespace, taskQueue)
	if err := http.ListenAndServe(listenAddr, server.Handler()); err != nil {
		log.Fatalf("gateway exited: %v", err)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
