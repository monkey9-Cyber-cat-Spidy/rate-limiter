import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { RateLimiterConfig, RateLimiterStore, RateLimiterResult } from '../types.js';
import { FixedWindow } from '../algorithms/fixed-window.js';
import { TokenBucket } from '../algorithms/token-bucket.js';
import { SlidingWindow } from '../algorithms/sliding-window.js';
import { LeakyBucket } from '../algorithms/leaky-bucket.js';
import { RedisStore } from '../store/redis-store.js';
import { MemoryStore } from '../store/memory-store.js';

export interface MiddlewareConfig extends RateLimiterConfig {
  store: RateLimiterStore;
}

export function createRateLimiter(config: MiddlewareConfig): RequestHandler {
  const {
    store,
    max,
    windowMs,
    algorithm,
    keyPrefix,
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    keyGenerator,
    onLimitReached,
  } = config;

  // Instantiate the algorithm helper once
  let limiter: FixedWindow | TokenBucket | SlidingWindow | LeakyBucket;
  switch (algorithm) {
    case 'fixed-window':
      limiter = new FixedWindow(store, config);
      break;
    case 'token-bucket':
      limiter = new TokenBucket(store, config);
      break;
    case 'sliding-window':
      limiter = new SlidingWindow(store, config);
      break;
    case 'leaky-bucket':
      limiter = new LeakyBucket(store, config);
      break;
    default:
      throw new Error(`Unsupported rate limiting algorithm: ${algorithm}`);
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Extract identifier
    let identifier: string;
    try {
      if (keyGenerator) {
        identifier = keyGenerator(req);
      } else {
        const xForwardedFor = req.headers['x-forwarded-for'];
        if (xForwardedFor) {
          identifier = Array.isArray(xForwardedFor)
            ? xForwardedFor[0]
            : xForwardedFor.split(',')[0].trim();
        } else {
          identifier = req.ip || req.socket.remoteAddress || '127.0.0.1';
        }
      }
    } catch (err) {
      console.warn('[RateLimiter] Error generating key, using remoteAddress:', err);
      identifier = req.socket.remoteAddress || '127.0.0.1';
    }

    // Generate unique member for sliding window and potential rollback/decrements
    const now = Date.now();
    const uniqueMember = `${now}:${Math.random().toString(36).substring(2, 7)}`;

    // 2. Execute rate limiting
    let result: RateLimiterResult;
    try {
      result = limiter instanceof SlidingWindow
        ? await limiter.limit(identifier, uniqueMember)
        : await limiter.limit(identifier);
    } catch (err) {
      console.error('[RateLimiter] Execution error, falling back to allow:', err);
      result = {
        allowed: true,
        remaining: max,
        resetTime: Date.now() + windowMs,
        totalHits: 0,
      };
    }

    // 3. Set standard response headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', result.allowed ? result.remaining : 0);
    res.setHeader('X-RateLimit-Reset', result.resetTime);

    // 4. Handle block if denied
    if (!result.allowed) {
      if (result.retryAfter !== undefined) {
        res.setHeader('Retry-After', result.retryAfter);
      }
      
      if (onLimitReached) {
        try {
          onLimitReached(req);
        } catch (callbackErr) {
          console.error('[RateLimiter] Error in onLimitReached callback:', callbackErr);
        }
      }

      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: result.retryAfter ?? Math.ceil(windowMs / 1000),
        limit: max,
        windowMs,
      });
      return;
    }

    // 5. Handle success hooks for skipping requests
    if (skipSuccessfulRequests || skipFailedRequests) {
      res.on('finish', () => {
        const isSuccess = res.statusCode < 400;
        const isFailed = res.statusCode >= 400;

        if ((skipSuccessfulRequests && isSuccess) || (skipFailedRequests && isFailed)) {
          // Decrement the hit count
          decrementLimit(store, config, identifier, uniqueMember)
            .catch((err) => console.warn('[RateLimiter] Failed to roll back rate limit hits:', err));
        }
      });
    }

    next();
  };
}

/**
 * Helper to roll back (decrement) a rate limit hit in case skipSuccessful/Failed is activated.
 */
async function decrementLimit(
  store: RateLimiterStore,
  config: MiddlewareConfig,
  identifier: string,
  uniqueMember: string
): Promise<void> {
  const { keyPrefix, algorithm, windowMs } = config;
  const now = Date.now();

  try {
    if (algorithm === 'fixed-window') {
      const windowNumber = Math.floor(now / windowMs);
      const k = `rl:${keyPrefix}:${identifier}:${windowNumber}`;
      await store.decrement(k);
    } else if (algorithm === 'sliding-window') {
      const k = `rl:${keyPrefix}:${identifier}`;
      if (store instanceof RedisStore) {
        await store.client.zrem(k, uniqueMember);
      } else if (store instanceof MemoryStore) {
        const logs = store.db.get(k) as { timestamp: number; member: string }[] | undefined;
        if (logs) {
          store.db.set(k, logs.filter((log) => log.member !== uniqueMember));
        }
      }
    } else if (algorithm === 'token-bucket') {
      const k = `rl:${keyPrefix}:${identifier}`;
      if (store instanceof RedisStore) {
        await store.client.hincrbyfloat(k, 'tokens', 1);
      } else if (store instanceof MemoryStore) {
        const state = store.db.get(k);
        if (state) {
          const cap = config.burst || config.max;
          state.tokens = Math.min(cap, state.tokens + 1);
        }
      }
    } else if (algorithm === 'leaky-bucket') {
      const k = `rl:${keyPrefix}:${identifier}`;
      if (store instanceof RedisStore) {
        await store.client.hincrbyfloat(k, 'queue_size', -1);
      } else if (store instanceof MemoryStore) {
        const state = store.db.get(k);
        if (state) {
          state.queueSize = Math.max(0, state.queueSize - 1);
        }
      }
    }
  } catch (err) {
    console.warn('[RateLimiter] Error decrementing request:', err);
  }
}

