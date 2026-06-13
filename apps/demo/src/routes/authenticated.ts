import { Router } from 'express';
import { createRateLimiter, RateLimiterStore } from '@manikanta/rate-limiter';
import { verifyToken, AuthenticatedRequest } from '../middleware/auth.js';

export function createAuthenticatedRouter(store: RateLimiterStore): Router {
  const router = Router();

  // Apply JWT verification to all routes in this router
  router.use(verifyToken as any);

  // 1. Sliding Window rate limiter: 100 requests per minute per user ID
  const profileLimiter = createRateLimiter({
    store,
    windowMs: 60000,
    max: 100,
    keyPrefix: 'user-profile',
    algorithm: 'sliding-window',
    keyGenerator: (req) => {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user?.id) {
        throw new Error('User ID not available for rate limiting');
      }
      return authReq.user.id;
    },
  });

  router.get('/profile', profileLimiter, (req: AuthenticatedRequest, res) => {
    res.json({
      message: 'Access granted to authenticated profile',
      user: req.user,
      profile: {
        firstName: 'Jane',
        lastName: 'Doe',
        email: `${req.user?.username || 'user'}@example.com`,
        membership: 'Gold',
      },
    });
  });

  // 2. Token Bucket rate limiter: 20 requests per minute per user, allowing burst of 5
  const actionLimiter = createRateLimiter({
    store,
    windowMs: 60000,
    max: 20,
    burst: 5,
    keyPrefix: 'user-action',
    algorithm: 'token-bucket',
    keyGenerator: (req) => {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user?.id) {
        throw new Error('User ID not available for rate limiting');
      }
      return authReq.user.id;
    },
  });

  router.post('/action', actionLimiter, (req: AuthenticatedRequest, res) => {
    const remaining = res.getHeader('X-RateLimit-Remaining');
    res.json({
      success: true,
      action: 'Perform account sync operation',
      timestamp: new Date().toISOString(),
      tokensRemaining: remaining !== undefined ? Number(remaining) : null,
    });
  });

  return router;
}
