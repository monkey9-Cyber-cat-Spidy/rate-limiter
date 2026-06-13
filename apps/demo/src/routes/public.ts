import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { createRateLimiter, RateLimiterStore } from '@manikanta/rate-limiter';

export function createPublicRouter(store: RateLimiterStore): Router {
  const router = Router();

  // Fixed window rate limiter: 10 requests per minute per IP
  const publicLimiter = createRateLimiter({
    store,
    windowMs: 60000,
    max: 10,
    keyPrefix: 'public-api',
    algorithm: 'fixed-window',
  });

  router.get('/data', publicLimiter, (req, res) => {
    // Read the remaining header set by the rate limiter
    const remaining = res.getHeader('X-RateLimit-Remaining');
    
    res.json({
      message: 'Hello from the public API!',
      timestamp: new Date().toISOString(),
      requestsRemaining: remaining !== undefined ? Number(remaining) : null,
    });
  });

  // Helper route to generate mock JWTs for testing
  router.post('/token', (req, res) => {
    const { username = 'demo_user', role = 'user' } = req.body;
    const userId = `user_${Math.random().toString(36).substring(2, 9)}`;
    const secret = process.env.JWT_SECRET || 'dev-secret-change-in-production';

    const token = jwt.sign({ id: userId, username, role }, secret, { expiresIn: '1h' });

    res.json({
      token,
      user: {
        id: userId,
        username,
        role,
      },
    });
  });

  return router;
}
