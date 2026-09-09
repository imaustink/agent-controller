import { GlyphClient, type Page, type Task } from "./glyph/client.js";
import { markdownToProseMirror, proseMirrorToMarkdown } from "./markdown.js";
import type { GlyphCommand } from "./schema.js";

/**
 * Executes one validated command against the Glyph API and returns the
 * Markdown the tool reports as its `succeeded` result. Notes map to Glyph
 * pages (type `page`); a note's body round-trips through the Markdown ⇆
 * ProseMirror converter.
 *
 * Search is client-side: Glyph has no server-side full-text endpoint for
 * pages (the app searches with Fuse.js in the browser), so this fetches the
 * caller's notes/tasks and filters them by a case-insensitive substring —
 * the same "match title/tags/description" behavior a user gets from ⌘K.
 */
export async function runCommand(client: GlyphClient, command: GlyphCommand): Promise<string> {
  switch (command.resource) {
    case "note":
      return runNote(client, command);
    case "task":
      return runTask(client, command);
  }
}

// ─── Notes ────────────────────────────────────────────────────────────────────

async function runNote(client: GlyphClient, command: Extract<GlyphCommand, { resource: "note" }>): Promise<string> {
  switch (command.action) {
    case "create": {
      const page = await client.createPage({
        title: command.title,
        parentId: command.parentId,
        tags: command.tags,
        priority: command.priority,
      });
      if (command.body !== undefined && command.body !== "") {
        await client.upsertPageContent(page.id, markdownToProseMirror(command.body));
      }
      return `✅ Created note **${page.title}** (\`${page.id}\`).`;
    }
    case "get": {
      const page = await client.getPage(command.id);
      let body = "";
      try {
        const content = await client.getPageContent(command.id);
        body = proseMirrorToMarkdown(content.content);
      } catch {
        // A note with no content yet returns 404 for its content — that's an
        // empty body, not a failure.
        body = "";
      }
      return `${noteHeading(page)}\n\n${body || "_(empty note)_"}`;
    }
    case "update": {
      const page = await client.updatePage(command.id, {
        title: command.title,
        tags: command.tags,
        priority: command.priority,
      });
      if (command.body !== undefined) {
        await client.upsertPageContent(command.id, markdownToProseMirror(command.body));
      }
      return `✅ Updated note **${page.title}** (\`${page.id}\`).`;
    }
    case "search": {
      const pages = (await client.listPages()).filter((p) => p.type === "page");
      const matched = filterByQuery(pages, command.query, (p) => [p.title, ...p.tags]);
      const limited = matched.slice(0, command.limit ?? 25);
      if (limited.length === 0) return queryEmptyMessage("notes", command.query);
      const lines = limited.map((p) => `- **${p.title}** — \`${p.id}\`${tagSuffix(p.tags)}`);
      return `Found ${matched.length} note(s)${countSuffix(matched.length, limited.length)}:\n${lines.join("\n")}`;
    }
  }
}

function noteHeading(page: Page): string {
  return `# ${page.title}\n\`${page.id}\` · priority: ${page.priority}${tagSuffix(page.tags)}`;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

async function runTask(client: GlyphClient, command: Extract<GlyphCommand, { resource: "task" }>): Promise<string> {
  switch (command.action) {
    case "create": {
      const task = await client.createTask({
        title: command.title,
        description: command.description,
        status: command.status,
        priority: command.priority,
        dueDate: command.dueDate,
        tags: command.tags,
      });
      return `✅ Created task **${task.title}** (\`${task.id}\`) — ${task.status}, ${task.priority} priority.`;
    }
    case "get": {
      const task = await client.getTask(command.id);
      return formatTaskDetail(task);
    }
    case "update": {
      const task = await client.updateTask(command.id, {
        title: command.title,
        description: command.description,
        status: command.status,
        priority: command.priority,
        dueDate: command.dueDate,
        tags: command.tags,
      });
      return `✅ Updated task **${task.title}** (\`${task.id}\`) — ${task.status}, ${task.priority} priority.`;
    }
    case "search": {
      let tasks = await client.listTasks();
      if (command.status) tasks = tasks.filter((t) => t.status === command.status);
      if (command.priority) tasks = tasks.filter((t) => t.priority === command.priority);
      const matched = filterByQuery(tasks, command.query, (t) => [t.title, t.description, ...t.tags]);
      const limited = matched.slice(0, command.limit ?? 25);
      if (limited.length === 0) return queryEmptyMessage("tasks", command.query);
      const lines = limited.map((t) => `- ${formatTaskLine(t)}`);
      return `Found ${matched.length} task(s)${countSuffix(matched.length, limited.length)}:\n${lines.join("\n")}`;
    }
  }
}

function formatTaskLine(task: Task): string {
  const due = task.dueDate ? ` · due ${task.dueDate}` : "";
  return `**${task.title}** — \`${task.id}\` · ${task.status} · ${task.priority}${due}${tagSuffix(task.tags)}`;
}

function formatTaskDetail(task: Task): string {
  const lines = [
    `# ${task.title}`,
    `\`${task.id}\` · status: ${task.status} · priority: ${task.priority}${task.dueDate ? ` · due ${task.dueDate}` : ""}${tagSuffix(task.tags)}`,
  ];
  if (task.description) lines.push("", task.description);
  return lines.join("\n");
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function filterByQuery<T>(items: T[], query: string | undefined, fields: (item: T) => string[]): T[] {
  if (!query || query.trim() === "") return items;
  const needle = query.trim().toLowerCase();
  return items.filter((item) =>
    fields(item).some((f) => f.toLowerCase().includes(needle)),
  );
}

function tagSuffix(tags: string[]): string {
  return tags.length ? ` · tags: ${tags.join(", ")}` : "";
}

function countSuffix(total: number, shown: number): string {
  return total > shown ? ` (showing first ${shown})` : "";
}

function queryEmptyMessage(kind: string, query: string | undefined): string {
  return query && query.trim() !== ""
    ? `No ${kind} matched "${query}".`
    : `No ${kind} found.`;
}
