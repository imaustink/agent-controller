import type { CrdChangeEvent } from "../k8s/crd-watcher.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

/** Port for discovering the current catalog of launchable tools/sub-agents (ADR 0004). */
export interface ToolRegistry {
  listAll(): Promise<ToolDescriptor[]>;
  /**
   * Live catalog updates after the initial `listAll()` (ADR 0020) -- a CR
   * created/edited/deleted after startup is reported here instead of only
   * taking effect on the next orchestrator restart. Returns a handle to stop
   * watching (used on shutdown).
   */
  watch(onChange: (event: CrdChangeEvent<ToolDescriptor>) => void, onError?: (err: unknown) => void): { stop: () => void };
}
