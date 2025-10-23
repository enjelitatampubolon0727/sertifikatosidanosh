const fs = require('fs').promises;
const path = require('path');
const inquirer = require('inquirer');
const { scanParentFolder } = require('./map-folders');

function toCsvValue(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function hasUpperCase(str) {
  return /[A-Z]/.test(str);
}

async function main() {
  try {
    console.log('🚀 Starting folder link mapping process...');

    // Reuse auth flow from map-folders via scanParentFolder's internals
    const { parentFolderId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'parentFolderId',
        message: 'Enter the parent folder ID to scan:',
        validate: (input) => !!(input && input.trim()) || 'Please enter a valid folder ID'
      }
    ]);

    // scanParentFolder returns a mapping: name -> id (also lowercase variants)
    const idMap = await scanParentFolder(null, parentFolderId.trim());

    // Build a link map: name -> link
    const linkMapRaw = {};
    for (const [name, id] of Object.entries(idMap)) {
      linkMapRaw[name] = `https://drive.google.com/drive/folders/${id}`;
    }

    // Deduplicate lowercase duplicates for CSV: prefer cased names when available
    const byLower = new Map(); // lowerName -> { name, link }
    for (const [name, link] of Object.entries(linkMapRaw)) {
      const lower = name.toLowerCase();
      if (!byLower.has(lower)) {
        byLower.set(lower, { name, link });
      } else {
        const cur = byLower.get(lower);
        if (!hasUpperCase(cur.name) && hasUpperCase(name)) {
          byLower.set(lower, { name, link });
        }
      }
    }

    const outputDir = './cache';
    await fs.mkdir(outputDir, { recursive: true });

    // Write JSON (includes both original and lowercase keys)
    const jsonPath = path.join(outputDir, 'folder-links-mapping.json');
    await fs.writeFile(jsonPath, JSON.stringify(linkMapRaw, null, 2), 'utf8');

    // Write CSV (deduped)
    const rows = Array.from(byLower.values()).sort((a, b) => a.name.localeCompare(b.name));
    const csvPath = path.join(outputDir, 'folder-links-mapping.csv');
    const header = 'Name,FolderLink\n';
    const body = rows.map(r => `${toCsvValue(r.name)},${toCsvValue(r.link)}`).join('\n') + '\n';
    await fs.writeFile(csvPath, header + body, 'utf8');

    console.log('✅ Folder link mapping completed.');
    console.log(`📁 JSON: ${jsonPath}`);
    console.log(`📁 CSV : ${csvPath} (rows: ${rows.length})`);
  } catch (err) {
    console.error('❌ Error generating folder link mapping:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { };

