# Wire-contract conformance fixtures

Shared JSON cases that every implementation of the `agentcontroller.protocol.v1`
contract must agree on (ADR 0047). One file per message:

| File | Message |
| ---- | ------- |
| `event.json` | `Event` (tool event stream) |
| `turn_event.json` | `TurnEvent` (turn lifecycle) |
| `agent_up.json` | `AgentUpMessage` (agent → orchestrator) |
| `agent_down.json` | `AgentDownMessage` (orchestrator → agent) |

Each case is:

```jsonc
{
  "name": "unique within the file",
  "valid": true,            // the CANONICAL verdict
  "json": { ... },          // the message exactly as it appears on the wire
  "roundTrip": false,       // optional: skip the re-encode check (see below)
  "divergences": {          // optional: an implementation known to disagree
    "zod": "why, and what resolves it"
  }
}
```

## Implementations and their runners

| Id | Implementation | Runner |
| -- | -------------- | ------ |
| `proto-ts` | generated TS + `@bufbuild/protovalidate` | `framework/protocol/src/conformance.test.ts` |
| `proto-go` | generated Go + `protovalidate-go` | `framework/protocol/go/conformance_test.go` |
| `zod` | hand-written zod schemas in `@controller-agent/messaging` | `packages/messaging/src/conformance.test.ts` |

Every runner asserts, for every case:

1. **Verdict.** The implementation accepts the case if and only if it is
   `valid` — unless the case lists a divergence for that implementation, in
   which case it must reach the **opposite** verdict. A divergence that has
   quietly stopped diverging fails the suite, so this list cannot rot into a
   list of things that used to be true.
2. **Round trip** (generated implementations, valid cases). Decoding and
   re-encoding reproduces the same JSON object — same keys, same values, key
   order and whitespace aside. This is the proof that the `.proto`'s
   `json_name`s keep today's wire shape. Cases carrying fields the contract
   doesn't define (tolerated, then dropped) set `"roundTrip": false`.

Adding a fixture is the way to pin a behaviour. When a case fails, decide which
side is right; don't just flip `valid`.
