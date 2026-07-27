import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
  serializeEnvelope
} from "../src/crypto/envelope.js";

describe("AES-256-GCM envelope encryption", () => {
  it("round-trips data through a wrapped per-record key", () => {
    const masterKey = randomBytes(32);
    const envelope = encryptEnvelope(
      Buffer.from("not-a-real-secret"),
      "test:tenant:source",
      7,
      masterKey
    );

    expect(envelope.kid).toBe(7);
    expect(envelope.wrappedKey.ciphertext).not.toContain("not-a-real-secret");
    expect(
      decryptEnvelope(
        parseEnvelope(serializeEnvelope(envelope)),
        "test:tenant:source",
        new Map([[7, masterKey]])
      ).toString("utf8")
    ).toBe("not-a-real-secret");
  });

  it("rejects a different AAD context and tampering", () => {
    const masterKey = randomBytes(32);
    const envelope = encryptEnvelope(Buffer.from("payload"), "right", 1, masterKey);

    expect(() =>
      decryptEnvelope(envelope, "wrong", new Map([[1, masterKey]]))
    ).toThrow();

    const tampered = structuredClone(envelope);
    tampered.data.tag = Buffer.alloc(16).toString("base64");
    expect(() =>
      decryptEnvelope(tampered, "right", new Map([[1, masterKey]]))
    ).toThrow();
  });

  it("requires the exact key version referenced by the envelope", () => {
    const envelope = encryptEnvelope(Buffer.from("payload"), "ctx", 2, randomBytes(32));
    expect(() =>
      decryptEnvelope(envelope, "ctx", new Map([[1, randomBytes(32)]]))
    ).toThrow(/version 2/);
  });
});
