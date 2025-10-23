import { getSheetsClient } from '../config/google-auth';
import { SheetsPerson, SheetsData } from '../types';
import { withRateLimitAndRetry } from '../utils/rate-limiter';
import { sheetsCache, CacheKeys, getOrSet } from '../utils/cache';
import { sheetsLogger, ProgressLogger } from '../utils/logger';
import { CACHE_TTL, CONFIG } from '../config';

export class SheetsScanner {
  private sheets = getSheetsClient();

  /**
   * Detect column headers automatically
   */
  async detectHeaders(sheetId: string, worksheetName: string): Promise<{ headers: string[]; dataStartRow: number }> {
    return withRateLimitAndRetry(async () => {
      sheetsLogger.debug(`Detecting headers in ${sheetId}:${worksheetName}`);

      // Try first few rows to find headers
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${worksheetName}!A1:Z10`, // Check first 10 rows
      });

      const rows = response.data.values || [];

      if (rows.length === 0) {
        throw new Error('No data found in spreadsheet');
      }

      // Look for row with "Nama" or "Email" columns
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const lowerRow = row.map(cell => (cell || '').toString().toLowerCase());

        if (lowerRow.includes('nama') || lowerRow.includes('email')) {
          sheetsLogger.info(`Headers found at row ${i + 1}`, { headers: row });
          return {
            headers: row,
            dataStartRow: i + 2, // Next row after headers (1-indexed)
          };
        }
      }

      // Fallback: assume first row is headers
      sheetsLogger.warn('Header detection failed, using first row as headers');
      return {
        headers: rows[0],
        dataStartRow: 2,
      };
    });
  }

  /**
   * Get column indices for known columns
   */
  getColumnIndices(headers: string[]): {
    nama: number;
    email: number;
    isShared: number;
    isFolderExists: number;
    lastLog: number;
    folderId: number;
  } {
    const lowerHeaders = headers.map(h => (h || '').toString().toLowerCase());

    const indices = {
      nama: -1,
      email: -1,
      isShared: -1,
      isFolderExists: -1,
      lastLog: -1,
      folderId: -1,
    };

    // Find column indices
    indices.nama = lowerHeaders.findIndex(h =>
      h.includes('nama') || h.includes('name') || h.includes('participant')
    );

    indices.email = lowerHeaders.findIndex(h =>
      h.includes('email') || h.includes('e-mail') || h.includes('mail')
    );

    indices.isShared = lowerHeaders.findIndex(h =>
      h.includes('isshared') || h.includes('is_shared') || h.includes('shared')
    );

    indices.isFolderExists = lowerHeaders.findIndex(h =>
      h.includes('isfolderexists') || h.includes('is_folder_exists') || h.includes('folder_exists')
    );

    indices.lastLog = lowerHeaders.findIndex(h =>
      h.includes('lastlog') || h.includes('last_log') || h.includes('log')
    );

    indices.folderId = lowerHeaders.findIndex(h =>
      h.includes('folderid') || h.includes('folder_id') || h.includes('id')
    );

    sheetsLogger.debug('Column indices detected', indices);
    return indices;
  }

  /**
   * Extract email from various formats
   */
  extractEmail(emailField: string): string {
    if (!emailField) return '';

    // Remove extra whitespace
    emailField = emailField.trim();

    // If it's already just an email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(emailField)) {
      return emailField.toLowerCase();
    }

    // Extract email from longer text
    const emailMatch = emailField.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (emailMatch) {
      return emailMatch[0].toLowerCase();
    }

    return '';
  }

  /**
   * Parse a single row into SheetsPerson object
   */
  parseRow(row: any[], indices: ReturnType<typeof this.getColumnIndices>): SheetsPerson | null {
    const nama = row[indices.nama]?.toString().trim();

    if (!nama) {
      return null; // Skip rows without names
    }

    const emailRaw = row[indices.email]?.toString() || '';
    const email = this.extractEmail(emailRaw);

    const person: SheetsPerson = {
      nama,
      email: email || undefined,
    };

    // Parse optional status columns
    if (indices.isShared >= 0) {
      const isSharedValue = row[indices.isShared]?.toString().toLowerCase();
      person.isShared = isSharedValue === 'true' || isSharedValue === '1' || isSharedValue === 'yes';
    }

    if (indices.isFolderExists >= 0) {
      const isFolderExistsValue = row[indices.isFolderExists]?.toString().toLowerCase();
      person.isFolderExists = isFolderExistsValue === 'true' || isFolderExistsValue === '1' || isFolderExistsValue === 'yes';
    }

    if (indices.lastLog >= 0 && row[indices.lastLog]) {
      person.lastLog = row[indices.lastLog].toString();
    }

    if (indices.folderId >= 0 && row[indices.folderId]) {
      person.folderId = row[indices.folderId].toString();
    }

    return person;
  }

  /**
   * Read all data from Google Sheets
   */
  async readSheetsData(sheetId: string = CONFIG.sheetsId, worksheetName: string = CONFIG.worksheetName): Promise<SheetsData> {
    const progressLogger = new ProgressLogger('sheets-scanner', 'read-data');

    try {
      // Detect headers and data start row
      const { headers, dataStartRow } = await this.detectHeaders(sheetId, worksheetName);
      const indices = this.getColumnIndices(headers);

      if (indices.nama < 0) {
        throw new Error('No "Nama" column found in spreadsheet');
      }

      // Read all data from data start row onwards
      const range = `${worksheetName}!A${dataStartRow}:Z1000`; // Adjust range as needed

      const response = await withRateLimitAndRetry(async () => {
        return this.sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range,
        });
      });

      const rows = response.data.values || [];
      const people: SheetsPerson[] = [];

      progressLogger.progress(0, `Processing ${rows.length} rows`);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const person = this.parseRow(row, indices);

        if (person) {
          people.push(person);
        }

        if ((i + 1) % 100 === 0) {
          progressLogger.progress(i + 1, `Processed ${i + 1}/${rows.length} rows`);
        }
      }

      progressLogger.complete(`Processed ${people.length} people from ${rows.length} rows`);

      return {
        people,
        headers,
        range,
      };
    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Get cached sheets data with fallback to fresh read
   */
  async getCachedSheetsData(sheetId: string = CONFIG.sheetsId, worksheetName: string = CONFIG.worksheetName): Promise<SheetsData> {
    const cacheKey = CacheKeys.SHEETS_DATA(sheetId, worksheetName);

    return getOrSet(
      sheetsCache,
      cacheKey,
      () => this.readSheetsData(sheetId, worksheetName),
      CACHE_TTL.SHEETS_DATA
    );
  }

  /**
   * Update status columns in the spreadsheet
   */
  async updatePersonStatus(
    person: SheetsPerson,
    rowIndex: number,
    updates: Partial<Pick<SheetsPerson, 'isShared' | 'isFolderExists' | 'lastLog' | 'folderId'>>,
    sheetId: string = CONFIG.sheetsId,
    worksheetName: string = CONFIG.worksheetName
  ): Promise<void> {
    const progressLogger = new ProgressLogger('sheets-scanner', 'update-status');

    try {
      // First, get headers to know column positions
      const { headers } = await this.detectHeaders(sheetId, worksheetName);
      const indices = this.getColumnIndices(headers);

      const updateRequests = [];

      // Build update requests for each field
      for (const [field, value] of Object.entries(updates)) {
        let columnIndex = -1;

        switch (field) {
          case 'isShared':
            columnIndex = indices.isShared;
            break;
          case 'isFolderExists':
            columnIndex = indices.isFolderExists;
            break;
          case 'lastLog':
            columnIndex = indices.lastLog;
            break;
          case 'folderId':
            columnIndex = indices.folderId;
            break;
        }

        if (columnIndex >= 0 && value !== undefined) {
          const cellAddress = this.getCellAddress(rowIndex, columnIndex);
          const range = `${worksheetName}!${cellAddress}`;

          updateRequests.push({
            range,
            values: [[value.toString()]],
          });
        }
      }

      if (updateRequests.length === 0) {
        sheetsLogger.warn('No valid columns found for status update');
        return;
      }

      // Batch update
      await withRateLimitAndRetry(async () => {
        return this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: updateRequests,
          },
        });
      });

      sheetsLogger.info(`Updated status for ${person.nama}`, updates);
      progressLogger.complete(`Updated ${updateRequests.length} fields`);

      // Invalidate cache
      const cacheKey = CacheKeys.SHEETS_DATA(sheetId, worksheetName);
      sheetsCache.delete(cacheKey);

    } catch (error) {
      progressLogger.error(error as Error);
      throw error;
    }
  }

  /**
   * Convert row and column indices to Excel-style cell address (e.g., A1, B2)
   */
  private getCellAddress(rowIndex: number, columnIndex: number): string {
    let columnName = '';
    let tempIndex = columnIndex;

    while (tempIndex >= 0) {
      columnName = String.fromCharCode(65 + (tempIndex % 26)) + columnName;
      tempIndex = Math.floor(tempIndex / 26) - 1;
    }

    return `${columnName}${rowIndex}`;
  }

  /**
   * Search for people by name (case-insensitive, partial matching)
   */
  async searchPeople(query: string, sheetId?: string, worksheetName?: string): Promise<SheetsPerson[]> {
    const data = await this.getCachedSheetsData(sheetId, worksheetName);
    const normalizedQuery = query.toLowerCase();

    return data.people.filter(person =>
      person.nama.toLowerCase().includes(normalizedQuery)
    );
  }

  /**
   * Get person by exact name match
   */
  async getPersonByName(name: string, sheetId?: string, worksheetName?: string): Promise<SheetsPerson | null> {
    const data = await this.getCachedSheetsData(sheetId, worksheetName);

    return data.people.find(person =>
      person.nama.toLowerCase() === name.toLowerCase()
    ) || null;
  }

  /**
   * Validate data integrity
   */
  async validateData(sheetId?: string, worksheetName?: string): Promise<{
    total: number;
    withEmail: number;
    withoutEmail: number;
    duplicateNames: string[];
    invalidEmails: string[];
  }> {
    const data = await this.getCachedSheetsData(sheetId, worksheetName);

    const nameCount = new Map<string, number>();
    const invalidEmails = [];
    let withEmail = 0;

    for (const person of data.people) {
      // Count name occurrences
      const normalizedName = person.nama.toLowerCase();
      nameCount.set(normalizedName, (nameCount.get(normalizedName) || 0) + 1);

      // Validate email
      if (person.email) {
        withEmail++;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(person.email)) {
          invalidEmails.push(person.email);
        }
      }
    }

    const duplicateNames = Array.from(nameCount.entries())
      .filter(([_, count]) => count > 1)
      .map(([name, _]) => name);

    return {
      total: data.people.length,
      withEmail,
      withoutEmail: data.people.length - withEmail,
      duplicateNames,
      invalidEmails,
    };
  }
}