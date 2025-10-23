#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
const inquirer = require('inquirer');
const { google } = require('googleapis');
const Conf = require('conf');
const ora = require('ora');

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

// Unified Monitor Filtered: Filter unfinished work in Sheets before running workers
// Only processes participants that haven't been completed yet (isShared != 'YES')

if (!process.env.POLL_INTERVAL) process.env.POLL_INTERVAL = '30';
if (!process.env.LOOP) process.env.LOOP = 'true';

// Simple args parsing
const ARGS = new Set(process.argv.slice(2));
const MODE_TABLE = ARGS.has('--table');
const EXPLICIT_MODE = ARGS.has('--logs') || ARGS.has('--live-logs') || ARGS.has('--stream') || ARGS.has('--table') || ARGS.has('--logs-only') || ARGS.has('--attach');
// Default to logs view unless user explicitly chooses --table or other explicit modes
const MODE_LOGS = MODE_TABLE ? false : (ARGS.has('--logs') || ARGS.has('--live-logs') || !EXPLICIT_MODE);
const MODE_LOGS_ONLY = MODE_LOGS && (ARGS.has('--logs-only') || ARGS.has('--attach'));
const MODE_STREAM_STDOUT = ARGS.has('--stream'); // stream worker stdout/stderr directly

const LOCK_PATH = '/tmp/certificate-sharing-monitor-filtered.lock';

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (pid && !Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.log(chalk.red(`Another filtered monitor is running (pid=${pid}). Exiting.`));
          process.exit(1);
        } catch (_) {
          // stale lock, continue
        }
      }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    const cleanup = () => { try { fs.unlinkSync(LOCK_PATH); } catch (_) {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  } catch (e) {
    console.log(chalk.yellow(`⚠️  Cannot create lock file: ${e.message}`));
  }
}

function findWorkerBinary() {
  try {
    const execDir = path.dirname(process.execPath);
    const execBase = path.basename(process.execPath);
    const candidates = [];
    
    // Try replacing 'monitor' with 'sharing' in current binary name
    if (execBase.toLowerCase().includes('monitor')) {
      candidates.push(path.join(execDir, execBase.replace(/monitor/gi, 'sharing')));
    }
    
    // Common names per platform
    const platform = process.platform;
    const ext = platform === 'win32' ? '.exe' : '';
    candidates.push(
      path.join(execDir, `certificate-sharing${ext}`),
      path.join(execDir, `certificate-sharing-win${ext}`),
      path.join(execDir, `certificate-sharing-mac${ext}`),
      path.join(process.cwd(), `certificate-sharing${ext}`),
      path.join(process.cwd(), `certificate-sharing-win${ext}`),
      path.join(process.cwd(), `certificate-sharing-mac${ext}`),
      path.join(process.cwd(), 'index.js'),
    );

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Authentication
async function authenticate() {
  const spinner = ora('🔐 Authenticating Google API...').start();
  
  try {
    // Try to find service account key
    const serviceKeyPaths = [
      path.join(process.cwd(), 'service.json'),
      path.join(process.cwd(), 'service-account.json'),
      path.join(process.cwd(), 'credentials.json')
    ];
    
    let serviceKeyPath = null;
    for (const keyPath of serviceKeyPaths) {
      if (fs.existsSync(keyPath)) {
        serviceKeyPath = keyPath;
        break;
      }
    }
    
    if (!serviceKeyPath) {
      spinner.fail();
      console.log(chalk.red('❌ Service account key not found!'));
      console.log(chalk.yellow('   Expected files: service.json, service-account.json, or credentials.json'));
      return null;
    }
    
    const serviceAccount = JSON.parse(fs.readFileSync(serviceKeyPath, 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    
    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    
    spinner.succeed('🔐 Authentication successful');
    return { auth: authClient, drive, sheets };
  } catch (error) {
    spinner.fail();
    console.log(chalk.red(`❌ Authentication failed: ${error.message}`));
    return null;
  }
}

// Get unfinished participants from Sheets
async function getUnfinishedParticipants(sheets) {
  const spinner = ora('📊 Filtering unfinished participants from Sheets...').start();
  
  try {
    const sheetId = config.get('sheetId');
    const sheetName = config.get('sheetName');

    // Get header row first
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!1:1`
    });
    const headers = (headerRes.data.values && headerRes.data.values[0]) || [];
    if (headers.length === 0) {
      spinner.fail();
      console.log(chalk.red('❌ Headers kosong!'));
      return null;
    }

    // Helper to find column index by various possible names
    const findIndexByNames = (candidates) => {
      for (const candidate of candidates) {
        const idx = headers.findIndex(h => (h || '').toString().toLowerCase().trim() === candidate.toLowerCase());
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // Detect name/email columns using flexible matching
    const nameCandidates = ['nama peserta','nama','nama lengkap','name','full name','participant name'];
    const emailCandidates = ['email address','email','e-mail','gmail','participant email'];
    const nameCol = findIndexByNames(nameCandidates);
    const emailCol = findIndexByNames(emailCandidates);
    
    if (nameCol === -1 || emailCol === -1) {
      spinner.fail();
      console.log(chalk.red('❌ Kolom Nama/Email tidak ditemukan!'));
      console.log(chalk.yellow(`   Headers yang ada: ${headers.join(', ')}`));
      return null;
    }

    // Add missing columns if they don't exist
    const requiredColumns = ['FolderId', 'isShared', 'isFolderExists', 'LastLog'];
    const missing = requiredColumns.filter(col => !headers.includes(col));
    if (missing.length > 0) {
      // For filtering, we'll just set defaults for missing columns
      console.log(chalk.yellow(`⚠️  Missing columns will use defaults: ${missing.join(', ')}`));
    }

    const folderIdCol = headers.indexOf('FolderId');
    const isSharedCol = headers.indexOf('isShared');
    const isFolderExistsCol = headers.indexOf('isFolderExists');
    const lastLogCol = headers.indexOf('LastLog');

    // Read all data
    const valuesRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:ZZ`
    });
    const values = valuesRes.data.values || [];
    if (values.length <= 1) {
      spinner.fail();
      console.log(chalk.red('❌ Tidak ada data peserta (hanya header).'));
      return null;
    }

    const allParticipants = values.slice(1).map((row, index) => ({
      rowIndex: index + 2,
      nama: (row[nameCol] || '').toString(),
      email: (row[emailCol] || '').toString(),
      folderId: (row[folderIdCol] || '').toString(),
      isShared: (row[isSharedCol] || '').toString(),
      isFolderExists: (row[isFolderExistsCol] || '').toString(),
      lastLog: (row[lastLogCol] || '').toString()
    }));

    // Filter only unfinished participants 
    // Skip yang isShared = 'true' (sudah berhasil) dan isShared = 'false' (sudah diproses tapi gagal)
    // Hanya proses yang kosong/undefined
    const unfinishedParticipants = allParticipants.filter(participant => {
      const isSharedValue = String(participant.isShared || '').toLowerCase();
      return isSharedValue !== 'true' && 
             isSharedValue !== 'false' && 
             participant.email.trim() !== '' &&
             participant.nama.trim() !== '';
    });

    const totalCount = allParticipants.length;
    const unfinishedCount = unfinishedParticipants.length;
    const completedCount = totalCount - unfinishedCount;

    spinner.succeed(`📊 Found ${chalk.green(unfinishedCount)} unfinished of ${chalk.blue(totalCount)} total participants (${chalk.yellow(completedCount)} already completed)`);
    
    return { 
      unfinishedParticipants, 
      totalCount, 
      unfinishedCount, 
      completedCount,
      headers,
      columns: { nameCol, emailCol, folderIdCol, isSharedCol, isFolderExistsCol, lastLogCol }
    };
  } catch (error) {
    spinner.fail();
    console.log(chalk.red(`❌ Sheets Error: ${error.message}`));
    return null;
  }
}

// Write filtered participants to cache file for workers to use
async function writeFilteredCache(unfinishedParticipants) {
  const spinner = ora('💾 Creating filtered cache for workers...').start();
  
  try {
    const cacheDir = path.join(process.cwd(), 'cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    const cacheFile = path.join(cacheDir, 'filtered-participants.json');
    const cacheData = {
      timestamp: new Date().toISOString(),
      count: unfinishedParticipants.length,
      participants: unfinishedParticipants
    };
    
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
    
    spinner.succeed(`💾 Filtered cache created: ${chalk.green(unfinishedParticipants.length)} unfinished participants`);
    return cacheFile;
  } catch (error) {
    spinner.fail();
    console.log(chalk.red(`❌ Cache creation failed: ${error.message}`));
    return null;
  }
}

// Table Monitor Class (embedded from original)
class CertificateWorkerMonitor {
  constructor() {
    this.workers = [];
    this.maxWorkers = 16;
    this.logsDir = path.join(process.cwd(), 'logs');
    this.refreshInterval = 2000; // 2 seconds
    this.lastDisplayTime = 0;
    
    // Initialize workers
    for (let i = 0; i < this.maxWorkers; i++) {
      this.workers[i] = {
        id: i + 1,
        status: 'IDLE',
        current: '-',
        progress: '0/0',
        success: 0,
        error: 0,
        skip: 0,
        lastActivity: '-',
        logFile: null
      };
    }
  }

  async start() {
    console.log(chalk.cyan('Starting Certificate Sharing Workers Monitor (Filtered Mode)...'));
    console.log(chalk.gray(`Monitoring directory: ${this.logsDir}`));
    console.log(chalk.gray('Press Ctrl+C to exit\n'));

    // Create logs directory if it doesn't exist
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Start monitoring loop
    this.startMonitoring();
  }

  startMonitoring() {
    const interval = setInterval(() => {
      this.updateWorkerStates();
      this.displayTable();
    }, this.refreshInterval);

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log(chalk.yellow('\nMonitoring stopped.'));
      process.exit(0);
    });

    // Initial display
    this.updateWorkerStates();
    this.displayTable();
  }

  updateWorkerStates() {
    try {
      if (!fs.existsSync(this.logsDir)) return;

      const logFiles = fs.readdirSync(this.logsDir)
        .filter(file => file.startsWith('share-') && file.endsWith('.log'))
        .sort((a, b) => {
          try {
            const statA = fs.statSync(path.join(this.logsDir, a));
            const statB = fs.statSync(path.join(this.logsDir, b));
            return statB.mtime.getTime() - statA.mtime.getTime();
          } catch {
            return 0;
          }
        });

      // Reset all workers to IDLE first
      this.workers.forEach(worker => {
        if (worker.status === 'RUNNING') {
          worker.status = 'IDLE';
          worker.current = '-';
        }
      });

      // Process up to maxWorkers log files
      for (let i = 0; i < Math.min(logFiles.length, this.maxWorkers); i++) {
        const logFile = logFiles[i];
        const logPath = path.join(this.logsDir, logFile);
        this.parseLogFile(logPath, i);
      }

    } catch (error) {
      // Silently handle errors to avoid cluttering display
    }
  }

  parseLogFile(logPath, workerIndex) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const stat = fs.statSync(logPath);
      const lines = content.split('\n').filter(line => line.trim());
      const worker = this.workers[workerIndex];
      
      worker.logFile = path.basename(logPath);
      worker.status = 'IDLE';
      worker.current = '-';
      worker.progress = '0/0';
      worker.success = 0;
      worker.error = 0;
      worker.skip = 0;
      worker.lastActivity = '-';

      let totalParticipants = 0;
      let processed = 0;
      let lastTimestamp = null;

      // Parse log lines
      for (const line of lines) {
        // Extract timestamp
        const timestampMatch = line.match(/\[([^\]]+)\]/);
        if (timestampMatch) {
          lastTimestamp = timestampMatch[1];
          
          // Convert to display format (HH:mm:ss)
          try {
            const date = new Date(timestampMatch[1]);
            worker.lastActivity = date.toTimeString().split(' ')[0];
          } catch {
            worker.lastActivity = timestampMatch[1].split(' ')[1] || '-';
          }
        }

        // Extract current participant
        const successMatch = line.match(/Row\s+\d+\s+(GRANTED|DRY_RUN)\s+\w+\s+->\s+([^\s]+)\s+-/);
        const skipMatch = line.match(/Row\s+\d+\s+SKIP\b.*?:\s+([^\s\|]+)(?:\|[^\s]+)?\s+-/);
        const errorMatch = line.match(/Row\s+\d+\s+ERROR\b.*?(?:name='([^']+)')?/);
        if (successMatch) {
          worker.success++;
          processed++;
          const email = successMatch[2] || '';
          const name = email.split('@')[0];
          if (name) worker.current = name;
        } else if (skipMatch) {
          worker.skip++;
          processed++;
          const token = (skipMatch[1] || '').trim();
          if (token) worker.current = token;
        } else if (errorMatch) {
          worker.error++;
          processed++;
          const name = (errorMatch[1] || '').trim();
          if (name) worker.current = name;
        }

        // Extract progress info
        if (line.includes('Processing') && line.includes('participants')) {
          const m = line.match(/Processing\s+(\d+)\s+participants/);
          if (m) totalParticipants = parseInt(m[1]);
        }
      }

      // Set final status
      const now = Date.now();
      const freshMs = 15000; // treat as running if log updated in last 15s
      if (totalParticipants > 0) {
        worker.status = processed < totalParticipants ? 'RUNNING' : 'COMPLETED';
      } else if (processed > 0) {
        worker.status = (now - stat.mtimeMs) < freshMs ? 'RUNNING' : 'COMPLETED';
      } else {
        worker.status = (now - stat.mtimeMs) < freshMs ? 'RUNNING' : 'IDLE';
      }

      // Set progress
      worker.progress = totalParticipants > 0 ? `${processed}/${totalParticipants}` : `${processed}`;

    } catch (error) {
      // Handle file reading errors silently
    }
  }

  displayTable() {
    // Clear screen and move cursor to top
    process.stdout.write('\x1b[2J\x1b[H');
    
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    
    // Header
    console.log(chalk.cyan('╔══════════════════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║                   CERTIFICATE SHARING WORKERS MONITOR (FILTERED)            ║'));
    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════════════════════╣'));
    console.log(chalk.cyan('║ ID │ Status │ Progress │ Current Participant      │ ✅Success │ ❌Error │ ⏭️Skip │ Last ║'));
    console.log(chalk.cyan('╠════╪════════╪══════════╪═══════════════════════════╪═════════╪═══════╪════════╪══════╣'));

    // Worker rows
    let totalActive = 0;
    let totalSuccess = 0;
    let totalError = 0;
    let totalSkip = 0;

    for (const worker of this.workers) {
      const statusColor = worker.status === 'RUNNING' ? chalk.green('● RUN') :
                         worker.status === 'COMPLETED' ? chalk.blue('● DONE') :
                         chalk.gray('○ IDLE');
      
      const current = worker.current.length > 25 ? worker.current.substring(0, 22) + '...' : worker.current;
      
      console.log(chalk.cyan('║') + 
        ` ${String(worker.id).padStart(2)} │ ${statusColor.padEnd(14)} │ ${worker.progress.padEnd(8)} │ ${current.padEnd(25)} │ ${String(worker.success).padStart(7)} │ ${String(worker.error).padStart(5)} │ ${String(worker.skip).padStart(6)} │ ${worker.lastActivity.padEnd(8)} ` +
        chalk.cyan('║'));

      if (worker.status !== 'IDLE') totalActive++;
      totalSuccess += worker.success;
      totalError += worker.error;
      totalSkip += worker.skip;
    }

    // Summary
    console.log(chalk.cyan('╠════╪════════╪══════════╪═══════════════════════════╪═════════╪═══════╪════════╪══════╣'));
    console.log(chalk.cyan('║') + 
      ` TOTAL SUMMARY │ Active: ${String(totalActive).padStart(2)} │ Success: ${String(totalSuccess).padStart(4)} │ Error: ${String(totalError).padStart(3)} │ Skip: ${String(totalSkip).padStart(4)} ` +
      chalk.cyan('║'));
    console.log(chalk.cyan('╚═══════════════╧══════════╧═════════════════╧═══════════╧═══════╧════════╧══════╝'));
    
    console.log(`Last updated: ${timeStr} | Refresh: ${this.refreshInterval/1000}s | Press Ctrl+C to exit | ${chalk.yellow('FILTERED MODE')}`);
  }
}

// Live logs follower (from original)
class LiveLogsFollower {
  constructor(logsDir, options = {}) {
    this.logsDir = logsDir;
    this.intervalMs = options.intervalMs || 500;
    this.maxWorkers = options.maxWorkers || 64;
    this.tracked = new Map(); // filePath -> { pos }
    this.colorMap = new Map(); // filePath -> color fn
    this.colors = [chalk.cyan, chalk.green, chalk.yellow, chalk.magenta, chalk.blue, chalk.white, chalk.gray, chalk.red];
  }

  pickColor(index) {
    return this.colors[index % this.colors.length];
  }

  listLogFiles() {
    if (!fs.existsSync(this.logsDir)) return [];
    return fs.readdirSync(this.logsDir)
      .filter(f => f.startsWith('share-') && f.endsWith('.log'))
      .map(f => path.join(this.logsDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, this.maxWorkers);
  }

  ensureTracking() {
    const files = this.listLogFiles();
    files.forEach((filePath, idx) => {
      if (!this.tracked.has(filePath)) {
        const pos = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        this.tracked.set(filePath, { pos });
        this.colorMap.set(filePath, this.pickColor(idx));
      }
    });
    // Cleanup removed files
    for (const filePath of Array.from(this.tracked.keys())) {
      if (!files.includes(filePath)) {
        this.tracked.delete(filePath);
        this.colorMap.delete(filePath);
      }
    }
  }

  printLine(filePath, line) {
    const color = this.colorMap.get(filePath) || ((x) => x);
    const base = path.basename(filePath);
    process.stdout.write(color(`[${base}] `) + line + '\n');
  }

  async pollOnce() {
    this.ensureTracking();
    for (const [filePath, state] of this.tracked.entries()) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const st = fs.statSync(filePath);
        if (st.size > state.pos) {
          const fd = fs.openSync(filePath, 'r');
          const len = st.size - state.pos;
          const buffer = Buffer.alloc(Math.min(len, 1024 * 256)); // cap read chunk
          const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, state.pos);
          fs.closeSync(fd);
          state.pos += bytesRead;
          const text = buffer.slice(0, bytesRead).toString('utf8');
          const lines = text.split(/\r?\n/).filter(Boolean);
          for (const line of lines) this.printLine(filePath, line);
        }
      } catch (_) {
        // ignore
      }
    }
  }

  async start() {
    console.log(chalk.yellow('🔎 Live logs mode (filtered): following latest log files. Press Ctrl+C to stop.'));
    // Initial poll & watch
    this.ensureTracking();
    const timer = setInterval(() => { this.pollOnce(); }, this.intervalMs);
    process.on('SIGINT', () => { clearInterval(timer); console.log(chalk.gray('\nLive logs stopped.')); process.exit(0); });
    // keep alive
    await new Promise(() => {});
  }
}

async function startFilteredMonitor() {
  console.clear();
  console.log(chalk.cyan.bold('╔══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║        CERTIFICATE SHARING MONITOR (FILTERED)           ║'));
  console.log(chalk.cyan.bold('║        Filter Unfinished -> Run Workers                 ║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════════╝'));
  console.log();

  // Step 1: Authenticate
  const auth = await authenticate();
  if (!auth) {
    process.exit(1);
  }

  // Step 2: Check configuration
  const sheetId = config.get('sheetId');
  const sheetName = config.get('sheetName');
  
  if (!sheetId) {
    console.log(chalk.red('❌ Sheet ID not configured!'));
    console.log(chalk.yellow('   Run the main script first to configure the sheet.'));
    process.exit(1);
  }

  console.log(chalk.green(`📋 Sheet: ${sheetId}`));
  console.log(chalk.green(`📄 Sheet Name: ${sheetName}`));
  console.log();

  // Step 3: Get unfinished participants
  const result = await getUnfinishedParticipants(auth.sheets);
  if (!result) {
    process.exit(1);
  }

  const { unfinishedParticipants, totalCount, unfinishedCount, completedCount } = result;

  if (unfinishedCount === 0) {
    console.log(chalk.green('🎉 All participants are already completed! No work needed.'));
    console.log(chalk.blue(`   Total: ${totalCount}, Completed: ${completedCount}`));
    process.exit(0);
  }

  // Step 4: Write filtered cache
  const cacheFile = await writeFilteredCache(unfinishedParticipants);
  if (!cacheFile) {
    process.exit(1);
  }

  // Step 5: Show summary and ask for confirmation
  console.log();
  console.log(chalk.cyan('📊 FILTERING SUMMARY:'));
  console.log(chalk.blue(`   Total participants: ${totalCount}`));
  console.log(chalk.green(`   Already completed: ${completedCount}`));
  console.log(chalk.yellow(`   Need to process: ${unfinishedCount}`));
  console.log();

  const { confirmRun } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmRun',
      message: `Process ${unfinishedCount} unfinished participants with workers?`,
      default: true
    }
  ]);

  if (!confirmRun) {
    console.log(chalk.yellow('🚫 Cancelled.'));
    process.exit(0);
  }

  // Logs-only/attach mode: do not start workers, only follow logs
  if (MODE_LOGS_ONLY) {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    console.log(chalk.yellow('📎 Attach mode: following logs without starting workers...'));
    const follower = new LiveLogsFollower(logsDir);
    await follower.start();
    return;
  }

  // Step 6: Find worker binary
  const workerBinary = findWorkerBinary();
  if (!workerBinary) {
    console.log(chalk.red('❌ Worker binary tidak ditemukan!'));
    console.log(chalk.yellow('   Pastikan certificate-sharing executable ada di direktori yang sama.'));
    process.exit(1);
  }

  console.log(chalk.green(`✅ Worker binary: ${path.basename(workerBinary)}`));
  console.log();

  // Step 7: Ask for worker count
  const { workerCount } = await inquirer.prompt([
    {
      type: 'number',
      name: 'workerCount',
      message: 'Berapa worker yang ingin dijalankan?',
      default: Math.min(8, unfinishedCount),
      validate: (input) => {
        if (!Number.isInteger(input) || input < 1 || input > 64) {
          return 'Masukkan angka antara 1-64';
        }
        return true;
      }
    }
  ]);

  console.log();
  console.log(chalk.yellow(`🚀 Memulai ${workerCount} worker untuk ${unfinishedCount} participants...`));
  console.log(chalk.gray('────────────────────────────────────────────────'));

  // Step 8: Launch workers with filtered data
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    try {
      const env = {
        ...process.env,
        SHARD_TOTAL: workerCount.toString(),
        SHARD_INDEX: i.toString(),
        NODE_ENV: 'production',
        FILTERED_MODE: 'true',  // Tell workers to use filtered cache
        CACHE_FILE: cacheFile   // Path to filtered cache
      };

      let worker;
      if (workerBinary.endsWith('.js')) {
        // If it's a JS file, run with node
        worker = spawn('node', [workerBinary], {
          env,
          stdio: MODE_STREAM_STDOUT ? 'inherit' : 'pipe',
          detached: false
        });
      } else {
        // If it's an executable
        worker = spawn(workerBinary, [], {
          env,
          stdio: MODE_STREAM_STDOUT ? 'inherit' : 'pipe',
          detached: false
        });
      }

      workers.push(worker);
      
      console.log(chalk.green(`✅ Worker ${i + 1}/${workerCount} started (PID: ${worker.pid})`));
      
      // Add small delay between worker starts
      if (i < workerCount - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.log(chalk.red(`❌ Failed to start worker ${i + 1}: ${error.message}`));
    }
  }

  console.log();
  console.log(chalk.green(`🎉 ${workers.length} workers started successfully!`));
  console.log(chalk.yellow(`📊 Processing ${unfinishedCount} unfinished participants...`));
  
  // Step 9: Start monitoring
  if (workerCount >= 8) {
    if (MODE_LOGS) {
      console.log(chalk.yellow('📜 Live logs mode enabled (default).'));
      const follower = new LiveLogsFollower(path.join(process.cwd(), 'logs'));
      await follower.start();
    } else {
      console.log(chalk.yellow('🔄 Switching to table monitor view...'));
      await new Promise(resolve => setTimeout(resolve, 3000));
      // Start table monitor
      const tableMonitor = new CertificateWorkerMonitor();
      await tableMonitor.start();
    }
  } else {
    if (MODE_LOGS) {
      console.log(chalk.yellow('📜 Live logs mode enabled (default).'));
      const follower = new LiveLogsFollower(path.join(process.cwd(), 'logs'));
      await follower.start();
    } else {
      console.log(chalk.gray('\n📊 Table view selected.'));
      // Start table monitor even with fewer workers
      const tableMonitor = new CertificateWorkerMonitor();
      await tableMonitor.start();
    }
  }
}

async function main() {
  acquireLock();
  await startFilteredMonitor();
}

if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red('❌ Filtered Monitor error:'), error);
    process.exit(1);
  });
}

module.exports = { main };