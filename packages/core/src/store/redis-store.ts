import { Redis } from 'ioredis';
import { RateLimiterResult, RateLimiterStore } from '../types.js';
import { TOKEN_BUCKET_LUA } from '../algorithms/token-bucket.js';
import { LEAKY_BUCKET_LUA } from '../algorithms/leaky-bucket.js';

export interface RedisWithCustomCommands extends Redis {
  rateLimitTokenBucket(
    key: string,
    max: string | number,
    refillRate: string | number,
    refillInterval: string | number,
    now: string | number
  ): Promise<[number, number, number, number]>;

  rateLimitLeakyBucket(
    key: string,
    max: string | number,
    leakRate: string | number,
    now: string | number,
    windowMs: string | number
  ): Promise<[number, number, number, number]>;
}

export class RedisStore implements RateLimiterStore {
  public readonly client: RedisWithCustomCommands;

  constructor(redisClient: Redis) {
    this.client = redisClient as RedisWithCustomCommands;
    this.initializeCommands();
  }

  private initializeCommands(): void {
    // Define Token Bucket custom command if not already defined
    if (typeof this.client.rateLimitTokenBucket !== 'function') {
      this.client.defineCommand('rateLimitTokenBucket', {
        numberOfKeys: 1,
        lua: TOKEN_BUCKET_LUA,
      });
    }

    // Define Leaky Bucket custom command if not already defined
    if (typeof this.client.rateLimitLeakyBucket !== 'function') {
      this.client.defineCommand('rateLimitLeakyBucket', {
        numberOfKeys: 1,
        lua: LEAKY_BUCKET_LUA,
      });
    }
  }

  /**
   * Helper to check if Redis is connected.
   */
  private isConnected(): boolean {
    return this.client.status === 'ready';
  }

  /**
   * Default Fixed Window increment using simple INCR + EXPIRE.
   */
  async increment(key: string, windowMs: number): Promise<RateLimiterResult> {
    if (!this.isConnected()) {
      return this.fallbackResult(windowMs);
    }

    try {
      // Run INCR and PEXPIRE in a pipeline to ensure atomicity
      const pipeline = this.client.pipeline();
      pipeline.incr(key);
      pipeline.pexpire(key, windowMs, 'NX'); // Only set expire if key doesn't have one
      const results = await pipeline.exec();

      if (!results) {
        throw new Error('Pipeline failed');
      }

      const [incrErr, hits] = results[0];
      if (incrErr) throw incrErr;

      const totalHits = Number(hits);
      const now = Date.now();
      const resetTime = now + windowMs;

      return {
        allowed: true, // FixedWindow algorithm will check count against max
        remaining: 0,  // Evaluated by the FixedWindow class
        resetTime,
        totalHits,
      };
    } catch (error) {
      console.warn(`[RateLimiter] Redis error in increment:`, error);
      return this.fallbackResult(windowMs);
    }
  }

  async decrement(key: string): Promise<void> {
    if (!this.isConnected()) return;
    try {
      await this.client.decr(key);
    } catch (error) {
      console.warn(`[RateLimiter] Redis error in decrement:`, error);
    }
  }

  async reset(key: string): Promise<void> {
    if (!this.isConnected()) return;
    try {
      await this.client.del(key);
    } catch (error) {
      console.warn(`[RateLimiter] Redis error in reset:`, error);
    }
  }

  async get(key: string): Promise<number> {
    if (!this.isConnected()) return 0;
    try {
      const val = await this.client.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch (error) {
      console.warn(`[RateLimiter] Redis error in get:`, error);
      return 0;
    }
  }

  /**
   * Fail-open fallback response if Redis is unavailable.
   */
  private fallbackResult(windowMs: number): RateLimiterResult {
    return {
      allowed: true,
      remaining: 1, // Fallback to allowed state
      resetTime: Date.now() + windowMs,
      totalHits: 0,
    };
  }
}

/**
 * Factory function to create a RedisStore.
 */
export function createRedisStore(redisClient: Redis): RedisStore {
  return new RedisStore(redisClient);
}
