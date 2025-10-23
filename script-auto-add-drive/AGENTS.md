# Repository Guidelines

## Project Structure & Module Organization
- `index.js`: Core certificate sharing worker (batching, Drive/Sheets ops).
- `unified-monitor.js`: Orchestrator/monitor CLI (spawns workers, shows status/logs).
- `map-folders.js`: Helper for Drive folder mapping.
- `logs/`: Runtime logs per worker/session. Do not commit manual edits.
- `build/`: Packaged binaries output (e.g., Windows `.exe`).
- `cache/`, `sample.csv`, `service.json|service-bintang.json`: Local data and credentials (keep secrets private).

## Build, Test, and Development Commands
- `bun install`: Install dependencies.
- `bun run dev` or `bun start`: Run monitor locally (spawns workers as needed).
- `bun index.js`: Run a single worker once (useful for debugging).
- `bun unified-monitor.js --table|--logs|--logs-only|--stream`: Alternate monitor views.
- `bun run build:win`: Build Windows binaries with `pkg` into `build/`.

Environment hints: set `SHEET_ID`, `SHEET_NAME`, `PARENT_FOLDER_ID`, `MAX_PER_RUN`, `POLL_INTERVAL` for non-interactive runs.

## Coding Style & Naming Conventions
- Language: Node.js (>=14). Use async/await and Promises, avoid callback-style.
- Indentation: 2 spaces; max line length ~100; prefer single quotes.
- Filenames: kebab-case (`unified-monitor.js`, `map-folders.js`).
- Logging: prefer concise, actionable messages; avoid leaking emails or tokens.
- No linter configured; match existing style. Keep functions small and pure; isolate I/O.

## Testing Guidelines
- No formal test suite. Use a staging Google Sheet and `sample.csv` for manual tests.
- Dry-run by pointing to a test parent folder via `PARENT_FOLDER_ID`; verify no unintended writes.
- Aim for small batches (`MAX_PER_RUN=5`) when validating changes.
- Add unit tests if introducing complex logic (suggest Jest) under `__tests__/` with `*.test.js`.

## Commit & Pull Request Guidelines
- Commits: imperative, scoped messages (e.g., `feat(monitor): add table view refresh`).
- PRs: include purpose, screenshots/terminal output, repro steps, and risk/rollback notes.
- Link related issues; describe config/env vars touched; note migration needs for `service.json`.

## Security & Configuration
- Never commit credentials. Keep `service*.json` local; ensure `.gitignore` covers them.
- Rate limits: respect throttling settings; prefer small worker counts in new environments.
