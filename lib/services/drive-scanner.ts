import { getDriveClient } from '../config/google-auth';
import { DriveFolder, FolderMapping } from '../types';
import { withRateLimitAndRetry } from '../utils/rate-limiter';
import { driveCache, CacheKeys, getOrSet } from '../utils/cache';
import { driveLogger, ProgressLogger } from '../utils/logger';
import { CACHE_TTL, CONFIG } from '../config';
import fs from 'fs/promises';
import path from 'path';

export class DriveScanner {
  private drive = getDriveClient();

  /**
   * Recursively scan all folders from a parent folder
   */
  async scanFoldersRecursive(parentFolderId: string): Promise<DriveFolder[]> {
    const progressLogger = new ProgressLogger('drive-scanner', 'recursive-scan');
    const allFolders: DriveFolder[] = [];

    try {
      await this.scanFoldersRecursiveHelper(parentFolderId, allFolders, progressLogger);
      progressLogger.complete(`Found ${allFolders.length} folders`);
      return allFolders;
    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  private async scanFoldersRecursiveHelper(
    parentFolderId: string,
    allFolders: DriveFolder[],
    progressLogger: ProgressLogger,
    depth: number = 0
  ): Promise<void> {
    const maxDepth = 10; // Prevent infinite recursion
    if (depth > maxDepth) {
      driveLogger.warn(`Maximum depth ${maxDepth} reached for folder ${parentFolderId}`);
      return;
    }

    const cacheKey = CacheKeys.DRIVE_FOLDER_CHILDREN(parentFolderId);

    try {
      const folders = await getOrSet(
        driveCache,
        cacheKey,
        () => this.getFolderChildren(parentFolderId),
        CACHE_TTL.DRIVE_FOLDERS
      );

      allFolders.push(...folders);
      progressLogger.progress(allFolders.length, `Scanning depth ${depth}`);

      // Recursively scan each subfolder
      for (const folder of folders) {
        await this.scanFoldersRecursiveHelper(folder.id, allFolders, progressLogger, depth + 1);
      }
    } catch (error) {
      driveLogger.error(`Failed to scan folder ${parentFolderId} at depth ${depth}`, error);
      throw error;
    }
  }

  /**
   * Get direct children folders of a parent folder
   */
  async getFolderChildren(parentFolderId: string): Promise<DriveFolder[]> {
    return withRateLimitAndRetry(async () => {
      driveLogger.debug(`Fetching children of folder ${parentFolderId}`);

      const response = await this.drive.files.list({
        q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id,name,parents,mimeType,createdTime,modifiedTime)',
        pageSize: 1000, // Max page size for Google Drive API
      });

      const folders = response.data.files?.map(file => ({
        id: file.id!,
        name: file.name!,
        parents: file.parents,
        mimeType: file.mimeType!,
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
      })) || [];

      driveLogger.info(`Found ${folders.length} folders in ${parentFolderId}`);
      return folders;
    });
  }

  /**
   * Create folder mapping (name -> folderId) with case-insensitive matching
   */
  async createFolderMapping(folders?: DriveFolder[]): Promise<FolderMapping> {
    const progressLogger = new ProgressLogger('drive-scanner', 'create-mapping');

    try {
      if (!folders) {
        folders = await this.scanFoldersRecursive(CONFIG.parentFolderId);
      }

      const mapping: FolderMapping = {};
      let processed = 0;

      for (const folder of folders) {
        // Use lowercase for case-insensitive matching
        const normalizedName = folder.name.toLowerCase();

        // Store both original case and normalized versions
        mapping[folder.name] = folder.id;
        mapping[normalizedName] = folder.id;

        processed++;
        if (processed % 100 === 0) {
          progressLogger.progress(processed, `Processed ${processed}/${folders.length} folders`);
        }
      }

      progressLogger.complete(`Created mapping for ${Object.keys(mapping).length} entries`);
      return mapping;
    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Save folder mapping to JSON file
   */
  async saveFolderMapping(mapping: FolderMapping, filePath: string = './folder-mapping.json'): Promise<void> {
    try {
      await fs.writeFile(filePath, JSON.stringify(mapping, null, 2));
      driveLogger.info(`Folder mapping saved to ${filePath}`);
    } catch (error) {
      driveLogger.error(`Failed to save folder mapping to ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Load folder mapping from JSON file
   */
  async loadFolderMapping(filePath: string = './folder-mapping.json'): Promise<FolderMapping> {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const mapping = JSON.parse(data);
      driveLogger.info(`Folder mapping loaded from ${filePath}`);
      return mapping;
    } catch (error) {
      driveLogger.error(`Failed to load folder mapping from ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Perform incremental sync - only scan folders that have been modified
   */
  async incrementalSync(): Promise<FolderMapping> {
    const progressLogger = new ProgressLogger('drive-scanner', 'incremental-sync');

    try {
      // Try to load existing mapping
      let existingMapping: FolderMapping = {};
      try {
        existingMapping = await this.loadFolderMapping();
      } catch (error) {
        driveLogger.info('No existing mapping found, performing full scan');
      }

      // Get all folders from parent
      const allFolders = await this.scanFoldersRecursive(CONFIG.parentFolderId);

      // Create new mapping
      const newMapping = await this.createFolderMapping(allFolders);

      // Compare and log changes
      const oldKeys = new Set(Object.keys(existingMapping));
      const newKeys = new Set(Object.keys(newMapping));

      const added = Array.from(newKeys).filter(key => !oldKeys.has(key));
      const removed = Array.from(oldKeys).filter(key => !newKeys.has(key));

      driveLogger.info(`Incremental sync completed`, {
        totalFolders: allFolders.length,
        added: added.length,
        removed: removed.length,
      });

      if (added.length > 0) {
        driveLogger.info(`Added folders: ${added.slice(0, 10).join(', ')}${added.length > 10 ? '...' : ''}`);
      }

      if (removed.length > 0) {
        driveLogger.info(`Removed folders: ${removed.slice(0, 10).join(', ')}${removed.length > 10 ? '...' : ''}`);
      }

      // Save updated mapping
      await this.saveFolderMapping(newMapping);

      // Update cache
      driveCache.set(CacheKeys.FOLDER_MAPPING(), newMapping, CACHE_TTL.FOLDER_MAPPING);

      progressLogger.complete(`Sync completed: ${allFolders.length} folders`);
      return newMapping;
    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Find folder by name (case-insensitive)
   */
  async findFolderByName(name: string, mapping?: FolderMapping): Promise<string | null> {
    if (!mapping) {
      const cacheKey = CacheKeys.FOLDER_MAPPING();
      mapping = await getOrSet(
        driveCache,
        cacheKey,
        () => this.loadFolderMapping(),
        CACHE_TTL.FOLDER_MAPPING
      );
    }

    // Try exact match first
    if (mapping[name]) {
      return mapping[name];
    }

    // Try case-insensitive match
    const normalizedName = name.toLowerCase();
    if (mapping[normalizedName]) {
      return mapping[normalizedName];
    }

    // Try partial matches
    for (const [folderName, folderId] of Object.entries(mapping)) {
      if (folderName.toLowerCase().includes(normalizedName)) {
        driveLogger.debug(`Partial match found: "${name}" -> "${folderName}"`);
        return folderId;
      }
    }

    return null;
  }

  /**
   * Get folder metadata
   */
  async getFolderMetadata(folderId: string) {
    return withRateLimitAndRetry(async () => {
      const response = await this.drive.files.get({
        fileId: folderId,
        fields: 'id,name,parents,mimeType,createdTime,modifiedTime,owners,permissions',
      });

      return response.data;
    });
  }

  /**
   * Check if folder exists
   */
  async folderExists(folderId: string): Promise<boolean> {
    try {
      await this.getFolderMetadata(folderId);
      return true;
    } catch (error) {
      return false;
    }
  }
}