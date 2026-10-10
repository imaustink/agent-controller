package messaging

import (
	"fmt"

	"buf.build/go/protovalidate"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// CheckContract decides whether raw wire JSON is a valid instance of msg's
// type under the canonical wire contract (framework/protocol, ADR 0047), and
// fills msg in. It is the ONLY place the engine decides validity: the
// hand-written per-type rules this package used to carry had already drifted
// from the TypeScript side by the time the contract was written.
//
// Callers use it as a gate and then decode the same bytes into this engine's
// own structs with encoding/json, unchanged. Those structs are Temporal signal
// payloads, activity results and workflow state, so their JSON is recorded in
// workflow history and must keep decoding exactly as before; and routing a
// tool's result through google.protobuf.Value would reorder its keys and
// round its large integers on the way to the model. The contract judges, the
// existing structs carry.
//
// Fields the contract doesn't define are ignored, not rejected: a reader must
// tolerate additions from a newer writer.
func CheckContract(raw []byte, msg proto.Message) error {
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(raw, msg); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return protovalidate.Validate(msg)
}

// EncodeContract validates msg against the canonical wire contract and returns
// its wire JSON. Validating outbound messages turns a malformed message into
// an error at the sender instead of a silent rejection at the receiver.
//
// The output is not byte-stable (protojson varies whitespace on purpose), so it
// must never be signed or compared as bytes; nothing here does either.
func EncodeContract(msg proto.Message) ([]byte, error) {
	if err := protovalidate.Validate(msg); err != nil {
		return nil, err
	}
	return protojson.Marshal(msg)
}
