import { DriveScanner } from './drive-scanner';
import { SheetsScanner } from './sheets-scanner';
import { AutoInviteSystem } from './auto-invite';
import { FolderMapping, SheetsPerson, SheetsData } from '../types';
import { createServiceLogger, ProgressLogger } from '../utils/logger';
import { CONFIG } from '../config';

/**
 * Main orchestrator class that coordinates all scanning and invitation services
 */
export class ScannerOrchestrator {
  private driveScanner = new DriveScanner();
  private sheetsScanner = new SheetsScanner();
  private autoInvite = new AutoInviteSystem();
  private logger = createServiceLogger('orchestrator');

  /**
   * Perform a complete synchronization workflow
   */
  async fullSync(): Promise<{
    driveFolders: number;
    sheetsPeople: number;
    inviteResults: {
      processed: number;
      successful: number;
      failed: number;
    };
    timestamp: Date;
  }> {
    const progressLogger = new ProgressLogger('orchestrator', 'full-sync');

    try {
      this.logger.info('Starting full synchronization workflow');

      // Step 1: Scan and sync Drive folders
      progressLogger.progress(25, 'Syncing Drive folders');
      const folderMapping = await this.driveScanner.incrementalSync();
      this.logger.info(`Drive sync completed: ${Object.keys(folderMapping).length} folders`);

      // Step 2: Scan and refresh Sheets data
      progressLogger.progress(50, 'Syncing Sheets data');
      const sheetsData = await this.sheetsScanner.readSheetsData();
      this.logger.info(`Sheets sync completed: ${sheetsData.people.length} people`);

      // Step 3: Process auto-invitations
      progressLogger.progress(75, 'Processing invitations');
      const inviteResults = await this.autoInvite.autoInviteAll();
      this.logger.info(`Auto-invite completed: ${inviteResults.successful}/${inviteResults.processed} successful`);

      progressLogger.complete('Full synchronization completed successfully');

      return {
        driveFolders: Object.keys(folderMapping).length,
        sheetsPeople: sheetsData.people.length,
        inviteResults: {
          processed: inviteResults.processed,
          successful: inviteResults.successful,
          failed: inviteResults.failed,
        },
        timestamp: new Date(),
      };

    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Search for a person across all systems and return comprehensive information
   */
  async searchPerson(name: string): Promise<{
    person: SheetsPerson | null;
    folderId: string | null;
    folderExists: boolean;
    hasAccess: boolean | null;
    suggestions: SheetsPerson[];
  }> {
    this.logger.info(`Searching for person: ${name}`);

    try {
      // Search in sheets
      const person = await this.sheetsScanner.getPersonByName(name);
      const suggestions = await this.sheetsScanner.searchPeople(name);

      // Search for folder
      const folderId = await this.driveScanner.findFolderByName(name);
      const folderExists = folderId ? await this.driveScanner.folderExists(folderId) : false;

      // Check access if person has email and folder exists
      let hasAccess: boolean | null = null;
      if (person?.email && folderId && folderExists) {
        hasAccess = await this.autoInvite.checkFolderPermission(folderId, person.email);
      }

      return {
        person,
        folderId,
        folderExists,
        hasAccess,
        suggestions: suggestions.filter(s => s.nama !== person?.nama).slice(0, 5),
      };

    } catch (error) {
      this.logger.error(`Failed to search for person: ${name}`, error);
      throw error;
    }
  }

  /**
   * Get comprehensive system statistics
   */
  async getSystemStats(): Promise<{
    drive: {
      totalFolders: number;
      lastSync?: Date;
    };
    sheets: {
      totalPeople: number;
      withEmail: number;
      withoutEmail: number;
      duplicates: number;
      invalidEmails: number;
      lastSync?: Date;
    };
    invitations: {
      total: number;
      shared: number;
      pending: number;
      failed: number;
      folderExists: number;
    };
  }> {
    this.logger.info('Gathering system statistics');

    try {
      // Drive statistics
      const folderMapping = await this.driveScanner.loadFolderMapping();

      // Sheets statistics
      const validation = await this.sheetsScanner.validateData();

      // Invitation statistics
      const inviteStats = await this.autoInvite.getInviteStatistics();

      return {
        drive: {
          totalFolders: Object.keys(folderMapping).length,
        },
        sheets: {
          totalPeople: validation.total,
          withEmail: validation.withEmail,
          withoutEmail: validation.withoutEmail,
          duplicates: validation.duplicateNames.length,
          invalidEmails: validation.invalidEmails.length,
        },
        invitations: inviteStats,
      };

    } catch (error) {
      this.logger.error('Failed to gather system statistics', error);
      throw error;
    }
  }

  /**
   * Process a specific person manually
   */
  async processPersonManually(name: string, email?: string): Promise<{
    success: boolean;
    person: SheetsPerson | null;
    folderId: string | null;
    inviteStatus: any;
    message: string;
  }> {
    this.logger.info(`Manually processing person: ${name}`);

    try {
      // Find person in sheets
      let person = await this.sheetsScanner.getPersonByName(name);

      // If not found and email provided, create temporary person object
      if (!person && email) {
        person = { nama: name, email };
      }

      if (!person) {
        return {
          success: false,
          person: null,
          folderId: null,
          inviteStatus: null,
          message: `Person "${name}" not found in sheets and no email provided`,
        };
      }

      // Find folder
      const folderId = await this.driveScanner.findFolderByName(name);

      if (!folderId) {
        return {
          success: false,
          person,
          folderId: null,
          inviteStatus: null,
          message: `No folder found for "${name}"`,
        };
      }

      // Process invitation
      const inviteStatus = await this.autoInvite.processSingleInvite(person);

      return {
        success: inviteStatus.status === 'completed',
        person,
        folderId,
        inviteStatus,
        message: inviteStatus.status === 'completed'
          ? `Successfully processed "${name}"`
          : `Failed to process "${name}": ${inviteStatus.error}`,
      };

    } catch (error) {
      this.logger.error(`Failed to manually process person: ${name}`, error);
      throw error;
    }
  }

  /**
   * Validate system integrity
   */
  async validateSystemIntegrity(): Promise<{
    drive: { valid: boolean; errors: string[] };
    sheets: { valid: boolean; errors: string[] };
    configuration: { valid: boolean; errors: string[] };
    overall: boolean;
  }> {
    this.logger.info('Validating system integrity');

    const result = {
      drive: { valid: true, errors: [] as string[] },
      sheets: { valid: true, errors: [] as string[] },
      configuration: { valid: true, errors: [] as string[] },
      overall: true,
    };

    try {
      // Validate configuration
      try {
        const { validateConfig } = await import('../config');
        validateConfig();
      } catch (error) {
        result.configuration.valid = false;
        result.configuration.errors.push(error instanceof Error ? error.message : 'Configuration error');
      }

      // Validate Drive access
      try {
        const folderMapping = await this.driveScanner.loadFolderMapping();
        if (Object.keys(folderMapping).length === 0) {
          result.drive.errors.push('No folders found in mapping');
        }
      } catch (error) {
        result.drive.valid = false;
        result.drive.errors.push('Cannot access Drive or load folder mapping');
      }

      // Validate Sheets access
      try {
        const validation = await this.sheetsScanner.validateData();
        if (validation.total === 0) {
          result.sheets.errors.push('No people found in sheets');
        }
        if (validation.invalidEmails.length > 0) {
          result.sheets.errors.push(`${validation.invalidEmails.length} invalid emails found`);
        }
        if (validation.duplicateNames.length > 0) {
          result.sheets.errors.push(`${validation.duplicateNames.length} duplicate names found`);
        }
      } catch (error) {
        result.sheets.valid = false;
        result.sheets.errors.push('Cannot access Sheets or validate data');
      }

      // Set overall validity
      result.overall = result.drive.valid && result.sheets.valid && result.configuration.valid;

      this.logger.info(`System integrity validation completed: ${result.overall ? 'VALID' : 'INVALID'}`);

      return result;

    } catch (error) {
      this.logger.error('Failed to validate system integrity', error);
      throw error;
    }
  }
}

// Global instance
let orchestrator: ScannerOrchestrator | null = null;

export function getOrchestrator(): ScannerOrchestrator {
  if (!orchestrator) {
    orchestrator = new ScannerOrchestrator();
  }
  return orchestrator;
}