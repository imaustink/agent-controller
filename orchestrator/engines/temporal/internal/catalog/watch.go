package catalog

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

const resyncPeriod = 10 * time.Minute

// watchSpec is one CR kind the catalog mirrors.
type watchSpec struct {
	gvr    schema.GroupVersionResource
	upsert func(context.Context, *unstructured.Unstructured) error
	delete func(context.Context, string) error
}

// knowledgeBasesEnabled gates the Connection/KnowledgeBase watches, and is off
// unless explicitly turned on.
//
// A derived kb:<name>/search descriptor carries no image, no agentRef and no
// localExec, so indexing a knowledge base before the connection-broker and the
// tool executors exist lets the planner select one and then fail at dispatch —
// a confusing runtime error rather than a clean "not implemented".
func knowledgeBasesEnabled() bool {
	return os.Getenv("AGENT_KNOWLEDGE_BASES_ENABLED") == "true"
}

// mcpEnabled gates the MCPTool watch, off unless explicitly turned on, for the
// same reason knowledgeBasesEnabled exists: an MCPTool descriptor carries no
// image, no agentRef and no localExec — only an mcpExec that dispatches through
// the mcp-broker. Indexing one before the broker is deployed lets the planner
// select it and then fail at dispatch, a confusing runtime error rather than a
// clean "not configured" (ADR 0045).
func mcpEnabled() bool {
	return os.Getenv("AGENT_MCP_ENABLED") == "true"
}

// watchGroup is one namespace's worth of watches, so the KB CRs can be watched
// in a namespace of their own while the rest of the catalog stays put.
type watchGroup struct {
	namespace string
	watches   []watchSpec
}

// planWatchGroups decides which namespace each CR kind is watched in.
//
// Corpus/KnowledgeBase CRs go in kbNamespace when it is set and differs from the
// catalog namespace — matching the agent-orchestrator's KNOWLEDGE_BASE_NAMESPACE,
// so a deployment can keep its knowledge bases in a namespace of their own.
// kbNamespace == "" (or equal to namespace) means "same namespace", which keeps
// a single informer factory and is byte-identical to the old behavior. kb is
// empty when knowledge bases are disabled, so it collapses to one group too.
func planWatchGroups(namespace, kbNamespace string, catalog, kb []watchSpec) []watchGroup {
	if len(kb) == 0 {
		return []watchGroup{{namespace, catalog}}
	}
	if kbNamespace == "" || kbNamespace == namespace {
		return []watchGroup{{namespace, append(append([]watchSpec{}, catalog...), kb...)}}
	}
	return []watchGroup{{namespace, catalog}, {kbNamespace, kb}}
}

// RunWatch starts shared dynamic informers on the catalog CRs and feeds every
// event into the indexer. Tool/Skill/Agent/LocalTool are watched in namespace;
// Corpus/KnowledgeBase in kbNamespace (which may be the same). The initial
// informer list doubles as the startup full sync. Blocks until ctx is done.
func RunWatch(ctx context.Context, client dynamic.Interface, namespace, kbNamespace string, ix *Indexer) error {
	catalogWatches := []watchSpec{
		{ToolGVR,
			func(ctx context.Context, obj *unstructured.Unstructured) error {
				tool, err := DecodeTool(obj)
				if err != nil {
					return err
				}
				return ix.UpsertTool(ctx, tool)
			},
			ix.DeleteTool,
		},
		{AgentGVR,
			func(ctx context.Context, obj *unstructured.Unstructured) error {
				agent, err := DecodeAgent(obj)
				if err != nil {
					return err
				}
				return ix.UpsertAgent(ctx, agent)
			},
			ix.DeleteAgent,
		},
		// LocalTool CRs (ADR 0014) union into the SAME Tools collection as
		// container Tools — a skill's toolRefs reference either kind
		// transparently, distinguished only by ToolDescriptor.LocalExec.
		{LocalToolGVR,
			func(ctx context.Context, obj *unstructured.Unstructured) error {
				tool, err := DecodeLocalTool(obj)
				if err != nil {
					return err
				}
				return ix.UpsertTool(ctx, tool)
			},
			ix.DeleteTool,
		},
		{SkillGVR,
			func(ctx context.Context, obj *unstructured.Unstructured) error {
				skill, err := DecodeSkill(obj)
				if err != nil {
					return err
				}
				return ix.UpsertSkill(ctx, skill)
			},
			ix.DeleteSkill,
		},
	}

	// Corpora, KnowledgeBases (ADR 0038, 0039) and MCPTools (ADR 0045) are all
	// watched in the KB namespace, which may differ from the catalog namespace.
	// Neither a Corpus nor a KnowledgeBase is retrievable in its own right; an
	// MCPTool unions into the SAME Tools collection as container Tools and
	// LocalTools — a skill's toolRefs reference any kind transparently,
	// distinguished only by ToolDescriptor.MCPExec. MCPTools live beside the
	// Connection/Corpus CRs (one catalog namespace, ADR 0045), so they are
	// watched here rather than in the catalog group, which is where the broker
	// writes them.
	var kbWatches []watchSpec
	if knowledgeBasesEnabled() {
		kbWatches = []watchSpec{
			{CorpusGVR,
				func(ctx context.Context, obj *unstructured.Unstructured) error {
					conn, err := DecodeCorpus(obj)
					if err != nil {
						return err
					}
					return ix.UpsertCorpus(ctx, conn)
				},
				ix.DeleteCorpus,
			},
			{KnowledgeBaseGVR,
				func(ctx context.Context, obj *unstructured.Unstructured) error {
					kb, err := DecodeKnowledgeBase(obj)
					if err != nil {
						return err
					}
					return ix.UpsertKnowledgeBase(ctx, kb)
				},
				ix.DeleteKnowledgeBase,
			},
		}
	}

	// MCPTools (ADR 0045), gated independently of knowledge bases: a deployment
	// may run MCP servers without any knowledge base, or vice versa. Off until
	// the mcp-broker is present to dispatch to, for the same reason the KB gate
	// exists — an indexed tool whose dispatch path is absent is a confusing
	// runtime error rather than a clean "not configured".
	if mcpEnabled() {
		kbWatches = append(kbWatches, watchSpec{
			MCPToolGVR,
			func(ctx context.Context, obj *unstructured.Unstructured) error {
				tool, err := DecodeMCPTool(obj)
				if err != nil {
					return err
				}
				return ix.UpsertTool(ctx, tool)
			},
			ix.DeleteTool,
		})
	}

	groups := planWatchGroups(namespace, kbNamespace, catalogWatches, kbWatches)

	// One informer factory per group namespace. A factory is pinned to a single
	// namespace, so a distinct KB namespace needs a second one.
	factories := make([]dynamicinformer.DynamicSharedInformerFactory, len(groups))
	for i, g := range groups {
		factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(client, resyncPeriod, g.namespace, nil)
		for _, w := range g.watches {
			informer := factory.ForResource(w.gvr).Informer()
			if _, err := informer.AddEventHandler(eventHandler(ctx, w.gvr, w.upsert, w.delete)); err != nil {
				return fmt.Errorf("add %s event handler: %w", w.gvr.Resource, err)
			}
		}
		factories[i] = factory
	}

	for _, factory := range factories {
		factory.Start(ctx.Done())
	}
	for i, factory := range factories {
		if err := waitForCacheSync(ctx, factory.WaitForCacheSync(ctx.Done())); err != nil {
			return err
		}
		resources := make([]string, 0, len(groups[i].watches))
		for _, w := range groups[i].watches {
			resources = append(resources, w.gvr.Resource)
		}
		log.Printf("catalog watch established: namespace=%s resources=%s", groups[i].namespace, strings.Join(resources, ","))
	}

	<-ctx.Done()
	return nil
}

// RunRouteWatch keeps a RouteRegistry current from IntegrationRoute CRs.
//
// Separate from RunWatch because the two have different consumers: the
// catalog sync process needs Qdrant and no routes, while whichever process
// terminates inbound events needs routes and no Qdrant. Folding routes into
// RunWatch would make the route table depend on a vector store it never
// touches. Blocks until ctx is done.
func RunRouteWatch(ctx context.Context, client dynamic.Interface, namespace string, reg *RouteRegistry) error {
	factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(client, resyncPeriod, namespace, nil)

	informer := factory.ForResource(IntegrationRouteGVR).Informer()
	handler := eventHandler(ctx, IntegrationRouteGVR,
		func(_ context.Context, obj *unstructured.Unstructured) error {
			route, err := DecodeIntegrationRoute(obj)
			if err != nil {
				// A malformed route must not take the whole table down with
				// it: the others keep routing and this one is skipped, which
				// is the same "falls back to retrieval" outcome as no route
				// at all.
				return err
			}
			reg.Upsert(route)
			return nil
		},
		func(_ context.Context, id string) error {
			reg.Delete(id)
			return nil
		},
	)
	if _, err := informer.AddEventHandler(handler); err != nil {
		return fmt.Errorf("add %s event handler: %w", IntegrationRouteGVR.Resource, err)
	}

	factory.Start(ctx.Done())
	if err := waitForCacheSync(ctx, factory.WaitForCacheSync(ctx.Done())); err != nil {
		return err
	}
	log.Printf("integration route watch established: namespace=%s routes=%d", namespace, reg.Len())

	<-ctx.Done()
	return nil
}

// waitForCacheSync turns the factory's per-resource sync map into an error,
// distinguishing "this informer never caught up" from "we were asked to shut
// down while it was still catching up".
//
// cache.WaitForCacheSync polls on a 100ms period and reports false the moment
// its stop channel closes, so a process told to stop during startup would
// otherwise log a cache failure it never had — an alarming, and wrong, last
// line in the log of an ordinary rollout.
func waitForCacheSync(ctx context.Context, synced map[schema.GroupVersionResource]bool) error {
	for gvr, ok := range synced {
		if ok {
			continue
		}
		if ctx.Err() != nil {
			return nil // shutting down, not failing
		}
		return fmt.Errorf("informer cache for %s never synced", gvr.Resource)
	}
	return nil
}

func eventHandler(
	ctx context.Context,
	gvr schema.GroupVersionResource,
	upsert func(context.Context, *unstructured.Unstructured) error,
	del func(context.Context, string) error,
) cache.ResourceEventHandler {
	handleUpsert := func(obj any) {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			log.Printf("%s watch: unexpected object type %T", gvr.Resource, obj)
			return
		}
		if err := upsert(ctx, u); err != nil {
			log.Printf("%s watch: upsert %s failed: %v", gvr.Resource, u.GetName(), err)
			return
		}
		log.Printf("%s watch: indexed %s", gvr.Resource, u.GetName())
	}
	return cache.ResourceEventHandlerFuncs{
		AddFunc: handleUpsert,
		UpdateFunc: func(_, newObj any) {
			handleUpsert(newObj)
		},
		DeleteFunc: func(obj any) {
			if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
				obj = tombstone.Obj
			}
			u, ok := obj.(*unstructured.Unstructured)
			if !ok {
				log.Printf("%s watch: unexpected delete object type %T", gvr.Resource, obj)
				return
			}
			if err := del(ctx, u.GetName()); err != nil {
				log.Printf("%s watch: delete %s failed: %v", gvr.Resource, u.GetName(), err)
				return
			}
			log.Printf("%s watch: removed %s", gvr.Resource, u.GetName())
		},
	}
}
