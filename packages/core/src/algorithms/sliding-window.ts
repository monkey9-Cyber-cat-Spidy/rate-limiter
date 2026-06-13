import { RateLimiterConfig, RateLimiterResult, RateLimiterStore } from '../types.js';
import { RedisStore } from '../store/redis-store.js';
import { MemoryStore } from '../store/memory-store.js';

interface SlidingWindowLogEntry {
  timestamp: number;
  member: string;
}

export class SlidingWindow {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig
  ) {}

  async limit(identifier: string): Promise<RateLimiterResult> {
    const { keyPrefix, max, windowMs } = this.config;
    const now = Date.now();
    const key = `rl:${keyPrefix}:${identifier}`;
    const uniqueMember = `${now}:${Math.random().toString(36).substring(2, 7)}`;

    if (this.store instanceof RedisStore) {
      try {
        const pipeline = this.store.client.pipeline();
        // 1. Remove elements older than windowMs
        pipeline.zremrangebyscore(key, 0, now - windowMs);
        // 2. Add current timestamp
        pipeline.zadd(key, now, uniqueMember);
        // 3. Count remaining entries
        pipeline.zcard(key);
        // 4. Get oldest entry to calculate retryAfter if needed
        pipeline.zrange(key, 0, 0, 'WITHSCORES');
        // 5. Update TTL on the set
        pipeline.pexpire(key, windowMs * 2);

        const results = await pipeline.exec();

        if (!results) {
          throw new Error('Pipeline execution returned null');
        }

        // Check for errors in pipeline execution
        for (const res of results) {
          if (res[0]) throw res[0];
        }

        const count = Number(results[2][1]);
        const oldestEntry = results[3][1] as string[];
        const oldestTimestamp = oldestEntry && oldestEntry[1] ? Number(oldestEntry[1]) : now;

        const allowed = count <= max;
        const remaining = Math.max(0, max - count);
        const resetTime = oldestTimestamp + windowMs;

        if (!allowed) {
          // Remove the entry we just added because limit was exceeded
          await this.store.client.zrem(key, uniqueMember);
          const retryAfterMs = oldestTimestamp + windowMs - now;
          const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
          return {
            allowed: false,
            remaining: 0,
            resetTime,
            totalHits: count,
            retryAfter,
          };
        }

        return {
          allowed: true,
          remaining,
          resetTime,
          totalHits: count,
        };
      } catch (error) {
        console.warn(`[RateLimiter] SlidingWindow Redis error, falling back to allow:`, error);
        return this.fallbackResult(max, windowMs, now);
      }
    }

    if (this.store instanceof MemoryStore) {
      const logs = (this.store.db.get(key) as SlidingWindowLogEntry[] | undefined) || [];
      
      // 1. Filter out expired logs
      const cutoff = now - windowMs;
      const activeLogs = logs.filter((log) => log.timestamp > cutoff);

      const count = activeLogs.length;

      if (count >= max) {
        const oldestTimestamp = activeLogs[0] ? activeLogs[0].timestamp : now;
        const resetTime = oldestTimestamp + windowMs;
        const retryAfterMs = oldestTimestamp + windowMs - now;
        const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));

        // Save filtered logs back
        this.store.db.set(key, activeLogs);

        return {
          allowed: false,
          remaining: 0,
          resetTime,
          totalHits: count,
          retryAfter,
        };
      }

      // Add new log
      activeLogs.push({ timestamp: now, member: uniqueMember });
      this.store.db.set(key, activeLogs);

      const oldestTimestamp = activeLogs[0] ? activeLogs[0].timestamp : now;
      const resetTime = oldestTimestamp + windowMs;

      return {
        allowed: true,
        remaining: Math.max(0, max - activeLogs.length),
        resetTime,
        totalHits: activeLogs.length,
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
