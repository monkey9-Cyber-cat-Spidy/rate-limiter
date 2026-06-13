import { Router } from 'express';
import { createRateLimiter, RateLimiterStore } from '@manikanta/rate-limiter';

export function createAdminRouter(store: RateLimiterStore): Router {
  const router = Router();

  // Leaky Bucket rate limiter: 5 requests per minute per IP
  const adminLimiter = createRateLimiter({
    store,
    windowMs: 60000,
    max: 5,
    keyPrefix: 'admin-bulk',
    algorithm: 'leaky-bucket',
  });

  router.post('/bulk-operation', adminLimiter, (req, res) => {
    const limit = 5;
    const remaining = Number(res.getHeader('X-RateLimit-Remaining') ?? limit);
    const queueSize = limit - remaining;
    
    // Each request leaks at a rate of windowMs / max.
    // 60,000ms / 5 = 12,000ms (12 seconds) per request.
    const timePerRequestSec = 60000 / limit / 1000;
    const estimatedProcessingTimeSec = queueSize * timePerRequestSec;

    res.json({
      queued: true,
      message: 'Admin bulk operation queued for execution.',
      queuePosition: queueSize,
      estimatedProcessingTime: `${estimatedProcessingTimeSec} seconds`,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
