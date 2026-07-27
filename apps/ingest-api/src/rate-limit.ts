import type { Redis } from "ioredis";
import type { RedisFailurePolicy } from "./config.js";

const FIXED_WINDOW_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly enforced: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export class RateLimitUnavailableError extends Error {
  public constructor(cause: unknown) {
    super("rate limiter unavailable", { cause });
    this.name = "RateLimitUnavailableError";
  }
}

export class RedisRateLimiter {
  public constructor(
    private readonly redis: Redis,
    private readonly failurePolicy: RedisFailurePolicy
  ) {}

  public async consume(sourceId: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const windowMs = rule.windowSeconds * 1_000;
    // Source IDs are UUIDs from the database, so keys contain no attacker-controlled payload.
    const key = `sluice:ingest:rate:${sourceId}`;

    try {
      const response = (await this.redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        String(windowMs)
      )) as [number | string, number | string];
      const current = Number(response[0]);
      const ttlMs = Math.max(0, Number(response[1]));
      return {
        allowed: current <= rule.limit,
        enforced: true,
        remaining: Math.max(0, rule.limit - current),
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1_000))
      };
    } catch (error) {
      if (this.failurePolicy === "closed") {
        throw new RateLimitUnavailableError(error);
      }
      return {
        allowed: true,
        enforced: false,
        remaining: 0,
        retryAfterSeconds: 0
      };
    }
  }
}
