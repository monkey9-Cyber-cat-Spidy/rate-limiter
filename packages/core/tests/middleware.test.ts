import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import { createRateLimiter } from '../src/middleware/express.js';
import { createMemoryStore } from '../src/store/memory-store.js';
import { createRedisStore } from '../src/store/redis-store.js';

describe('Express Middleware integration', () => {
  describe('Memory Store Middleware', () => {
    let store = createMemoryStore(5000);

    beforeEach(() => {
      store = createMemoryStore(5000);
    });

    afterEach(() => {
      store.close();
    });

    it('sets X-RateLimit headers on allowed responses', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          store,
          windowMs: 60000,
          max: 5,
          keyPrefix: 'mw-test',
          algorithm: 'fixed-window',
        })
      );
      app.get('/test', (req, res) => {
        res.json({ data: 'ok' });
      });

      const response = await request(app).get('/test');
      expect(response.status).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe('5');
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('responds with 429 and correct headers on denied requests', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          store,
          windowMs: 60000,
          max: 2,
          keyPrefix: 'mw-test-429',
          algorithm: 'fixed-window',
        })
      );
      app.get('/test', (req, res) => {
        res.json({ data: 'ok' });
      });

      // Hit 1
      await request(app).get('/test');
      // Hit 2
      await request(app).get('/test');
      // Hit 3 - Should fail
      const response = await request(app).get('/test');

      expect(response.status).toBe(429);
      expect(response.headers['x-ratelimit-limit']).toBe('2');
      expect(response.headers['x-ratelimit-remaining']).toBe('0');
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
      expect(response.headers['retry-after']).toBeDefined();
      expect(response.body).toEqual({
        error: 'Too Many Requests',
        retryAfter: expect.any(Number),
        limit: 2,
        windowMs: 60000,
      });
    });

    it('uses custom keyGenerator if provided', async () => {
      const app = express();
      app.use(
        createRateLimiter({
          store,
          windowMs: 60000,
          max: 1,
          keyPrefix: 'mw-keygen-test',
          algorithm: 'fixed-window',
          keyGenerator: (req) => req.headers['x-custom-user'] as string || 'default',
        })
      );
      app.get('/test', (req, res) => {
        res.json({ data: 'ok' });
      });

      // Request 1 as user-a (allowed)
      const r1 = await request(app).get('/test').set('x-custom-user', 'user-a');
      expect(r1.status).toBe(200);

      // Request 2 as user-a (denied)
      const r2 = await request(app).get('/test').set('x-custom-user', 'user-a');
      expect(r2.status).toBe(429);

      // Request 3 as user-b (allowed - should not share rate limits with user-a)
      const r3 = await request(app).get('/test').set('x-custom-user', 'user-b');
      expect(r3.status).toBe(200);
    });
  });

  describe('Redis Store Middleware (Resilience)', () => {
    it('Redis failure falls back to allowing requests (fail-open)', async () => {
      const redisClient = new RedisMock();
      const store = createRedisStore(redisClient);

      // Simulate connection drop by mocking status to 'connecting' (not ready)
      Object.defineProperty(redisClient, 'status', { get: () => 'close' });

      const app = express();
      app.use(
        createRateLimiter({
          store,
          windowMs: 60000,
          max: 2,
          keyPrefix: 'mw-fail-test',
          algorithm: 'fixed-window',
        })
      );
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      // Make 3 requests. Because Redis is down, it should allow all of them (fail-open)
      const r1 = await request(app).get('/test');
      const r2 = await request(app).get('/test');
      const r3 = await request(app).get('/test');

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);

      expect(r1.body.success).toBe(true);
      expect(r2.body.success).toBe(true);
      expect(r3.body.success).toBe(true);

      await redisClient.quit();
    });
  });
});
