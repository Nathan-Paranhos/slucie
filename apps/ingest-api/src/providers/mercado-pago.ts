import { createHmac } from "node:crypto";
import { z } from "zod";
import type {
  AuthenticationInput,
  AuthenticationResult,
  CanonicalEvent,
  ProviderAdapter,
  QueryBag
} from "./types.js";
import { ProviderRequestError } from "./types.js";
import {
  assertFreshTimestamp,
  constantTimeBytesEqual,
  optionalDate,
  parseJsonObject,
  requiredHeader,
  requiredQuery
} from "./utils.js";

const mercadoPagoEventSchema = z
  .object({
    id: z.union([z.string().min(1), z.number()]),
    type: z.string().min(1),
    action: z.string().min(1),
    date_created: z.string().optional(),
    data: z.object({ id: z.union([z.string().min(1), z.number()]) }).passthrough()
  })
  .passthrough();

function signatureParts(header: string): { timestamp: number; signatures: string[] } {
  const values = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get("ts")?.[0]);
  const signatures = values.get("v1") ?? [];
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) {
    throw new ProviderRequestError("authentication", "malformed Mercado Pago signature");
  }
  return { timestamp, signatures };
}

function authenticate(input: AuthenticationInput): AuthenticationResult {
  const xSignature = requiredHeader(input.headers, "x-signature");
  const requestId = requiredHeader(input.headers, "x-request-id");
  const dataId = requiredQuery(input.query, "data.id").toLowerCase();
  const { timestamp, signatures } = signatureParts(xSignature);
  assertFreshTimestamp(
    timestamp,
    input.toleranceSeconds,
    input.nowSeconds
  );

  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const expected = createHmac("sha256", input.secret).update(manifest, "utf8").digest();
  const valid = signatures.some((signature) =>
    /^[a-fA-F0-9]{64}$/.test(signature)
      ? constantTimeBytesEqual(Buffer.from(signature, "hex"), expected)
      : false
  );

  if (!valid) {
    throw new ProviderRequestError("authentication", "invalid Mercado Pago signature");
  }
  return { timestamp, requestId };
}

function parse(rawBody: Buffer, query: QueryBag): CanonicalEvent {
  const result = mercadoPagoEventSchema.safeParse(parseJsonObject(rawBody));
  if (!result.success) {
    throw new ProviderRequestError("schema", "invalid Mercado Pago webhook schema");
  }
  const queryDataId = requiredQuery(query, "data.id");
  if (String(result.data.data.id).toLowerCase() !== queryDataId.toLowerCase()) {
    throw new ProviderRequestError("schema", "Mercado Pago data.id does not match the body");
  }

  return {
    externalEventId: String(result.data.id),
    eventType: `${result.data.type}.${result.data.action}`,
    occurredAt: optionalDate(result.data.date_created),
    payload: result.data
  };
}

export const mercadoPagoAdapter: ProviderAdapter = {
  name: "mercado_pago",
  authenticate,
  parse
};
