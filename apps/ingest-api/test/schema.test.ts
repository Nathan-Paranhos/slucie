import { describe, expect, it } from "vitest";
import {
  getProviderAdapter,
  normalizeProviderName,
  providerRouteName
} from "../src/providers/index.js";

describe("provider payload schemas", () => {
  it.each([
    ["asaas", { event: "PAYMENT_CREATED" }],
    ["pagbank", { status: "PAID" }],
    [
      "mercado_pago",
      { id: 1, type: "payment", action: "payment.created", data: {} }
    ],
    [
      "stripe",
      { id: "evt_dev", object: "event", type: "test", created: 1, data: {} }
    ]
  ] as const)("rejects incomplete %s events", (provider, payload) => {
    expect(() =>
      getProviderAdapter(provider).parse(
        Buffer.from(JSON.stringify(payload)),
        provider === "mercado_pago" ? { "data.id": "dev" } : {},
        {}
      )
    ).toThrow();
  });

  it("rejects non-object JSON before persistence", () => {
    expect(() =>
      getProviderAdapter("asaas").parse(Buffer.from("[]"), {}, {})
    ).toThrow(/JSON object/);
  });

  it("normalizes the public Mercado Pago URL to the database provider value", () => {
    expect(normalizeProviderName("mercado-pago")).toBe("mercado_pago");
    expect(getProviderAdapter("mercado-pago").name).toBe("mercado_pago");
    expect(providerRouteName("mercado_pago")).toBe("mercado-pago");
  });
});
