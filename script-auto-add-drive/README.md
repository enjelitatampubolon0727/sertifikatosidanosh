# Certificate Sharing Tool

Automated Google Drive certificate folder sharing tool that distributes access permissions to participants based on Google Sheets data. Perfect for schools, universities, and training programs with mass certificate distribution needs.

## Key Features
- **Multi-worker parallel processing** with safe sharding (no overlap conflicts)
- **Small batch processing** (default 20 participants/worker) with auto-loop
- **Smart filtering** - only processes unshared items (isShared != TRUE)
- **Flexible folder search** - case-insensitive name-based search with FolderId priority
- **Safe Google Sheets integration** - dynamic column mapping without hard-coded references
- **Built-in rate limiting** - throttling + retry/backoff to avoid 403/429 errors
- **Comprehensive logging** - detailed file-based logging in `logs/` directory
- **Real-time monitoring** - live status updates and log aggregation

## Architecture & Workflow

### System Components
- **Orchestrator**: `unified-monitor.js` - manages worker spawning and displays real-time status/logs
- **Worker**: `index.js` (CertificateSharing class) - handles batch processing and Google API operations
- **Utilities**: `map-folders.js` - Google Drive folder mapping and search helpers

### Processing Flow
1. **Initialization**: Read Google Sheet, detect columns, add required columns if missing
2. **Filtering**: Skip rows where `isShared == TRUE` (case-insensitive)
3. **Sharding**: Each worker processes different data subsets to prevent conflicts
   - Shard key: `FolderId` (case-sensitive) or `Nama.toLowerCase()` if FolderId is empty
4. **Batch Processing**: Process participants in small batches (default 20/worker)
5. **Permission Management**: For each participant:
   - Validate email → Find/search folder → Check existing permissions → Grant access → Update sheet → Log results

## Google Sheet Structure

### Required Columns (flexible naming, case-insensitive detection)
- **Name**: "Nama Peserta", "Nama", "Nama Lengkap", "Name", etc.
- **Email**: "Email Address", "Email", "E-mail", "Gmail", etc.

### Optional Columns
- **FolderId**: Google Drive folder ID for participant (if empty, searches by Name)

### Auto-Generated Columns
- **isShared**: Tracks sharing status (TRUE/FALSE)
- **isFolderExists**: Folder existence status
- **LastLog**: Last operation timestamp

> **Note**: Folder search by Name is case-insensitive, but `FolderId` is treated as-is (case-sensitive). Column updates use detected index mapping without hard-coded column letters, ensuring safe operations without overwriting other columns.

## Getting Started

### Prerequisites
- Node.js >=14.0.0
- Google Service Account credentials (`service.json`)
- Google Sheet with participant data
- Google Drive folders to share

### Installation & Setup
```bash
bun install
```

### Development Commands
```bash
# Single worker run (debugging)
node index.js

# Interactive monitor with worker spawning (default: live logs)
node unified-monitor.js

# Table status view (compact)
node unified-monitor.js --table

# Attach to existing workers (logs only, no new workers)
node unified-monitor.js --logs-only

# Raw stdout/stderr stream (verbose debugging)
node unified-monitor.js --stream
```

### Environment Variables
- `SHEET_ID`, `SHEET_NAME`: Bypass interactive configuration prompts
- `PARENT_FOLDER_ID`: Restrict folder search to specific parent folder (optional)
- `MAX_PER_RUN`: Override default batch size per worker (default: 20)
- `POLL_INTERVAL`: Worker polling interval in seconds (default: 30)
- `DEBUG=true`: Enable debug logging
- `throttleMs`: API rate limiting delay via config (default: 2500ms)

## Binary Distribution

### Running Packaged Binaries
Place `service.json` in the same directory as the binary. The monitor will automatically detect and run the worker binary from the same directory.

**Windows:**
```powershell
.\build\certificate-monitor-win.exe
```

**macOS/Linux:**
```bash
./build/certificate-monitor-mac
./build/certificate-monitor-linux
```

### Building Executables
```bash
# Build Windows binaries
bun run build:win

# Clean build directory
bun run clean:exe

# Manual build commands
bunx pkg unified-monitor.js --targets node18-win-x64 --output build/certificate-monitor-win.exe
bunx pkg index.js --targets node18-win-x64 --output build/certificate-sharing-win.exe
```

## Best Practices & Performance

### Recommended Settings
- **Start with 2-4 workers** and monitor for 403/429 errors
- **Keep small batches** (20 participants/worker) for API stability
- **Adjust throttling** if rate limits occur (`throttleMs` or worker count)
- **Avoid manual column changes** during processing (dynamic mapping may need re-detection)

### Monitor Display Modes
- **Default (Live Logs)**: Real-time aggregated logs from `logs/share-*.log` files with filename prefixes
- **Table Mode** (`--table`): Compact status table view
- **Logs Only** (`--logs-only`): Attach to existing workers without spawning new ones
- **Stream Mode** (`--stream`): Raw stdout/stderr output (verbose, for debugging)

## Configuration & Service Account

### Google Service Account Setup
1. Create a Google Cloud Project
2. Enable Google Drive API and Google Sheets API
3. Create a Service Account and download credentials as `service.json`
4. Share your Google Sheet and Drive folders with the service account email
5. Place `service.json` in the project root directory

### Security Notes
- **Never commit** `service.json` or other credential files
- Service account files are automatically ignored by git
- Use environment variables for sensitive configuration in production

## Troubleshooting & Logging

### Log Files
- **Location**: `logs/` directory with timestamp-based filenames
- **Format**: `share-YYYYMMDD-HHMMSS.log` per worker session  
- **Content**: Concise error messages with HTTP codes and automatic retry/backoff for rate limits

### Common Issues
- **Rate Limiting**: Reduce worker count or increase `throttleMs` value
- **Column Detection**: If target columns aren't detected, updates are skipped safely
- **Permission Errors**: Ensure service account has proper access to sheets and folders
- **Folder Not Found**: Check folder names and parent folder restrictions

## License

MIT License - see package.json for details.
