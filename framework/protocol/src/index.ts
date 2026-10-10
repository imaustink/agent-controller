import { fromJson, toJson, type DescMessage, type JsonValue, type MessageShape } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";

export * from "./gen/agentcontroller/protocol/v1/artifact_pb.js";
export * from "./gen/agentcontroller/protocol/v1/event_pb.js";
export * from "./gen/agentcontroller/protocol/v1/turn_event_pb.js";
export * from "./gen/agentcontroller/protocol/v1/agent_protocol_pb.js";

const validator = createValidator();

export type DecodeResult<Desc extends DescMessage> =
  | { ok: true; message: MessageShape<Desc> }
  | { ok: false; error: string };

/**
 * Decodes one wire message and enforces the contract's rules (required fields,
 * per-`type` requirements, ranges). Fields the contract doesn't define are
 * ignored rather than rejected: a reader must tolerate additions from a newer
 * writer.
 */
export function decode<Desc extends DescMessage>(schema: Desc, json: JsonValue): DecodeResult<Desc> {
  let message: MessageShape<Desc>;
  try {
    message = fromJson(schema, json, { ignoreUnknownFields: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const result = validator.validate(schema, message);
  switch (result.kind) {
    case "valid":
      return { ok: true, message };
    case "invalid":
      return { ok: false, error: result.violations.map((v) => v.toString()).join("; ") };
    default:
      return { ok: false, error: String(result.error) };
  }
}

/** Encodes a message to its wire JSON (field names per the contract's json_names). */
export function encode<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): JsonValue {
  return toJson(schema, message);
}
