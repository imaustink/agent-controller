import { beforeEach, describe, expect, it } from "vitest";
import { render } from "../src/render.js";
import type { FormConfig, Json, JSONSchema } from "../src/types.js";

interface Harness {
  root: HTMLElement;
  submissions: { yaml: string; values: Record<string, Json> }[];
  submit(): void;
  q<E extends Element = HTMLElement>(sel: string): E | null;
  all<E extends Element = HTMLElement>(sel: string): E[];
  /** Controls get a stable id derived from their dotted path. */
  field<E extends Element = HTMLInputElement>(path: string): E;
  errors(): string[];
  values(): Record<string, Json>;
}

function mount(cfg: Partial<FormConfig> & { schema: JSONSchema }): Harness {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const submissions: { yaml: string; values: Record<string, Json> }[] = [];
  render(root, { chart: "test-chart", ...cfg }, (yaml, values) =>
    submissions.push({ yaml, values }),
  );

  const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel);
  const all = <E extends Element = HTMLElement>(sel: string) =>
    Array.from(root.querySelectorAll<E>(sel));

  return {
    root,
    submissions,
    q,
    all,
    submit: () => q<HTMLButtonElement>(".hvf-submit")!.click(),
    field: <E extends Element = HTMLInputElement>(path: string) => {
      const id = `hvf-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const node = root.querySelector<E>(`#${id}`);
      if (!node) throw new Error(`no control for ${path} (looked for #${id})`);
      return node;
    },
    errors: () => all(".hvf-e.hvf-on").map((e) => e.textContent ?? ""),
    values: () => {
      const last = submissions[submissions.length - 1];
      if (!last) throw new Error("nothing was submitted");
      return last.values;
    },
  };
}

beforeEach(() => {
  document.body.textContent = "";
});

describe("controls for each supported schema type", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      text: { type: "string" },
      choice: { type: "string", enum: ["a", "b"], default: "a" },
      when: { type: "string", format: "date" },
      who: { type: "string", format: "email" },
      where: { type: "string", format: "uri" },
      ratio: { type: "number" },
      count: { type: "integer" },
      flag: { type: "boolean", default: true },
      list: { type: "array", items: { type: "string" } },
      records: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
      map: { type: "object", additionalProperties: { type: "string" } },
    },
  };

  it("renders a text input for a string", () => {
    const h = mount({ schema });
    expect(h.field("text").type).toBe("text");
  });

  it("renders a select for a string enum, with the default selected", () => {
    const h = mount({ schema });
    const sel = h.field<HTMLSelectElement>("choice");
    expect(sel.tagName).toBe("SELECT");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "a", "b"]);
    expect(sel.value).toBe("a");
  });

  it("renders typed inputs for date, email and uri formats", () => {
    const h = mount({ schema });
    expect(h.field("when").type).toBe("date");
    expect(h.field("who").type).toBe("email");
    expect(h.field("where").type).toBe("url");
  });

  it("renders number inputs, with step 1 only for integers", () => {
    const h = mount({ schema });
    expect(h.field("ratio").type).toBe("number");
    expect(h.field("ratio").step).toBe("any");
    expect(h.field("count").step).toBe("1");
  });

  it("renders a checkbox for a boolean, checked from the default", () => {
    const h = mount({ schema });
    expect(h.field("flag").type).toBe("checkbox");
    expect(h.field("flag").checked).toBe(true);
  });

  it("renders repeatable rows for an array of strings", () => {
    const h = mount({ schema });
    const add = h.all<HTMLButtonElement>(".hvf-add")[0]!;
    expect(h.all(".hvf-row").length).toBe(0);
    add.click();
    add.click();
    expect(h.all(".hvf-row input.hvf-in").length).toBe(2);
    h.all<HTMLButtonElement>(".hvf-row .hvf-x")[0]!.click();
    expect(h.all(".hvf-row input.hvf-in").length).toBe(1);
  });

  it("renders a repeatable card of sub-fields for an array of objects", () => {
    const h = mount({ schema: { type: "object", properties: { records: schema.properties!.records! } } });
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    expect(h.all(".hvf-card").length).toBe(1);
    expect(h.all(".hvf-card input.hvf-in").length).toBe(1);
  });

  it("renders a key/value editor for additionalProperties", () => {
    const h = mount({ schema: { type: "object", properties: { map: schema.properties!.map! } } });
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    const inputs = h.all<HTMLInputElement>(".hvf-row input.hvf-in");
    expect(inputs.length).toBe(2);
    expect(inputs[0]!.placeholder).toBe("key");
    expect(inputs[1]!.placeholder).toBe("value");
  });

  it("uses a plain button, never a form or a submit control", () => {
    const h = mount({ schema });
    expect(h.all("form").length).toBe(0);
    expect(h.all<HTMLButtonElement>("button").every((b) => b.type === "button")).toBe(true);
  });
});

describe("nesting", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      resources: {
        type: "object",
        title: "Resources",
        properties: {
          limits: {
            type: "object",
            title: "Limits",
            properties: { cpu: { type: "string", default: "500m" } },
          },
        },
      },
    },
  };

  it("produces a section per object level", () => {
    const h = mount({ schema });
    const sections = h.all("details.hvf-sec");
    expect(sections.length).toBe(2);
    expect(sections[0]!.querySelector("summary")!.textContent).toContain("Resources");
    expect(sections[1]!.querySelector("summary")!.textContent).toContain("Limits");
    // The inner section is inside the outer one, not a sibling.
    expect(sections[0]!.contains(sections[1]!)).toBe(true);
  });

  it("renders and collects a three-deep path", () => {
    const h = mount({ schema });
    h.field("resources.limits.cpu").value = "1500m";
    h.submit();
    expect(h.values()).toEqual({ resources: { limits: { cpu: "1500m" } } });
    expect(h.submissions[0]!.yaml).toContain("resources:\n  limits:\n    cpu: 1500m");
  });

  it("nests four levels and falls back below that", () => {
    const deep = (n: number): JSONSchema =>
      n === 0
        ? { type: "object", properties: { leaf: { type: "string" } } }
        : { type: "object", properties: { [`l${n}`]: deep(n - 1) } };
    const h = mount({ schema: deep(5) });
    expect(h.all("details.hvf-sec").length).toBe(4);
    const fallbacks = h.all<HTMLInputElement>("input:disabled");
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]!.value).toBe("Unsupported field type");
    // The reason names the path and the depth limit, so the fix is obvious.
    expect(h.root.textContent).toContain("nesting deeper than 4 levels");
  });

  it("still renders scalar leaves inside the fourth level", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: {
                  c: {
                    type: "object",
                    properties: { d: { type: "object", properties: { leaf: { type: "string" } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    h.field("a.b.c.d.leaf").value = "deep";
    h.submit();
    expect(h.values()).toEqual({ a: { b: { c: { d: { leaf: "deep" } } } } });
  });
});

describe("nullable fields", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      secretName: { type: ["string", "null"], default: "tls-secret" },
    },
  };

  it("renders a text input plus a null toggle", () => {
    const h = mount({ schema });
    expect(h.field("secretName").type).toBe("text");
    expect(h.field("secretName").value).toBe("tls-secret");
    expect(h.q(".hvf-null input")).not.toBeNull();
  });

  it("can be cleared to null, which survives pruning", () => {
    const h = mount({ schema });
    const nul = h.q<HTMLInputElement>(".hvf-null input")!;
    nul.checked = true;
    nul.dispatchEvent(new Event("change"));
    expect(h.field("secretName").disabled).toBe(true);
    h.submit();
    expect(h.values()).toEqual({ secretName: null });
    expect(h.submissions[0]!.yaml).toContain("secretName: null");
  });
});

describe("$ref", () => {
  it("resolves a local $ref into $defs and renders it", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: { tls: { $ref: "#/$defs/tls" } },
        $defs: {
          tls: {
            type: "object",
            title: "TLS",
            properties: { enabled: { type: "boolean" }, host: { type: "string" } },
          },
        },
      },
    });
    expect(h.q("details.hvf-sec summary")!.textContent).toContain("TLS");
    expect(h.field("tls.enabled").type).toBe("checkbox");
    h.field("tls.host").value = "example.com";
    h.submit();
    expect(h.values()).toEqual({ tls: { host: "example.com" } });
  });

  it("falls back for a remote $ref rather than fetching it", () => {
    const h = mount({
      schema: { type: "object", properties: { x: { $ref: "https://example.com/s.json" } } },
    });
    expect(h.all("input:disabled").length).toBe(1);
  });
});

describe("free-form maps", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      podAnnotations: {
        type: "object",
        additionalProperties: { type: "string" },
        default: {},
      },
    },
  };

  it("collects the keys the user adds", () => {
    const h = mount({ schema });
    const add = h.q<HTMLButtonElement>(".hvf-add")!;
    add.click();
    add.click();
    const inputs = h.all<HTMLInputElement>(".hvf-row input.hvf-in");
    inputs[0]!.value = "prometheus.io/scrape";
    inputs[1]!.value = "true";
    inputs[2]!.value = "team";
    inputs[3]!.value = "platform";
    h.submit();
    expect(h.values()).toEqual({
      podAnnotations: { "prometheus.io/scrape": "true", team: "platform" },
    });
    // The string "true" must survive as a string, or Kubernetes rejects the
    // annotation.
    expect(h.submissions[0]!.yaml).toContain("'true'");
  });

  it("rejects a duplicate key", () => {
    const h = mount({ schema });
    const add = h.q<HTMLButtonElement>(".hvf-add")!;
    add.click();
    add.click();
    const inputs = h.all<HTMLInputElement>(".hvf-row input.hvf-in");
    inputs[0]!.value = "a";
    inputs[1]!.value = "1";
    inputs[2]!.value = "a";
    inputs[3]!.value = "2";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors().join(" ")).toContain("Duplicate key");
  });

  it("rejects a value with no key", () => {
    const h = mount({ schema });
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    h.all<HTMLInputElement>(".hvf-row input.hvf-in")[1]!.value = "orphan";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors().join(" ")).toContain("key is required");
  });

  it("adds an extra-keys editor alongside fixed properties without clobbering them", () => {
    // A node with both `properties` and `additionalProperties`. The extra-keys
    // editor binds to the parent object's own path, so a plain assignment would
    // overwrite everything the typed controls collected.
    const h = mount({
      schema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: { logLevel: { type: "string" } },
            additionalProperties: { type: "string" },
          },
        },
      },
    });
    h.field("config.logLevel").value = "debug";
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    const rows = h.all<HTMLInputElement>(".hvf-row input.hvf-in");
    rows[0]!.value = "customKey";
    rows[1]!.value = "customValue";
    h.submit();
    expect(h.values()).toEqual({ config: { logLevel: "debug", customKey: "customValue" } });
  });

  it("rejects an extra key that collides with a field of its own", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: { logLevel: { type: "string" } },
            additionalProperties: { type: "string" },
          },
        },
      },
    });
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    const rows = h.all<HTMLInputElement>(".hvf-row input.hvf-in");
    rows[0]!.value = "logLevel";
    rows[1]!.value = "trace";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors().join(" ")).toContain("its own field");
  });

  it("drops an untouched map, so it does not restate the default", () => {
    const h = mount({ schema });
    h.submit();
    expect(h.values()).toEqual({});
  });
});

describe("validation", () => {
  it("blocks submit on a required field nested inside a section", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          temporal: {
            type: "object",
            properties: { namespace: { type: "string" } },
            required: ["namespace"],
          },
        },
      },
    });
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors()).toContain("Required.");
    expect(h.q(".hvf-summary")!.textContent).toContain("1 field needs attention");
  });

  it("expands the containing section and focuses the offending control", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          outer: {
            type: "object",
            properties: {
              inner: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
          },
        },
      },
    });
    for (const d of h.all<HTMLDetailsElement>("details")) d.open = false;
    h.submit();
    expect(h.all<HTMLDetailsElement>("details").every((d) => d.open)).toBe(true);
    expect(document.activeElement).toBe(h.field("outer.inner.name"));
  });

  it("expands every section holding an error, not just the first field's", () => {
    // The regression this guards: when the first invalid field is at the top
    // level its section chain is empty, so expanding only that chain leaves the
    // other errors hidden inside collapsed sections.
    const h = mount({
      schema: {
        type: "object",
        properties: {
          replicaCount: { type: "integer", maximum: 50 },
          temporal: {
            type: "object",
            properties: { namespace: { type: "string" } },
            required: ["namespace"],
          },
          resources: {
            type: "object",
            properties: {
              limits: {
                type: "object",
                properties: { cpu: { type: "string", pattern: "^[0-9]+m$" } },
              },
            },
          },
        },
      },
    });
    h.field("replicaCount").value = "99";
    h.field("resources.limits.cpu").value = "not-a-quantity";
    for (const d of h.all<HTMLDetailsElement>("details")) d.open = false;

    h.submit();

    expect(h.submissions.length).toBe(0);
    expect(h.errors().length).toBe(3);
    // Both the Temporal section and the nested Resources > Limits chain open.
    expect(h.all<HTMLDetailsElement>("details").every((d) => d.open)).toBe(true);
    // Focus still lands on the first offender, which is the top-level one.
    expect(document.activeElement).toBe(h.field("replicaCount"));
  });

  it("leaves sections without errors alone", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          clean: { type: "object", properties: { ok: { type: "string" } } },
          dirty: {
            type: "object",
            properties: { needed: { type: "string" } },
            required: ["needed"],
          },
        },
      },
    });
    const [clean, dirty] = h.all<HTMLDetailsElement>("details");
    clean!.open = false;
    dirty!.open = false;

    h.submit();

    expect(clean!.open).toBe(false);
    expect(dirty!.open).toBe(true);
  });

  it("blocks submit when minimum is violated", () => {
    const h = mount({
      schema: { type: "object", properties: { replicaCount: { type: "integer", minimum: 1 } } },
    });
    h.field("replicaCount").value = "0";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors()).toContain("Must be 1 or more.");
  });

  it("blocks submit when maxLength is violated", () => {
    const h = mount({
      schema: { type: "object", properties: { name: { type: "string", maxLength: 4 } } },
    });
    h.field("name").value = "toolong";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors()).toContain("Must be at most 4 characters.");
  });

  it("blocks submit when pattern is violated", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: { queue: { type: "string", pattern: "^[a-z-]+$" } },
      },
    });
    h.field("queue").value = "Not Valid";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors().join(" ")).toContain("Must match ^[a-z-]+$");
  });

  it("blocks submit when an integer field holds a fraction", () => {
    const h = mount({
      schema: { type: "object", properties: { n: { type: "integer" } } },
    });
    h.field("n").value = "1.5";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors()).toContain("Must be a whole number.");
  });

  it("validates a required sub-field inside an array card", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          extraEnv: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, value: { type: "string" } },
              required: ["name"],
            },
          },
        },
      },
    });
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    h.all<HTMLInputElement>(".hvf-card input.hvf-in")[1]!.value = "no-name";
    h.submit();
    expect(h.submissions.length).toBe(0);
    expect(h.errors()).toContain("Required.");
  });

  it("clears the error once the value is fixed", () => {
    const h = mount({
      schema: { type: "object", properties: { n: { type: "integer", minimum: 1 } } },
    });
    h.field("n").value = "0";
    h.submit();
    expect(h.errors().length).toBe(1);
    h.field("n").value = "2";
    h.submit();
    expect(h.errors().length).toBe(0);
    expect(h.values()).toEqual({ n: 2 });
  });

  it("does not mark an untouched optional field invalid", () => {
    const h = mount({
      schema: { type: "object", properties: { note: { type: "string", maxLength: 3 } } },
    });
    h.submit();
    expect(h.submissions.length).toBe(1);
    expect(h.values()).toEqual({});
  });
});

describe("the allowlist tripwire", () => {
  it("refuses to render when an include path does not resolve", () => {
    const h = mount({
      schema: { type: "object", properties: { image: { type: "object", properties: { tag: { type: "string" } } } } },
      include: ["image.tag", "image.digest", "nope.at.all"],
    });
    const banner = h.q(".hvf-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("allowlist");
    expect(banner!.textContent).toContain("image.digest");
    expect(banner!.textContent).toContain("nope.at.all");
    expect(banner!.textContent).not.toContain("image.tag,");
    // No form and no submit button: a form missing fields would emit a values
    // file missing an override the user asked for.
    expect(h.q(".hvf-submit")).toBeNull();
    expect(h.all("input").length).toBe(0);
  });

  it("renders normally when every include path resolves", () => {
    const h = mount({
      schema: { type: "object", properties: { image: { type: "object", properties: { tag: { type: "string" } } } } },
      include: ["image.tag"],
    });
    expect(h.q(".hvf-banner")).toBeNull();
    expect(h.field("image.tag")).toBeTruthy();
  });
});

describe("hostile and broken schemas", () => {
  it("renders a disabled fallback for an unknown type without throwing", () => {
    const h = mount({
      schema: {
        type: "object",
        properties: {
          weird: { type: "wat" as never },
          alsoWeird: { anyOf: [{ type: "string" }, { type: "object" }] },
          fine: { type: "string" },
        },
      },
    });
    const disabled = h.all<HTMLInputElement>("input:disabled");
    expect(disabled.length).toBe(2);
    expect(disabled[0]!.value).toBe("Unsupported field type");
    // The renderable field beside them still works.
    h.field("fine").value = "ok";
    h.submit();
    expect(h.values()).toEqual({ fine: "ok" });
  });

  it("renders an error state, not a blank root, for a schema with no properties", () => {
    const h = mount({ schema: { type: "object" } });
    expect(h.q(".hvf-banner")).not.toBeNull();
    expect(h.root.textContent).toContain("cannot be rendered as a form");
  });

  it("renders an error state for a schema that is not an object at all", () => {
    for (const schema of [{}, { type: "string" } as JSONSchema, { type: "array" } as JSONSchema]) {
      const h = mount({ schema });
      expect(h.q(".hvf-banner")).not.toBeNull();
    }
  });

  it("never interprets schema text as HTML", () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const h = mount({
      schema: {
        type: "object",
        title: payload,
        properties: {
          f: { type: "string", title: payload, description: payload },
          e: { type: "string", enum: [payload] },
        },
      },
      title: payload,
      description: payload,
    });
    expect(h.all("img").length).toBe(0);
    expect(h.all("script").length).toBe(0);
    expect(h.root.textContent).toContain(payload);
    expect(h.q<HTMLSelectElement>("select")!.options[1]!.textContent).toBe(payload);
  });

  it("labels a field by its key when the schema has no title", () => {
    const h = mount({ schema: { type: "object", properties: { taskQueue: { type: "string" } } } });
    expect(h.q(".hvf-l")!.textContent).toContain("taskQueue");
  });
});

describe("what gets submitted", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      replicaCount: { type: "integer", default: 1 },
      image: { type: "object", properties: { tag: { type: "string", default: "0.1.0" } } },
    },
  };

  it("emits only the fields that differ from the defaults", () => {
    const h = mount({ schema, chart: "temporal-worker" });
    h.field("image.tag").value = "1.42.3";
    h.submit();
    expect(h.values()).toEqual({ image: { tag: "1.42.3" } });
    const yaml = h.submissions[0]!.yaml;
    expect(yaml).toContain("image:\n  tag: 1.42.3");
    expect(yaml).not.toContain("replicaCount");
  });

  it("carries a generated-by header naming the chart", () => {
    const h = mount({ schema, chart: "temporal-worker", chartVersion: "0.3.1" });
    h.submit();
    const yaml = h.submissions[0]!.yaml;
    expect(yaml).toContain("# Generated by helm-values-form for chart: temporal-worker");
    expect(yaml).toContain("# Schema version: 0.3.1");
  });

  it("says so explicitly when nothing was overridden", () => {
    const h = mount({ schema });
    h.submit();
    expect(h.submissions[0]!.yaml).toContain("No overrides");
    expect(h.submissions[0]!.values).toEqual({});
  });

  it("does not emit false for a checkbox the user never touched", () => {
    // A checkbox has no blank state, so without this an untouched boolean with
    // no schema default would override the chart with `false`.
    const h = mount({ schema: { type: "object", properties: { debug: { type: "boolean" } } } });
    h.submit();
    expect(h.values()).toEqual({});
  });

  it("does emit false once the user has actually toggled it", () => {
    const h = mount({ schema: { type: "object", properties: { debug: { type: "boolean" } } } });
    const box = h.field("debug");
    box.click(); // on
    box.click(); // and deliberately back off
    h.submit();
    expect(h.values()).toEqual({ debug: false });
  });

  it("emits a boolean flipped away from its default", () => {
    const h = mount({
      schema: { type: "object", properties: { debug: { type: "boolean", default: true } } },
    });
    h.field("debug").click();
    h.submit();
    expect(h.values()).toEqual({ debug: false });
  });

  it("drops a blank row the user added but never filled in", () => {
    const h = mount({
      schema: { type: "object", properties: { extraArgs: { type: "array", items: { type: "string" } } } },
    });
    h.q<HTMLButtonElement>(".hvf-add")!.click();
    h.submit();
    expect(h.values()).toEqual({});
  });
});
