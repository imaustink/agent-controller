package catalog

import (
	"context"
	"fmt"
	"log"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

const resyncPeriod = 10 * time.Minute

// RunWatch starts shared dynamic informers on the Tool/Skill/Agent CRs in
// namespace and feeds every event into the indexer. The initial informer
// list doubles as the startup full sync. Blocks until ctx is done.
func RunWatch(ctx context.Context, client dynamic.Interface, namespace string, ix *Indexer) error {
	factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(client, resyncPeriod, namespace, nil)

	watches := []struct {
		gvr    schema.GroupVersionResource
		upsert func(context.Context, *unstructured.Unstructured) error
		delete func(context.Context, string) error
	}{
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

	for _, w := range watches {
		informer := factory.ForResource(w.gvr).Informer()
		if _, err := informer.AddEventHandler(eventHandler(ctx, w.gvr, w.upsert, w.delete)); err != nil {
			return fmt.Errorf("add %s event handler: %w", w.gvr.Resource, err)
		}
	}

	factory.Start(ctx.Done())
	if err := waitForCacheSync(ctx, factory.WaitForCacheSync(ctx.Done())); err != nil {
		return err
	}
	log.Printf("catalog watch established: namespace=%s resources=tools,skills,agents", namespace)

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
