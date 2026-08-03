package main

import (
	"context"
	"log"
	"os"
	"strconv"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"k8s.io/client-go/dynamic"

	"durable-agents/internal/authz"
	"durable-agents/internal/identitylink"
	"durable-agents/internal/kubeconfig"
	"durable-agents/internal/llm"
	"durable-agents/internal/temporal"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
	"durable-agents/internal/toolrun"
	"durable-agents/internal/vectorstore"
)

func main() {
	cfg := temporal.ConfigFromEnv()

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY is required")
	}
	llmClient := llm.New(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		getenv("OPENAI_MODEL", "gpt-4o-2024-08-06"),
	)

	c, err := temporal.NewClient(cfg)
	if err != nil {
		log.Fatalf("dial temporal at %s: %v", cfg.Address, err)
	}
	defer c.Close()

	w := worker.New(c, cfg.TaskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(workflows.ConversationWorkflow, workflow.RegisterOptions{
		Name: workflows.ConversationWorkflowName,
	})
	w.RegisterWorkflowWithOptions(workflows.ToolRunWorkflow, workflow.RegisterOptions{
		Name: workflows.ToolRunWorkflowName,
	})
	w.RegisterWorkflowWithOptions(workflows.AgentWorkflow, workflow.RegisterOptions{
		Name: workflows.AgentWorkflowName,
	})
	w.RegisterWorkflowWithOptions(workflows.PodAgentWorkflow, workflow.RegisterOptions{
		Name: workflows.PodAgentWorkflowName,
	})
	w.RegisterActivityWithOptions((&activities.LLMActivities{Client: llmClient}).CompleteTurn, activity.RegisterOptions{
		Name: activities.CompleteTurnActivityName,
	})

	agentLoop := &activities.AgentLoopActivities{LLM: llmClient}
	w.RegisterActivityWithOptions(agentLoop.CheckNeedsCapability, activity.RegisterOptions{Name: activities.CheckNeedsCapabilityActivityName})
	w.RegisterActivityWithOptions(agentLoop.CheckSkillFit, activity.RegisterOptions{Name: activities.CheckSkillFitActivityName})
	w.RegisterActivityWithOptions(agentLoop.CheckToolFit, activity.RegisterOptions{Name: activities.CheckToolFitActivityName})
	w.RegisterActivityWithOptions(agentLoop.SelectSkill, activity.RegisterOptions{Name: activities.SelectSkillActivityName})
	w.RegisterActivityWithOptions(agentLoop.PlanAction, activity.RegisterOptions{Name: activities.PlanActionActivityName})
	w.RegisterActivityWithOptions(agentLoop.ComposeResponse, activity.RegisterOptions{Name: activities.ComposeResponseActivityName})
	w.RegisterActivityWithOptions(agentLoop.SelectDelegate, activity.RegisterOptions{Name: activities.SelectDelegateActivityName})
	w.RegisterActivityWithOptions(agentLoop.PlanAgentAction, activity.RegisterOptions{Name: activities.PlanAgentActionActivityName})

	// Authorization pre-flight. The real credential store lives in
	// agent-controller's integration-gateway; without a URL for it we fall
	// back to the in-memory fake, which is dev-only and says so.
	var links identitylink.Port
	if baseURL := os.Getenv("IDENTITY_LINK_GATEWAY_URL"); baseURL != "" {
		links = identitylink.New(identitylink.Options{
			BaseURL: baseURL,
			Token:   os.Getenv("IDENTITY_LINK_GATEWAY_TOKEN"),
		})
		log.Printf("identity-link gateway: %s", baseURL)
	} else {
		fake, err := identitylink.NewFake(os.Getenv("IDENTITY_LINKS"), os.Getenv("IDENTITY_LINK_URLS"))
		if err != nil {
			log.Fatalf("build fake identity link store: %v", err)
		}
		links = fake
		log.Printf("IDENTITY_LINK_GATEWAY_URL not set; using the in-memory identity-link fake (dev only)")
	}

	// The Secret writer is what keeps a credential out of Temporal's event
	// history: the pre-flight writes values here and returns only a name.
	var secretWriter authz.SecretWriter
	if kubeCfg, err := kubeconfig.Load(); err == nil {
		if dynamicClient, err := dynamic.NewForConfig(kubeCfg); err == nil {
			secretWriter = authz.NewK8sSecretWriter(dynamicClient, getenv("CATALOG_NAMESPACE", "controller-agent"))
		} else {
			log.Printf("no dynamic client for credential secrets: %v", err)
		}
	} else {
		log.Printf("no kube config for credential secrets: %v", err)
	}

	authorize := &activities.AuthorizeActivities{Service: authz.New(authz.Deps{
		Links:  links,
		Secret: secretWriter,
		// One bounded hop. The workflow's own durable wait is what spans a
		// human's attention; this only lets the gateway short-circuit it when
		// the link lands immediately.
		WaitForLink: 30 * time.Second,
	})}
	w.RegisterActivityWithOptions(authorize.Authorize, activity.RegisterOptions{Name: activities.AuthorizeActivityName})
	w.RegisterActivityWithOptions(authorize.ResolveLinked, activity.RegisterOptions{Name: activities.ResolveLinkedActivityName})
	w.RegisterActivityWithOptions(authorize.ResolveToolCredentials, activity.RegisterOptions{Name: activities.ResolveToolCredentialsActivityName})

	// Retrieval activities need Qdrant; without it the worker still serves
	// plain conversations (hello-world mode).
	if qdrantHost := os.Getenv("QDRANT_HOST"); qdrantHost != "" {
		qdrantPort, err := strconv.Atoi(getenv("QDRANT_PORT", "6334"))
		if err != nil {
			log.Fatalf("invalid QDRANT_PORT: %v", err)
		}
		embedder := llm.NewEmbedder(
			getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
			apiKey,
			getenv("OPENAI_EMBED_MODEL", llm.DefaultEmbedModel),
		)
		qdrantClient, collections, err := vectorstore.OpenCollections(context.Background(), qdrantHost, qdrantPort, embedder, llm.DefaultEmbedDims, os.Getenv("QDRANT_COLLECTION_PREFIX"))
		if err != nil {
			log.Fatalf("open qdrant collections: %v", err)
		}
		defer qdrantClient.Close()

		retrieval := &activities.RetrievalActivities{Collections: collections}
		w.RegisterActivityWithOptions(retrieval.RetrieveSkills, activity.RegisterOptions{Name: activities.RetrieveSkillsActivityName})
		w.RegisterActivityWithOptions(retrieval.RetrieveAgents, activity.RegisterOptions{Name: activities.RetrieveAgentsActivityName})
		w.RegisterActivityWithOptions(retrieval.RetrieveTools, activity.RegisterOptions{Name: activities.RetrieveToolsActivityName})
		w.RegisterActivityWithOptions(retrieval.ResolveSkillTools, activity.RegisterOptions{Name: activities.ResolveSkillToolsActivityName})
		w.RegisterActivityWithOptions(retrieval.ResolveAgent, activity.RegisterOptions{Name: activities.ResolveAgentActivityName})
		w.RegisterActivityWithOptions(retrieval.ResolveAgentTools, activity.RegisterOptions{Name: activities.ResolveAgentToolsActivityName})
		log.Printf("retrieval activities enabled: qdrant=%s:%d", qdrantHost, qdrantPort)
	} else {
		log.Printf("QDRANT_HOST not set; retrieval activities disabled")
	}

	// Tool execution: TOOLRUN_MODE=k8s creates real ToolRun CRs;
	// TOOLRUN_MODE=fake logs launches for cluster-less dev (play the tool by
	// posting signed callbacks yourself); unset disables tool activities.
	switch mode := os.Getenv("TOOLRUN_MODE"); mode {
	case "":
		log.Printf("TOOLRUN_MODE not set; tool execution disabled")
	case "k8s", "fake":
		callbackBaseURL := os.Getenv("CALLBACK_BASE_URL")
		if callbackBaseURL == "" {
			log.Fatal("CALLBACK_BASE_URL is required when TOOLRUN_MODE is set")
		}
		var launcher toolrun.Launcher
		if mode == "k8s" {
			kubeCfg, err := kubeconfig.Load()
			if err != nil {
				log.Fatalf("load kube config: %v", err)
			}
			dynamicClient, err := dynamic.NewForConfig(kubeCfg)
			if err != nil {
				log.Fatalf("build dynamic client: %v", err)
			}
			launcher = toolrun.NewK8sLauncher(
				dynamicClient,
				getenv("TOOLRUN_NAMESPACE", "controller-agent"),
				toolrun.SecretRef{
					Name: getenv("CALLBACK_SECRET_NAME", "durable-agents-callback"),
					Key:  getenv("CALLBACK_SECRET_KEY", "AGENT_CALLBACK_SECRET"),
				},
			)
		} else {
			launcher = toolrun.NewFakeLauncher()
		}
		toolRunActivities := &activities.ToolRunActivities{Launcher: launcher, CallbackBaseURL: callbackBaseURL}
		w.RegisterActivityWithOptions(toolRunActivities.LaunchToolRun, activity.RegisterOptions{Name: activities.LaunchToolRunActivityName})
		w.RegisterActivityWithOptions(toolRunActivities.GetToolRunPhase, activity.RegisterOptions{Name: activities.GetToolRunPhaseActivityName})
		log.Printf("tool execution enabled: mode=%s callbacks=%s", mode, callbackBaseURL)
	default:
		log.Fatalf("unknown TOOLRUN_MODE %q (want k8s, fake, or unset)", mode)
	}

	log.Printf("worker starting: temporal=%s namespace=%s taskQueue=%s model=%s",
		cfg.Address, cfg.Namespace, cfg.TaskQueue, llmClient.Model())
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalf("worker exited: %v", err)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
