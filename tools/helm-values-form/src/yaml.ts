/**
 * A minimal, dependency-free YAML emitter for exactly the shape prune.ts
 * produces: nested maps, sequences of scalars, sequences of maps, and scalars.
 * No anchors, no flow style (beyond empty `{}` / `[]`), no multi-document.
 *
 * The whole risk in this file is quoting. The output is fed to Helm, which
 * parses through sigs.k8s.io/yaml -> go-yaml, a YAML 1.1 resolver: there, a
 * bare `yes` is the boolean true, a bare `3.14` is a float, and a bare
 * `2024-01-01` is a timestamp. An image tag of `1.10` silently becoming the
 * number 1.1 is the class of bug this file exists to prevent, so the
 * "does this need quotes" test below is deliberately broader than YAML 1.2
 * would require. Over-quoting is free -- Helm parses `'128Mi'` and `128Mi` to
 * the same string, so it cannot change a rendered manifest -- while
 * under-quoting corrupts values.
 */

export interface EmitOptions {
  /** Comment lines placed above the document, written without the leading "# ". */
  header?: string[];
}

const INDENT = "  ";

/**
 * Renders `value` as a YAML document. The result has no trailing newline; the
 * caller decides that (the shell wraps it in a fenced code block).
 *
 * Key order is the object's own insertion order, which is how the emitter
 * stays deterministic without knowing anything about schemas. prune.ts is what
 * makes that order meaningful: it builds its output by walking the schema's
 * `properties`, so insertion order *is* schema order by the time we get here.
 * User-keyed maps (podAnnotations and friends) keep the order they were
 * entered in, which is the only order that exists for them.
 */
export function emitYaml(value: unknown, opts: EmitOptions = {}): string {
  const lines: string[] = [];
  for (const line of opts.header ?? []) lines.push(line === "" ? "#" : `# ${line}`);

  if (isPlainObject(value)) {
    const keys = presentKeys(value);
    if (keys.length === 0) lines.push("{}");
    else emitMapInto(lines, value, keys, "");
  } else if (Array.isArray(value)) {
    if (value.length === 0) lines.push("[]");
    else emitSeqInto(lines, value, "");
  } else {
    lines.push(...scalarLines(value, ""));
  }

  return lines.join("\n");
}

// --- containers ------------------------------------------------------------

function emitMapInto(
  lines: string[],
  obj: Record<string, unknown>,
  keys: string[],
  pad: string,
): void {
  for (const key of keys) {
    const label = `${pad}${formatKey(key)}:`;
    const v = obj[key];

    if (isPlainObject(v)) {
      const childKeys = presentKeys(v);
      if (childKeys.length === 0) {
        lines.push(`${label} {}`);
      } else {
        lines.push(label);
        emitMapInto(lines, v, childKeys, pad + INDENT);
      }
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${label} []`);
      } else {
        lines.push(label);
        emitSeqInto(lines, v, pad + INDENT);
      }
    } else {
      const [head, ...rest] = scalarLines(v, pad + INDENT);
      lines.push(`${label} ${head}`);
      lines.push(...rest);
    }
  }
}

function emitSeqInto(lines: string[], arr: unknown[], pad: string): void {
  // "- " is two columns, so a map's continuation keys line up under its first
  // key at pad + INDENT. That alignment is what makes `- name: x` / `  value: y`
  // parse as one mapping rather than two entries.
  const inner = pad + INDENT;

  for (const item of arr) {
    if (isPlainObject(item)) {
      const keys = presentKeys(item);
      if (keys.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const buf: string[] = [];
      emitMapInto(buf, item, keys, inner);
      // Splice the dash onto the first line in place of its indentation.
      lines.push(`${pad}- ${buf[0]!.slice(inner.length)}`);
      lines.push(...buf.slice(1));
    } else if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}- []`);
      } else {
        const buf: string[] = [];
        emitSeqInto(buf, item, inner);
        lines.push(`${pad}- ${buf[0]!.slice(inner.length)}`);
        lines.push(...buf.slice(1));
      }
    } else {
      const [head, ...rest] = scalarLines(item, inner);
      lines.push(`${pad}- ${head}`);
      lines.push(...rest);
    }
  }
}

/**
 * `undefined` is not representable in YAML. prune.ts never produces it, but a
 * hand-built object might, so map keys holding it are skipped the way
 * JSON.stringify skips them rather than emitted as a bogus `null`.
 */
function presentKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter((k) => obj[k] !== undefined);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- scalars ---------------------------------------------------------------

/**
 * A scalar as one or more lines. Multi-line strings return the block-scalar
 * header (`|-`) followed by the already-indented body, so callers append the
 * first line to `key:` and push the rest verbatim.
 */
function scalarLines(v: unknown, pad: string): [string, ...string[]] {
  if (v === null || v === undefined) return ["null"];

  switch (typeof v) {
    case "boolean":
      return [v ? "true" : "false"];
    case "number":
      return [formatNumber(v)];
    case "string":
      return formatString(v, pad);
    default:
      // Symbols, functions, bigints: nothing sane to emit. Fail loudly here
      // rather than write a file Helm will reject in a confusing way.
      throw new TypeError(`emitYaml: cannot represent ${typeof v}`);
  }
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return ".nan";
  if (n === Infinity) return ".inf";
  if (n === -Infinity) return "-.inf";
  // JS number->string is round-trip exact for finite doubles, and never
  // produces a form YAML reads as anything but a number.
  return String(n);
}

function formatString(s: string, pad: string): [string, ...string[]] {
  if (s.includes("\n")) {
    const block = blockScalar(s, pad);
    if (block) return block;
    // Block form could not round-trip this string (see blockScalar); a
    // double-quoted escape always can.
    return [doubleQuote(s)];
  }
  if (needsQuotes(s)) {
    return [hasControlChars(s) ? doubleQuote(s) : singleQuote(s)];
  }
  return [s];
}

/**
 * Block scalar (`|-`), or null when the string cannot survive one.
 *
 * A block scalar is defined by indentation, so it silently mangles any line
 * with leading whitespace and any trailing space on a line. Rather than emit
 * something that parses back differently, those cases return null and get
 * double-quoted instead -- `parse(emit(x)) === x` is the invariant that
 * matters, prettiness is not.
 */
function blockScalar(s: string, pad: string): [string, ...string[]] | null {
  if (hasControlChars(s)) return null;

  // Split off trailing newlines; they decide the chomping indicator.
  const trailing = /\n*$/.exec(s)![0].length;
  const body = s.slice(0, s.length - trailing);
  // 0 -> "|-" (strip), 1 -> "|" (clip). More than one trailing newline needs
  // "|+" plus genuinely empty lines, which is fragile enough to not be worth
  // it against a double-quoted string that is simply correct.
  if (trailing > 1) return null;
  const indicator = trailing === 0 ? "|-" : "|";

  const bodyLines = body.split("\n");
  for (const line of bodyLines) {
    if (/^[ \t]/.test(line)) return null; // would read as extra indentation
    if (/[ \t]$/.test(line)) return null; // trailing space, silently lost
  }
  if (bodyLines[0] === "") return null; // leading blank line needs an explicit indent indicator

  // `pad` is already the column the body belongs at -- callers pass the
  // *content* indentation, not the key's. Adding INDENT again here would still
  // parse (a block scalar takes its indentation from its first line) which is
  // exactly why it went unnoticed until an exact-output assertion caught it.
  return [indicator, ...bodyLines.map((l) => (l === "" ? "" : pad + l))];
}

const YAML_NULL = /^(?:~|null|Null|NULL)$/;

/**
 * YAML 1.1 booleans. go-yaml (and therefore Helm) resolves every one of these,
 * including the bare `y`/`n` forms, so a chart value of "n" for a region code
 * or "off" for a mode has to be quoted.
 */
const YAML_BOOL =
  /^(?:y|Y|n|N|yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;

const NUMERIC = [
  /^[-+]?[0-9][0-9_]*$/, // decimal int
  /^0[oO]?[0-7_]+$/, // octal, both the 0o and bare-leading-zero forms
  /^[-+]?0[xX][0-9a-fA-F_]+$/, // hex
  /^[-+]?0[bB][01_]+$/, // binary
  /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?$/, // float: 3.14, .5, 1.
  /^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/, // 1e3, 1.5E-4
  /^[-+]?\.(?:inf|Inf|INF)$/,
  /^\.(?:nan|NaN|NAN)$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/, // sexagesimal (1:30)
];

/** YAML 1.1 timestamps, which go-yaml turns into a time.Time, not a string. */
const TIMESTAMP = [
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$/,
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}/,
];

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) continue; // newline is not "control" here -- it routes to blockScalar
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Exported for tests: the single decision this file lives or dies by. */
export function needsQuotes(s: string): boolean {
  if (s === "") return true;
  if (s !== s.trim()) return true; // leading/trailing whitespace is not preserved plain
  if (hasControlChars(s)) return true;

  if (YAML_NULL.test(s)) return true;
  if (YAML_BOOL.test(s)) return true;
  if (NUMERIC.some((re) => re.test(s))) return true;
  if (TIMESTAMP.some((re) => re.test(s))) return true;

  // Indicator characters that can never start a plain scalar.
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  // `-`, `?` and `:` are legal plain-scalar starters *unless* a space follows
  // (or nothing does) -- which is why `-Xmx512m` stays unquoted but `- x` does not.
  if (/^[-?:]([ \t]|$)/.test(s)) return true;

  if (s.includes(": ")) return true; // reads as a mapping
  if (/\s#/.test(s)) return true; // reads as a trailing comment
  if (s.endsWith(":")) return true; // reads as a key

  return false;
}

/** Single quotes are preferred: the only escape is a doubled quote. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function doubleQuote(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

/**
 * Map keys go through the same test as values -- a key of `on` or `1` would
 * otherwise come back as a boolean or an int. Multi-line keys are pathological
 * and get double-quoted rather than blocked.
 */
function formatKey(key: string): string {
  if (key.includes("\n") || hasControlChars(key)) return doubleQuote(key);
  if (needsQuotes(key)) return singleQuote(key);
  return key;
}
