import express from 'express';
import { Redis } from 'ioredis';
import { createRedisStore, createMemoryStore, RedisStore } from '@manikanta/rate-limiter';
import { createPublicRouter } from './routes/public.js';
import { createAuthenticatedRouter } from './routes/authenticated.js';
import { createAdminRouter } from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

app.use(express.json());

// Initialize Rate Limiter Store (Redis with In-Memory fallback)
let store: any;
let redisClient: Redis | null = null;

if (process.env.USE_MEMORY_STORE === 'true') {
  console.log('ℹ️ [Server] Forced to use Memory Store.');
  store = createMemoryStore();
} else {
  try {
    console.log(`🔌 [Server] Connecting to Redis at: ${REDIS_URL}`);
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1, // Fail fast so that we transition to fallback if down
      connectTimeout: 2000,
    });

    redisClient.on('error', (err: Error) => {
      console.warn('⚠️ [Server] Redis client error. Limiter will fall back to safe mode:', err.message);
    });

    store = createRedisStore(redisClient);
  } catch (err: any) {
    console.warn('⚠️ [Server] Failed to initialize Redis client. Falling back to MemoryStore:', err.message);
    store = createMemoryStore();
  }
}

// Register API Routes
app.use('/api/public', createPublicRouter(store));
app.use('/api/user', createAuthenticatedRouter(store));
app.use('/api/admin', createAdminRouter(store));

// Stress test / Benchmark endpoint (no rate limits)
app.get('/api/stress-test', async (req, res) => {
  try {
    if (store instanceof RedisStore && redisClient && redisClient.status === 'ready') {
      const info = await redisClient.info('memory');
      const dbsize = await redisClient.dbsize();
      const usedMemoryHuman = info
        .split('\r\n')
        .find((line: string) => line.startsWith('used_memory_human:'))
        ?.split(':')[1] || 'unknown';

      res.json({
        storeType: 'redis',
        activeKeys: dbsize,
        redisMemoryUsed: usedMemoryHuman,
        timestamp: new Date().toISOString(),
      });
    } else {
      const memoryStore = store as any;
      res.json({
        storeType: 'memory',
        activeKeys: memoryStore.db ? memoryStore.db.size : 0,
        memoryUsed: 'N/A (In-Memory Map)',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve stats', details: error.message });
  }
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Distributed Rate Limiter Demo Server is Running',
    documentation: '/README.md',
    endpoints: {
      public: 'GET /api/public/data',
      login: 'POST /api/public/token',
      profile: 'GET /api/user/profile (JWT required)',
      action: 'POST /api/user/action (JWT required)',
      admin: 'POST /api/admin/bulk-operation',
      stressTest: 'GET /api/stress-test',
    },
  });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 [Server] Demo server is running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Stopping server...');
  server.close(() => {
    if (redisClient) redisClient.quit();
    if (store && typeof store.close === 'function') store.close();
    console.log('Server stopped.');
  });
});
