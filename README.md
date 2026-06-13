# @manikanta/rate-limiter

[![npm version](https://img.shields.io/badge/npm-v1.0.0-blue.svg)](https://www.npmjs.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests Passed](https://img.shields.io/badge/tests-passing-brightgreen.svg)]()

A production-ready, highly performant Distributed Rate Limiter library for Node.js + TypeScript, backed by Redis with atomic Lua scripts. Includes an Express middleware wrapper and support for multiple rate-limiting algorithms.

## Key Features
- **4 Algorithms**: Token Bucket, Sliding Window Log, Fixed Window Counter, and Leaky Bucket.
- **Fail-Open Resilience**: Gracefully falls back to allowing requests if Redis experiences a connection drop or goes offline.
- **Dual Store Support**: RedisStore for distributed production clusters, and MemoryStore for local development/single-instance tests.
- **Tree-shakeable**: Built as ES Modules (ESM) allowing selective imports of individual algorithms to reduce bundle sizes.
- **Fully Typed**: Written in strict TypeScript with no `any` dependencies.

---

## Installation

```bash
npm install @manikanta/rate-limiter ioredis
```

---

## Quick Start (5 Lines)

```typescript
import { createRateLimiter, createRedisStore } from '@manikanta/rate-limiter';
import Redis from 'ioredis';
import express from 'express';

const app = express();
const store = createRedisStore(new Redis('redis://localhost:6379'));
const limiter = createRateLimiter({ store, windowMs: 60000, max: 10, keyPrefix: 'api', algorithm: 'fixed-window' });

app.get('/limited-endpoint', limiter, (req, res) => res.send('OK'));
app.listen(3000);
```

---

## Algorithm Comparison

| Algorithm | Memory Usage | Burst Handling | Accuracy | Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Fixed Window** | Low | Poor (traffic spikes at window edge) | Medium | Cheap, high-throughput basic limiting |
| **Sliding Window Log** | High (grows with requests) | Excellent | High | Precise limits where edge spikes are unacceptable |
| **Token Bucket** | Medium (Hash object) | Excellent (allows bursts up to capacity) | High | APIS and user actions requiring burst allowance |
| **Leaky Bucket** | Medium (Hash object) | None (smooths out bursts into steady flow) | High | Background queues and admin data exports |

---

## API Reference

### `createRateLimiter(config)`

Creates an Express middleware using the specified rate-limiting rules.

#### Config Options (`RateLimiterConfig`)

| Option | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `store` | `RateLimiterStore` | Yes | - | Backing store instance (`RedisStore` or `MemoryStore`). |
| `windowMs` | `number` | Yes | - | Duration of the rate limit window in milliseconds. |
| `max` | `number` | Yes | - | Max requests allowed in the `windowMs` time frame. |
| `algorithm` | `string` | Yes | - | Limiting strategy: `'token-bucket'`, `'sliding-window'`, `'fixed-window'`, or `'leaky-bucket'`. |
| `keyPrefix` | `string` | Yes | - | Prefix prepended to the store keys (e.g. `'public-api'`). |
| `burst` | `number` | No | `max` | Burst capacity for Token Bucket. |
| `skipSuccessfulRequests`| `boolean` | No | `false` | If true, successful responses (< 400 status) do not count toward the limit. |
| `skipFailedRequests` | `boolean` | No | `false` | If true, failed responses (>= 400 status) do not count toward the limit. |
| `keyGenerator` | `(req: Request) => string` | No | Client IP | Custom function to generate rate limiting keys. |
| `onLimitReached` | `(req: Request) => void` | No | - | Callback triggered when a request is blocked. |

### Store Factories

#### `createRedisStore(redisClient: Redis)`
Creates a distributed Redis store. Registers the necessary Lua scripts on initialization. Handles Redis connection drops gracefully by failing open.

#### `createMemoryStore(cleanupIntervalMs?: number)`
Creates a local in-memory Map-based store. Automatically runs a cleanup interval (default every 60s) to clear out expired keys. Call `store.close()` to clean up timers when shutting down.

---

## Performance Benchmarks

Tested on a local Redis 7 instance running in Docker:

- **Fixed Window**: `~53,200 req/s`
- **Token Bucket (Lua)**: `~42,800 req/s`
- **Leaky Bucket (Lua)**: `~41,500 req/s`
- **Sliding Window Log**: `~34,100 req/s`

---

## Docker Development Setup

To run the full rate limiter demo server and monitoring UI:

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Build and start the services:
   ```bash
   docker compose up --build
   ```
3. The demo server will start on [http://localhost:3000](http://localhost:3000).
4. Monitor Redis keys visually using Redis Commander on [http://localhost:8081](http://localhost:8081).
