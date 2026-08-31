# image-gen

Self-contained subagent container: a prompt (and optionally a prior image URL)
in, a **generated or edited image** out as a presigned URL.

One tool covers both create-from-scratch and iterative refinement. Whether it
generates or edits is decided by a single input field:

- **Generate** — no `image_url` → text-to-image via the OpenAI Images API.
- **Edit** — `image_url` present → the tool downloads that image (SSRF-guarded,
  size-capped) and edits it with the prompt.

The produced PNG is uploaded to a **private S3-compatible object store** and the
tool returns a **time-limited presigned GET URL** — the bucket itself stays
private. To keep iterating on a picture, feed the previous result's URL back in
as `image_url`; the skill (`image-gen-skill`) does this automatically across
turns.

## Input

A single argv string, either JSON or a bare prompt:

```jsonc
{
  "prompt": "a bowl of ramen, studio photo",
  "image_url": "https://.../prev.png",   // optional; presence => edit branch
  "size": "1024x1024",                    // optional; "1024x1536" | "1536x1024" | "auto"
  "quality": "high",                      // optional; "low" | "medium" | "high" | "auto"
  "background": "transparent"             // optional (generation); "opaque" | "auto"
}
```

```bash
./run.sh 'a bowl of ramen, studio photo'
./run.sh '{"prompt":"add a soft-boiled egg on top","image_url":"https://.../prev.png"}'
```

## Output

- `succeeded.result` — Markdown embedding the image as `![prompt](<presigned-url>)`,
  so a chat client renders it inline and the next turn can read the URL back.
- `succeeded.artifacts[0]` — an `ArtifactRef` (`uri`, `sha256`, `bytes`,
  `content_type`) for the raw PNG, delivered out-of-band (bytes never travel on
  the event channel; see `packages/messaging/src/artifact.ts`).

Failure classes map to exit codes: `usage` (2), `blocked_url` (3),
`provider_error` (4), `storage_error` (5), `general` (1).

## Configuration (env)

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI credential (secret) | — |
| `OPENAI_BASE_URL` | Override the OpenAI endpoint | OpenAI default |
| `IMAGE_MODEL` | Image model | `gpt-image-1` |
| `IMAGE_SIZE` | Default size | `1024x1024` |
| `IMAGE_QUALITY` | Default quality | `auto` |
| `IMAGE_MAX_BYTES` | Cap on a downloaded source image | 15 MiB |
| `IMAGE_S3_PREFIX` | Key prefix | `images` |
| `IMAGE_S3_PRESIGN_TTL_SECONDS` | Presigned-URL lifetime (max 7d) | 7 days |

The **S3 target and its credentials** are supplied together, as one connection
profile — the tool reads them from these env vars:

| Variable | Purpose | Default |
| --- | --- | --- |
| `IMAGE_S3_BUCKET` | Target bucket | — (required) |
| `IMAGE_S3_REGION` | Region | `us-east-1` |
| `IMAGE_S3_ENDPOINT` | S3-compatible endpoint URL; empty ⇒ AWS default | AWS default |
| `IMAGE_S3_FORCE_PATH_STYLE` | Path-style addressing (`true` for MinIO/Ceph) | `false` |
| `IMAGE_S3_ACCESS_KEY_ID` / `IMAGE_S3_SECRET_ACCESS_KEY` | S3 credentials | — (required) |

Empty strings are treated as unset (so `IMAGE_S3_ENDPOINT=""` means AWS's default
endpoint). The object store is **bring-your-own**: an operator provisions the
bucket and hands the tool this whole profile. In the Kubernetes deployment the
community-components chart injects all of the S3 vars above from a single
operator-provided secret (`imageGen.s3.secretName`, default `image-gen-s3`) —
the chart itself carries no bucket/region/endpoint, so the target lives in one
place next to where the bucket is provisioned. The messaging-transport vars
(`RECIPE_*`) are the shared wire protocol used by every tool in this repo.

## Build

```bash
# from the repo root (depends on the @controller-agent/messaging workspace pkg)
docker build -f tools/image-gen/Dockerfile -t image-gen:latest .
```

## Test

```bash
npm --workspace tools/image-gen run typecheck
npm --workspace tools/image-gen test
```
