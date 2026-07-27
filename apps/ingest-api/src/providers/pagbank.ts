import { createHash } from "node:crypto";
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

const pagBankEventSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    created_at: z.string().optional()
  })
  .passthrough();

function authenticate(input: AuthenticationInput): AuthenticationResult {
  const presented = requiredHeader(input.headers, "x-authenticity-token");
  const expected = createHash("sha256")
    .update(input.secret)
    .update(Buffer.from("-", "ascii"))
    .update(input.rawBody)
    .digest("hex");

  if (
    !constantTimeBytesEqual(
      Buffer.from(presented.trim().toLowerCase(), "ascii"),
      Buffer.from(expected, "ascii")
    )
  ) {
    throw new ProviderRequestError("authentication", "invalid PagBank authenticity token");
  }
  return {};
}

function parse(rawBody: Buffer): CanonicalEvent {
  const result = pagBankEventSchema.safeParse(parseJsonObject(rawBody));
  if (!result.success) {
    throw new ProviderRequestError("schema", "invalid PagBank webhook schema");
  }

  return {
    externalEventId: result.data.id,
    eventType: result.data.status,
    occurredAt: optionalDate(result.data.created_at),
    payload: result.data
  };
}

export const pagBankAdapter: ProviderAdapter = {
  name: "pagbank",
  authenticate,
  parse
};
