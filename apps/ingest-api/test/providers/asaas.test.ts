import { describe, expect, it } from "vitest";
import { asaasAdapter } from "../../src/providers/asaas.js";
import { ProviderRequestError } from "../../src/providers/types.js";

describe("Asaas adapter", () => {
  const secret = Buffer.from("a-secure-development-token");

  it("compares asaas-access-token and parses an event", () => {
    expect(
      asaasAdapter.authenticate({
        rawBody: Buffer.from("{}"),
        headers: { "asaas-access-token": secret.toString("utf8") },
        query: {},
        secret,
        providerConfig: {},
        toleranceSeconds: 300
      })
    ).toEqual({});

    const event = asaasAdapter.parse(
      Buffer.from(
        JSON.stringify({
          id: "evt_dev_01",
          event: "PAYMENT_CONFIRMED",
          payment: { id: "pay_dev_01" }
        })
      ),
      {},
      {}
    );
    expect(event.externalEventId).toBe("evt_dev_01");
    expect(event.eventType).toBe("PAYMENT_CONFIRMED");
  });

  it("rejects a different token and malformed schema", () => {
    expect(() =>
      asaasAdapter.authenticate({
        rawBody: Buffer.from("{}"),
        headers: { "asaas-access-token": "wrong" },
        query: {},
        secret,
        providerConfig: {},
        toleranceSeconds: 300
      })
    ).toThrow(ProviderRequestError);
    expect(() => asaasAdapter.parse(Buffer.from("{}"), {}, {})).toThrow(
      /Asaas webhook schema/
    );
  });
});
