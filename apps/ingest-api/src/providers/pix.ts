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
  getPath,
  optionalDate,
  parseJsonObject,
  requireScalarString,
  requiredHeader
} from "./utils.js";

export const pixAdapterConfigSchema = z
  .object({
    algorithm: z.literal("hmac-sha256"),
    signatureHeader: z.string().min(1).default("x-webhook-signature"),
    timestampHeader: z.string().min(1).optional(),
    signatureEncoding: z.enum(["hex", "base64"]).default("hex"),
    signaturePrefix: z.string().max(64).default(""),
    signedTemplate: z
      .string()
      .refine((value) => value.includes("{raw}"), "signedTemplate must include {raw}")
      .default("{raw}"),
    timestampToleranceSeconds: z.number().int().min(30).max(3_600).optional(),
    eventIdPath: z.string().min(1),
    eventTypePath: z.string().min(1),
    occurredAtPath: z.string().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.signedTemplate.includes("{timestamp}") &&
      value.timestampHeader === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timestampHeader"],
        message: "timestampHeader is required when signedTemplate uses {timestamp}"
      });
    }
  });

type PixAdapterConfig = z.infer<typeof pixAdapterConfigSchema>;

function parseConfig(config: unknown): PixAdapterConfig {
  const result = pixAdapterConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ProviderRequestError("authentication", "invalid Pix adapter configuration");
  }
  return result.data;
}

function renderSignedBytes(
  template: string,
  rawBody: Buffer,
  timestamp: string | undefined
): Buffer {
  const pieces: Buffer[] = [];
  let cursor = 0;
  const token = /\{raw\}|\{timestamp\}/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(template)) !== null) {
    pieces.push(Buffer.from(template.slice(cursor, match.index), "utf8"));
    if (match[0] === "{raw}") {
      pieces.push(rawBody);
    } else {
      if (timestamp === undefined) {
        throw new ProviderRequestError(
          "authentication",
          "Pix configuration requires a timestamp header"
        );
      }
      pieces.push(Buffer.from(timestamp, "utf8"));
    }
    cursor = match.index + match[0].length;
  }
  pieces.push(Buffer.from(template.slice(cursor), "utf8"));
  return Buffer.concat(pieces);
}

function authenticate(input: AuthenticationInput): AuthenticationResult {
  const config = parseConfig(input.providerConfig);
  let presented = requiredHeader(input.headers, config.signatureHeader);
  if (config.signaturePrefix.length > 0) {
    if (!presented.startsWith(config.signaturePrefix)) {
      throw new ProviderRequestError("authentication", "invalid Pix signature prefix");
    }
    presented = presented.slice(config.signaturePrefix.length);
  }

  const timestamp =
    config.timestampHeader === undefined
      ? undefined
      : requiredHeader(input.headers, config.timestampHeader);
  const numericTimestamp = timestamp === undefined ? undefined : Number(timestamp);
  if (numericTimestamp !== undefined) {
    assertFreshTimestamp(
      numericTimestamp,
      config.timestampToleranceSeconds ?? input.toleranceSeconds,
      input.nowSeconds
    );
  }

  const signed = renderSignedBytes(config.signedTemplate, input.rawBody, timestamp);
  const expected = createHmac("sha256", input.secret).update(signed).digest();
  let decoded: Buffer;
  try {
    if (config.signatureEncoding === "hex") {
      if (!/^[a-fA-F0-9]{64}$/.test(presented)) {
        throw new Error("invalid hex");
      }
      decoded = Buffer.from(presented, "hex");
    } else {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(presented)) {
        throw new Error("invalid base64");
      }
      decoded = Buffer.from(presented, "base64");
      if (decoded.toString("base64") !== presented) {
        throw new Error("non-canonical base64");
      }
    }
  } catch {
    throw new ProviderRequestError("authentication", "malformed Pix signature");
  }

  if (!constantTimeBytesEqual(decoded, expected)) {
    throw new ProviderRequestError("authentication", "invalid Pix signature");
  }
  return numericTimestamp === undefined ? {} : { timestamp: numericTimestamp };
}

function parse(rawBody: Buffer, _query: QueryBag, providerConfig: unknown): CanonicalEvent {
  const config = parseConfig(providerConfig);
  const payload = parseJsonObject(rawBody);
  const externalEventId = requireScalarString(
    getPath(payload, config.eventIdPath),
    config.eventIdPath
  );
  const eventType = requireScalarString(
    getPath(payload, config.eventTypePath),
    config.eventTypePath
  );

  return {
    externalEventId,
    eventType,
    occurredAt:
      config.occurredAtPath === undefined
        ? undefined
        : optionalDate(getPath(payload, config.occurredAtPath)),
    payload
  };
}

export const pixAdapter: ProviderAdapter = {
  name: "pix",
  authenticate,
  parse
};
