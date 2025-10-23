#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
const inquirer = require('inquirer');

// Unified Monitor: Basic monitor + Table monitor in one
// Automatically switches to table view when 16 workers are selected

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

const LOCK_PATH = '/tmp/certificate-sharing-monitor.lock';

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (pid && !Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.log(chalk.red(`Another monitor is running (pid=${pid}). Exiting.`));
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

// Table Monitor Class (embedded)
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
    console.log(chalk.cyan('Starting Certificate Sharing Workers Monitor...'));
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
        // Success line example: "Row 669 GRANTED reader -> email - Time: ..."
        // Skip line example:    "Row 586 SKIP already has reader - Time: ..."
        // Error line example:   "Row 473 ERROR folder not found for name='...' - Time: ..."
        const successMatch = line.match(/Row\s+\d+\s+(GRANTED|DRY_RUN)\s+\w+\s+->\s+([^\s]+)\s+-/);
        const skipMatch = line.match(/Row\s+\d+\s+SKIP\b.*?:\s+([^\s\|]+)(?:\|[^\s]+)?\s+-/);
        const errorMatch = line.match(/Row\s+\d+\s+ERROR\b.*?(?:name='([^']+)')?/);
        if (successMatch) {
          worker.success++;
          processed++;
          // Derive a human-friendly "current" from the email local-part
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
    console.log(chalk.cyan('║                        CERTIFICATE SHARING WORKERS MONITOR                  ║'));
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
    
    console.log(`Last updated: ${timeStr} | Refresh: ${this.refreshInterval/1000}s | Press Ctrl+C to exit`);
  }
}

// Live logs follower (aggregated tail)
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
    console.log(chalk.yellow('🔎 Live logs mode: following latest log files. Press Ctrl+C to stop.'));
    // Initial poll & watch
    this.ensureTracking();
    const timer = setInterval(() => { this.pollOnce(); }, this.intervalMs);
    process.on('SIGINT', () => { clearInterval(timer); console.log(chalk.gray('\nLive logs stopped.')); process.exit(0); });
    // keep alive
    await new Promise(() => {});
  }
}

async function startBasicMonitor() {
  console.clear();
  console.log(chalk.cyan.bold('╔══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║             CERTIFICATE SHARING MONITOR                 ║'));
  console.log(chalk.cyan.bold('║            Script Monitor Multi-Worker                  ║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════════╝'));
  console.log();

  // Logs-only/attach mode: do not start workers, only follow logs
  if (MODE_LOGS_ONLY) {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    console.log(chalk.yellow('📎 Attach mode: following logs without starting workers...'));
    const follower = new LiveLogsFollower(logsDir);
    await follower.start();
    return;
  }

  const workerBinary = findWorkerBinary();
  if (!workerBinary) {
    console.log(chalk.red('❌ Worker binary tidak ditemukan!'));
    console.log(chalk.yellow('   Pastikan certificate-sharing executable ada di direktori yang sama.'));
    process.exit(1);
  }

  console.log(chalk.green(`✅ Worker binary: ${path.basename(workerBinary)}`));
  console.log();

  const { workerCount } = await inquirer.prompt([
    {
      type: 'number',
      name: 'workerCount',
      message: 'Berapa worker yang ingin dijalankan?',
      default: 16,
      validate: (input) => {
        if (!Number.isInteger(input) || input < 1 || input > 64) {
          return 'Masukkan angka antara 1-64';
        }
        return true;
      }
    }
  ]);

  console.log();
  console.log(chalk.yellow(`🚀 Memulai ${workerCount} worker...`));
  console.log(chalk.gray('────────────────────────────────────────────────'));

  // Launch workers
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    try {
      const env = {
        ...process.env,
        SHARD_TOTAL: workerCount.toString(),
        SHARD_INDEX: i.toString(),
        NODE_ENV: 'production'
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
  
  // Auto-switch to table monitor if 16 workers
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
  await startBasicMonitor();
}

if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red('❌ Monitor error:'), error);
    process.exit(1);
  });
}

module.exports = { CertificateWorkerMonitor, main };
