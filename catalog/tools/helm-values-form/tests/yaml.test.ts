/**
 * Round-trip tests for the emitter.
 *
 * Everything goes back through the `yaml` package -- a dev dependency, never
 * shipped -- in **YAML 1.1 mode**, because that is the resolver Helm uses
 * (sigs.k8s.io/yaml -> go-yaml). In 1.2 mode a bare `yes` stays the string
 * "yes" and half of these assertions would pass while the shipped emitter
 * silently corrupted values.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { emitYaml, needsQuotes } from "../src/yaml.js";

/** Helm's resolver, not the modern one. */
function parse11(src: string): unknown {
  return parse(src, { version: "1.1" });
}

function roundTrip(value: unknown): unknown {
  return parse11(emitYaml(value));
}

describe("emitYaml round-trips", () => {
  const fixtures: Record<string, unknown> = {
    "an empty object": {},
    "flat scalars": { name: "worker", replicas: 3, enabled: true, disabled: false, unset: null },
    "nested maps": {
      image: { repository: "ghcr.io/example/app", tag: "1.42.3" },
      resources: { limits: { cpu: "500m", memory: "1Gi" } },
    },
    "three levels deep": { a: { b: { c: { d: "leaf" } } } },
    "a sequence of scalars": { extraArgs: ["--verbose", "--max=10"] },
    "a sequence of maps": {
      extraEnv: [
        { name: "LOG_LEVEL", value: "debug" },
        { name: "REGION", value: "us-east-1" },
      ],
    },
    "a sequence of maps with nested maps": {
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-pvc" } }],
    },
    "a sequence of sequences": { matrix: [["a", "b"], ["c"]] },
    "empty containers": { podAnnotations: {}, extraArgs: [] },
    "numbers at the edges": { zero: 0, negative: -1, float: 0.5, big: 1e21, small: 1e-7 },
    "free-form map keys": {
      podAnnotations: { "prometheus.io/scrape": "true", "example.com/note": "yes" },
    },
    "keys that look like other types": { "1": "one", "true": "yes", "null": "nothing", "on": "x" },
  };

  for (const [label, value] of Object.entries(fixtures)) {
    it(label, () => {
      expect(roundTrip(value)).toEqual(value);
    });
  }
});

describe("strings that would parse as something else", () => {
  // Each of these, emitted bare, comes back as a boolean, a number, a null, a
  // date, or a parse error. They must all survive as strings.
  const hazards = [
    "yes",
    "no",
    "on",
    "off",
    "y",
    "N",
    "true",
    "FALSE",
    "null",
    "Null",
    "~",
    "",
    "3.14",
    "0",
    "-1",
    "1e3",
    "0x10",
    "0o17",
    "010",
    "1_000",
    ".inf",
    ".nan",
    "1:30",
    "2024-01-01",
    "2024-01-01T10:30:00Z",
    "a: b",
    "text # not a comment",
    "trailing:",
    "- item",
    "-",
    "? maybe",
    ": colon",
    "#hash",
    "&anchor",
    "*alias",
    "!tag",
    "|pipe",
    ">fold",
    "%directive",
    "@reserved",
    "`backtick",
    "{brace",
    "[bracket",
    ",comma",
    "'quoted'",
    '"quoted"',
    "  padded  ",
    "trailing space ",
  ];

  for (const s of hazards) {
    it(`keeps ${JSON.stringify(s)} a string`, () => {
      const out = roundTrip({ v: s }) as { v: unknown };
      expect(out.v).toBe(s);
      expect(typeof out.v).toBe("string");
    });
  }

  it("keeps them strings inside sequences and as keys too", () => {
    expect(roundTrip({ list: hazards })).toEqual({ list: hazards });
    const asKeys = Object.fromEntries(hazards.filter((h) => h !== "").map((h) => [h, "v"]));
    expect(roundTrip(asKeys)).toEqual(asKeys);
  });
});

describe("strings that do not need quoting stay readable", () => {
  // Over-quoting is safe but ugly, and a values file that lands in git should
  // read like one a person wrote. These are the common Helm shapes.
  const plain = ["128Mi", "500m", "1.14.2", "-Xmx512m", "IfNotPresent", "worker-tq", "v1.2.3-rc1"];

  for (const s of plain) {
    it(`emits ${s} unquoted`, () => {
      expect(needsQuotes(s)).toBe(false);
      expect(emitYaml({ v: s })).toBe(`v: ${s}`);
      expect((roundTrip({ v: s }) as { v: unknown }).v).toBe(s);
    });
  }

  it("leaves a host:port unquoted only when no space follows the colon", () => {
    expect(emitYaml({ v: "temporal:7233" })).toBe("v: temporal:7233");
    expect(needsQuotes("host: value")).toBe(true);
  });
});

describe("multi-line strings", () => {
  it("uses a |- block scalar and round-trips", () => {
    const value = { script: "set -e\necho hello\nexit 0" };
    const out = emitYaml(value);
    expect(out).toContain("script: |-");
    expect(parse11(out)).toEqual(value);
  });

  it("indents block bodies under their key at any depth", () => {
    const value = { outer: { inner: "one\ntwo" } };
    expect(emitYaml(value)).toBe("outer:\n  inner: |-\n    one\n    two");
    expect(parse11(emitYaml(value))).toEqual(value);
  });

  it("uses | when the string ends in a single newline", () => {
    const value = { body: "a\nb\n" };
    expect(emitYaml(value)).toContain("body: |");
    expect(emitYaml(value)).not.toContain("|-");
    expect(parse11(emitYaml(value))).toEqual(value);
  });

  it("falls back to a quoted form when a block scalar could not round-trip", () => {
    // Leading indentation, trailing spaces, CR, and multiple trailing newlines
    // are all silently altered by block scalars.
    for (const s of ["  indented\nnext", "trailing \nnext", "a\r\nb", "a\n\n\n"]) {
      const out = emitYaml({ v: s });
      expect(out).not.toContain("|");
      expect(parse11(out)).toEqual({ v: s });
    }
  });

  it("round-trips a multi-line string inside a sequence of maps", () => {
    const value = { steps: [{ name: "build", run: "make\nmake test" }] };
    expect(parse11(emitYaml(value))).toEqual(value);
  });
});

describe("shape of the output", () => {
  it("is byte-identical when the same object is emitted twice", () => {
    const value = {
      image: { tag: "1.2.3" },
      extraEnv: [{ name: "A", value: "1" }],
      podAnnotations: { "b/c": "yes" },
    };
    expect(emitYaml(value)).toBe(emitYaml(value));
  });

  it("follows insertion order, which prune.ts makes schema order", () => {
    expect(emitYaml({ b: 1, a: 2, c: 3 })).toBe("b: 1\na: 2\nc: 3");
  });

  it("uses two-space block style with aligned sequence-of-map keys", () => {
    expect(emitYaml({ env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] })).toBe(
      ["env:", "  - name: A", "    value: '1'", "  - name: B", "    value: '2'"].join("\n"),
    );
  });

  it("writes header lines as comments and no trailing newline", () => {
    const out = emitYaml({ a: 1 }, { header: ["generated by x", "", "chart: y"] });
    expect(out).toBe("# generated by x\n#\n# chart: y\na: 1");
    expect(out.endsWith("\n")).toBe(false);
    expect(parse11(out)).toEqual({ a: 1 });
  });

  it("emits empty containers in flow form so they are still valid", () => {
    expect(emitYaml({ m: {}, l: [] })).toBe("m: {}\nl: []");
    expect(emitYaml({})).toBe("{}");
    expect(emitYaml([])).toBe("[]");
  });

  it("refuses values it cannot represent rather than inventing one", () => {
    expect(() => emitYaml({ v: Symbol("x") as unknown })).toThrow(/cannot represent/);
  });
});
