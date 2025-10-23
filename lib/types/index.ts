// Google Drive Types
export interface DriveFolder {
  id: string;
  name: string;
  parents?: string[];
  mimeType: string;
  createdTime?: string;
  modifiedTime?: string;
}

export interface FolderMapping {
  [key: string]: string; // name -> folderId
}

// Google Sheets Types
export interface SheetsPerson {
  nama: string;
  email?: string;
  isShared?: boolean;
  isFolderExists?: boolean;
  lastLog?: string;
  folderId?: string;
}

export interface SheetsData {
  people: SheetsPerson[];
  headers: string[];
  range: string;
}

// Scanner Configuration
export interface ScannerConfig {
  parentFolderId: string;
  sheetsId: string;
  worksheetName: string;
  maxPerRun?: number;
  pollInterval?: number;
  dryRun?: boolean;
  debug?: boolean;
}

// Permission Types
export interface DrivePermission {
  email: string;
  role: 'reader' | 'writer' | 'owner';
  type: 'user' | 'group' | 'domain' | 'anyone';
}

export interface InviteStatus {
  email: string;
  folderId: string;
  status: 'pending' | 'sent' | 'completed' | 'failed';
  error?: string;
  attempts: number;
  lastAttempt?: Date;
}

// Background Processing Types
export interface JobConfig {
  type: 'scan_drive' | 'scan_sheets' | 'auto_invite' | 'sync_all';
  priority: number;
  retryCount: number;
  maxRetries: number;
  data?: any;
}

export interface ProcessMonitor {
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  startTime: Date;
  endTime?: Date;
  progress?: number;
  message?: string;
  error?: string;
}


// Cache Types
export interface CacheEntry<T> {
  data: T;
  timestamp: Date;
  ttl: number; // time to live in milliseconds
}

// Rate Limiting Types
export interface RateLimitConfig {
  requestsPerSecond: number;
  burstLimit: number;
  backoffMultiplier: number;
  maxBackoffTime: number;
}