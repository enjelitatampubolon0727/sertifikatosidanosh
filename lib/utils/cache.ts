import { CacheEntry } from '../types';

class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  set(key: string, data: T, ttl: number): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: new Date(),
      ttl,
    };
    this.cache.set(key, entry);
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();
    const expired = now - entry.timestamp.getTime() > entry.ttl;

    if (expired) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    // Clean up expired entries first
    this.cleanup();
    return this.cache.size;
  }

  keys(): string[] {
    this.cleanup();
    return Array.from(this.cache.keys());
  }

  private cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      const expired = now - entry.timestamp.getTime() > entry.ttl;
      if (expired) {
        this.cache.delete(key);
      }
    }
  }

  // Get all entries with their metadata
  getAll(): Array<{ key: string; data: T; timestamp: Date; ttl: number; isExpired: boolean }> {
    const now = Date.now();
    const results = [];

    for (const [key, entry] of this.cache.entries()) {
      const isExpired = now - entry.timestamp.getTime() > entry.ttl;
      results.push({
        key,
        data: entry.data,
        timestamp: entry.timestamp,
        ttl: entry.ttl,
        isExpired,
      });
    }

    return results;
  }
}

// Global cache instances
export const driveCache = new MemoryCache<any>();
export const sheetsCache = new MemoryCache<any>();
export const folderMappingCache = new MemoryCache<any>();

// Cache key generators
export const CacheKeys = {
  DRIVE_FOLDERS: (parentId: string) => `drive:folders:${parentId}`,
  DRIVE_FOLDER_CHILDREN: (folderId: string) => `drive:children:${folderId}`,
  SHEETS_DATA: (sheetId: string, range: string) => `sheets:${sheetId}:${range}`,
  FOLDER_MAPPING: () => 'folder:mapping',
  PERSON_FOLDER: (email: string) => `person:folder:${email}`,
} as const;

// Helper functions
export async function getOrSet<T>(
  cache: MemoryCache<T>,
  key: string,
  fetcher: () => Promise<T>,
  ttl: number
): Promise<T> {
  const cached = cache.get(key);

  if (cached !== null) {
    return cached;
  }

  const data = await fetcher();
  cache.set(key, data, ttl);
  return data;
}

export function invalidatePattern(cache: MemoryCache<any>, pattern: string): number {
  let deleted = 0;
  const keys = cache.keys();

  for (const key of keys) {
    if (key.includes(pattern)) {
      cache.delete(key);
      deleted++;
    }
  }

  return deleted;
}