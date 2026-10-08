# `agentcontroller.protocol.v1` — the wire contract

The canonical definition of every message that crosses the framework /
orchestrator boundary ([ADR 0047](../../docs/adr/0047-decouple-framework-from-orchestrator.md)).
Anyone building an agent, a tool, an orchestrator or an engine in any language
builds against these `.proto` files.

| Message | Direction | What it is |
| ------- | --------- | ---------- |
| `Event` | tool → caller | One step of a tool call: `accepted → progress*/warning* → succeeded\|failed` |
| `TurnEvent` | orchestrator → client | One lifecycle point of a turn (skill selected, tool started, approval, …) |
| `AgentUpMessage` | agent → orchestrator | `ready`, `progress`, `reply`, `tool_call`, … |
| `AgentDownMessage` | orchestrator → agent | `prompt`, `cancel`, `reply_ack`, `tool_result`, … |
| `ArtifactRef` | (embedded) | A pointer to out-of-band bytes, verified by hash |

## Layout

```
proto/agentcontroller/protocol/v1/   the contract (edit these)
src/gen/                             generated TypeScript (@controller-agent/protocol)
go/agentcontroller/protocol/v1/      generated Go
conformance/                         fixtures every implementation must agree on
```

Generated code is committed. After editing a `.proto`:

```sh
npm run generate -w @controller-agent/protocol   # needs Go on PATH for protoc-gen-go
npm run lint -w @controller-agent/protocol       # buf lint
```

CI fails if the generated code is stale, if `buf lint` fails, or if the change
breaks the JSON wire against the base branch (`buf breaking`, `WIRE_JSON` rules).

## The JSON is the wire, not protobuf binary

Messages travel as JSON, and that JSON is byte-for-byte what the system has
always sent: one flat object per message, discriminated by a `type` (or
`kind`) string, with the field names it already had (including the agent
protocol's mixed `agent_run_id` / `callId` casing). That's why every field
carries an explicit `json_name` and per-type requirements are protovalidate
rules rather than `oneof`s. See the ADR for the reasoning.

Decode with unknown fields **ignored**, and validate:

```ts
import { decode, EventSchema } from "@controller-agent/protocol";

const r = decode(EventSchema, JSON.parse(body));
if (!r.ok) throw new Error(r.error);
```

```go
msg := &protocolv1.Event{}
if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, msg); err != nil { ... }
if err := validator.Validate(msg); err != nil { ... } // buf.build/go/protovalidate
```

**Signatures.** Callback HMACs are computed and verified over the exact bytes
received. Never re-serialize a message and sign or verify that: neither proto3
JSON nor protobuf binary is canonical across implementations.

## Conformance

[`conformance/`](conformance/README.md) holds the shared fixtures. The generated
TypeScript, the generated Go and the hand-written zod schemas in
`@controller-agent/messaging` all run them, and must agree, except for each
documented divergence. The Go module needs Go 1.26 because `protovalidate-go`
1.4 does.
