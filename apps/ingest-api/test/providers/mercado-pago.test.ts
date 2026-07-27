import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mercadoPagoAdapter } from "../../src/providers/mercado-pago.js";

describe("Mercado Pago adapter", () => {
  it("validates x-signature using request id, data.id, and timestamp", () => {
    const timestamp = 1_800_000_000;
    const secret = Buffer.from("mp-development-secret");
    const requestId = "request-dev-01";
    const dataId = "PAY_DEV_01";
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
    const signature = createHmac("sha256", secret).update(manifest).digest("hex");

    expect(
      mercadoPagoAdapter.authenticate({
        rawBody: Buffer.from("{}"),
        headers: {
          "x-signature": `ts=${timestamp},v1=${signature}`,
          "x-request-id": requestId
        },
        query: { "data.id": dataId },
        secret,
        providerConfig: {},
        toleranceSeconds: 300,
        nowSeconds: timestamp + 10
      })
    ).toEqual({ timestamp, requestId });
  });

  it("rejects stale signatures and mismatched body/query data IDs", () => {
    const timestamp = 1_800_000_000;
    const secret = Buffer.from("mp-development-secret");
    const manifest = `id:one;request-id:req;ts:${timestamp};`;
    const signature = createHmac("sha256", secret).update(manifest).digest("hex");
    expect(() =>
      mercadoPagoAdapter.authenticate({
        rawBody: Buffer.from("{}"),
        headers: {
          "x-signature": `ts=${timestamp},v1=${signature}`,
          "x-request-id": "req"
        },
        query: { "data.id": "one" },
        secret,
        providerConfig: {},
        toleranceSeconds: 300,
        nowSeconds: timestamp + 301
      })
    ).toThrow(/tolerance/);

    expect(() =>
      mercadoPagoAdapter.parse(
        Buffer.from(
          JSON.stringify({
            id: 123,
            type: "payment",
            action: "payment.created",
            data: { id: "two" }
          })
        ),
        { "data.id": "one" },
        {}
      )
    ).toThrow(/does not match/);
  });
});
