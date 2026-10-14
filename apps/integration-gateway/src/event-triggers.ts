import type * as k8s from "@kubernetes/client-node";
import {
  compileTrigger,
  evaluate,
  type CompiledTrigger,
  type Envelope,
  type EventTriggerResource,
} from "@controller-agent/event-triggers";
import { CrdTable, crdApisFromKubeConfig, type CrdTableOptions } from "./crd-table.js";

/**
 * The gateway's READ-ONLY view of `EventTrigger`s, used for exactly one thing:
 * deciding whether a verified delivery is worth resolving its sender for
 * (docs/event-triggers.md §7). Resolving a sender costs live GitHub API calls,
 * and most deliveries a GitHub App receives (push, check_run, status, ...)
 * match no trigger at all -- resolving each of them would spend the App's
 * rate limit on events that are about to be ignored.
 *
 * Matching itself stays the orchestrator's: this view can only DROP an event
 * early, never dispatch one, and an event that survives it still has its
 * sender verified and is still matched authoritatively downstream. So getting
 * this view wrong in the permissive direction costs an API call, and in the
 * restrictive direction (a trigger created moments ago, not yet watched)
 * ignores one delivery -- the same window any informer has.
 */

export const EVENT_TRIGGER_PLURAL = "eventtriggers";

export interface EventTriggerLookup {
  /** Every compiled trigger, or undefined while the table is still unknown (never listed). */
  all(): Iterable<CompiledTrigger> | undefined;
}

/** A fixed set of triggers -- tests. */
export class StaticEventTriggerTable implements EventTriggerLookup {
  private readonly triggers: CompiledTrigger[];

  constructor(resources: EventTriggerResource[] = []) {
    this.triggers = resources.map((r) => compileTrigger(r));
  }

  all(): Iterable<CompiledTrigger> {
    return this.triggers;
  }
}

/** List-then-watch over `eventtriggers` in one namespace (see {@link CrdTable}). */
export class CrdEventTriggerRegistry implements EventTriggerLookup {
  private readonly table: CrdTable<CompiledTrigger>;

  constructor(options: CrdTableOptions) {
    this.table = new CrdTable(options, {
      kind: "EventTrigger",
      plural: EVENT_TRIGGER_PLURAL,
      // compileTrigger never fails outright: a broken trigger compiles to
      // ready=false, which couldMatchBeforeSender skips just as the
      // orchestrator's selectTrigger does.
      compile: (obj) => ({ ok: true, value: compileTrigger(obj as EventTriggerResource) }),
    });
  }

  static fromKubeConfig(
    kubeConfig: k8s.KubeConfig,
    opts: { namespace: string; group: string; version: string },
  ): CrdEventTriggerRegistry {
    return new CrdEventTriggerRegistry({ ...opts, ...crdApisFromKubeConfig(kubeConfig) });
  }

  all(): Iterable<CompiledTrigger> | undefined {
    return this.table.loaded ? this.table.values() : undefined;
  }

  /**
   * Never throws: a gateway that cannot list triggers (no RBAC yet, apiserver
   * blip) just keeps resolving every sender, as if it had no view at all.
   */
  start(): void {
    this.table.startInBackground();
  }

  stop(): void {
    this.table.stop();
  }
}

/**
 * Whether any trigger could match `preliminary` -- an envelope whose `sender`
 * and `repository` are NOT resolved yet. A trigger whose match expression
 * reads either of those can't be decided before resolution, so it counts as a
 * possible match; every other trigger is evaluated exactly as the
 * orchestrator's selectTrigger would (same compile, same source filter, an
 * evaluation error or non-bool is a non-match), on fields resolution does not
 * change.
 */
export function couldMatchBeforeSender(triggers: Iterable<CompiledTrigger>, preliminary: Envelope): boolean {
  for (const t of triggers) {
    if (!t.ready || !t.target) continue;
    if (t.sourceRef && t.sourceRef !== preliminary.source) continue;
    if (!t.match) return true;
    if (readsResolvedFields(t.match.source)) return true;
    const r = evaluate(t.match, preliminary);
    if (r.ok && r.value === true) return true;
  }
  return false;
}

const RESOLVED_VARIABLES = new Set(["sender", "repository"]);

/**
 * True when a CEL expression references the top-level `sender` or
 * `repository` variable. A lexical scan: string literals and comments are
 * skipped, and an identifier right after `.` is a field select
 * (`body.repository`), not the variable. Errs toward true -- a false positive
 * only costs a sender lookup.
 */
export function readsResolvedFields(expr: string): boolean {
  let i = 0;
  let prevSignificant = "";
  while (i < expr.length) {
    const c = expr[i] as string;
    if (c === "/" && expr[i + 1] === "/") {
      while (i < expr.length && expr[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const raw = /[rR]/.test(expr[i - 1] ?? "") || /[rR]/.test(expr[i - 2] ?? "");
      i = skipString(expr, i, raw);
      prevSignificant = c;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j] as string)) j++;
      const ident = expr.slice(i, j);
      // A string prefix (r"...", b'...', rb"...") is consumed with its string.
      if (/^[rRbB]{1,2}$/.test(ident) && (expr[j] === '"' || expr[j] === "'")) {
        i = j;
        continue;
      }
      if (RESOLVED_VARIABLES.has(ident) && prevSignificant !== ".") return true;
      prevSignificant = ident;
      i = j;
      continue;
    }
    prevSignificant = c;
    i++;
  }
  return false;
}

/** Index just past the string literal opening at `start` (single, double, or triple quoted). */
function skipString(expr: string, start: number, raw: boolean): number {
  const q = expr[start] as string;
  const triple = expr.startsWith(q.repeat(3), start);
  const close = triple ? q.repeat(3) : q;
  let i = start + close.length;
  while (i < expr.length) {
    if (!raw && expr[i] === "\\") {
      i += 2;
      continue;
    }
    if (expr.startsWith(close, i)) return i + close.length;
    if (!triple && expr[i] === "\n") return i; // unterminated; the compiler already rejected it
    i++;
  }
  return i;
}
