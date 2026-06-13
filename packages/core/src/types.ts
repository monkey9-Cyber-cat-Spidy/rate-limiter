import type { Request } from 'express';

export interface RateLimiterConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
  algorithm: 'token-bucket' | 'sliding-window' | 'fixed-window' | 'leaky-bucket';
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  keyGenerator?: (req: Request) => string;
  onLimitReached?: (req: Request) => void;
  // Custom algorithm specific parameters (e.g. burst for token bucket, which could be max)
  burst?: number;
}

export interface RateLimiterResult {
  allowed: boolean;
  remaining: number;
  resetTime: number; // Unix timestamp in milliseconds
  totalHits: number;
  retryAfter?: number; // seconds to wait before retrying
}

export interface RateLimiterStore {
  increment(key: string, windowMs: number): Promise<RateLimiterResult>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  get(key: string): Promise<number>;
}
