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
	for gvr, synced := range factory.WaitForCacheSync(ctx.Done()) {
		if !synced {
			return fmt.Errorf("informer cache for %s never synced", gvr.Resource)
		}
	}
	log.Printf("catalog watch established: namespace=%s resources=tools,skills,agents", namespace)

	<-ctx.Done()
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
