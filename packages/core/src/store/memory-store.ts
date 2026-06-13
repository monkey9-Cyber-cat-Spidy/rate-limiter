import { RateLimiterResult, RateLimiterStore } from '../types.js';

interface MemoryStoreEntry {
  count: number;
  resetTime: number;
}

/**
 * MemoryStore is an in-memory implementation of the RateLimiterStore interface.
 * 
 * @description This store uses a local Map to track rate limit counts.
 * It is suitable for testing, local development, and single-instance deployments.
 * 
 * @warning **NOT suitable for distributed use** as state is not shared across processes.
 * For production distributed systems, use `RedisStore` instead.
 */
export class MemoryStore implements RateLimiterStore {
  public readonly db = new Map<string, any>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(cleanupIntervalMs = 60000) {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, cleanupIntervalMs);
    
    // Allow process to exit even if the timer is still active
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Default Fixed Window increment.
   */
  async increment(key: string, windowMs: number): Promise<RateLimiterResult> {
    const now = Date.now();
    const entry = this.db.get(key) as MemoryStoreEntry | undefined;

    if (!entry || now >= entry.resetTime) {
      const resetTime = now + windowMs;
      const newEntry: MemoryStoreEntry = { count: 1, resetTime };
      this.db.set(key, newEntry);
      return {
        allowed: true,
        remaining: Math.max(0, 1000000), // Note: max should be handled by algorithm, but return a placeholder or calculate based on dummy/context. Let's return general metadata
        resetTime,
        totalHits: 1,
      };
    }

    entry.count += 1;
    this.db.set(key, entry);

    return {
      allowed: true, // Let algorithm wrapper decide allowance
      remaining: 0,
      resetTime: entry.resetTime,
      totalHits: entry.count,
    };
  }

  async decrement(key: string): Promise<void> {
    const entry = this.db.get(key);
    if (entry && typeof entry === 'object' && 'count' in entry) {
      entry.count = Math.max(0, entry.count - 1);
    }
  }

  async reset(key: string): Promise<void> {
    this.db.delete(key);
  }

  async get(key: string): Promise<number> {
    const entry = this.db.get(key);
    if (!entry) return 0;
    if (typeof entry === 'object' && 'count' in entry) {
      return entry.count;
    }
    return 0;
  }

  /**
   * Cleans up expired entries from the memory store.
   */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.db.entries()) {
      if (value && typeof value === 'object' && 'resetTime' in value) {
        if (now >= value.resetTime) {
          this.db.delete(key);
        }
      } else if (value && typeof value === 'object' && 'lastRefill' in value) {
        // Handle Token Bucket / Leaky Bucket style keys (refill/leak checks)
        // If it hasn't been accessed in twice the window/some buffer, clean it up.
        // For simplicity, we can let algorithms manage their own keys, or prune if inactive
      }
    }
  }

  /**
   * Stops the cleanup interval. Must be called when the store is no longer needed.
   */
  public close(): void {
    clearInterval(this.cleanupInterval);
  }
}

/**
 * Factory function to create a new MemoryStore instance.
 */
export function createMemoryStore(cleanupIntervalMs = 60000): MemoryStore {
  return new MemoryStore(cleanupIntervalMs);
}
