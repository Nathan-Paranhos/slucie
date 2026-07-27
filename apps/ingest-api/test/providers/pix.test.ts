import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pixAdapter } from "../../src/providers/pix.js";

describe("configurable Pix adapter", () => {
  const config = {
    algorithm: "hmac-sha256",
    signatureHeader: "x-acme-signature",
    timestampHeader: "x-acme-timestamp",
    signatureEncoding: "base64",
    signaturePrefix: "sha256=",
    signedTemplate: "{timestamp}:{raw}",
    timestampToleranceSeconds: 120,
    eventIdPath: "evento.id",
    eventTypePath: "evento.tipo",
    occurredAtPath: "evento.criadoEm"
  };

  it("authenticates the explicitly configured HMAC contract", () => {
    const timestamp = 1_800_000_000;
    const secret = Buffer.from("pix-development-secret");
    const rawBody = Buffer.from(
      JSON.stringify({
        evento: {
          id: "pix-event-dev-01",
          tipo: "pix.recebido",
          criadoEm: "2026-01-01T12:00:00Z"
        }
      })
    );
    const signature = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}:`), rawBody]))
      .digest("base64");

    expect(
      pixAdapter.authenticate({
        rawBody,
        headers: {
          "x-acme-signature": `sha256=${signature}`,
          "x-acme-timestamp": String(timestamp)
        },
        query: {},
        secret,
        providerConfig: config,
        toleranceSeconds: 300,
        nowSeconds: timestamp + 1
      })
    ).toEqual({ timestamp });

    const event = pixAdapter.parse(rawBody, {}, config);
    expect(event.externalEventId).toBe("pix-event-dev-01");
    expect(event.eventType).toBe("pix.recebido");
  });

  it("refuses ambiguous or incomplete Pix configurations", () => {
    expect(() =>
      pixAdapter.authenticate({
        rawBody: Buffer.from("{}"),
        headers: {},
        query: {},
        secret: Buffer.alloc(32),
        providerConfig: {
          algorithm: "hmac-sha256",
          signedTemplate: "{timestamp}.{raw}",
          eventIdPath: "id",
          eventTypePath: "type"
        },
        toleranceSeconds: 300
      })
    ).toThrow(/configuration/);
  });
});
