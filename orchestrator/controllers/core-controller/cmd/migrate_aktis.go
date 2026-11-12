package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"

	"github.com/aktisai/orchestrator/controllers/core-controller/internal/migrate"
)

// runMigrateAktis is the `manager migrate-aktis` mode: the chart's
// post-install/post-upgrade hook Job (templates/migrate-aktis.yaml) runs it so
// a GitOps upgrade from the core.controller-agent.dev release completes with
// no hand-applied steps. See internal/migrate for what it does and why.
func runMigrateAktis(args []string) int {
	fs := flag.NewFlagSet("migrate-aktis", flag.ExitOnError)
	namespaces := fs.String("namespaces", os.Getenv("POD_NAMESPACE"),
		"Comma-separated namespaces whose Secrets/ConfigMaps get the aktis.ai keys (the credential stores' namespaces).")
	timeout := fs.Duration("timeout", 5*time.Minute, "Overall deadline.")
	_ = fs.Parse(args)

	var nss []string
	for _, ns := range strings.Split(*namespaces, ",") {
		if ns = strings.TrimSpace(ns); ns != "" {
			nss = append(nss, ns)
		}
	}
	if len(nss) == 0 {
		fmt.Fprintln(os.Stderr, "migrate-aktis: no namespaces (set --namespaces or POD_NAMESPACE)")
		return 2
	}

	cfg := ctrl.GetConfigOrDie()
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate-aktis:", err)
		return 1
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate-aktis:", err)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	logf := func(format string, a ...any) { fmt.Printf(format+"\n", a...) }

	n, err := migrate.Relabel(ctx, cs, nss, logf)
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate-aktis:", err)
		return 1
	}
	fmt.Printf("relabel: %d object(s) given aktis.ai keys in %s\n", n, strings.Join(nss, ","))

	n, err = migrate.StripOldFinalizers(ctx, dyn, logf)
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate-aktis:", err)
		return 1
	}
	fmt.Printf("finalizers: %d old-group object(s) released\n", n)
	return 0
}
