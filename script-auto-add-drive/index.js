#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const inquirer = require('inquirer');
const chalk = require('chalk');
// const figlet = require('figlet');
const ora = require('ora');
const cliProgress = require('cli-progress');
const Conf = require('conf');
const os = require('os');

// Configuration storage  
const config = new Conf({
  projectName: 'certificate-sharing',
  defaults: {
    sheetId: '',
    sheetName: 'participants_sample',
    parentFolderId: '',
    role: 'reader',
    dryRun: false,
    throttleMs: 2500,
    maxPerRun: 300
  }
});

class CertificateSharing {
  constructor() {
    this.auth = null;
    this.drive = null;
    this.sheets = null;
    this.progressBar = null;
    this.lastApiCallAt = 0;
    this.debugEnabled = process.env.DEBUG === 'true' || process.env.DEBUG_SHARE === 'true';
    this.logStream = null;
    this.logFilePath = null;
    // Sharding config (untuk multi-worker aman tanpa overlap)
    this.shardTotal = Number(process.env.SHARD_TOTAL || 0) || 0;
    this.shardIndex = Number(process.env.SHARD_INDEX || 0) || 0;
    // Simple folder mapping (name -> id)
    this.folderMapping = null;
    this.mappingLoaded = false;
  }

  // Initialize local file logger
  async initLogger() {
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const ts = new Date();
      const pad = n => String(n).padStart(2, '0');
      const fname = `share-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.log`;
      this.logFilePath = path.join(logsDir, fname);
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.writeLog(`Session start: ${ts.toISOString()}`);
    } catch (e) {
      console.log(chalk.yellow(`⚠️  Cannot initialize logger: ${e.message}`));
    }
  }

  // Write a line to log file with timestamp
  writeLog(message, level = 'info') {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] ${message}\n`;
    try {
      if (this.logStream) this.logStream.write(line);
    } catch (_) {}
  }

  // Utility: sleep with optional jitter
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Utility: simple stable hash (djb2)
  hashKey(str) {
    const s = (str || '').toString();
    let hash = 5381;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) + s.charCodeAt(i);
      hash = hash | 0; // force 32-bit
    }
    // Convert to unsigned 32-bit
    return hash >>> 0;
  }

  // Sleep with countdown display
  async sleepWithCountdown(totalSeconds) {
    const startTime = Date.now();
    let remaining = totalSeconds;
    
    while (remaining > 0) {
      // Clear current line and show countdown
      process.stdout.write(`\r⏱️  Next check in: ${remaining}s... (Ctrl+C to stop)`);
      
      await this.sleep(1000);
      remaining = totalSeconds - Math.floor((Date.now() - startTime) / 1000);
    }
    
    // Clear countdown line
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
  }

  // Utility: throttle Drive API calls to avoid rate limits
  async throttle() {
    const minDelay = Number(config.get('throttleMs')) || 2500;
    const now = Date.now();
    const elapsed = now - (this.lastApiCallAt || 0);
    if (elapsed < minDelay) {
      const jitter = Math.floor(Math.random() * 400); // 0-400ms
      await this.sleep(minDelay - elapsed + jitter);
    }
    this.lastApiCallAt = Date.now();
  }

  // Detect retryable rate-limit errors
  isRetryableRateLimit(error) {
    const status = error?.response?.status || error?.code;
    const reason = error?.response?.data?.error?.errors?.[0]?.reason || error?.errors?.[0]?.reason || '';
    if (status === 429) return true;
    if (status === 403) {
      const r = String(reason);
      return (
        r.includes('rateLimitExceeded') ||
        r.includes('userRateLimitExceeded') ||
        r.includes('sharingRateLimitExceeded')
      );
    }
    return false;
  }

  // Extract structured error details for logging/debugging
  extractErrorDetails(error) {
    const status = error?.response?.status || error?.code || null;
    const dataErr = error?.response?.data?.error;
    const reasons = Array.isArray(dataErr?.errors) ? dataErr.errors.map(e => e.reason).filter(Boolean) : [];
    const message = dataErr?.message || error?.message || String(error);
    const domain = Array.isArray(dataErr?.errors) ? dataErr.errors.map(e => e.domain).filter(Boolean).join(',') : null;
    return { status, reasons, message, domain };
  }

  // Format concise error summary string
  formatErrorSummary(error) {
    const { status, reasons, message } = this.extractErrorDetails(error);
    const reasonStr = reasons && reasons.length ? reasons.join('|') : 'unknown';
    return `[HTTP ${status ?? 'n/a'}] ${reasonStr} - ${message}`;
  }

  // Optional debug logger
  dlog(...args) {
    if (this.debugEnabled) {
      const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      console.log(chalk.gray('[DEBUG]'), msg);
      this.writeLog(msg, 'debug');
    }
  }

  // Load simple folder mapping
  loadFolderMapping() {
    if (this.mappingLoaded && this.folderMapping) return true;
    
    try {
      const mappingPath = path.join(process.cwd(), 'cache', 'folder-mapping.json');
      
      if (!fs.existsSync(mappingPath)) {
        console.log(chalk.yellow('⚠️  Folder mapping not found. Run "node map-folders.js" first (optional)'));
        this.writeLog('Folder mapping not found - will use API search fallback');
        return false;
      }
      
      const mappingData = fs.readFileSync(mappingPath, 'utf8');
      this.folderMapping = JSON.parse(mappingData);
      this.mappingLoaded = true;
      
      const folderCount = Object.keys(this.folderMapping).length / 2; // Divided by 2 (original + lowercase)
      
      console.log(chalk.green(`✅ Loaded folder mapping: ${folderCount} folders`));
      this.writeLog(`Loaded folder mapping: ${folderCount} folders`);
      
      return true;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Error loading folder mapping: ${error.message}`));
      this.writeLog(`Error loading folder mapping: ${error.message}`, 'warn');
      return false;
    }
  }

  // Wrap error with operation context for richer logs
  wrapError(op, ctx, error) {
    try {
      error.__op = op;
      error.__ctx = ctx;
      return error;
    } catch (_) {
      const e = new Error(`${op} failed: ${error?.message || error}`);
      e.original = error;
      e.__op = op;
      e.__ctx = ctx;
      return e;
    }
  }

  // Print beautiful header
  printHeader() {
    console.clear();
    console.log(chalk.cyan.bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║                 CERTIFICATE SHARING TOOL                ║'));
    console.log(chalk.cyan.bold('║              Script Otomatis Berbagi Sertifikat         ║'));
    console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════════╝'));
    console.log();
  }

  // Setup Google authentication  
  async setupAuth() {
    const spinner = ora('🔐 Initializing Google services...').start();
    
    try {
      if (!this.logStream) await this.initLogger();
      this.writeLog('Initializing Google services...');
      // Check if service account file exists - look in current directory first
      let serviceAccountPath = path.join(process.cwd(), 'service.json');

      if (!fs.existsSync(serviceAccountPath)) {
        // If running as packaged binary, try alongside executable
        const execDir = path.dirname(process.execPath);
        serviceAccountPath = path.join(execDir, 'service.json');
      }
      
      if (!fs.existsSync(serviceAccountPath)) {
        spinner.fail();
        console.log(chalk.red('❌ File service.json tidak ditemukan!'));
        console.log(chalk.yellow(`   Dicari di: ${process.cwd()} dan ${path.dirname(process.execPath)}`));
        process.exit(1);
      }

      // Load service account
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      
      // Create JWT auth
      this.auth = new google.auth.JWT(
        serviceAccount.client_email,
        null,
        serviceAccount.private_key,
        [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/spreadsheets'
        ]
      );

      // Initialize services
      this.drive = google.drive({ version: 'v3', auth: this.auth });
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });

      spinner.succeed(`🔐 Service Account: ${chalk.green(serviceAccount.client_email)}`);
      this.writeLog(`Service Account: ${serviceAccount.client_email}`);
      
      // Try to load folder mapping for faster search
      this.loadFolderMapping();
      
      return true;
    } catch (error) {
      spinner.fail();
      console.log(chalk.red(`❌ Auth Error: ${error.message}`));
      this.writeLog(`Auth Error: ${error.message}`, 'error');
      return false;
    }
  }

  // Interactive configuration setup
  async setupConfig() {
    console.log(chalk.blue('🔧 KONFIGURASI'));
    console.log(chalk.gray('─'.repeat(40)));

    // ENV shortcut to skip prompts (non-interactive runs)
    const envSheetId = process.env.SHEET_ID;
    const envSheetName = process.env.SHEET_NAME;
    const envParentFolderId = process.env.PARENT_FOLDER_ID;
    const envDryRun = process.env.DRY_RUN;
    if (envSheetId && envSheetName) {
      config.set('sheetId', envSheetId);
      config.set('sheetName', envSheetName);
      config.set('parentFolderId', envParentFolderId || '');
      config.set('role', 'reader');
      if (typeof envDryRun === 'string') {
        config.set('dryRun', envDryRun === 'true');
      }
      console.log(chalk.green('✅ Konfigurasi dari ENV diterapkan.'));
      console.log(`   📊 Sheet ID: ${chalk.cyan(config.get('sheetId'))}`);
      console.log(`   📄 Sheet Name: ${chalk.cyan(config.get('sheetName'))}`);
      console.log(`   📁 Folder ID: ${chalk.cyan(config.get('parentFolderId') || '(semua folder)')}`);
      this.writeLog(`Config: sheetId=${config.get('sheetId')}, sheetName=${config.get('sheetName')}, parentFolderId=${config.get('parentFolderId')}`);
      return true;
    }

    // Check if config exists
    const hasConfig = config.get('sheetId') && config.get('sheetId') !== '';
    
    if (hasConfig) {
      console.log(chalk.green('✅ Konfigurasi ditemukan:'));
      console.log(`   📊 Sheet ID: ${chalk.cyan(config.get('sheetId'))}`);
      console.log(`   📄 Sheet Name: ${chalk.cyan(config.get('sheetName'))}`);
      console.log(`   📁 Folder ID: ${chalk.cyan(config.get('parentFolderId') || '(semua folder)')}`);
      console.log(`   🔗 Role: ${chalk.cyan('reader')}`);
      console.log();

      const nonInteractive = process.env.NON_INTERACTIVE === 'true' || process.env.LOOP === 'true' || !process.stdout.isTTY;
      if (nonInteractive) {
        return true; // gunakan konfigurasi yang ada tanpa prompt
      }

      const { useExisting } = await inquirer.prompt([{
        type: 'confirm',
        name: 'useExisting',
        message: '🔄 Gunakan konfigurasi yang ada?',
        default: true
      }]);

      if (useExisting) return true;
    }

    // New configuration
    console.log(chalk.yellow('🆕 Setup konfigurasi baru...'));
    console.log();

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'sheetId',
        message: '📊 Google Sheets ID:',
        default: config.get('sheetId'),
        validate: input => input.length > 0 || 'Sheet ID wajib diisi!'
      },
      {
        type: 'input',
        name: 'sheetName',
        message: '📄 Nama worksheet:',
        default: config.get('sheetName')
      },
      {
        type: 'input',
        name: 'parentFolderId',
        message: '📁 Parent Folder ID (optional):',
        default: config.get('parentFolderId')
      }
    ]);

    // Save configuration
    config.set('sheetId', answers.sheetId);
    config.set('sheetName', answers.sheetName);
    config.set('parentFolderId', answers.parentFolderId || '');
    config.set('role', 'reader');
    // fixed behaviors: notifications off, throttle & batching from defaults

    console.log();
    console.log(chalk.green('✅ Konfigurasi disimpan!'));
    this.writeLog(`Config saved: sheetId=${answers.sheetId}, sheetName=${answers.sheetName}, parentFolderId=${answers.parentFolderId || ''}`);
    return true;
  }

  // Get spreadsheet data
  async getSpreadsheetData() {
    const spinner = ora('📊 Membaca Google Sheets...').start();
    
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: config.get('sheetId'),
        range: `${config.get('sheetName')}!A:F`
      });

      const values = response.data.values;
      if (!values || values.length === 0) {
        spinner.fail();
        console.log(chalk.red('❌ Sheet kosong atau tidak ditemukan!'));
        return null;
      }

      const headers = values[0];
      const requiredHeaders = ['Nama', 'Email', 'isShared', 'isFolderExists', 'LastLog'];
      
      // Check required headers
      for (const header of requiredHeaders) {
        if (!headers.includes(header)) {
          spinner.fail();
          console.log(chalk.red(`❌ Kolom "${header}" tidak ditemukan!`));
          console.log(chalk.yellow(`   Headers yang ada: ${headers.join(', ')}`));
          return null;
        }
      }

      const participants = values.slice(1).map((row, index) => ({
        rowIndex: index + 2, // +2 because we skip header and 0-based to 1-based
        nama: row[headers.indexOf('Nama')] || '',
        email: row[headers.indexOf('Email')] || '',
        folderId: row[headers.indexOf('FolderId')] || '',
        isShared: row[headers.indexOf('isShared')] || '',
        isFolderExists: row[headers.indexOf('isFolderExists')] || '',
        lastLog: row[headers.indexOf('LastLog')] || ''
      }));

      spinner.succeed(`📊 Found ${chalk.green(participants.length)} participants`);
      return { participants, headers };
    } catch (error) {
      spinner.fail();
      console.log(chalk.red(`❌ Sheets Error: ${error.message}`));
      return null;
    }
  }

  // Get spreadsheet data (flexible mapping + auto-add columns)
  async getSpreadsheetDataFlexible() {
    const spinner = ora('📊 Membaca Google Sheets...').start();
    try {
      const sheetId = config.get('sheetId');
      const sheetName = config.get('sheetName');
      this.writeLog(`Reading sheet: ${sheetId} / ${sheetName}`);

      // Read header row
      const headerRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${sheetName}!1:1`
      });
      const headers = (headerRes.data.values && headerRes.data.values[0]) || [];
      if (headers.length === 0) {
        spinner.fail();
        console.log(chalk.red('❌ Sheet kosong atau header tidak ditemukan!'));
        this.writeLog('Sheet empty or missing headers', 'error');
        return null;
      }

      const lower = headers.map(h => (h || '').toString().trim().toLowerCase());
      const findIndexByNames = (candidates) => {
        for (const name of candidates) {
          const idx = lower.indexOf(name);
          if (idx !== -1) return idx;
        }
        return -1;
      };

      // Detect name/email columns
      const nameCandidates = ['nama peserta','nama','nama lengkap','name','full name','participant name'];
      const emailCandidates = ['email address','email','e-mail','gmail','participant email'];
      const nameCol = findIndexByNames(nameCandidates);
      const emailCol = findIndexByNames(emailCandidates);
      if (nameCol === -1 || emailCol === -1) {
        spinner.fail();
        console.log(chalk.red('❌ Kolom Nama/Email tidak ditemukan!'));
        console.log(chalk.yellow(`   Headers yang ada: ${headers.join(', ')}`));
        this.writeLog(`Missing name/email columns. Headers: ${headers.join(', ')}`, 'error');
        return null;
      }

      // Helper: index -> A1 column letter
      const toCol = (index) => {
        let s = '';
        let n = index + 1;
        while (n > 0) {
          const rem = (n - 1) % 26;
          s = String.fromCharCode(65 + rem) + s;
          n = Math.floor((n - 1) / 26);
        }
        return s;
      };

      // Ensure required columns appended if missing
      const extras = ['FolderId','isShared','isFolderExists','LastLog'];
      const missing = extras.filter(h => !headers.includes(h));
      if (missing.length > 0) {
        const startCol = toCol(headers.length);
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `${sheetName}!${startCol}1`,
          valueInputOption: 'RAW',
          resource: { values: [missing] }
        });
        this.writeLog(`Added missing columns: ${missing.join(', ')}`);
        headers.push(...missing);
      }

      const folderIdCol = headers.indexOf('FolderId');
      const isSharedCol = headers.indexOf('isShared');
      const isFolderExistsCol = headers.indexOf('isFolderExists');
      const lastLogCol = headers.indexOf('LastLog');

      // Read data rows widely
      const valuesRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${sheetName}!A:ZZ`
      });
      const values = valuesRes.data.values || [];
      if (values.length <= 1) {
        spinner.fail();
        console.log(chalk.red('❌ Tidak ada data peserta (hanya header).'));
        this.writeLog('No participant rows (only header)', 'error');
        return null;
      }

      const participants = values.slice(1).map((row, index) => ({
        rowIndex: index + 2,
        nama: (row[nameCol] || '').toString(),
        email: (row[emailCol] || '').toString(),
        folderId: (row[folderIdCol] || '').toString(),
        isShared: (row[isSharedCol] || '').toString(),
        isFolderExists: (row[isFolderExistsCol] || '').toString(),
        lastLog: (row[lastLogCol] || '').toString()
      }));

      spinner.succeed(`📊 Found ${chalk.green(participants.length)} participants`);
      this.writeLog(`Participants: ${participants.length}`);
      return { participants, headers, columns: { nameCol, emailCol, folderIdCol, isSharedCol, isFolderExistsCol, lastLogCol, toCol } };
    } catch (error) {
      spinner.fail();
      console.log(chalk.red(`❌ Sheets Error: ${error.message}`));
      this.writeLog(`Sheets Error: ${error.message}`, 'error');
      return null;
    }
  }

  // Find folder by name using simple mapping or API fallback
  async findFolderByName(name, parentFolderId = null) {
    const startTime = Date.now();
    const targetName = (name || '').toString();
    if (!targetName) return null;

    // Try simple mapping lookup first
    if (this.folderMapping) {
      // Try exact match
      let folderId = this.folderMapping[targetName];
      
      // Try lowercase match
      if (!folderId) {
        folderId = this.folderMapping[targetName.toLowerCase()];
      }
      
      // Try variations
      if (!folderId) {
        const variations = this._createSearchVariations(targetName);
        for (const variation of variations) {
          folderId = this.folderMapping[variation] || this.folderMapping[variation.toLowerCase()];
          if (folderId) break;
        }
      }
      
      const elapsed = Date.now() - startTime;
      
      if (folderId) {
        console.log(chalk.gray(`✅ Found folder (mapped): "${targetName}" (${elapsed}ms)`));
        this.writeLog(`Found folder (mapped): "${targetName}" (${elapsed}ms)`);
        return folderId;
      } else {
        console.log(chalk.gray(`❌ Folder not found in mapping: "${targetName}"`));
        this.writeLog(`Folder not found in mapping: "${targetName}"`);
      }
    }

    // Fallback to API search
    console.log(chalk.gray(`🔍 Falling back to API search for: "${targetName}"`));
    return await this._findFolderByNameFallback(name, parentFolderId);
  }

  // Create search variations for better matching
  _createSearchVariations(name) {
    const variations = new Set();
    
    // Original name
    variations.add(name);
    variations.add(name.toLowerCase());
    variations.add(name.toUpperCase());
    
    // Remove extra spaces and normalize
    const normalized = name.replace(/\s+/g, ' ').trim();
    variations.add(normalized);
    variations.add(normalized.toLowerCase());
    
    // Remove common prefixes/suffixes
    const withoutPrefixes = name.replace(/\b(muhammad|moh|drs|dr|prof|hj|h)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (withoutPrefixes && withoutPrefixes !== name) {
      variations.add(withoutPrefixes);
      variations.add(withoutPrefixes.toLowerCase());
    }
    
    // Remove dots and special characters
    const withoutSpecialChars = name.replace(/[\.,-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (withoutSpecialChars && withoutSpecialChars !== name) {
      variations.add(withoutSpecialChars);
      variations.add(withoutSpecialChars.toLowerCase());
    }
    
    return Array.from(variations).filter(v => v.length > 0);
  }


  // Fallback folder search (old implementation)
  async _findFolderByNameFallback(name, parentFolderId = null) {
    const startTime = Date.now();
    
    // Timeout for fallback method
    const timeoutMs = 30000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Folder search took too long (${timeoutMs/1000}s) for "${name}"`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        this._findFolderByNameInternal(name, parentFolderId),
        timeoutPromise
      ]);
      const elapsed = Date.now() - startTime;
      if (result) {
        console.log(chalk.gray(`✅ Found folder (fallback): "${name}" (${elapsed}ms)`));
      } else {
        console.log(chalk.gray(`❌ Folder not found (fallback): "${name}" (${elapsed}ms)`));
      }
      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.dlog(`Folder search timeout: ${name} - ${error.message} (${elapsed}ms)`);
      return null;
    }
  }

  // Internal folder search implementation (original BFS method)
  async _findFolderByNameInternal(name, parentFolderId = null) {
    // Search depth = 3 for comprehensive folder search: Parent -> Kabupaten -> Peserta (or deeper nesting)
    const targetName = (name || '').toString();
    const targetLower = targetName.toLowerCase();
    if (!targetName) return null;

    // If no parent specified, fall back to global search by name
    if (!parentFolderId) {
      try {
        // Enhanced case-insensitive search with fuzzy matching
        const searchVariations = [
          targetName, // exact
          targetName.toLowerCase(),
          targetName.toUpperCase(),
          // Remove extra spaces and normalize
          targetName.replace(/\s+/g, ' ').trim(),
          // Try without common prefixes/suffixes
          targetName.replace(/\b(muhammad|moh|drs|dr|prof)\b/gi, '').trim(),
        ].filter(v => v.length > 0);
        
        for (const searchTerm of searchVariations) {
          try {
            let query = `mimeType='application/vnd.google-apps.folder' and name contains '${searchTerm.replace(/'/g, "\\'")}' and trashed=false`;
            let attempt = 0;
            const maxAttempts = 3; // Reduced attempts per variation
            
            while (attempt < maxAttempts) {
              try {
                await this.throttle();
                const response = await this.drive.files.list({
                  q: query,
                  spaces: 'drive',
                  fields: 'files(id,name,parents)',
                  includeItemsFromAllDrives: true,
                  supportsAllDrives: true,
                  pageSize: 20
                });
                
                // Try exact match first, then fuzzy match
                const files = response.data.files || [];
                let match = files.find(f => (f.name || '').toLowerCase() === targetLower);
                if (!match) {
                  // Fuzzy match: check if target is contained in folder name
                  match = files.find(f => {
                    const folderName = (f.name || '').toLowerCase();
                    return folderName.includes(targetLower) || targetLower.includes(folderName);
                  });
                }
                
                if (match) {
                  console.log(chalk.gray(`✅ Found folder: "${targetName}" -> "${match.name}" (ID: ${match.id})`));
                  return match.id;
                }
                break; // No match found with this variation, try next
              } catch (err) {
                this.dlog('files.list(global) error:', this.formatErrorSummary(err));
                attempt++;
                if (this.isRetryableRateLimit(err) && attempt < maxAttempts) {
                  const base = Math.min(30000, Math.pow(2, attempt) * 1000); // Reduced wait time
                  const jitter = Math.floor(Math.random() * 500);
                  await this.sleep(base + jitter);
                  continue;
                }
                break; // Try next variation
              }
            }
          } catch (err) {
            continue; // Try next variation
          }
        }
        return null;
      } catch {
        return null;
      }
    }

    // BFS up to depth 3 starting from parentFolderId (comprehensive search: Parent -> Kabupaten -> Peserta or deeper)
    const maxDepth = 3;
    const queue = [{ id: parentFolderId, depth: 0 }];

    const listSubfolders = async (parentId) => {
      let all = [];
      let pageToken = undefined;
      do {
        await this.throttle();
        const res = await this.drive.files.list({
          q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          spaces: 'drive',
          fields: 'nextPageToken, files(id,name,parents)',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          pageSize: 100,
          pageToken
        });
        all = all.concat(res.data.files || []);
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);
      return all;
    };

    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      if (current.depth > maxDepth) continue;
      try {
        const children = await listSubfolders(current.id);
        // Check match on this level (case-insensitive)
        const hit = children.find(f => (f.name || '').toLowerCase() === targetLower);
        if (hit) return hit.id;
        // Enqueue next level
        if (current.depth < maxDepth) {
          for (const c of children) {
            queue.push({ id: c.id, depth: current.depth + 1 });
          }
        }
      } catch (err) {
        if (this.isRetryableRateLimit(err)) {
          // Soft wait and continue
          await this.sleep(1000);
          queue.push({ id: current.id, depth: current.depth });
          continue;
        }
        this.dlog('files.list(children) error:', this.formatErrorSummary(err));
        // Non-retryable: skip this branch
      }
    }
    return null;
  }

  // Check if user has permission
  async hasPermission(fileId, email, role) {
    try {
      let attempt = 0;
      const maxAttempts = 5;
      while (true) {
        try {
          await this.throttle();
          const response = await this.drive.permissions.list({
            fileId: fileId,
            fields: 'permissions(emailAddress,role)',
            supportsAllDrives: true
          });
          const permissions = response.data.permissions || [];
          return permissions.some(p => 
            p.emailAddress && p.emailAddress.toLowerCase() === email.toLowerCase() && p.role === role
          );
        } catch (err) {
          this.dlog('permissions.list error:', this.formatErrorSummary(err));
          attempt++;
          if (this.isRetryableRateLimit(err) && attempt < maxAttempts) {
            const base = Math.min(60000, Math.pow(2, attempt) * 1000);
            const jitter = Math.floor(Math.random() * 500);
            await this.sleep(base + jitter);
            continue;
          }
          throw this.wrapError('drive.permissions.list', { fileId, email, role }, err);
        }
      }
    } catch (error) {
      return false;
    }
  }

  // Grant permission
  async grantPermission(fileId, email) {
    const role = 'reader';
    const dryRun = config.get('dryRun');

    if (dryRun) {
      return { status: 'DRY_RUN' };
    }

    let attempt = 0;
    const maxAttempts = 6;
    const capMs = 60000; // 60s
    while (true) {
      try {
        await this.throttle();
        const response = await this.drive.permissions.create({
          fileId: fileId,
          sendNotificationEmail: false,
          supportsAllDrives: true,
          resource: {
            type: 'user',
            role: role,
            emailAddress: email
          }
        });
        return response.data;
      } catch (error) {
        this.dlog('permissions.create error:', this.formatErrorSummary(error));
        attempt++;
        if (this.isRetryableRateLimit(error) && attempt < maxAttempts) {
          const base = Math.min(capMs, Math.pow(2, attempt) * 1000);
          const jitter = Math.floor(Math.random() * 500);
          await this.sleep(base + jitter);
          continue;
        }
        throw this.wrapError('drive.permissions.create', { fileId, email, role }, error);
      }
    }
  }

  // Update cell in spreadsheet
  async updateCell(row, col, value) {
    try {
      const range = `${config.get('sheetName')}!${col}${row}`;
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: config.get('sheetId'),
        range: range,
        valueInputOption: 'RAW',
        resource: {
          values: [[value]]
        }
      });
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Warning: Could not update cell ${col}${row}`));
    }
  }

  // Safe updater by column index mapping (prevents overwriting wrong columns)
  async updateCellByIndex(columns, colIndex, row, value, label = 'unknown') {
    if (typeof colIndex === 'number' && colIndex >= 0) {
      const col = columns.toCol(colIndex);
      return this.updateCell(row, col, value);
    } else {
      this.writeLog(`Skip update: missing column '${label}'`, 'error');
      return;
    }
  }

  // Get current timestamp
  getCurrentTimestamp() {
    return new Date().toLocaleString('id-ID', { 
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  // Process participants
  async processParticipants(data) {
    const { participants, headers, columns } = data;
    const parentFolderId = config.get('parentFolderId');
    const role = 'reader';
    const dryRun = config.get('dryRun');
    const throttleMs = Number(config.get('throttleMs')) || 2500;
    const envMax = process.env.MAX_PER_RUN ? Number(process.env.MAX_PER_RUN) : undefined;
    const maxPerRun = (Number.isFinite(envMax) && envMax > 0) ? envMax : (Number(config.get('maxPerRun')) || 300);

    console.log();
    console.log(chalk.blue('🔄 MEMPROSES PESERTA'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(chalk.cyan(`📁 Parent Folder: ${parentFolderId || 'All folders'}`));
    console.log(chalk.cyan(`🔗 Role: ${role}`));
    console.log(chalk.cyan(`🎯 Mode: ${dryRun ? 'Simulasi' : 'Production'}`));
    if (this.shardTotal > 0) {
      console.log(chalk.cyan(`🧩 Shard: ${this.shardIndex + 1}/${this.shardTotal}`));
    }
    console.log();

    if (dryRun) {
      console.log(chalk.yellow('🧪 MODE SIMULASI - Tidak ada perubahan aktual'));
    } else {
      // Production mode: always proceed without prompt
      console.log(chalk.yellow('🚀 PRODUCTION MODE: berjalan otomatis tanpa konfirmasi.'));
    }

    // Progress bar
    this.progressBar = new cliProgress.SingleBar({
      format: chalk.cyan('Progress') + ' |{bar}| {percentage}% | {value}/{total} | {status}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    });

    let stats = { total: 0, done: 0, skipped: 0, errors: 0 };
    // Normalize and prepare list
    let normalized = participants.map(p => ({
      ...p,
      nama: (p.nama || '').toString().trim(),
      email: (p.email || '').toString().trim().toLowerCase()
    })).filter(p => p.nama && p.email);

    // Hanya proses yang belum pernah diproses sama sekali (isShared kosong/undefined)
    // Skip yang isShared = 'TRUE' (sudah berhasil) dan isShared = 'FALSE' (sudah diproses tapi gagal)
    normalized = normalized.filter(p => {
      const isSharedValue = String(p.isShared || '').toLowerCase();
      return isSharedValue !== 'true' && isSharedValue !== 'false';
    });

    // Terapkan sharding (hindari overlap folder/permission antar worker)
    if (this.shardTotal > 0) {
      const before = normalized.length;
      normalized = normalized.filter(p => {
        // Kunci shard: utamakan FolderId (case-sensitive), fallback Nama (lowercase)
        const key = p.folderId ? String(p.folderId) : String(p.nama).toLowerCase();
        const h = this.hashKey(key);
        return (h % this.shardTotal) === this.shardIndex;
      });
      this.writeLog(`Sharding applied: ${normalized.length}/${before} records for shard ${this.shardIndex}/${this.shardTotal - 1}`);
    }

    // Prioritize participants: process easy ones first, problematic ones later
    // 1. Those who already have folderId (fastest)
    // 2. Those who need folder search but isFolderExists is not 'FALSE' 
    // 3. Those with isFolderExists = 'FALSE' (slowest/problematic - previously failed)
    
    const withFolderId = normalized.filter(p => p.folderId);
    const needsSearch = normalized.filter(p => !p.folderId && String(p.isFolderExists || '').toLowerCase() !== 'false');
    const problematic = normalized.filter(p => !p.folderId && String(p.isFolderExists || '').toLowerCase() === 'false');
    
    // Combine in priority order
    const prioritized = [...withFolderId, ...needsSearch, ...problematic];
    
    // Apply batch limit
    const workingParticipants = prioritized.slice(0, maxPerRun);
    
    console.log(chalk.blue(`📋 Processing prioritization:
   ✅ With Folder ID: ${withFolderId.length}
   🔍 Needs Search: ${needsSearch.length} 
   ⚠️  Problematic: ${problematic.length}
   🎯 Selected: ${workingParticipants.length}`));

    this.progressBar.start(workingParticipants.length, 0, { status: 'Starting...' });
    this.writeLog(`Processing ${workingParticipants.length} participants. parentFolderId=${parentFolderId}`);

    const seen = new Set();
    for (const [index, participant] of workingParticipants.entries()) {
      const { rowIndex, nama, email } = participant;
      
      // Start timing for this participant
      const participantStartTime = Date.now();
      let folderSearchTime = 0; // Initialize here for access in catch block
      // Update progress bar with real-time stats
      const progressStatus = `[${index + 1}/${workingParticipants.length}] ${nama} | ✅${stats.done} ❌${stats.errors} ⏭️${stats.skipped}`;
      this.progressBar.update(index, { status: progressStatus });
      stats.total++;

      try {
        // Enhanced email validation - must be Gmail and proper format
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        const isValidEmail = emailRegex.test(email);
        const isGmail = email.toLowerCase().endsWith('@gmail.com');
        
        if (!isValidEmail || !isGmail) {
          stats.skipped++;
          const totalTime = Date.now() - participantStartTime;
          const reason = !isValidEmail ? 'INVALID EMAIL FORMAT' : 'NOT GMAIL ACCOUNT';
          
          // Skip notification for email validation
          console.log(chalk.yellow(`
⏭️  SKIPPED: ${chalk.bold(nama)} - ${reason}
   📧 Email: ${email}
   💡 Penjelasan: ${reason === 'INVALID EMAIL FORMAT' ? 'Format email tidak valid' : 'Hanya email Gmail yang didukung'}
   ⏱️  Waktu: ${totalTime}ms
   📊 Progress: ✅ ${stats.done} berhasil | ❌ ${stats.errors} gagal | ⏭️ ${stats.skipped} dilewati
`));
          
          await this.updateCellByIndex(columns, columns.isSharedCol, rowIndex, 'FALSE', 'isShared');
          await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, `[${this.getCurrentTimestamp()}] SKIP: ${reason} '${email}' (${totalTime}ms)`, 'LastLog');
          this.writeLog(`Row ${rowIndex} SKIP ${reason}: ${email} - Time: ${totalTime}ms`);
          continue;
        }

        // Deduplicate by (name+email)
        const key = `${nama.toLowerCase()}|${email}`;
        if (seen.has(key)) {
          stats.skipped++;
          const totalTime = Date.now() - participantStartTime;
          
          // Duplicate notification
          console.log(chalk.yellow(`
⏭️  SKIPPED: ${chalk.bold(nama)} - DUPLICATE ENTRY
   📧 Email: ${email}
   💡 Penjelasan: Peserta sudah diproses dalam batch ini
   ⏱️  Waktu: ${totalTime}ms
   📊 Progress: ✅ ${stats.done} berhasil | ❌ ${stats.errors} gagal | ⏭️ ${stats.skipped} dilewati
`));
          
          await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, `[${this.getCurrentTimestamp()}] SKIP: Duplicate entry (${totalTime}ms)`, 'LastLog');
          this.writeLog(`Row ${rowIndex} SKIP duplicate: ${nama}|${email} - Time: ${totalTime}ms`);
          continue;
        }
        seen.add(key);

        // Skip if already shared
        if (participant.isShared && participant.isShared.toLowerCase() === 'true') {
          stats.skipped++;
          const totalTime = Date.now() - participantStartTime;
          await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, `[${this.getCurrentTimestamp()}] SKIP: Already shared (${totalTime}ms)`, 'LastLog');
          this.writeLog(`Row ${rowIndex} SKIP already shared - Time: ${totalTime}ms`);
          continue;
        }

        // Find folder - timeout only applies to folder search, not permission operations
        let folderId = participant.folderId;
        if (!folderId) {
          const folderSearchStart = Date.now();
          // Only use timeout for folder search (not for permission operations)
          folderId = await this.findFolderByName(nama, parentFolderId);
          folderSearchTime = Date.now() - folderSearchStart;
        }

        if (!folderId) {
          stats.errors++;
          const totalTime = Date.now() - participantStartTime;
          
          // Folder not found notification
          console.log(chalk.red(`
❌ ERROR: ${chalk.bold(nama)} - FOLDER NOT FOUND
   📧 Email: ${email}
   💡 Penjelasan: Folder dengan nama '${nama}' tidak ditemukan dalam structure Google Drive
   🔍 Search Duration: ${folderSearchTime}ms (${(folderSearchTime/1000).toFixed(1)}s)
   ⏱️  Total Time: ${totalTime}ms
   📁 Search Location: ${parentFolderId || 'Global search'}
   📊 Progress: ✅ ${stats.done} berhasil | ❌ ${stats.errors} gagal | ⏭️ ${stats.skipped} dilewati
`));
          
          await this.updateCellByIndex(columns, columns.isFolderExistsCol, rowIndex, 'FALSE', 'isFolderExists');
          await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, `[${this.getCurrentTimestamp()}] FOLDER NOT FOUND: '${nama}' (${totalTime}ms)`, 'LastLog');
          this.writeLog(`Row ${rowIndex} ERROR folder not found for name='${nama}' - Time: ${totalTime}ms (folder search: ${folderSearchTime}ms)`, 'error');
          continue;
        }

        // Update folder exists
        await this.updateCellByIndex(columns, columns.isFolderExistsCol, rowIndex, 'TRUE', 'isFolderExists');
        if (!participant.folderId) {
          await this.updateCellByIndex(columns, columns.folderIdCol, rowIndex, folderId, 'FolderId');
        }

        // Check existing permission (fast operation, no timeout needed)
        const permissionCheckStart = Date.now();
        const hasPermission = await this.hasPermission(folderId, email, role);
        const permissionCheckTime = Date.now() - permissionCheckStart;
        
        if (hasPermission) {
          stats.skipped++;
          const totalTime = Date.now() - participantStartTime;
          await this.updateCellByIndex(columns, columns.isSharedCol, rowIndex, 'TRUE', 'isShared');
          await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, `[${this.getCurrentTimestamp()}] SKIP: Already has ${role} access (${totalTime}ms)`, 'LastLog');
          
          // Skip notification for already shared
          console.log(chalk.yellow(`
⏭️  SKIPPED: ${chalk.bold(nama)} sudah memiliki akses
   📧 Email: ${email}
   📁 Folder ID: ${folderId}
   🔗 Role: ${role} (sudah ada)
   ⏱️  Waktu: ${totalTime}ms (folder: ${folderSearchTime}ms, permission: ${permissionCheckTime}ms)
   📊 Progress: ✅ ${stats.done} berhasil | ❌ ${stats.errors} gagal | ⏭️ ${stats.skipped} dilewati
`));
          
          this.writeLog(`Row ${rowIndex} SKIP already has ${role} - Time: ${totalTime}ms (folder: ${folderSearchTime}ms, permission: ${permissionCheckTime}ms)`);
          
          // Update isShared to TRUE since they already have access (should be marked as completed)
          await this.updateCellByIndex(columns, columns.isSharedCol, rowIndex, 'TRUE', 'isShared');
          continue;
        }

        // Grant permission (fast operation, no timeout needed)
        const grantPermissionStart = Date.now();
        await this.grantPermission(folderId, email);
        const grantPermissionTime = Date.now() - grantPermissionStart;
        
        stats.done++;
        const totalTime = Date.now() - participantStartTime;
        await this.updateCellByIndex(columns, columns.isSharedCol, rowIndex, 'TRUE', 'isShared');
        const status = dryRun ? 'DRY_RUN' : 'GRANTED';
        await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, `[${this.getCurrentTimestamp()}] ${status} ${role} → ${email} (${totalTime}ms)`, 'LastLog');
        
        // Success notification
        console.log(chalk.green(`
✅ SUCCESS: Berhasil menambahkan akses untuk ${chalk.bold(nama)}
   📧 Email: ${email}
   📁 Folder ID: ${folderId || 'N/A'}
   🔗 Role: ${role}
   ⏱️  Waktu: ${totalTime}ms (folder: ${folderSearchTime}ms, permission: ${permissionCheckTime}ms, grant: ${grantPermissionTime}ms)
   ${dryRun ? '🧪 Mode: DRY RUN (simulasi)' : '🚀 Mode: PRODUCTION'}
   📊 Progress: ✅ ${stats.done} berhasil | ❌ ${stats.errors} gagal | ⏭️ ${stats.skipped} dilewati
`));
        
        this.writeLog(`Row ${rowIndex} ${status} ${role} -> ${email} - Time: ${totalTime}ms (folder: ${folderSearchTime}ms, permission: ${permissionCheckTime}ms, grant: ${grantPermissionTime}ms)`);

        // Optional steady throttle between participants (light jitter)
        const jitter = Math.floor(Math.random() * 200);
        await this.sleep(Math.max(0, Math.floor(throttleMs / 2)) + jitter);

      } catch (error) {
        stats.errors++;
        
        // Calculate total time even for errors
        const totalTime = Date.now() - participantStartTime;
        
        // Extract detailed error information
        const { status, reasons, message, domain } = this.extractErrorDetails(error);
        const ctxInfo = error?.__op ? ` op=${error.__op}` : '';
        const contextData = error?.__ctx ? error.__ctx : {};
        
        // Format user-friendly error message
        let friendlyMessage = '';
        if (status === 403) {
          if (reasons.includes('cannotInviteNonGoogleUser')) {
            friendlyMessage = `Email ${email} tidak memiliki Google Account aktif atau tidak dapat diundang`;
          } else if (reasons.includes('sharingRateLimitExceeded')) {
            friendlyMessage = `Rate limit tercapai untuk sharing, coba lagi nanti`;
          } else if (reasons.includes('permissionDenied')) {
            friendlyMessage = `Tidak ada izin untuk membagikan folder ini`;
          } else {
            friendlyMessage = `Akses ditolak: ${message}`;
          }
        } else if (status === 404) {
          friendlyMessage = `Folder tidak ditemukan atau telah dihapus`;
        } else if (status === 429) {
          friendlyMessage = `Terlalu banyak permintaan, coba lagi nanti`;
        } else {
          friendlyMessage = message || 'Error tidak diketahui';
        }
        
        // Short log line for sheet with timing
        const shortLogLine = `[${this.getCurrentTimestamp()}] ERROR: ${friendlyMessage} (${totalTime}ms)`;
        
        // Detailed console output with timing breakdown
        console.log(chalk.red(`
❌ ERROR processing row ${rowIndex} (${nama}, ${email})
   💡 Penjelasan: ${friendlyMessage}
   🔍 Detail Teknis: HTTP ${status || 'N/A'} - ${reasons.join(', ') || 'unknown'}
   📝 Pesan Asli: ${message}
   🎯 Operasi: ${error?.__op || 'unknown'}${contextData.fileId ? `\n   📁 Folder ID: ${contextData.fileId}` : ''}
   ⏱️  Waktu Total: ${totalTime}ms${folderSearchTime ? ` (folder search: ${folderSearchTime}ms)` : ''}
   📊 Progress: ✅ ${stats.done} berhasil | ❌ ${stats.errors} gagal | ⏭️ ${stats.skipped} dilewati
`));
        
        await this.updateCellByIndex(columns, columns.isSharedCol, rowIndex, 'FALSE', 'isShared');
        await this.updateCellByIndex(columns, columns.lastLogCol, rowIndex, shortLogLine, 'LastLog');
        this.writeLog(`Row ${rowIndex} ERROR: ${friendlyMessage} - Time: ${totalTime}ms${folderSearchTime ? ` (folder: ${folderSearchTime}ms)` : ''} | Technical: HTTP ${status} ${reasons.join(',')} - ${message}`, 'error');
      }
    }

    this.progressBar.update(workingParticipants.length, { status: 'Completed!' });
    this.progressBar.stop();

    // Final summary
    console.log();
    console.log(chalk.green('🎉 RINGKASAN EKSEKUSI'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(`📈 Total: ${chalk.cyan(stats.total)}`);
    console.log(`✅ Berhasil: ${chalk.green(stats.done)}`);
    console.log(`⏭️  Dilewati: ${chalk.yellow(stats.skipped)}`);
    console.log(`❌ Error: ${chalk.red(stats.errors)}`);
    
    const successRate = stats.total > 0 ? (stats.done / stats.total * 100).toFixed(1) : 0;
    console.log(`🎯 Success Rate: ${chalk.green(successRate + '%')}`);
    console.log();
    const summaryLine = `Summary: total=${stats.total} done=${stats.done} skipped=${stats.skipped} errors=${stats.errors} successRate=${successRate}%`;
    this.writeLog(summaryLine);
    if (this.logFilePath) console.log(chalk.gray(`📝 Log file: ${this.logFilePath}`));
    console.log(chalk.blue('✅ Proses selesai! Cek Google Sheet untuk detail lengkap.'));
  }

  // Main application flow
  async run() {
    try {
      this.printHeader();

      // Setup authentication
      if (!(await this.setupAuth())) return;

      // Setup configuration
      if (!(await this.setupConfig())) return;

      const loop = String(process.env.LOOP || '').toLowerCase() === 'true';
      const pollSec = Math.max(5, parseInt(process.env.POLL_INTERVAL || '30', 10) || 30);
      if (!loop) {
        // Single pass
        const data = await this.getSpreadsheetDataFlexible();
        if (!data) return;
        await this.processParticipants(data);
      } else {
        console.log(chalk.cyan(`🔁 Loop mode aktif. Interval: ${pollSec}s`));
        this.writeLog(`Loop mode enabled. Interval=${pollSec}s`);
        while (true) {
          try {
            const data = await this.getSpreadsheetDataFlexible();
            if (data) {
              await this.processParticipants(data);
            }
          } catch (err) {
            console.log(chalk.red(`Loop error: ${err.message}`));
            this.writeLog(`Loop error: ${err.message}`, 'error');
          }
          await this.sleepWithCountdown(pollSec);
        }
      }

    } catch (error) {
      console.log();
      console.log(chalk.red(`❌ Unexpected Error: ${error.message}`));
      process.exit(1);
    }
  }
}

// Run the application
if (require.main === module) {
  const app = new CertificateSharing();
  
  app.run()
    .then(() => {
      console.log();
      console.log(chalk.gray('Press any key to exit...'));
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', () => process.exit(0));
      } else {
        process.exit(0);
      }
    })
    .catch(error => {
      console.log(chalk.red(`Fatal Error: ${error.message}`));
      process.exit(1);
    });
}

module.exports = CertificateSharing;
