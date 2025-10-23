const fs = require('fs');
const path = require('path');

function toCsvValue(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function hasUpperCase(str) {
  return /[A-Z]/.test(str);
}

function main() {
  const inPath = process.argv[2] || 'cache/folder-mapping.json';
  const outPath = process.argv[3] || 'cache/folder-mapping.csv';

  const raw = fs.readFileSync(inPath, 'utf8');
  const obj = JSON.parse(raw);

  // Deduplicate lowercase duplicates: prefer a key with any uppercase letters
  const byLower = new Map(); // lowerName -> { name, id }
  for (const [name, id] of Object.entries(obj)) {
    const lower = name.toLowerCase();
    if (!byLower.has(lower)) {
      byLower.set(lower, { name, id });
    } else {
      const cur = byLower.get(lower);
      if (!hasUpperCase(cur.name) && hasUpperCase(name)) {
        byLower.set(lower, { name, id });
      }
    }
  }

  const rows = Array.from(byLower.values())
    .sort((a, b) => a.name.localeCompare(b.name));

  const header = 'Name,FolderId\n';
  const body = rows.map(r => `${toCsvValue(r.name)},${toCsvValue(r.id)}`).join('\n') + '\n';
  fs.writeFileSync(outPath, header + body, 'utf8');
  console.log(`CSV written: ${outPath} (rows: ${rows.length})`);
}

if (require.main === module) main();

