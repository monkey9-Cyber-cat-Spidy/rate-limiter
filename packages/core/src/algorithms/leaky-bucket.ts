import { RateLimiterConfig, RateLimiterResult, RateLimiterStore } from '../types.js';
import { RedisStore } from '../store/redis-store.js';
import { MemoryStore } from '../store/memory-store.js';

export const LEAKY_BUCKET_LUA = `
local key = KEYS[1]
local max_capacity = tonumber(ARGV[1])
local leak_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'queue_size', 'last_leak')
local queue_size = tonumber(data[1])
local last_leak = tonumber(data[2])

if not queue_size or not last_leak then
  queue_size = 0
  last_leak = now
else
  local elapsed = now - last_leak
  if elapsed > 0 then
    local leaked = elapsed * leak_rate
    queue_size = math.max(0, queue_size - leaked)
    last_leak = now
  end
end

local allowed = 0
if queue_size < max_capacity then
  queue_size = queue_size + 1
  redis.call('HSET', key, 'queue_size', queue_size, 'last_leak', last_leak)
  redis.call('PEXPIRE', key, window_ms * 2)
  allowed = 1
else
  redis.call('HSET', key, 'queue_size', queue_size, 'last_leak', last_leak)
  redis.call('PEXPIRE', key, window_ms * 2)
end

local retry_after = 0
if allowed == 0 then
  local time_to_leak_one = (queue_size - max_capacity + 1) / leak_rate
  retry_after = math.max(1, math.ceil(time_to_leak_one / 1000))
end

local remaining = math.max(0, max_capacity - math.ceil(queue_size))
local reset_time = last_leak + (queue_size / leak_rate)

return { allowed, remaining, reset_time, retry_after }
`;

interface LeakyBucketState {
  queueSize: number;
  lastLeak: number;
}

export class LeakyBucket {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig
  ) {}

  async limit(identifier: string): Promise<RateLimiterResult> {
    const { keyPrefix, max, windowMs } = this.config;
    const leakRate = max / windowMs;
    const now = Date.now();
    const key = `rl:${keyPrefix}:${identifier}`;

    if (this.store instanceof RedisStore) {
      try {
        const result = await this.store.client.rateLimitLeakyBucket(
          key,
          max,
          leakRate,
          now,
          windowMs
        );

        const [allowedVal, remainingVal, resetTimeVal, retryAfterVal] = result;
        const allowed = allowedVal === 1;

        return {
          allowed,
          remaining: Math.max(0, Math.floor(remainingVal)),
          resetTime: Math.floor(resetTimeVal),
          totalHits: Math.floor(max - remainingVal),
          retryAfter: allowed ? undefined : Number(retryAfterVal),
        };
      } catch (error) {
        console.warn(`[RateLimiter] LeakyBucket Redis error, falling back to allow:`, error);
        return this.fallbackResult(max, windowMs, now);
      }
    }

    if (this.store instanceof MemoryStore) {
      const state = this.store.db.get(key) as LeakyBucketState | undefined;
      let queueSize = 0;
      let lastLeak = now;

      if (state) {
        const elapsed = now - state.lastLeak;
        if (elapsed > 0) {
          const leaked = elapsed * leakRate;
          queueSize = Math.max(0, state.queueSize - leaked);
          lastLeak = now;
        } else {
          queueSize = state.queueSize;
          lastLeak = state.lastLeak;
        }
      }

      const allowed = queueSize < max;
      if (allowed) {
        queueSize += 1;
      }

      const newState: LeakyBucketState = {
        queueSize,
        lastLeak,
      };
      this.store.db.set(key, newState);

      const remaining = Math.max(0, max - Math.ceil(queueSize));
      const resetTime = lastLeak + (queueSize / leakRate);
      const waitTime = allowed ? 0 : (queueSize - max + 1) / leakRate;
      const retryAfter = allowed ? undefined : Math.max(1, Math.ceil(waitTime / 1000));

      return {
        allowed,
        remaining,
        resetTime: Math.floor(resetTime),
        totalHits: Math.floor(queueSize),
        retryAfter,
      };
    }

    return this.fallbackResult(max, windowMs, now);
  }

  private fallbackResult(max: number, windowMs: number, now: number): RateLimiterResult {
    return {
      allowed: true,
      remaining: max,
      resetTime: now + windowMs,
      totalHits: 0,
    };
  }
}
