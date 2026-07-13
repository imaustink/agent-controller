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
    // Default: food/unit search returns no existing match; create returns a new entity with an id.
    if (method === "GET" && u.includes("/api/foods?")) return jsonResponse({ items: [] });
    if (method === "POST" && u.endsWith("/api/foods")) {
      const body = JSON.parse(init!.body as string) as { name: string };
      return jsonResponse({ id: `food-${body.name}`, name: body.name });
    }
    if (method === "GET" && u.includes("/api/units?")) return jsonResponse({ items: [] });
    if (method === "POST" && u.endsWith("/api/units")) {
      const body = JSON.parse(init!.body as string) as { name: string };
      return jsonResponse({ id: `unit-${body.name}`, name: body.name });
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
    // On the create path the name is NOT re-sent -- Mealie already assigned it during
    // POST, and re-asserting it trips Mealie's name-uniqueness check ("Recipe already exists").
    expect(patchBody.name).toBeUndefined();
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
    // Simulate realistic parser response: unit has a real id (known unit), food has a real id (known food).
    const fetchImpl = defaultFetchImpl({
      "POST https://recipes.example.com/api/parser/ingredients": () =>
        jsonResponse([
          { input: "2 eggs", confidence: {}, ingredient: { quantity: 2, unit: null, food: { id: "food-eggs", name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs", referenceId: "ref-1" } },
          { input: "1 cup flour", confidence: {}, ingredient: { quantity: 1, unit: { id: "unit-cup", name: "cup" }, food: { id: "food-flour", name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour", referenceId: "ref-2" } },
        ]),
    });

    await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    expect(patchBody.recipeIngredient).toEqual([
      { quantity: 2, unit: null, food: { id: "food-eggs", name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs", referenceId: "ref-1" },
      { quantity: 1, unit: { id: "unit-cup", name: "cup" }, food: { id: "food-flour", name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour", referenceId: "ref-2" },
    ]);
  });

  it("resolves foods/units with null IDs by creating them in Mealie before the PATCH", async () => {
    // Mealie's parser returns food/unit with id: null when not in its database yet.
    // The resolution step (search + create) runs before the PATCH so all ingredients
    // end up with valid UUIDs and Mealie's full quantity/unit/food structure is used.
    const fetchImpl = defaultFetchImpl({
      "POST https://recipes.example.com/api/parser/ingredients": () =>
        jsonResponse([
          { input: "2 eggs", confidence: {}, ingredient: { quantity: 2, unit: { id: "unit-each", name: "each" }, food: { id: null, name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs", referenceId: "ref-1", disableAmount: null } },
          { input: "1 cup flour", confidence: {}, ingredient: { quantity: 1, unit: { id: null, name: "cup" }, food: { id: "food-flour", name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour", referenceId: "ref-2", disableAmount: null } },
        ]),
      // food "eggs": no existing match → create returns a new ID
      "GET https://recipes.example.com/api/foods?search=eggs&perPage=10": () => jsonResponse({ items: [] }),
      "POST https://recipes.example.com/api/foods": () => jsonResponse({ id: "created-food-eggs", name: "eggs" }),
      // unit "cup": existing match found → reuse its ID
      "GET https://recipes.example.com/api/units?search=cup&perPage=10": () => jsonResponse({ items: [{ id: "existing-unit-cup", name: "cup" }] }),
    });

    await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    // Both ingredients now use the structured format with valid IDs (no fallback to plain text)
    expect(patchBody.recipeIngredient).toEqual([
      { quantity: 2, unit: { id: "unit-each", name: "each" }, food: { id: "created-food-eggs", name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs", referenceId: "ref-1", disableAmount: null },
      { quantity: 1, unit: { id: "existing-unit-cup", name: "cup" }, food: { id: "food-flour", name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour", referenceId: "ref-2", disableAmount: null },
    ]);
    // resolution creates food but reuses existing unit — no POST to /api/units
    const calls = fetchImpl.mock.calls as [string, RequestInit][];
    expect(calls.some(([u, i]) => i.method === "POST" && u.endsWith("/api/foods"))).toBe(true);
    expect(calls.some(([u, i]) => i.method === "POST" && u.endsWith("/api/units"))).toBe(false);
  });

  it("falls back to unparsed text when food/unit resolution also fails, without failing the publish", async () => {
    // If the parser returns null IDs AND the resolve/create calls also fail, the ingredient
    // gracefully falls back to plain text so the publish itself still succeeds.
    const fetchImpl = defaultFetchImpl({
      "POST https://recipes.example.com/api/parser/ingredients": () =>
        jsonResponse([
          { input: "2 eggs", confidence: {}, ingredient: { quantity: 2, unit: { id: "unit-each", name: "each" }, food: { id: null, name: "eggs" }, note: "", display: "2 eggs", title: null, originalText: "2 eggs", referenceId: "ref-1", disableAmount: null } },
          { input: "1 cup flour", confidence: {}, ingredient: { quantity: 1, unit: { id: null, name: "cup" }, food: { id: "food-flour", name: "flour" }, note: "", display: "1 cup flour", title: null, originalText: "1 cup flour", referenceId: "ref-2", disableAmount: null } },
        ]),
      // Both resolution calls fail
      "GET https://recipes.example.com/api/foods?search=eggs&perPage=10": () => new Response("err", { status: 500 }),
      "POST https://recipes.example.com/api/foods": () => new Response("err", { status: 500 }),
      "GET https://recipes.example.com/api/units?search=cup&perPage=10": () => new Response("err", { status: 500 }),
      "POST https://recipes.example.com/api/units": () => new Response("err", { status: 500 }),
    });

    const result = await publishRecipe(CFG, MARKDOWN, fetchImpl as unknown as typeof fetch);
    expect(result.slug).toBe("pancakes"); // publish succeeded despite resolution failures

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    // Both fall back to unparsed plain text (full ingredient text preserved)
    expect(patchBody.recipeIngredient).toEqual([
      { title: null, note: "2 eggs", originalText: "2 eggs", display: "2 eggs", disableAmount: true },
      { title: null, note: "1 cup flour", originalText: "1 cup flour", display: "1 cup flour", disableAmount: true },
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

  it("sets title on the first ingredient of each named section (no separate header row)", async () => {
    const markdown = [
      "# Birria Tacos",
      "",
      "## Ingredients",
      "",
      "### Birria",
      "1. Beef chuck",
      "2. Dried chiles",
      "",
      "### Quesa Tacos",
      "1. Corn tortillas",
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
      if (method === "GET") return jsonResponse({});
      throw new Error("unexpected request");
    });

    await publishRecipe(CFG, markdown, fetchImpl as unknown as typeof fetch);

    const patchCall = (fetchImpl.mock.calls as [string, RequestInit][]).find(([, init]) => init.method === "PATCH")!;
    const patchBody = JSON.parse(patchCall[1].body as string);
    // title: "Birria" on the FIRST ingredient of that section → Mealie section header
    // title: null on subsequent items in the same section
    // title: "Quesa Tacos" on the first ingredient of the next section
    // No separate empty header-only entry — that would render as a blank checkbox row
    expect(patchBody.recipeIngredient).toEqual([
      { title: "Birria", note: "Beef chuck", originalText: "Beef chuck", display: "Beef chuck", disableAmount: true },
      { title: null, note: "Dried chiles", originalText: "Dried chiles", display: "Dried chiles", disableAmount: true },
      { title: "Quesa Tacos", note: "Corn tortillas", originalText: "Corn tortillas", display: "Corn tortillas", disableAmount: true },
    ]);
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
    // The update path DOES re-send the name so title edits during refinement take effect.
    expect(JSON.parse(patchCall[1].body as string).name).toBe("Pancakes");
  });
});

