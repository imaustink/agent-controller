#!/usr/bin/env node
/** What a Drive shortcut actually carries, and what it points at. */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { getAccessToken } from "./lib/google-auth.mjs";

const env = loadEnv(findEnvFile());
const token = await getAccessToken({ env });

const res = await fetch(
  "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.shortcut' and trashed = false",
      fields: "files(id,name,mimeType,shortcutDetails,parents)",
      pageSize: "5",
    }),
  { headers: { Authorization: `Bearer ${token}` } },
);
const body = await res.json();

for (const file of body.files ?? []) {
  console.log(`\n${file.name}`);
  console.log(`  id:      ${file.id}`);
  console.log(`  details: ${JSON.stringify(file.shortcutDetails)}`);

  const targetId = file.shortcutDetails?.targetId;
  if (!targetId) continue;

  const target = await (
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${targetId}?fields=id,name,mimeType,parents,size`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json();
  console.log(`  target:  ${target.name} [${target.mimeType}] parents=${JSON.stringify(target.parents)}`);
}
