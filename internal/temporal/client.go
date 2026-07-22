// Package temporal holds this repo's Temporal wiring: the shared client
// used by both the gateway and the worker, plus the workflows and
// activities subpackages.
package temporal

import (
	"os"

	"go.temporal.io/sdk/client"
)

type Config struct {
	Address   string
	Namespace string
	TaskQueue string
}

// ConfigFromEnv reads TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and TASK_QUEUE
// with local-dev defaults matching `temporal server start-dev`.
func ConfigFromEnv() Config {
	return Config{
		Address:   envOr("TEMPORAL_ADDRESS", "127.0.0.1:7233"),
		Namespace: envOr("TEMPORAL_NAMESPACE", "default"),
		TaskQueue: envOr("TASK_QUEUE", "durable-agents"),
	}
}

// NewClient dials the Temporal frontend.
func NewClient(cfg Config) (client.Client, error) {
	return client.Dial(client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
