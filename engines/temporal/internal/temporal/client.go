// Package temporal holds this repo's Temporal wiring: the shared client
// used by both the gateway and the worker, plus the workflows and
// activities subpackages.
package temporal

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"google.golang.org/protobuf/types/known/durationpb"
)

type Config struct {
	Address   string
	Namespace string
	TaskQueue string
	// Retention for closed workflow histories when this process registers
	// the namespace. Existing namespaces are left untouched.
	NamespaceRetention time.Duration
}

const defaultNamespaceRetention = 72 * time.Hour

// ConfigFromEnv reads TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TASK_QUEUE, and
// TEMPORAL_NAMESPACE_RETENTION with local-dev defaults matching
// `temporal server start-dev`.
func ConfigFromEnv() Config {
	retention := defaultNamespaceRetention
	if v := os.Getenv("TEMPORAL_NAMESPACE_RETENTION"); v != "" {
		parsed, err := time.ParseDuration(v)
		if err != nil {
			log.Fatalf("invalid TEMPORAL_NAMESPACE_RETENTION %q: %v", v, err)
		}
		retention = parsed
	}
	return Config{
		Address:            envOr("TEMPORAL_ADDRESS", "127.0.0.1:7233"),
		Namespace:          envOr("TEMPORAL_NAMESPACE", "default"),
		TaskQueue:          envOr("TASK_QUEUE", "durable-agents"),
		NamespaceRetention: retention,
	}
}

// NewClient ensures the configured namespace exists, then dials the
// Temporal frontend against it.
func NewClient(cfg Config) (client.Client, error) {
	if err := ensureNamespace(cfg); err != nil {
		return nil, err
	}
	return client.Dial(client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
	})
}

// ensureNamespace registers cfg.Namespace if it doesn't exist and waits for
// the registration to become visible (it propagates asynchronously).
func ensureNamespace(cfg Config) error {
	nsClient, err := client.NewNamespaceClient(client.Options{HostPort: cfg.Address})
	if err != nil {
		return fmt.Errorf("dial namespace service at %s: %w", cfg.Address, err)
	}
	defer nsClient.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if _, err := nsClient.Describe(ctx, cfg.Namespace); err == nil {
		return nil
	} else {
		var notFound *serviceerror.NamespaceNotFound
		if !errors.As(err, &notFound) {
			return fmt.Errorf("describe temporal namespace %q: %w", cfg.Namespace, err)
		}
	}

	log.Printf("registering temporal namespace %q (retention %s)", cfg.Namespace, cfg.NamespaceRetention)
	err = nsClient.Register(ctx, &workflowservice.RegisterNamespaceRequest{
		Namespace:                        cfg.Namespace,
		WorkflowExecutionRetentionPeriod: durationpb.New(cfg.NamespaceRetention),
	})
	var alreadyExists *serviceerror.NamespaceAlreadyExists
	if err != nil && !errors.As(err, &alreadyExists) {
		return fmt.Errorf("register temporal namespace %q: %w", cfg.Namespace, err)
	}

	// Registration propagates asynchronously; wait until it's queryable so
	// the first workflow start doesn't race it.
	for {
		if _, err := nsClient.Describe(ctx, cfg.Namespace); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("temporal namespace %q not visible after registration: %w", cfg.Namespace, ctx.Err())
		case <-time.After(time.Second):
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
