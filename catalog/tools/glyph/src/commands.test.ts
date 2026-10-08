import { describe, expect, it } from "vitest";
import { CommandError, parseCommand } from "./commands.js";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";

describe("parseCommand", () => {
  it("parses a note create command", () => {
    const cmd = parseCommand(JSON.stringify({ resource: "note", action: "create", title: "Hi", body: "# Hi" }));
    expect(cmd).toMatchObject({ resource: "note", action: "create", title: "Hi", body: "# Hi" });
  });

  it("parses a task create command with status/priority/due", () => {
    const cmd = parseCommand(
      JSON.stringify({ resource: "task", action: "create", title: "Ship", status: "in-progress", priority: "high", dueDate: "2026-09-09" }),
    );
    expect(cmd).toMatchObject({ resource: "task", action: "create", status: "in-progress", priority: "high", dueDate: "2026-09-09" });
  });

  it("parses a get command with a uuid", () => {
    const cmd = parseCommand(JSON.stringify({ resource: "note", action: "get", id: NOTE_ID }));
    expect(cmd).toMatchObject({ resource: "note", action: "get", id: NOTE_ID });
  });

  it("parses a search command with no query", () => {
    const cmd = parseCommand(JSON.stringify({ resource: "task", action: "search", status: "todo" }));
    expect(cmd).toMatchObject({ resource: "task", action: "search", status: "todo" });
  });

  it("rejects non-JSON input", () => {
    expect(() => parseCommand("not json")).toThrow(CommandError);
  });

  it("rejects an unknown resource", () => {
    expect(() => parseCommand(JSON.stringify({ resource: "widget", action: "create", title: "x" }))).toThrow(/resource/);
  });

  it("rejects an unknown action", () => {
    expect(() => parseCommand(JSON.stringify({ resource: "note", action: "delete", id: NOTE_ID }))).toThrow(/action/);
  });

  it("reports the offending field on a schema violation", () => {
    expect(() => parseCommand(JSON.stringify({ resource: "note", action: "create" }))).toThrow(/title/);
  });

  it("rejects an invalid task status", () => {
    expect(() =>
      parseCommand(JSON.stringify({ resource: "task", action: "create", title: "x", status: "blocked" })),
    ).toThrow(/status/);
  });

  it("rejects a non-uuid id", () => {
    expect(() => parseCommand(JSON.stringify({ resource: "task", action: "get", id: "42" }))).toThrow(/id/);
  });

  it("rejects a malformed dueDate", () => {
    expect(() =>
      parseCommand(JSON.stringify({ resource: "task", action: "create", title: "x", dueDate: "09/09/2026" })),
    ).toThrow(/dueDate/);
  });
});
