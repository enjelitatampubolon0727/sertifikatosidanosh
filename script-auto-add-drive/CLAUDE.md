# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This is a Google Drive certificate sharing automation tool that distributes certificate folder access to participants based on Google Sheets data. The system uses multi-worker architecture with sharding to prevent overlapping operations when processing large datasets.

## Core Architecture

### Main Components
- **`index.js`**: Core certificate sharing worker that handles batch processing, Google Drive/Sheets operations, and permission management
- **`unified-monitor.js`**: Orchestrator/monitor CLI that spawns multiple workers and displays status/logs in real-time
- **`map-folders.js`**: Helper utility for Google Drive folder mapping and search functionality
- **`unified-monitor-filtered.js`**: Filtered version of the monitor (untracked in git)

### Worker System Architecture
- Orchestrator spawns multiple workers with automatic sharding to prevent data overlap
- Each worker processes a subset of participants using sharding key (FolderId or Nama.toLowerCase())
- Default batch size: 20 participants per worker per iteration
- Workers run in continuous loops with configurable polling intervals
- Safe parallel execution with no permission conflicts between workers

### Data Flow
1. Monitor asks for number of workers and configuration
2. Workers read Google Sheet, detect columns, and add required columns if missing
3. Filter out already shared items (isShared == TRUE)
4. Apply sharding logic to divide work between workers
5. Process batches: validate email → find/search folder → check permissions → grant access → update sheet → log

## Commands

### Development
```bash
bun install                           # Install dependencies
bun start                            # Run monitor with worker spawning
bun run dev                          # Same as start
bun index.js                         # Run single worker once (debugging)
bun unified-monitor.js               # Interactive monitor (default: live logs)
bun unified-monitor.js --table       # Table status view
bun unified-monitor.js --logs-only   # Attach to existing workers, show logs only
bun unified-monitor.js --stream      # Raw stdout/stderr stream (verbose)
```

### Build
```bash
bun run build:win                    # Build Windows executables
bun run clean:exe                    # Clean build directory
```

### Environment Variables
- `SHEET_ID`, `SHEET_NAME`: Bypass interactive configuration prompts
- `PARENT_FOLDER_ID`: Restrict folder search to specific parent folder
- `MAX_PER_RUN`: Override default batch size (default: 20)
- `POLL_INTERVAL`: Worker polling interval in seconds (default: 30)
- `DEBUG=true` or `DEBUG_SHARE=true`: Enable debug logging
- `SHARD_TOTAL`, `SHARD_INDEX`: Manual sharding configuration (auto-set by monitor)

## Google Sheet Structure

### Required Columns (case-insensitive detection)
- **Nama**: "Nama Peserta", "Nama", "Nama Lengkap", "Name", etc.
- **Email**: "Email Address", "Email", "E-mail", "Gmail", etc.

### Optional Columns
- **FolderId**: Google Drive folder ID (if empty, searches by Nama)

### Auto-Added Columns
- **isShared**: Tracks sharing status (TRUE/FALSE)
- **isFolderExists**: Folder existence status
- **LastLog**: Last operation timestamp

## Configuration Management

### Service Account Setup
- Place `service.json` (Google service account credentials) in root directory
- Never commit credential files - they're gitignored
- For binary distributions, place service.json alongside the executable

### App Configuration
Uses `Conf` package for persistent settings:
- `sheetId`, `sheetName`: Target Google Sheet
- `parentFolderId`: Optional folder search restriction
- `role`: Permission role (default: 'reader')
- `throttleMs`: API rate limiting delay (default: 2500ms)
- `maxPerRun`: Batch size per worker (default: 300)

## Rate Limiting & Performance
- Built-in throttling with configurable delay (default: 2500ms between API calls)
- Automatic retry/backoff for 403/429 rate limit errors
- Small batch processing (20 participants/worker) for API stability
- Recommended: Start with 2-4 workers, monitor for rate limits

## Logging System
- File-based logging to `logs/` directory with timestamps
- Each worker creates separate log files: `share-YYYYMMDD-HHMMSS.log`
- Monitor aggregates and displays logs in real-time
- Sensitive data (emails, tokens) are filtered from logs

## Development Practices
- Node.js >=14 required
- No formal linter - follow existing 2-space indentation style
- Prefer async/await over callbacks
- Keep functions small and pure, isolate I/O operations
- Use kebab-case for filenames

## Testing Strategy
- No formal test suite - use manual testing with staging data
- Test with small batches (`MAX_PER_RUN=5`) for validation
- Use `sample.csv` and test Google Sheets for development
- Set `PARENT_FOLDER_ID` to restrict operations to test folders

## Binary Distribution
- Windows executables built with `pkg` to `build/` directory
- Binary automatically detects and uses worker binary in same directory
- Include `service.json` alongside binary for deployment