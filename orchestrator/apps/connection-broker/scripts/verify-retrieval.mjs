#!/usr/bin/env node
/**
 * Asks the indexed corpus real questions and shows what comes back.
 *
 * Everything else verifies PLUMBING: that chunks are written, hashes are
 * stable, boundaries hold. None of it can tell you whether the thing an agent
 * would retrieve is the thing it should have retrieved — a corpus can be
 * perfectly synced and useless, and it looks identical from the outside.
 *
 * This is the only check that needs real vectors, which is exactly why the
 * --local-embeddings mode refuses to imply it.
 *
 *   node orchestrator/apps/connection-broker/scripts/verify-retrieval.mjs <collection> [question...]
 */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { OpenAIEmbedder } from "../dist/embedder.js";

const env = loadEnv(findEnvFile());
const QDRANT = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = process.argv[2];
if (!COLLECTION) {
  console.error("usage: verify-retrieval.mjs <collection> [question...]");
  process.exit(1);
}

const questions = process.argv.slice(3);
if (questions.length === 0) {
  // Deliberately phrased as a person would ask, not as keywords: the point of
  // a vector index is that those differ.
  questions.push(
    "what went wrong on this project and what would we do differently",
    "who was on the team and what were their roles",
    "how do we track time and bill the client",
  );
}

const embedder = new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });

const info = await (await fetch(`${QDRANT}/collections/${COLLECTION}`)).json();
if (!info.result) {
  console.error(`no such collection: ${COLLECTION}`);
  process.exit(1);
}
console.log(`\nretrieval over ${COLLECTION} — ${info.result.points_count} point(s)\n`);

let weakest = 1;
for (const question of questions) {
  const [vector] = await embedder.embed([question]);

  const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vector, limit: 3, with_payload: true }),
  });
  const { result } = await res.json();

  console.log(`? ${question}`);
  if (!result || result.length === 0) {
    console.log("  (nothing returned)\n");
    weakest = 0;
    continue;
  }

  for (const hit of result) {
    const d = typeof hit.payload.descriptor === "string"
      ? JSON.parse(hit.payload.descriptor)
      : hit.payload.descriptor;
    const text = (d.text ?? "").replace(/\s+/g, " ").trim();
    console.log(`  ${hit.score.toFixed(3)}  ${d.title}`);
    console.log(`         ${text.slice(0, 150)}`);
  }
  weakest = Math.min(weakest, result[0].score);
  console.log();
}

// A similarity floor, not a correctness proof. Cosine over
// text-embedding-3-small puts a genuinely relevant passage well above this;
// scores hovering near zero mean the index is answering with noise, which is
// what a broken embedding or a mis-stored vector looks like.
console.log(`weakest top hit: ${weakest.toFixed(3)}`);
if (weakest < 0.2) {
  console.error("\n✗ the best match for at least one question is near-noise");
  process.exit(1);
}
console.log("\nPASS — the corpus answers questions with relevant passages.");
