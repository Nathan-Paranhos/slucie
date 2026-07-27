import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

const encryptedPartSchema = z.object({
  iv: z.string().min(1),
  ciphertext: z.string(),
  tag: z.string().min(1)
});

const envelopeSchema = z.object({
  v: z.literal(1),
  alg: z.literal("A256GCM"),
  kid: z.number().int().positive(),
  wrappedKey: encryptedPartSchema,
  data: encryptedPartSchema
});

export type Envelope = z.infer<typeof envelopeSchema>;

function encryptAesGcm(plaintext: Buffer, key: Buffer, aad: Buffer): Envelope["data"] {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptAesGcm(part: Envelope["data"], key: Buffer, aad: Buffer): Buffer {
  const iv = Buffer.from(part.iv, "base64");
  const ciphertext = Buffer.from(part.ciphertext, "base64");
  const tag = Buffer.from(part.tag, "base64");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("invalid encrypted envelope");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wrappedKeyAad(version: number, context: string): Buffer {
  return Buffer.from(`sluice:dek:v1:kid=${version}:${context}`, "utf8");
}

function payloadAad(version: number, context: string): Buffer {
  return Buffer.from(`sluice:data:v1:kid=${version}:${context}`, "utf8");
}

export function encryptEnvelope(
  plaintext: Buffer,
  context: string,
  keyVersion: number,
  masterKey: Buffer
): Envelope {
  if (masterKey.length !== 32) {
    throw new Error("AES-256-GCM master key must contain exactly 32 bytes");
  }

  const dataKey = randomBytes(32);
  try {
    return {
      v: 1,
      alg: "A256GCM",
      kid: keyVersion,
      wrappedKey: encryptAesGcm(dataKey, masterKey, wrappedKeyAad(keyVersion, context)),
      data: encryptAesGcm(plaintext, dataKey, payloadAad(keyVersion, context))
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptEnvelope(
  envelopeInput: unknown,
  context: string,
  masterKeys: ReadonlyMap<number, Buffer>
): Buffer {
  const envelope = envelopeSchema.parse(envelopeInput);
  const masterKey = masterKeys.get(envelope.kid);
  if (masterKey === undefined) {
    throw new Error(`master key version ${envelope.kid} is unavailable`);
  }

  const dataKey = decryptAesGcm(
    envelope.wrappedKey,
    masterKey,
    wrappedKeyAad(envelope.kid, context)
  );
  try {
    return decryptAesGcm(envelope.data, dataKey, payloadAad(envelope.kid, context));
  } finally {
    dataKey.fill(0);
  }
}

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(serialized: unknown): Envelope {
  if (Buffer.isBuffer(serialized)) {
    return envelopeSchema.parse(JSON.parse(serialized.toString("utf8")) as unknown);
  }
  if (typeof serialized === "string") {
    return envelopeSchema.parse(JSON.parse(serialized) as unknown);
  }
  return envelopeSchema.parse(serialized);
}

export function secureTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  const leftPadded = Buffer.alloc(length);
  const rightPadded = Buffer.alloc(length);
  leftBytes.copy(leftPadded);
  rightBytes.copy(rightPadded);
  const equal = timingSafeEqual(leftPadded, rightPadded);
  return equal && leftBytes.length === rightBytes.length;
}
