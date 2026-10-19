import type { Credentials, Cursor, ListPage, ResourceRef, Scope } from "./types.js";

/**
 * Drives a wildcard corpus (`scope.all`) across every provider the same way.
 *
 * It resolves the units the corpus covers — the Connection's `allowedScopes`
 * when it caps them (carried as `scope.allowedUnits`), otherwise whatever the
 * driver's `enumerate` returns — then fully lists each unit through the driver's
 * own single-unit lister and concatenates, de-duplicated by resource id (one
 * person, page or thread can sit in several units).
 *
 * The whole listing comes back in ONE page with `cursor: undefined`: the
 * per-unit cursors do not compose into one opaque incremental cursor, so a
 * wildcard corpus re-lists in full each reconcile. That is correct rather than
 * merely tolerable — the reconcile pass is the source of truth (ADR 0038 §4),
 * and the sync worker dedupes unchanged chunks by content hash, so a full
 * re-list re-embeds nothing that did not actually change.
 *
 * `enumerate` is called ONLY in the uncapped case, so a provider that cannot
 * cheaply enumerate its units (Drive has no natural "every folder" query) can
 * refuse there while still supporting a capped wildcard.
 */
export async function listWildcard(
  scope: Scope,
  credentials: Credentials,
  enumerate: (credentials: Credentials) => Promise<string[]>,
  unitScope: (unit: string) => Scope,
  listUnit: (scope: Scope, credentials: Credentials, since: Cursor) => Promise<ListPage>,
): Promise<ListPage> {
  const units =
    scope.allowedUnits && scope.allowedUnits.length > 0
      ? scope.allowedUnits
      : await enumerate(credentials);

  const seen = new Set<string>();
  const resources: ResourceRef[] = [];
  for (const unit of units) {
    let cursor: Cursor;
    do {
      const page = await listUnit(unitScope(unit), credentials, cursor);
      for (const ref of page.resources) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        resources.push(ref);
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return { resources, cursor: undefined };
}
