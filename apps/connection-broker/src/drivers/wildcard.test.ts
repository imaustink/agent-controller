import { describe, expect, it, vi } from "vitest";
import { listWildcard } from "./wildcard.js";
import type { Cursor, ListPage, Scope } from "./types.js";

const ref = (id: string) => ({ id, title: id, url: `https://x/${id}` });

describe("listWildcard", () => {
  it("uses the cap (allowedUnits) and never enumerates when it is set", async () => {
    const enumerate = vi.fn();
    const listUnit = vi.fn(async (scope: Scope) => ({ resources: [ref(`${scope.channel}-1`)], cursor: undefined }));
    const page = await listWildcard(
      { all: true, allowedUnits: ["C1", "C2"] },
      {},
      enumerate as never,
      (channel) => ({ channel }),
      listUnit,
    );
    expect(enumerate).not.toHaveBeenCalled();
    expect(page.resources.map((r) => r.id)).toEqual(["C1-1", "C2-1"]);
    expect(page.cursor).toBeUndefined();
  });

  it("enumerates units when the Connection sets no cap", async () => {
    const enumerate = vi.fn(async () => ["S1", "S2"]);
    const listUnit = vi.fn(async (scope: Scope) => ({ resources: [ref(`${scope.space}`)], cursor: undefined }));
    const page = await listWildcard({ all: true }, {}, enumerate, (space) => ({ space }), listUnit);
    expect(enumerate).toHaveBeenCalledOnce();
    expect(page.resources.map((r) => r.id)).toEqual(["S1", "S2"]);
  });

  it("fully paginates each unit, following its per-unit cursor", async () => {
    const listUnit = vi.fn(async (scope: Scope, _c, since: Cursor): Promise<ListPage> => {
      if (!since) return { resources: [ref(`${scope.folderID}-p1`)], cursor: "next" };
      return { resources: [ref(`${scope.folderID}-p2`)], cursor: undefined };
    });
    const page = await listWildcard({ all: true, allowedUnits: ["F1"] }, {}, vi.fn() as never, (folderID) => ({ folderID }), listUnit);
    expect(page.resources.map((r) => r.id)).toEqual(["F1-p1", "F1-p2"]);
    expect(listUnit).toHaveBeenCalledTimes(2);
  });

  it("treats a present-but-empty cap as ZERO units, not 'everything'", async () => {
    const enumerate = vi.fn();
    const listUnit = vi.fn();
    const page = await listWildcard(
      { all: true, allowedUnits: [] },
      {},
      enumerate as never,
      (channel) => ({ channel }),
      listUnit as never,
    );
    expect(enumerate).not.toHaveBeenCalled();
    expect(listUnit).not.toHaveBeenCalled();
    expect(page.resources).toEqual([]);
  });

  it("de-dupes a resource that sits in several units", async () => {
    const listUnit = vi.fn(async () => ({ resources: [ref("shared")], cursor: undefined }));
    const page = await listWildcard({ all: true, allowedUnits: ["A", "B"] }, {}, vi.fn() as never, (channel) => ({ channel }), listUnit);
    expect(page.resources.map((r) => r.id)).toEqual(["shared"]);
  });
});
