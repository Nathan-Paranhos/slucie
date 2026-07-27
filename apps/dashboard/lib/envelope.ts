import "server-only";
import {
  createCipheriv,
  randomBytes
} from "node:crypto";

interface EncryptedPart {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface Envelope {
  v: 1;
  alg: "A256GCM";
  kid: number;
  wrappedKey: EncryptedPart;
  data: EncryptedPart;
}

function masterKey(keyVersion: number) {
  const keyring = process.env.SLUICE_MASTER_KEYS;
  const encoded =
    keyring
      ?.split(",")
      .map((entry) => entry.trim().split(":", 2))
      .find(([version]) => Number(version) === keyVersion)?.[1] ??
    process.env.SLUICE_MASTER_KEY ??
    process.env[`SLUICE_MASTER_KEY_V${keyVersion}`];
  if (!encoded) {
    throw new Error(
      `Encryption key version ${keyVersion} is unavailable in the dashboard keyring`
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("Every dashboard master key must decode to exactly 32 bytes");
  }
  return key;
}

function encryptPart(plaintext: Buffer, key: Buffer, aad: Buffer): EncryptedPart {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

export function sealEnvelope(
  plaintext: Buffer,
  context: string,
  keyVersion = Number(
    process.env.SLUICE_ACTIVE_KEY_VERSION ??
      process.env.SLUICE_MASTER_KEY_VERSION ??
      1
  )
) {
  const dataKey = randomBytes(32);
  const key = masterKey(keyVersion);
  try {
    const envelope: Envelope = {
      v: 1,
      alg: "A256GCM",
      kid: keyVersion,
      wrappedKey: encryptPart(
        dataKey,
        key,
        Buffer.from(`sluice:dek:v1:kid=${keyVersion}:${context}`, "utf8")
      ),
      data: encryptPart(
        plaintext,
        dataKey,
        Buffer.from(`sluice:data:v1:kid=${keyVersion}:${context}`, "utf8")
      )
    };
    return {
      bytes: Buffer.from(JSON.stringify(envelope), "utf8"),
      keyVersion
    };
  } finally {
    dataKey.fill(0);
    key.fill(0);
  }
}
