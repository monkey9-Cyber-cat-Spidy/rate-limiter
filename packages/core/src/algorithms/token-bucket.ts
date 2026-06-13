import { RateLimiterConfig, RateLimiterResult, RateLimiterStore } from '../types.js';
import { RedisStore } from '../store/redis-store.js';
import { MemoryStore } from '../store/memory-store.js';

export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local refill_interval = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local current_tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if not current_tokens or not last_refill then
  current_tokens = capacity
  last_refill = now
else
  local elapsed = now - last_refill
  if elapsed > 0 then
    local added = elapsed * refill_rate
    current_tokens = math.min(capacity, current_tokens + added)
    last_refill = now
  end
end

local allowed = 0
if current_tokens >= 1 then
  current_tokens = current_tokens - 1
  redis.call('HSET', key, 'tokens', current_tokens, 'lastRefill', last_refill)
  redis.call('PEXPIRE', key, refill_interval * 2)
  allowed = 1
else
  redis.call('HSET', key, 'tokens', current_tokens, 'lastRefill', last_refill)
  redis.call('PEXPIRE', key, refill_interval * 2)
end

local retry_after = 0
if allowed == 0 then
  local wait_time = (1 - current_tokens) / refill_rate
  retry_after = math.max(1, math.ceil(wait_time / 1000))
end

local reset_time = last_refill + ((capacity - current_tokens) / refill_rate)

return { allowed, current_tokens, reset_time, retry_after }
`;

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export class TokenBucket {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig
  ) {}

  async limit(identifier: string): Promise<RateLimiterResult> {
    const { keyPrefix, max, windowMs } = this.config;
    const capacity = this.config.burst || max;
    const refillRate = max / windowMs;
    const now = Date.now();
    const key = `rl:${keyPrefix}:${identifier}`;

    if (this.store instanceof RedisStore) {
      try {
        const result = await this.store.client.rateLimitTokenBucket(
          key,
          capacity,
          refillRate,
          windowMs,
          now
        );

        const [allowedVal, remainingTokensVal, resetTimeVal, retryAfterVal] = result;
        const allowed = allowedVal === 1;

        return {
          allowed,
          remaining: Math.floor(remainingTokensVal),
          resetTime: Math.floor(resetTimeVal),
          totalHits: Math.floor(capacity - remainingTokensVal),
          retryAfter: allowed ? undefined : Number(retryAfterVal),
        };
      } catch (error) {
        console.warn(`[RateLimiter] TokenBucket Redis error, falling back to allow:`, error);
        return this.fallbackResult(capacity, windowMs, now);
      }
    }

    if (this.store instanceof MemoryStore) {
      const state = this.store.db.get(key) as TokenBucketState | undefined;
      let currentTokens = capacity;
      let lastRefill = now;

      if (state) {
        const elapsed = now - state.lastRefill;
        if (elapsed > 0) {
          const added = elapsed * refillRate;
          currentTokens = Math.min(capacity, state.tokens + added);
          lastRefill = now;
        } else {
          currentTokens = state.tokens;
          lastRefill = state.lastRefill;
        }
      }

      const allowed = currentTokens >= 1;
      if (allowed) {
        currentTokens -= 1;
      }

      const newState: TokenBucketState = {
        tokens: currentTokens,
        lastRefill,
      };
      this.store.db.set(key, newState);

      const waitTime = allowed ? 0 : (1 - currentTokens) / refillRate;
      const retryAfter = allowed ? undefined : Math.max(1, Math.ceil(waitTime / 1000));
      const resetTime = lastRefill + ((capacity - currentTokens) / refillRate);

      return {
        allowed,
        remaining: Math.floor(currentTokens),
        resetTime: Math.floor(resetTime),
        totalHits: Math.floor(capacity - currentTokens),
        retryAfter,
      };
    }

    // Default fallback if unsupported store type
    return this.fallbackResult(capacity, windowMs, now);
  }

  private fallbackResult(capacity: number, windowMs: number, now: number): RateLimiterResult {
    return {
      allowed: true,
      remaining: capacity,
      resetTime: now + windowMs,
      totalHits: 0,
    };
  }
}
