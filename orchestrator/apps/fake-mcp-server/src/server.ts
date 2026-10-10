import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getBearerToken } from "./request-context.js";

/**
 * Builds a fresh McpServer with the fixture's FIXED, deterministic tool set.
 *
 * A new server (and transport) is created per request for the SDK's stateless
 * streamable-http pattern, so this is called on every POST. The tools take no
 * external dependency and no persistent state — given the same input they
 * always return the same output.
 *
 *   - echo   { text }  -> a text part with exactly that text.
 *   - whoami {}        -> a text part with the inbound Bearer token (or
 *                         "anonymous"). This proves the broker forwarded the
 *                         caller's per-user delegated token upstream.
 *   - boom   {}        -> an isError result with "intentional tool error".
 *
 * No auth is enforced here: the server ACCEPTS any or no token and only
 * REFLECTS it via whoami. The broker is the component that enforces auth.
 */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: "fake-mcp-server",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      description:
        "Returns exactly the text it was given. Proves argument passing and result flattening.",
      inputSchema: { text: z.string().describe("The text to echo back verbatim.") },
    },
    ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Returns the Bearer token from the request's Authorization header, or 'anonymous' if none. Reflects, never enforces — it exists to prove the broker forwarded the caller's per-user delegated token upstream.",
      inputSchema: {},
    },
    () => ({
      content: [{ type: "text", text: getBearerToken() }],
    }),
  );

  server.registerTool(
    "boom",
    {
      description:
        "Always fails with a tool-level error. Proves the broker's isError path.",
      inputSchema: {},
    },
    () => ({
      isError: true,
      content: [{ type: "text", text: "intentional tool error" }],
    }),
  );

  return server;
}
