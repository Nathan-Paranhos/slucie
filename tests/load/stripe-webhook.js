import crypto from "k6/crypto";
import http from "k6/http";
import { check } from "k6";

const baseUrl = __ENV.SLUICE_BASE_URL ?? "http://127.0.0.1:8080";
const endpointKey = __ENV.SLUICE_ENDPOINT_KEY;
const signingSecret = __ENV.SLUICE_SIGNING_SECRET;

if (!endpointKey || !signingSecret) {
  throw new Error(
    "SLUICE_ENDPOINT_KEY and SLUICE_SIGNING_SECRET are required"
  );
}

export const options = {
  scenarios: {
    ingest: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { target: 100, duration: "1m" },
        { target: 100, duration: "3m" },
        { target: 0, duration: "30s" }
      ]
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    checks: ["rate>0.99"]
  }
};

export default function () {
  const now = Math.floor(Date.now() / 1000);
  const id = `evt_k6_${__VU}_${__ITER}_${Date.now()}`;
  const body = JSON.stringify({
    id,
    object: "event",
    type: "payment_intent.succeeded",
    created: now,
    data: {
      object: {
        id: `pi_${__VU}_${__ITER}`,
        amount: 1250,
        currency: "brl"
      }
    }
  });
  const signature = crypto.hmac(
    "sha256",
    signingSecret,
    `${now}.${body}`,
    "hex"
  );

  const response = http.post(
    `${baseUrl}/v1/webhooks/stripe/${endpointKey}`,
    body,
    {
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${now},v1=${signature}`
      },
      tags: { provider: "stripe" }
    }
  );

  check(response, {
    "accepted or deduplicated": (result) => result.status === 200
  });
}
