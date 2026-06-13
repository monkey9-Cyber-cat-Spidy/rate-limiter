import { RateLimiterConfig, RateLimiterResult, RateLimiterStore } from '../types.js';

export class FixedWindow {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig
  ) {}

  async limit(identifier: string): Promise<RateLimiterResult> {
    const { windowMs, max, keyPrefix } = this.config;
    const now = Date.now();
    const windowNumber = Math.floor(now / windowMs);
    const key = `rl:${keyPrefix}:${identifier}:${windowNumber}`;
    const resetTime = (windowNumber + 1) * windowMs;

    try {
      const result = await this.store.increment(key, windowMs);
      const hits = result.totalHits;
      const allowed = hits <= max;
      const remaining = Math.max(0, max - hits);
      const retryAfter = allowed ? undefined : Math.max(1, Math.ceil((resetTime - now) / 1000));

      return {
        allowed,
        remaining,
        resetTime,
        totalHits: hits,
        retryAfter,
      };
    } catch (error) {
      console.warn(`[RateLimiter] FixedWindow error, falling back to allow:`, error);
      return {
        allowed: true,
        remaining: max,
        resetTime: now + windowMs,
        totalHits: 0,
      };
    }
  }
}
