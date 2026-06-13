import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createRedisStore } from '../src/store/redis-store.js';
import { TokenBucket } from '../src/algorithms/token-bucket.js';

describe('Token Bucket Algorithm', () => {
  describe('MemoryStore implementation', () => {
    let store = createMemoryStore(5000);

    beforeEach(() => {
      store = createMemoryStore(5000);
    });

    afterEach(() => {
      store.close();
    });

    it('allows requests under limit', async () => {
      const config = {
        windowMs: 1000,
        max: 5,
        keyPrefix: 'tb-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      for (let i = 0; i < 5; i++) {
        const result = await limiter.limit('user-1');
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(5 - i - 1);
      }
    });

    it('denies requests over limit', async () => {
      const config = {
        windowMs: 1000,
        max: 5,
        keyPrefix: 'tb-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      // Consume 5 tokens
      for (let i = 0; i < 5; i++) {
        await limiter.limit('user-1');
      }

      // 6th request should be denied
      const result = await limiter.limit('user-1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('tokens refill after windowMs', async () => {
      const config = {
        windowMs: 100, // Small window for quick testing
        max: 2,
        keyPrefix: 'tb-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      await limiter.limit('user-1');
      await limiter.limit('user-1');

      // Exceeded
      const denied = await limiter.limit('user-1');
      expect(denied.allowed).toBe(false);

      // Wait 150ms for a full refill
      await new Promise((resolve) => setTimeout(resolve, 150));

      const allowed = await limiter.limit('user-1');
      expect(allowed.allowed).toBe(true);
    });

    it('burst traffic is handled correctly (custom burst config)', async () => {
      const config = {
        windowMs: 1000,
        max: 2, // Refill rate is 2 tokens per sec
        burst: 5, // Capacity of 5
        keyPrefix: 'tb-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      // We should be able to burst 5 requests
      for (let i = 0; i < 5; i++) {
        const result = await limiter.limit('user-1');
        expect(result.allowed).toBe(true);
      }

      // 6th should be denied
      const result = await limiter.limit('user-1');
      expect(result.allowed).toBe(false);
    });

    it('concurrent requests do not exceed limit (race condition test)', async () => {
      const config = {
        windowMs: 10000,
        max: 10,
        keyPrefix: 'tb-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      // Run 50 concurrent requests
      const promises = Array.from({ length: 50 }).map(() => limiter.limit('user-concurrent'));
      const results = await Promise.all(promises);

      const allowedCount = results.filter((r) => r.allowed).length;
      const deniedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(10);
      expect(deniedCount).toBe(40);
    });
  });

  describe('RedisStore implementation (mocked)', () => {
    let redisClient: any;
    let store: any;

    beforeEach(async () => {
      redisClient = new RedisMock();
      await redisClient.flushall();
      store = createRedisStore(redisClient);
    });

    afterEach(async () => {
      await redisClient.quit();
    });

    it('allows requests under limit', async () => {
      const config = {
        windowMs: 1000,
        max: 5,
        keyPrefix: 'tb-redis-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      for (let i = 0; i < 5; i++) {
        const result = await limiter.limit('user-1');
        expect(result.allowed).toBe(true);
      }
    });

    it('denies requests over limit', async () => {
      const config = {
        windowMs: 1000,
        max: 5,
        keyPrefix: 'tb-redis-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      for (let i = 0; i < 5; i++) {
        await limiter.limit('user-1');
      }

      const result = await limiter.limit('user-1');
      expect(result.allowed).toBe(false);
    });

    it('burst traffic is handled correctly (custom burst config)', async () => {
      const config = {
        windowMs: 1000,
        max: 2,
        burst: 5,
        keyPrefix: 'tb-redis-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      for (let i = 0; i < 5; i++) {
        const result = await limiter.limit('user-1');
        expect(result.allowed).toBe(true);
      }

      const result = await limiter.limit('user-1');
      expect(result.allowed).toBe(false);
    });

    it('concurrent requests do not exceed limit (race condition test)', async () => {
      const config = {
        windowMs: 10000,
        max: 10,
        keyPrefix: 'tb-redis-test',
        algorithm: 'token-bucket' as const,
      };
      const limiter = new TokenBucket(store, config);

      // Run 50 concurrent requests
      const promises = Array.from({ length: 50 }).map(() => limiter.limit('user-concurrent'));
      const results = await Promise.all(promises);

      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(10);
    });
  });
});
