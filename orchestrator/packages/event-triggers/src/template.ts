import { paramToString } from "./values.js";

/**
 * `{{ name }}` placeholders (§4). Whitespace inside the braces is the ASCII
 * set [ \t\n\f\r] (same as RE2's \s, so the Go engine can use the identical
 * pattern); a name is any run of characters other than braces/whitespace.
 */
export const PLACEHOLDER_PATTERN = /\{\{[ \t\n\f\r]*([^{} \t\n\f\r]+)[ \t\n\f\r]*\}\}/g;

/**
 * Renders a template in a single pass: each known placeholder is replaced
 * with paramToString(value); substituted text is never re-scanned; an unknown
 * placeholder is left verbatim. Param values may be CEL values (bigint = int)
 * or already-rendered strings.
 */
export function renderTemplate(template: string, params: Readonly<Record<string, unknown>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? paramToString(params[name]) : whole,
  );
}
