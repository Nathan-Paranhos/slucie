import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pagBankAdapter } from "../../src/providers/pagbank.js";

describe("PagBank adapter", () => {
  it("uses SHA-256 over token-hyphen-exact-raw-body", () => {
    const secret = Buffer.from("pagbank-development-token");
    const rawBody = Buffer.from(
      '{ "id": "ORDE_DEV_01", "status": "PAID", "amount": {"value": 100} }\n'
    );
    const signature = createHash("sha256")
      .update(secret)
      .update("-")
      .update(rawBody)
      .digest("hex");

    expect(
      pagBankAdapter.authenticate({
        rawBody,
        headers: { "x-authenticity-token": signature },
        query: {},
        secret,
        providerConfig: {},
        toleranceSeconds: 300
      })
    ).toEqual({});

    const reformatted = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())));
    expect(() =>
      pagBankAdapter.authenticate({
        rawBody: reformatted,
        headers: { "x-authenticity-token": signature },
        query: {},
        secret,
        providerConfig: {},
        toleranceSeconds: 300
      })
    ).toThrow(/PagBank/);
  });
});
