import { getDriveClient } from '../config/google-auth';
import { DrivePermission, InviteStatus, SheetsPerson } from '../types';
import { withRateLimitAndRetry } from '../utils/rate-limiter';
import { inviteLogger, ProgressLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { DriveScanner } from './drive-scanner';
import { SheetsScanner } from './sheets-scanner';

export class AutoInviteSystem {
  private drive = getDriveClient();
  private driveScanner = new DriveScanner();
  private sheetsScanner = new SheetsScanner();

  /**
   * Add permission to a folder for a specific user
   */
  async addFolderPermission(
    folderId: string,
    email: string,
    role: 'reader' | 'writer' | 'owner' = 'reader'
  ): Promise<void> {
    return withRateLimitAndRetry(async () => {
      inviteLogger.debug(`Adding ${role} permission for ${email} to folder ${folderId}`);

      await this.drive.permissions.create({
        fileId: folderId,
        requestBody: {
          role,
          type: 'user',
          emailAddress: email,
        },
        sendNotificationEmail: true,
        emailMessage: `You have been granted access to a folder. Please check your Google Drive.`,
      });

      inviteLogger.info(`Permission granted: ${email} -> ${folderId} (${role})`);
    });
  }

  /**
   * Check if user already has permission to a folder
   */
  async checkFolderPermission(folderId: string, email: string): Promise<boolean> {
    return withRateLimitAndRetry(async () => {
      try {
        const response = await this.drive.permissions.list({
          fileId: folderId,
          fields: 'permissions(emailAddress,role,type)',
        });

        const permissions = response.data.permissions || [];
        return permissions.some(p => p.emailAddress?.toLowerCase() === email.toLowerCase());
      } catch (error) {
        inviteLogger.error(`Failed to check permissions for ${folderId}`, error);
        return false;
      }
    });
  }

  /**
   * Process invitation for a single person
   */
  async processSingleInvite(person: SheetsPerson, rowIndex?: number): Promise<InviteStatus> {
    const inviteStatus: InviteStatus = {
      email: person.email || '',
      folderId: '',
      status: 'pending',
      attempts: 0,
    };

    try {
      // Validate email
      if (!person.email) {
        throw new Error('No email address provided');
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(person.email)) {
        throw new Error(`Invalid email format: ${person.email}`);
      }

      // Find folder for this person
      const folderId = await this.driveScanner.findFolderByName(person.nama);

      if (!folderId) {
        throw new Error(`No folder found for person: ${person.nama}`);
      }

      inviteStatus.folderId = folderId;

      // Check if folder exists
      const folderExists = await this.driveScanner.folderExists(folderId);
      if (!folderExists) {
        throw new Error(`Folder ${folderId} does not exist`);
      }

      // Check if already has permission
      const hasPermission = await this.checkFolderPermission(folderId, person.email);
      if (hasPermission) {
        inviteStatus.status = 'completed';
        inviteLogger.info(`User ${person.email} already has access to folder ${folderId}`);

        // Update sheets if row index provided
        if (rowIndex !== undefined) {
          await this.sheetsScanner.updatePersonStatus(person, rowIndex, {
            isShared: true,
            isFolderExists: true,
            lastLog: new Date().toISOString(),
            folderId,
          });
        }

        return inviteStatus;
      }

      // Add permission
      inviteStatus.attempts = 1;
      inviteStatus.lastAttempt = new Date();

      await this.addFolderPermission(folderId, person.email, 'reader');

      inviteStatus.status = 'completed';
      inviteLogger.info(`Successfully invited ${person.email} to folder ${folderId}`);

      // Update sheets if row index provided
      if (rowIndex !== undefined) {
        await this.sheetsScanner.updatePersonStatus(person, rowIndex, {
          isShared: true,
          isFolderExists: true,
          lastLog: new Date().toISOString(),
          folderId,
        });
      }

    } catch (error) {
      inviteStatus.status = 'failed';
      inviteStatus.error = error instanceof Error ? error.message : String(error);
      inviteLogger.error(`Failed to process invite for ${person.nama} (${person.email})`, error);

      // Update sheets with error if row index provided
      if (rowIndex !== undefined) {
        await this.sheetsScanner.updatePersonStatus(person, rowIndex, {
          lastLog: `ERROR: ${inviteStatus.error}`,
          isFolderExists: !!inviteStatus.folderId,
        });
      }
    }

    return inviteStatus;
  }

  /**
   * Process invitations in batch with configurable limits
   */
  async processBatchInvites(
    people: SheetsPerson[],
    maxPerRun: number = CONFIG.maxPerRun || 50
  ): Promise<{
    processed: number;
    successful: number;
    failed: number;
    results: InviteStatus[];
  }> {
    const progressLogger = new ProgressLogger('auto-invite', 'batch-process', Math.min(people.length, maxPerRun));

    const results: InviteStatus[] = [];
    let successful = 0;
    let failed = 0;

    try {
      const toProcess = people.slice(0, maxPerRun);

      for (let i = 0; i < toProcess.length; i++) {
        const person = toProcess[i];

        if (CONFIG.dryRun) {
          inviteLogger.info(`[DRY RUN] Would process invite for ${person.nama} (${person.email})`);
          continue;
        }

        const result = await this.processSingleInvite(person, i + 2); // Assuming data starts at row 2
        results.push(result);

        if (result.status === 'completed') {
          successful++;
        } else {
          failed++;
        }

        progressLogger.progress(i + 1, `Processed ${person.nama}: ${result.status}`);

        // Add delay between requests to be API-friendly
        if (i < toProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
        }
      }

      progressLogger.complete(`Batch completed: ${successful} successful, ${failed} failed`);

      return {
        processed: results.length,
        successful,
        failed,
        results,
      };

    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Auto-invite all people from sheets who haven't been processed
   */
  async autoInviteAll(): Promise<{
    processed: number;
    successful: number;
    failed: number;
    skipped: number;
    results: InviteStatus[];
  }> {
    const progressLogger = new ProgressLogger('auto-invite', 'auto-invite-all');

    try {
      // Get all people from sheets
      const sheetsData = await this.sheetsScanner.getCachedSheetsData();
      let skipped = 0;

      // Filter people who haven't been processed or need retry
      const toProcess = sheetsData.people.filter(person => {
        // Skip if no email
        if (!person.email) {
          skipped++;
          return false;
        }

        // Skip if already shared (unless forced retry)
        if (person.isShared && !CONFIG.debug) {
          skipped++;
          return false;
        }

        return true;
      });

      inviteLogger.info(`Found ${toProcess.length} people to process, ${skipped} skipped`);

      if (toProcess.length === 0) {
        progressLogger.complete('No people to process');
        return {
          processed: 0,
          successful: 0,
          failed: 0,
          skipped,
          results: [],
        };
      }

      // Process in batches
      const batchResult = await this.processBatchInvites(toProcess);

      progressLogger.complete(`Auto-invite completed: ${batchResult.successful}/${batchResult.processed} successful`);

      return {
        ...batchResult,
        skipped,
      };

    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Retry failed invitations
   */
  async retryFailedInvites(): Promise<{
    processed: number;
    successful: number;
    failed: number;
    results: InviteStatus[];
  }> {
    const progressLogger = new ProgressLogger('auto-invite', 'retry-failed');

    try {
      // Get all people from sheets
      const sheetsData = await this.sheetsScanner.getCachedSheetsData();

      // Filter people with failed invitations (indicated by error in lastLog)
      const toRetry = sheetsData.people.filter(person => {
        return person.email &&
               person.lastLog &&
               person.lastLog.includes('ERROR') &&
               !person.isShared;
      });

      inviteLogger.info(`Found ${toRetry.length} failed invitations to retry`);

      if (toRetry.length === 0) {
        progressLogger.complete('No failed invitations to retry');
        return {
          processed: 0,
          successful: 0,
          failed: 0,
          results: [],
        };
      }

      // Process retries
      const batchResult = await this.processBatchInvites(toRetry);

      progressLogger.complete(`Retry completed: ${batchResult.successful}/${batchResult.processed} successful`);

      return batchResult;

    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Get invitation statistics
   */
  async getInviteStatistics(): Promise<{
    total: number;
    withEmail: number;
    withoutEmail: number;
    shared: number;
    pending: number;
    failed: number;
    folderExists: number;
  }> {
    const sheetsData = await this.sheetsScanner.getCachedSheetsData();

    const stats = {
      total: sheetsData.people.length,
      withEmail: 0,
      withoutEmail: 0,
      shared: 0,
      pending: 0,
      failed: 0,
      folderExists: 0,
    };

    for (const person of sheetsData.people) {
      if (person.email) {
        stats.withEmail++;
      } else {
        stats.withoutEmail++;
      }

      if (person.isShared) {
        stats.shared++;
      }

      if (person.isFolderExists) {
        stats.folderExists++;
      }

      if (person.lastLog?.includes('ERROR')) {
        stats.failed++;
      } else if (person.email && !person.isShared) {
        stats.pending++;
      }
    }

    return stats;
  }

  /**
   * Remove permission from a folder
   */
  async removeFolderPermission(folderId: string, email: string): Promise<void> {
    return withRateLimitAndRetry(async () => {
      try {
        // First, find the permission ID
        const response = await this.drive.permissions.list({
          fileId: folderId,
          fields: 'permissions(id,emailAddress)',
        });

        const permissions = response.data.permissions || [];
        const permission = permissions.find(p => p.emailAddress?.toLowerCase() === email.toLowerCase());

        if (!permission?.id) {
          throw new Error(`No permission found for ${email} on folder ${folderId}`);
        }

        // Remove the permission
        await this.drive.permissions.delete({
          fileId: folderId,
          permissionId: permission.id,
        });

        inviteLogger.info(`Permission removed: ${email} from ${folderId}`);

      } catch (error) {
        inviteLogger.error(`Failed to remove permission for ${email} from ${folderId}`, error);
        throw error;
      }
    });
  }
}