import { ScannerConfig, RateLimitConfig } from '../types';

export const CONFIG: ScannerConfig = {
  parentFolderId: process.env.FOLDER_PARENT_ID || '',
  sheetsId: process.env.SHEETS_ID || '',
  worksheetName: process.env.WORKSHEET_NAME?.replace(/"/g, '') || 'Form Responses 1',
  maxPerRun: parseInt(process.env.MAX_PER_RUN || '50'),
  pollInterval: parseInt(process.env.POLL_INTERVAL || '300000'), // 5 minutes default
  dryRun: process.env.DRY_RUN === 'true',
  debug: process.env.DEBUG === 'true',
};

export const RATE_LIMITS: RateLimitConfig = {
  requestsPerSecond: 10, // Google API rate limit friendly
  burstLimit: 100,
  backoffMultiplier: 2,
  maxBackoffTime: 32000, // 32 seconds max backoff
};

export const CACHE_TTL = {
  DRIVE_FOLDERS: 10 * 60 * 1000, // 10 minutes
  SHEETS_DATA: 5 * 60 * 1000,    // 5 minutes
  FOLDER_MAPPING: 30 * 60 * 1000, // 30 minutes
};

export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000, // 1 second
  MAX_DELAY: 10000,    // 10 seconds
  EXPONENTIAL_BASE: 2,
};

// Validate required environment variables
export function validateConfig(): void {
  const required = ['FOLDER_PARENT_ID', 'SHEETS_ID'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Get shard configuration for distributed processing
export function getShardConfig() {
  return {
    total: parseInt(process.env.SHARD_TOTAL || '1'),
    index: parseInt(process.env.SHARD_INDEX || '0'),
  };
}