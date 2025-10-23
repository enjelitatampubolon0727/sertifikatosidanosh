import { RATE_LIMITS, RETRY_CONFIG } from '../config';

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;

  constructor(requestsPerSecond: number = RATE_LIMITS.requestsPerSecond, burstLimit: number = RATE_LIMITS.burstLimit) {
    this.capacity = burstLimit;
    this.tokens = burstLimit;
    this.refillRate = requestsPerSecond;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    const tokensToAdd = timePassed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async acquire(cost: number = 1): Promise<void> {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }

    // Calculate wait time
    const waitTime = ((cost - this.tokens) / this.refillRate) * 1000;
    await new Promise(resolve => setTimeout(resolve, waitTime));

    this.refill();
    this.tokens -= cost;
  }

  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

class ExponentialBackoff {
  private attempts: number = 0;

  constructor(
    private readonly maxRetries: number = RETRY_CONFIG.MAX_RETRIES,
    private readonly initialDelay: number = RETRY_CONFIG.INITIAL_DELAY,
    private readonly maxDelay: number = RETRY_CONFIG.MAX_DELAY,
    private readonly base: number = RETRY_CONFIG.EXPONENTIAL_BASE
  ) {}

  async retry<T>(operation: () => Promise<T>): Promise<T> {
    this.attempts = 0;

    while (this.attempts <= this.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        this.attempts++;

        if (this.attempts > this.maxRetries) {
          throw error;
        }

        const delay = Math.min(
          this.initialDelay * Math.pow(this.base, this.attempts - 1),
          this.maxDelay
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Maximum retry attempts exceeded');
  }

  reset(): void {
    this.attempts = 0;
  }

  getAttempts(): number {
    return this.attempts;
  }
}

// Global instances
export const googleApiRateLimiter = new RateLimiter();
export const createBackoff = () => new ExponentialBackoff();

// Utility function to wrap API calls with rate limiting and retry logic
export async function withRateLimitAndRetry<T>(
  operation: () => Promise<T>,
  rateLimiter: RateLimiter = googleApiRateLimiter
): Promise<T> {
  const backoff = createBackoff();

  return backoff.retry(async () => {
    await rateLimiter.acquire();
    return operation();
  });
}