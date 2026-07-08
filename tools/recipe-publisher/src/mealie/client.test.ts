import { describe, expect, it, vi } from "vitest";
import { MealiePublishError, publishRecipe, type MealieConfig } from "./client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json" } });
}

const CFG: MealieConfig = { baseUrl: "https://recipes.example.com", token: "tok-123", fetchTimeoutMs: 5_000, ingredientParser: "nlp" };

const MARKDOWN = [
  "# Pancakes",
  "",
  "## Ingredients",
  "",
  "1. 2 eggs",
  "2. 1 cup flour",
  "",
  "## Directions",
  "",
  "1. Mix",
  "2. Cook",
  "",
  "## Equipment",
  "",
  "1. Bowl",
  "",
  "## Tips",
  "",
  "1. Don't overmix",
  "",
  "[Source](https://example.com/recipe)",
].join("\n");

/** A reasonable default mock: creates the recipe, parses ingredients as unmatched (empty array), no existing tools, tool creation succeeds, group lookup succeeds. */
function defaultFetchImpl(overrides: Partial<Record<string, (url: string, init: RequestInit) => Response | Promise<Response>>> = {}) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const method = init?.method ?? "GET";

    if (overrides[`${method} ${u}`]) return overrides[`${method} ${u}`]!(u, init!);

    if (method === "POST" && u.endsWith("/api/recipes")) return jsonResponse("pancakes");
    if (method === "POST" && u.endsWith("/api/parser/ingredients")) return jsonResponse([]);
    if (method === "GET" && u.includes("/api/organizers/tools?")) return jsonResponse({ items: [] });
    if (method === "POST" && u.endsWith("/api/organizers/tools")) {
      const body = JSON.parse(init!.body as string) as { name: string };
      return jsonResponse({ id: "tool-1", groupId: "g", name: body.name, slug: body.name.toLowerCase(), householdsWithTool: [] }, { status: 201 });
    }
    if (method === "PATCH") return jsonResponse({});
    if (method === "GET" && u.endsWith("/api/groups/self")) return jsonResponse({ slug: "home" });
    throw new Error(`unexpected request: ${method} ${u}`);
  });
}

describe("publishRecipe", () => {
  it("creates the recipe by name, patches in parsed data, and returns the slug/name/url", async () => {
    const fetchImpl = defaultFetchImpl();

    const result = await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ slug: "pancakes", name: "Pancakes", url: "https://recipes.example.com/g/home/r/pancakes", created: true });

    const calls = fetchImpl.mock.calls as [string, RequestInit][];
    const createCall = calls.find(([url, init]) => url.endsWith("/api/recipes") && init.method === "POST")!;
    expect(createCall[0]).toBe("https://recipes.example.com/api/recipes");
    expect(JSON.parse(createCall[1].body as string)).toEqual({ name: "Pancakes" });
    expect((createCall[1].headers as Record<string, string>).authorization).toBe("Bearer tok-123");

    const parserCall = calls.find(([url]) => url.endsWith("/api/parser/ingredients"))!;
    expect(JSON.parse(parserCall[1].body as string)).toEqual({ parser: "nlp", ingredients: ["2 eggs", "1 cup flour"] });

    const patchCall = calls.find(([, init]) => init.method === "PATCH")!;
    expect(patchCall[0]).toBe("https://recipes.example.com/api/recipes/pancakes");
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.name).toBe("Pancakes");
    expect(patchBody.orgURL).toBe("https://example.com/recipe");
    // The mock parser returned no matches, so ingredients fall back to unparsed notes.
    expect(patchBody.recipeIngredient).toEqual([
      { title: null, note: "2 eggs", originalText: "2 eggs", display: "2 eggs", disableAmount: true },
      { title: null, note: "1 cup flour", originalText: "1 cup flour", display: "1 cup flour", disableAmount: true },
    ]);
    expect(patchBody.recipeInstructions).toEqual([
      { title: null, text: "Mix" },
      { title: null, text: "Cook" },
    ]);
    // "Bowl" was resolved as a Mealie Tool, so it's NOT in notes and IS in `tools`.
    expect(patchBody.notes).toEqual([{ title: "Tips", text: "1. Don't overmix" }]);
    expect(patchBody.tools).toEqual([{ id: "tool-1", groupId: "g", name: "Bowl", slug: "bowl", householdsWithTool: [] }]);
  });

  it("uses Mealie's own ingredient parser output when it successfully parses a line", async () => {
    const fetchImpl = defaultFetchImpl({
      "POST https://recipes.example.com/api/parser/ingredients": () =>
        jsonResponse([
          { input: "2 eggs", confidence: {}, ingredient: { quantity: 2, unit: null, food: { name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs" } },
          { input: "1 cup flour", confidence: {}, ingredient: { quantity: 1, unit: { name: "cup" }, food: { name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour" } },
        ]),
    });

    await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.recipeIngredient).toEqual([
      { quantity: 2, unit: null, food: { name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs" },
      { quantity: 1, unit: { name: "cup" }, food: { name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour" },
    ]);
  });

  it("falls back to unparsed ingredient notes when the parser call fails, without failing the publish", async () => {
    const fetchImpl = defaultFetchImpl({
      "POST https://recipes.example.com/api/parser/ingredients": () => new Response("parser unavailable", { status: 500 }),
    });

    const result = await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);
    expect(result.slug).toBe("pancakes");

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.recipeIngredient).toEqual([
      { title: null, note: "2 eggs", originalText: "2 eggs", display: "2 eggs", disableAmount: true },
      { title: null, note: "1 cup flour", originalText: "1 cup flour", display: "1 cup flour", disableAmount: true },
    ]);
  });

  it("reuses an existing Mealie Tool by name instead of creating a duplicate", async () => {
    const fetchImpl = defaultFetchImpl({
      "GET https://recipes.example.com/api/organizers/tools?search=Bowl&perPage=10": () =>
        jsonResponse({ items: [{ id: "existing-tool", groupId: "g", name: "Bowl", slug: "bowl", householdsWithTool: [] }] }),
    });

    await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);

    const calls = fetchImpl.mock.calls as [string, RequestInit][];
    expect(calls.some(([url, init]) => init.method === "POST" && url.endsWith("/api/organizers/tools"))).toBe(false);

    const patchCall = calls.find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.tools).toEqual([{ id: "existing-tool", groupId: "g", name: "Bowl", slug: "bowl", householdsWithTool: [] }]);
  });

  it("falls back to an Equipment note when a tool can't be resolved, without failing the publish", async () => {
    const fetchImpl = defaultFetchImpl({
      "GET https://recipes.example.com/api/organizers/tools?search=Bowl&perPage=10": () => new Response("nope", { status: 500 }),
      "POST https://recipes.example.com/api/organizers/tools": () => new Response("nope", { status: 500 }),
    });

    const result = await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);
    expect(result.slug).toBe("pancakes");

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.tools).toEqual([]);
    expect(patchBody.notes).toEqual([
      { title: "Equipment", text: "- Bowl" },
      { title: "Tips", text: "1. Don't overmix" },
    ]);
  });

  it("emits a header-only ingredient entry and a shared step title for named sections", async () => {
    const markdown = [
      "# Birria Tacos",
      "",
      "## Ingredients",
      "",
      "### Birria",
      "1. Beef chuck",
      "",
      "## Directions",
      "",
      "### Birria",
      "1. Braise the beef",
    ].join("\n");

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && u.endsWith("/api/recipes")) return jsonResponse("birria-tacos");
      if (method === "POST" && u.endsWith("/api/parser/ingredients")) return jsonResponse([]);
      if (method === "PATCH") return jsonResponse({});
      if (method === "GET") return jsonResponse({}); // no slug -> url falls back; no tool matches
      throw new Error("unexpected request");
    });

    const result = await publishRecipe(CFG, markdown, fetchImpl as unknown as typeof fetch);
    expect(result.url).toBe("https://recipes.example.com/recipe/birria-tacos");

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.recipeIngredient[0]).toEqual({ title: "Birria", note: "", originalText: "", display: "", disableAmount: true });
    expect(patchBody.recipeIngredient[1]).toMatchObject({ note: "Beef chuck" });
    expect(patchBody.recipeInstructions).toEqual([{ title: "Birria", text: "Braise the beef" }]);
  });

  it("throws MealiePublishError when creating the recipe fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch)).rejects.toThrow(MealiePublishError);
  });

  it("throws MealiePublishError when the patch fails", async () => {
    const fetchImpl = defaultFetchImpl({
      "PATCH https://recipes.example.com/api/recipes/pancakes": () => new Response("server error", { status: 500 }),
    });
    await expect(publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch)).rejects.toThrow(MealiePublishError);
  });

  it("updates an existing recipe in place via PATCH when given an existingSlug, without creating a new one", async () => {
    const fetchImpl = defaultFetchImpl();

    const result = await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch, "birria-tacos");

    expect(result).toEqual({ slug: "birria-tacos", name: "Pancakes", url: "https://recipes.example.com/g/home/r/birria-tacos", created: false });

    const calls = fetchImpl.mock.calls as [string, RequestInit][];
    expect(calls.some(([url, init]) => url.endsWith("/api/recipes") && init.method === "POST")).toBe(false);

    const patchCall = calls.find(([, init]) => init.method === "PATCH")!;
    expect(patchCall[0]).toBe("https://recipes.example.com/api/recipes/birria-tacos");
  });
});

