import { z } from "zod";
import type {
  AuthenticationInput,
  AuthenticationResult,
  CanonicalEvent,
  ProviderAdapter,
} from "./types.js";
import { ProviderRequestError } from "./types.js";
import {
  constantTimeBytesEqual,
  optionalDate,
  parseJsonObject,
  requiredHeader
} from "./utils.js";

const asaasEventSchema = z
  .object({
    id: z.union([z.string().min(1), z.number()]),
    event: z.string().min(1),
    dateCreated: z.string().optional()
  })
  .passthrough();

function authenticate(input: AuthenticationInput): AuthenticationResult {
  const presented = requiredHeader(input.headers, "asaas-access-token");
  if (
    !constantTimeBytesEqual(Buffer.from(presented, "utf8"), input.secret)
  ) {
    throw new ProviderRequestError("authentication", "invalid Asaas access token");
  }
  return {};
}

function parse(rawBody: Buffer): CanonicalEvent {
  const result = asaasEventSchema.safeParse(parseJsonObject(rawBody));
  if (!result.success) {
    throw new ProviderRequestError("schema", "invalid Asaas webhook schema");
  }

  return {
    externalEventId: String(result.data.id),
    eventType: result.data.event,
    occurredAt: optionalDate(result.data.dateCreated),
    payload: result.data
  };
}

export const asaasAdapter: ProviderAdapter = {
  name: "asaas",
  authenticate,
  parse
};
