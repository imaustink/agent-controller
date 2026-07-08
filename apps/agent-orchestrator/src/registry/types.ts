import type { ToolDescriptor } from "../tool-descriptor.js";

/** Port for discovering the current catalog of launchable tools/sub-agents (ADR 0004). */
export interface ToolRegistry {
  listAll(): Promise<ToolDescriptor[]>;
}
