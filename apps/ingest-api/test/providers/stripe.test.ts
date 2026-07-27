import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stripeAdapter } from "../../src/providers/stripe.js";

describe("Stripe adapter", () => {
  it("validates t.raw-body and supports multiple v1 signatures", () => {
    const timestamp = 1_800_000_000;
    const secret = Buffer.from("whsec_development_only");
    const rawBody = Buffer.from(
      '{\n  "id":"evt_dev_01","object":"event","type":"payment_intent.succeeded","created":1800000000,"data":{"object":{}}\n}'
    );
    const signature = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest("hex");

    expect(
      stripeAdapter.authenticate({
        rawBody,
        headers: {
          "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)},v1=${signature}`
        },
        query: {},
        secret,
        providerConfig: {},
        toleranceSeconds: 300,
        nowSeconds: timestamp
      })
    ).toEqual({ timestamp });

    expect(() =>
      stripeAdapter.authenticate({
        rawBody: Buffer.from(rawBody.toString().replace("\n  ", "")),
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        query: {},
        secret,
        providerConfig: {},
        toleranceSeconds: 300,
        nowSeconds: timestamp
      })
    ).toThrow(/Stripe/);
  });
});
