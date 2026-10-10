# 0047. Decouple the agent framework from the orchestrator

Date: 2026-10-07

## Status

Accepted

## Context

`agent-controller` has grown into one repository that is really two products
wearing one coat. There is a **framework** — the way you author an agent or a
tool and the wire protocols they speak — and there is an **orchestrator** — the
Kubernetes controller, the two execution engines, RBAC/identity, RAG retrieval,
credential linking and the deployment story that runs those agents at scale.
Today they ship, version and reason as a single unit, and that couples decisions
that should be independent: a consumer who wants only the agent-authoring SDK
still inherits the whole orchestrator's assumptions, and a consumer who wants to
run our orchestrator against their own agents has no documented surface to build
against.

We want two things the current shape does not give us:

1. **Build either half.** A third party should be able to take our *framework*
   and run it on their own orchestration, or take our *orchestrator* and point
   it at their own agents and tools — à la carte, piece by piece.
2. **In more than one language.** TypeScript and Go are what we maintain, but
   **Python is an officially supported target soon, and Rust is likely.** A
   contract that only the JavaScript ecosystem can consume does not serve that
   goal.

The good news is that the seam is already physical. Nothing on the agent or tool
side imports Kubernetes or Temporal; everything crosses the boundary through the
JSON wire protocols defined in `@controller-agent/messaging`. The orchestration
machinery sits entirely on the far side of those protocols. So this is not a
teardown — it is naming a boundary that mostly exists and paying down the debts
that keep either half from standing alone.

Three debts stand in the way:

- **`packages/messaging` is a grab-bag.** It now carries four concern-groups in
  one package — the tool `Event` stream, the `TurnEvent` lifecycle stream (ADR
  0004 of the temporal engine), the bidirectional agent protocol, and
  `ArtifactRef` — *and* mixes the transport implementations (`StdoutSink`,
  `FileSink`, `CallbackSink`, `NatsSink`) in beside the schemas. The single
  most-depended-on "leaf" is really protocol schemas welded to one transport.

- **The agent SDK is NATS-hardwired.** `agent-runtime` exposes a
  transport-agnostic `AgentChannel`, but ships only `NatsChannel`; `messaging`
  ships only `NatsSink`. A consumer cannot run an agent locally without standing
  up NATS. The abstraction exists; a non-NATS implementation does not.

- **The contract is hand-ported across stacks, and growing.** The schemas exist
  once in TypeScript (zod) and again as hand-written Go mirrors
  (`engines/temporal/internal/messaging/*.go`). `TurnEvent` arriving this week
  added a third copy by hand. Every protocol change now costs N hand-synced
  copies with nothing enforcing parity — and Python and Rust would make N
  larger. zod cannot be the source of truth for a multi-language public
  contract, because its reach is effectively the JS ecosystem.

This ADR records the decoupling and, as its enabling mechanism, the contract
strategy that lets "either half, any of four languages" actually hold.

## Decision

### 1. Two projects, one repo for now, enforced boundary

We split the codebase conceptually into a **framework** and an **orchestrator**,
establish and *enforce* the boundary in the monorepo first, and defer the
physical repo/registry split until the seam is proven.

- **Framework** (reusable with no cluster): the wire protocols, the agent SDK
  (`runAgent` / `AgentSession`), the tool-authoring SDK, and `github-app-auth`.
  The example agents (`stub-agent`, the SWE agents) are reference implementations
  that consume it, grouped under `catalog/` below.
- **Orchestrator** (the product; needs K8s/Qdrant/Redis/Temporal): the LangGraph
  engine (`agent-orchestrator`), the Temporal engine (`engines/temporal`), the
  controller (`core-controller`), the brokers/gateways, `charts/`, `sidecars/`.

Each major unit is independently adoptable (à la carte). The boundary is made
real by a CI check that **fails any framework → orchestrator import** — the
boundary is a deterministic check, not a convention, because a convention
decays back to coupling the first time it is convenient.

The repository is regrouped physically into three top-level trees:

- **`framework/`** — `messaging`, `agent-runtime`, `github-app-auth`, the
  `.proto` contract and its generated code.
- **`orchestrator/`** — `agent-orchestrator`, `engines/temporal`,
  `core-controller`, the brokers/gateways, `sidecars/`, `charts/`.
- **`catalog/`** — the reference tools (`catalog/tools/*`) and agents
  (`catalog/agents/*`: `stub-agent` and the SWE agents). They are consumers of
  the framework that the orchestrator happens to deploy, so neither half owns
  them.

The allowed import directions are **catalog → framework** and
**orchestrator → framework**; **framework → anything** and **catalog ↔
orchestrator** are violations. npm package names (`@controller-agent/*`) are
unchanged — the directory and the check are the boundary, not the scope.

The move lands *last* in its implementation sequence, so every earlier step can
merge without disturbing deployment paths. It changes the Dockerfile paths that
external image pipelines build from, and those pipelines must be updated in the
same window the move merges.

### 2. Protocol wire contracts: protobuf as the source of truth

The wire protocols — tool `Event`, `TurnEvent`, the agent protocol, `ArtifactRef`
— move to **protobuf (`.proto`) as the single canonical IDL**, from which types
are generated for TypeScript, Go, Python and Rust. This is what makes "build
either half in any language" buildable: a published `.proto` serves a Rust or
Python consumer that a zod schema never could.

Specifics, chosen deliberately:

- **Messages, not gRPC.** Our transports are NATS, HMAC-signed HTTP callbacks and
  the OpenAI-compatible facade — not gRPC request/response. We use proto purely
  as the message IDL and skip gRPC/service codegen. `buf` runs fine in
  message-only mode.
- **JSON stays on the wire** via proto3 canonical JSON mapping. The IDL changes;
  the bytes downstream consumers see do not. We are adopting protobuf for
  *codegen and a stable published contract*, not for binary encoding — binary
  buys us nothing here and would re-touch every transport.
- **The flat, `type`-tagged JSON shape is preserved exactly.** Today every
  protocol message is a flat snake_case object discriminated by a `type` string
  (`{"type":"progress","job_id":…,"stage":…}`). proto3 JSON cannot emit that
  shape from a `oneof` (it nests: `{"progress":{…}}`) or from an enum (it emits
  `"EVENT_TYPE_PROGRESS"`). So each protocol is **one flat message** with a
  `type` string, every per-type field `optional`, and an explicit snake_case
  `json_name`; protovalidate CEL rules state which fields each `type` requires
  and which `type` values exist. The generated code is less strongly typed than
  a `oneof` would be, and the per-language SDK wrappers restore the
  discriminated-union types authors actually use. This keeps the wire
  byte-compatible with every running agent and tool — no dual-read, no cutover.
  Moving to `oneof` later is a versioned (`v2`) decision, not a prerequisite.
- **Package `agentcontroller.protocol.v1`**, under
  `framework/protocol/proto/agentcontroller/protocol/v1/`, beside the
  generated TypeScript package, the generated Go module and the shared
  conformance fixtures. The package name is permanent once third
  parties depend on it.
- **Generated code is committed**, which is the Go norm and leaves Dockerfiles
  untouched. CI regenerates it and fails on any diff.
- **TypeScript and Go are generated now**; Python and Rust are added when they
  become official targets.
- **zod stays the TypeScript runtime parser for now.** The `.proto` is
  canonical; a golden-fixture conformance suite asserts that the zod schemas,
  the generated TS types and the generated Go types accept and reject exactly
  the same JSON. Replacing zod with `protovalidate-es` is a later, separate
  step.
- **Envelope strict, payload open.** The shared contract is the *envelope*
  (`job_id`, `seq`, `ts`, `type`, the lifecycle shape). The per-tool `result` is
  deliberately *not* part of the shared contract — it is modeled as
  `google.protobuf.Struct` and each tool validates its own result in its own
  language. This is more principled than today's loose-zod-field, not a
  regression.
- **`buf` for generation, lint, and breaking-change detection.** `buf breaking`
  in CI is the backward-compatibility gate a contract published for third parties
  requires — the deterministic guard that zod→JSON-Schema has no equivalent for.
- **`protovalidate` for refinements.** The runtime constraints that proto types
  do not express (monotonic `seq`, enum membership, timestamp format) are written
  as CEL annotations *in the `.proto`* and enforced at runtime from the one
  source of truth — recovering most of what zod's runtime validation bought us.
  Official runtimes exist for Go, Python and TypeScript; **Rust protovalidate
  support is community/emerging and must be verified before Rust is committed to
  it** (open item below).
- **Stock plugins for types; a custom plugin only for our SDK surface.** Type
  generation uses the maintained plugins (`protoc-gen-es`, `protoc-gen-go`,
  Python, `prost`/Rust) — we do not reimplement what `buf` maintains. A custom
  `buf` plugin is justified only for the thing stock plugins do not emit: our
  opinionated per-language SDK scaffolding (the `JobEmitter`/sink equivalents,
  the `runAgent`/`AgentSession` shape). Generate the ergonomics; let stock
  plugins + protovalidate handle types and validation underneath.

### 3. HMAC is signed over raw received bytes — independent of format

Protobuf does **not** make the wire canonical. proto3 JSON is non-deterministic
(field order, default omission, 64-bit-int encoding, whitespace), and protobuf
*binary* is explicitly not canonical across implementations either. Signing a
re-serialization in any format is a bug. Therefore the callback HMAC is computed
and verified over the **exact bytes received on the wire**, never a
re-serialization. This is the correct design regardless of format; we state it
explicitly here because adopting protobuf actively tempts the wrong assumption
that its output is canonical.

### 4. CRDs stay kubebuilder; their OpenAPI schema is the portable contract

Protobuf is **not** extended to the CRDs, and we do not build a proto → CRD
generator. The reasons invert the wire-protocol case:

- **No wire benefit.** Custom resources are JSON-only on the Kubernetes API wire;
  protobuf serialization is supported only for built-in types, never CRs. Proto
  could only ever be a definition format here.
- **It would reimplement a large part of kubebuilder.** `controller-gen` encodes
  K8s-specific semantics proto has no vocabulary for — validation markers,
  defaulting, `/status` and `/scale` subresources, printer columns, categories,
  short names, deepcopy, RBAC. Carrying all of that through custom proto options
  is a large bespoke surface to own forever.
- **Structural-schema mismatch.** CRD OpenAPI must be a *structural schema*;
  proto's `oneof`/`Any`/`Struct`/well-known types map awkwardly onto it.

Instead, **the CRD's `openAPIV3Schema` — already emitted by `controller-gen` — is
the language-neutral contract for non-Go orchestrators.** The Kubernetes client
ecosystem consumes it natively in every target language (`kube-rs` for Rust, the
Python `kubernetes`/`kopf` clients, client-go). A third party building an
orchestrator gets typed CRD access from a schema we already produce. If proto
CRD types are ever wanted in another language, they are generated *from* that
OpenAPI schema — never hand-maintained in parallel.

The result is two source formats, each the right one for its layer: **proto for
the wire protocols, kubebuilder/OpenAPI for the CRDs** — and both are
language-neutral at the boundary.

### 5. Decompose `messaging`; make transport pluggable

`messaging` is split along the line it is already straining against:
**protocol/schema** (the à-la-carte framework contracts, generated from proto)
separated from **transport** (the sinks/channels). A local consumer takes
schemas + a stdio/in-process transport; the orchestrator takes schemas + NATS.
Delivering this also delivers the "run an agent locally without a cluster" goal,
by giving the framework a non-NATS `AgentChannel` and `Sink`.

## Consequences

- **The framework can stand alone, in four languages.** A `.proto`-defined
  contract plus generated SDKs lets a Python or Rust consumer build a conformant
  agent, tool, orchestrator or engine. This is the capability the whole ADR
  exists to unlock.

- **Drift becomes a CI failure, not a silent bug.** One `.proto` source +
  generated types + `buf breaking` replaces the hand-ported Go mirrors (and the
  Python/Rust copies we would otherwise hand-write). The contract-parity debt is
  paid by codegen rather than discipline.

- **Migration has sharp edges, called out deliberately:**
  - The HMAC path must move to sign-over-raw-bytes *before or with* any
    serialization change, or callbacks break across languages.
  - proto3 JSON field names and the exact lifecycle shapes must stay
    wire-compatible with today's JSON during cutover; `buf breaking` guards the
    contract from that point forward but the first translation is by hand.
  - The Go engine's hand-written *validation* is deleted in favor of the
    contract, but its protocol *structs* stay. They are Temporal signal
    payloads, activity results and workflow state, so their JSON is recorded
    in workflow history: replacing them with generated types would change how
    in-flight workflows decode on replay, and routing a tool's result through
    `google.protobuf.Value` would reorder its keys and round large integers
    before the model saw them. So the engine adopts the contract **at its wire
    edges**: inbound callbacks and agent up-messages must pass the contract
    before they are decoded into the existing structs, and outbound
    down-messages are encoded through the generated types. The contract
    decides validity; the structs carry what passed.
  - An engine consumes the contract the way a third party would: as a
    versioned Go module from this repository, not a local `replace`, so image
    builds whose context is the engine's own directory keep working.

- **Two contract formats to keep coherent.** proto (wire) and OpenAPI (CRDs). We
  accept this because each is the correct tool for its layer and both are
  language-neutral; the alternative (forcing one format across both) is worse in
  both directions.

- **The boundary needs a guard to stay real.** The framework → orchestrator
  import lint, and the schema-parity/conformance checks, are load-bearing. "In
  the same repo" is not an excuse to let the boundary erode; the lint is what
  makes "in-repo boundary first" meaningfully different from "still coupled."

- **We are not committing to the physical repo/registry split yet.** This ADR
  establishes and enforces the seam in the monorepo. Publishing the framework as
  versioned packages (and/or the `.proto` via a schema registry) to separate
  repositories is a later decision, made easier by everything above but out of
  scope here.

## Open items

- **Rust `protovalidate`.** Confirm a usable Rust runtime for protovalidate
  before committing Rust refinements to it; if absent, Rust consumers get
  generated types (via `prost`) and a thin hand-written validation layer until
  the runtime matures.
- **ADR numbering.** `0046` is claimed by in-flight connections-page work (PR
  #275) not yet on `main`; this ADR takes `0047` to avoid the collision.
- **Python and Rust codegen.** Deferred until each is an official target; adding
  one is a `buf.gen.yaml` entry plus a leg in the conformance suite.
- **Replacing zod with `protovalidate-es`.** Deferred; the conformance suite is
  what makes it safe to do later.

## Implementation sequence

Each step is its own PR, stacked in this order so that everything before the
directory move can merge without touching deployment paths:

1. This ADR.
2. The import-boundary check in CI.
3. `buf` + the `.proto` contract, committed TS/Go codegen, the golden-fixture
   conformance suite, and the CI drift check.
4. The Temporal engine validates and encodes at its wire edges through the
   generated Go types, replacing its hand-written validation (see Consequences).
5. `messaging` split into schemas and transports, with an in-process
   `AgentChannel`/`Sink` so an agent runs without NATS.
6. The `framework/` / `orchestrator/` / `catalog/` directory move.
