import { JobConfig, ProcessMonitor } from '../types';
import { backgroundLogger, ProgressLogger } from '../utils/logger';
import { CONFIG, getShardConfig } from '../config';
import { DriveScanner } from './drive-scanner';
import { SheetsScanner } from './sheets-scanner';
import { AutoInviteSystem } from './auto-invite';
import * as cron from 'node-cron';

export class BackgroundProcessor {
  private jobs = new Map<string, NodeJS.Timeout>();
  private monitors = new Map<string, ProcessMonitor>();
  private isRunning = false;
  private shutdownHandlers: Array<() => Promise<void>> = [];

  private driveScanner = new DriveScanner();
  private sheetsScanner = new SheetsScanner();
  private autoInvite = new AutoInviteSystem();

  constructor() {
    this.setupShutdownHandlers();
  }

  /**
   * Start the background processor
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      backgroundLogger.warn('Background processor is already running');
      return;
    }

    this.isRunning = true;
    backgroundLogger.info('Starting background processor');

    // Schedule periodic jobs based on configuration
    await this.scheduleJobs();

    backgroundLogger.info('Background processor started successfully');
  }

  /**
   * Stop the background processor
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    backgroundLogger.info('Stopping background processor');
    this.isRunning = false;

    // Cancel all scheduled jobs
    for (const [jobId, timeout] of this.jobs) {
      clearTimeout(timeout);
      backgroundLogger.debug(`Cancelled job ${jobId}`);
    }
    this.jobs.clear();

    // Run shutdown handlers
    for (const handler of this.shutdownHandlers) {
      try {
        await handler();
      } catch (error) {
        backgroundLogger.error('Error in shutdown handler', error);
      }
    }

    backgroundLogger.info('Background processor stopped');
  }

  /**
   * Schedule all periodic jobs
   */
  private async scheduleJobs(): Promise<void> {
    const shardConfig = getShardConfig();

    // Only run on primary shard (index 0) unless specified otherwise
    if (shardConfig.index !== 0) {
      backgroundLogger.info(`Running on shard ${shardConfig.index}/${shardConfig.total}, skipping primary jobs`);
      return;
    }

    // Schedule drive sync every 30 minutes
    this.scheduleJob('drive-sync', 30 * 60 * 1000, async () => {
      await this.executeJob({
        type: 'scan_drive',
        priority: 1,
        retryCount: 0,
        maxRetries: 3,
      });
    });

    // Schedule sheets sync every 15 minutes
    this.scheduleJob('sheets-sync', 15 * 60 * 1000, async () => {
      await this.executeJob({
        type: 'scan_sheets',
        priority: 1,
        retryCount: 0,
        maxRetries: 3,
      });
    });

    // Schedule auto-invite every poll interval (default 5 minutes)
    this.scheduleJob('auto-invite', CONFIG.pollInterval || 5 * 60 * 1000, async () => {
      await this.executeJob({
        type: 'auto_invite',
        priority: 2,
        retryCount: 0,
        maxRetries: 2,
      });
    });

    // Schedule full sync every 2 hours
    this.scheduleJob('full-sync', 2 * 60 * 60 * 1000, async () => {
      await this.executeJob({
        type: 'sync_all',
        priority: 3,
        retryCount: 0,
        maxRetries: 1,
      });
    });

    backgroundLogger.info('All jobs scheduled successfully');
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(jobId: string, interval: number, handler: () => Promise<void>): void {
    // Initial delay to stagger job starts
    const initialDelay = Math.random() * 60 * 1000; // 0-60 seconds

    setTimeout(() => {
      // Execute immediately, then set up interval
      handler().catch(error => {
        backgroundLogger.error(`Initial execution of job ${jobId} failed`, error);
      });

      // Set up recurring execution
      const timeout = setInterval(async () => {
        if (!this.isRunning) {
          clearInterval(timeout);
          return;
        }

        try {
          await handler();
        } catch (error) {
          backgroundLogger.error(`Scheduled execution of job ${jobId} failed`, error);
        }
      }, interval);

      this.jobs.set(jobId, timeout);
      backgroundLogger.info(`Scheduled job ${jobId} with interval ${interval}ms`);
    }, initialDelay);
  }

  /**
   * Execute a specific job
   */
  async executeJob(config: JobConfig): Promise<void> {
    const jobId = `${config.type}-${Date.now()}`;
    const monitor: ProcessMonitor = {
      jobId,
      status: 'running',
      startTime: new Date(),
    };

    this.monitors.set(jobId, monitor);

    try {
      backgroundLogger.info(`Starting job ${jobId}`, { type: config.type, priority: config.priority });

      switch (config.type) {
        case 'scan_drive':
          await this.executeDriveScan(monitor);
          break;
        case 'scan_sheets':
          await this.executeSheetsScan(monitor);
          break;
        case 'auto_invite':
          await this.executeAutoInvite(monitor);
          break;
        case 'sync_all':
          await this.executeFullSync(monitor);
          break;
        default:
          throw new Error(`Unknown job type: ${config.type}`);
      }

      monitor.status = 'completed';
      monitor.endTime = new Date();
      monitor.message = 'Job completed successfully';

      backgroundLogger.info(`Job ${jobId} completed successfully`);

    } catch (error) {
      monitor.status = 'failed';
      monitor.endTime = new Date();
      monitor.error = error instanceof Error ? error.message : String(error);

      backgroundLogger.error(`Job ${jobId} failed`, error);

      // Retry logic
      if (config.retryCount < config.maxRetries) {
        const retryDelay = Math.pow(2, config.retryCount) * 1000; // Exponential backoff
        backgroundLogger.info(`Retrying job ${jobId} in ${retryDelay}ms (attempt ${config.retryCount + 1}/${config.maxRetries})`);

        setTimeout(() => {
          this.executeJob({
            ...config,
            retryCount: config.retryCount + 1,
          });
        }, retryDelay);
      }
    }
  }

  /**
   * Execute drive scanning job
   */
  private async executeDriveScan(monitor: ProcessMonitor): Promise<void> {
    monitor.message = 'Scanning Google Drive folders';

    const mapping = await this.driveScanner.incrementalSync();

    monitor.progress = 100;
    monitor.message = `Drive scan completed: ${Object.keys(mapping).length} folders`;
  }

  /**
   * Execute sheets scanning job
   */
  private async executeSheetsScan(monitor: ProcessMonitor): Promise<void> {
    monitor.message = 'Scanning Google Sheets data';

    const data = await this.sheetsScanner.readSheetsData();

    monitor.progress = 100;
    monitor.message = `Sheets scan completed: ${data.people.length} people`;
  }

  /**
   * Execute auto-invite job
   */
  private async executeAutoInvite(monitor: ProcessMonitor): Promise<void> {
    monitor.message = 'Processing auto-invitations';

    const result = await this.autoInvite.autoInviteAll();

    monitor.progress = 100;
    monitor.message = `Auto-invite completed: ${result.successful}/${result.processed} successful`;
  }

  /**
   * Execute full synchronization job
   */
  private async executeFullSync(monitor: ProcessMonitor): Promise<void> {
    monitor.message = 'Starting full synchronization';

    // Step 1: Drive scan
    monitor.progress = 25;
    monitor.message = 'Syncing Drive folders';
    await this.driveScanner.incrementalSync();

    // Step 2: Sheets scan
    monitor.progress = 50;
    monitor.message = 'Syncing Sheets data';
    await this.sheetsScanner.readSheetsData();

    // Step 3: Auto-invite
    monitor.progress = 75;
    monitor.message = 'Processing invitations';
    const result = await this.autoInvite.autoInviteAll();

    // Step 4: Statistics
    monitor.progress = 100;
    const stats = await this.autoInvite.getInviteStatistics();
    monitor.message = `Full sync completed: ${result.successful} invites, ${stats.total} total people`;
  }

  /**
   * Get job monitoring information
   */
  getJobMonitors(): ProcessMonitor[] {
    return Array.from(this.monitors.values());
  }

  /**
   * Get specific job monitor
   */
  getJobMonitor(jobId: string): ProcessMonitor | undefined {
    return this.monitors.get(jobId);
  }

  /**
   * Clean up old job monitors
   */
  cleanupOldMonitors(maxAge: number = 24 * 60 * 60 * 1000): void {
    const cutoff = new Date(Date.now() - maxAge);

    for (const [jobId, monitor] of this.monitors) {
      if (monitor.endTime && monitor.endTime < cutoff) {
        this.monitors.delete(jobId);
      }
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      backgroundLogger.info(`Received ${signal}, initiating graceful shutdown`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Cleanup old monitors every hour
    this.shutdownHandlers.push(async () => {
      clearInterval(this.cleanupInterval);
    });

    this.cleanupInterval = setInterval(() => {
      this.cleanupOldMonitors();
    }, 60 * 60 * 1000); // Every hour
  }

  private cleanupInterval!: NodeJS.Timeout;

  /**
   * Get system health status
   */
  getHealthStatus(): {
    isRunning: boolean;
    activeJobs: number;
    totalJobs: number;
    uptime: number;
    lastJobTime?: Date;
  } {
    const monitors = Array.from(this.monitors.values());
    const activeJobs = monitors.filter(m => m.status === 'running').length;
    const lastJobTime = monitors
      .filter(m => m.endTime)
      .sort((a, b) => (b.endTime?.getTime() || 0) - (a.endTime?.getTime() || 0))[0]?.endTime;

    return {
      isRunning: this.isRunning,
      activeJobs,
      totalJobs: this.jobs.size,
      uptime: process.uptime(),
      lastJobTime,
    };
  }

  /**
   * Force execute a specific job type immediately
   */
  async forceExecuteJob(type: JobConfig['type']): Promise<void> {
    await this.executeJob({
      type,
      priority: 1,
      retryCount: 0,
      maxRetries: 1,
    });
  }
}

// Global instance
let backgroundProcessor: BackgroundProcessor | null = null;

export function getBackgroundProcessor(): BackgroundProcessor {
  if (!backgroundProcessor) {
    backgroundProcessor = new BackgroundProcessor();
  }
  return backgroundProcessor;
}

export async function startBackgroundProcessor(): Promise<void> {
  const processor = getBackgroundProcessor();
  await processor.start();
}

export async function stopBackgroundProcessor(): Promise<void> {
  if (backgroundProcessor) {
    await backgroundProcessor.stop();
  }
}