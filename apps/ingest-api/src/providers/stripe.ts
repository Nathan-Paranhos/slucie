import { createHmac } from "node:crypto";
import { z } from "zod";
import type {
  AuthenticationInput,
  AuthenticationResult,
  CanonicalEvent,
  ProviderAdapter,
} from "./types.js";
import { ProviderRequestError } from "./types.js";
import {
  assertFreshTimestamp,
  constantTimeBytesEqual,
  optionalDate,
  parseJsonObject,
  requiredHeader
} from "./utils.js";

const stripeEventSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("event"),
    type: z.string().min(1),
    created: z.number().int().positive(),
    data: z.object({ object: z.record(z.unknown()) }).passthrough()
  })
  .passthrough();

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  const fields = header.split(",").map((field) => field.trim().split("=", 2));
  const timestamp = Number(fields.find(([key]) => key === "t")?.[1]);
  const signatures = fields
    .filter(([key, value]) => key === "v1" && value !== undefined)
    .map(([, value]) => value as string);

  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) {
    throw new ProviderRequestError("authentication", "malformed Stripe-Signature header");
  }
  return { timestamp, signatures };
}

function authenticate(input: AuthenticationInput): AuthenticationResult {
  const signatureHeader = requiredHeader(input.headers, "stripe-signature");
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  assertFreshTimestamp(timestamp, input.toleranceSeconds, input.nowSeconds);

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, "ascii"),
    input.rawBody
  ]);
  const expected = createHmac("sha256", input.secret).update(signedPayload).digest();
  const valid = signatures.some((signature) =>
    /^[a-fA-F0-9]{64}$/.test(signature)
      ? constantTimeBytesEqual(Buffer.from(signature, "hex"), expected)
      : false
  );
  if (!valid) {
    throw new ProviderRequestError("authentication", "invalid Stripe signature");
  }
  return { timestamp };
}

function parse(rawBody: Buffer): CanonicalEvent {
  const result = stripeEventSchema.safeParse(parseJsonObject(rawBody));
  if (!result.success) {
    throw new ProviderRequestError("schema", "invalid Stripe event schema");
  }

  return {
    externalEventId: result.data.id,
    eventType: result.data.type,
    occurredAt: optionalDate(result.data.created),
    payload: result.data
  };
}

export const stripeAdapter: ProviderAdapter = {
  name: "stripe",
  authenticate,
  parse
};
