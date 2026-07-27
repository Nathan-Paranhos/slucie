import { createHmac, timingSafeEqual } from "node:crypto";
import type { HeaderBag, QueryBag } from "./types.js";
import { ProviderRequestError } from "./types.js";

export function firstValue(
  bag: HeaderBag | QueryBag,
  key: string
): string | undefined {
  const value = bag[key.toLowerCase()] ?? bag[key];
  return Array.isArray(value) ? value[0] : value;
}

export function requiredHeader(headers: HeaderBag, name: string): string {
  const value = firstValue(headers, name);
  if (value === undefined || value.length === 0) {
    throw new ProviderRequestError("authentication", `missing ${name} header`);
  }
  return value;
}

export function requiredQuery(query: QueryBag, name: string): string {
  const value = firstValue(query, name);
  if (value === undefined || value.length === 0) {
    throw new ProviderRequestError("authentication", `missing ${name} query parameter`);
  }
  return value;
}

export function constantTimeBytesEqual(left: Buffer, right: Buffer): boolean {
  // HMAC normalizes arbitrary-length values to a fixed length before comparison.
  const comparisonKey = Buffer.alloc(32);
  const normalizedLeft = createHmac("sha256", comparisonKey).update(left).digest();
  const normalizedRight = createHmac("sha256", comparisonKey).update(right).digest();
  return timingSafeEqual(normalizedLeft, normalizedRight) && left.length === right.length;
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  return constantTimeBytesEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertFreshTimestamp(
  timestampSeconds: number,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000)
): void {
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds
  ) {
    throw new ProviderRequestError("replay", "signature timestamp is outside the tolerance");
  }
}

export function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw new ProviderRequestError("schema", "body is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderRequestError("schema", "body must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const date = new Date(typeof value === "number" ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function getPath(object: Record<string, unknown>, path: string): unknown {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new ProviderRequestError("schema", "configured JSON path is invalid");
  }
  let current: unknown = object;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function requireScalarString(value: unknown, field: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).length === 0
  ) {
    throw new ProviderRequestError("schema", `${field} must be a non-empty string or number`);
  }
  return String(value);
}
