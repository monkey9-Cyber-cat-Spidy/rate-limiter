import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createRedisStore } from '../src/store/redis-store.js';
import { SlidingWindow } from '../src/algorithms/sliding-window.js';

describe('Sliding Window Log Algorithm', () => {
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
        max: 3,
        keyPrefix: 'sw-test',
        algorithm: 'sliding-window' as const,
      };
      const limiter = new SlidingWindow(store, config);

      for (let i = 0; i < 3; i++) {
        const result = await limiter.limit('user-1');
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(3 - i - 1);
      }
    });

    it('denies at exactly max+1', async () => {
      const config = {
        windowMs: 1000,
        max: 3,
        keyPrefix: 'sw-test',
        algorithm: 'sliding-window' as const,
      };
      const limiter = new SlidingWindow(store, config);

      for (let i = 0; i < 3; i++) {
        await limiter.limit('user-1');
      }

      const denied = await limiter.limit('user-1');
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThan(0);
    });

    it('old requests fall outside window and count resets', async () => {
      const config = {
        windowMs: 100, // 100ms window
        max: 2,
        keyPrefix: 'sw-test',
        algorithm: 'sliding-window' as const,
      };
      const limiter = new SlidingWindow(store, config);

      await limiter.limit('user-1');
      await limiter.limit('user-1');

      const denied = await limiter.limit('user-1');
      expect(denied.allowed).toBe(false);

      // Wait 120ms so previous requests slide out
      await new Promise((resolve) => setTimeout(resolve, 120));

      const allowed = await limiter.limit('user-1');
      expect(allowed.allowed).toBe(true);
    });

    it('retryAfter is accurate', async () => {
      const config = {
        windowMs: 1000,
        max: 1,
        keyPrefix: 'sw-test',
        algorithm: 'sliding-window' as const,
      };
      const limiter = new SlidingWindow(store, config);

      const t1 = Date.now();
      await limiter.limit('user-1');

      const denied = await limiter.limit('user-1');
      expect(denied.allowed).toBe(false);
      
      const elapsed = Date.now() - t1;
      const expectedRetryMs = 1000 - elapsed;
      const expectedRetrySec = Math.max(1, Math.ceil(expectedRetryMs / 1000));

      expect(denied.retryAfter).toBeCloseTo(expectedRetrySec, 1);
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
        max: 3,
        keyPrefix: 'sw-redis-test',
        algorithm: 'sliding-window' as const,
      };
      const limiter = new SlidingWindow(store, config);

      for (let i = 0; i < 3; i++) {
        const result = await limiter.limit('user-1');
        expect(result.allowed).toBe(true);
      }
    });

    it('denies at exactly max+1', async () => {
      const config = {
        windowMs: 1000,
        max: 3,
        keyPrefix: 'sw-redis-test',
        algorithm: 'sliding-window' as const,
      };
      const limiter = new SlidingWindow(store, config);

      for (let i = 0; i < 3; i++) {
        await limiter.limit('user-1');
      }

      const denied = await limiter.limit('user-1');
      expect(denied.allowed).toBe(false);
    });
  });
});
