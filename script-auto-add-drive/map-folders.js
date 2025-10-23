const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const inquirer = require('inquirer');

// Service Account Authentication
const KEYFILE_PATH = './service.json'; 
const SCOPES = ['https://www.googleapis.com/auth/drive'];

async function authenticate() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE_PATH,
    scopes: SCOPES,
  });
  return auth.getClient();
}

async function scanParentFolder(auth, parentFolderId, maxDepth = 2) {
  const drive = google.drive({ version: 'v3', auth });
  const folderMapping = {};
  
  console.log(`🗂️  Scanning parent folder: ${parentFolderId} (max depth: ${maxDepth})`);
  
  let totalMapped = 0;
  
  async function scanFolderRecursive(folderId, currentDepth = 0, parentName = '') {
    if (currentDepth >= maxDepth) return 0;
    
    let pageToken = null;
    let folderCount = 0;
    
    do {
      try {
        const response = await drive.files.list({
          q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 1000,
          pageToken: pageToken
        });
        
        const folders = response.data.files || [];
        console.log(`📂 Depth ${currentDepth + 1}${parentName ? ` (${parentName})` : ''}: Found ${folders.length} folders`);
        
        for (const folder of folders) {
          // Store direct mapping: name -> id
          folderMapping[folder.name] = folder.id;
          
          // Also store lowercase version for case-insensitive lookup
          folderMapping[folder.name.toLowerCase()] = folder.id;
          
          folderCount++;
          totalMapped++;
          
          if (totalMapped % 50 === 0) {
            console.log(`✅ Total mapped so far: ${totalMapped / 2} unique folders`);
          }
          
          // Show current folder being processed
          if (currentDepth === 0) {
            console.log(`   📁 ${folder.name}`);
          } else if (currentDepth === 1) {
            console.log(`   → Processing: ${folder.name}`);
          }
          
          // Recursively scan this folder
          const childCount = await scanFolderRecursive(folder.id, currentDepth + 1, folder.name);
          folderCount += childCount;
        }
        
        pageToken = response.data.nextPageToken;
      } catch (error) {
        console.error(`❌ Error scanning folder at depth ${currentDepth}:`, error.message);
        break;
      }
    } while (pageToken);
    
    return folderCount;
  }
  
  const totalFolders = await scanFolderRecursive(parentFolderId);
  console.log(`\n✅ Mapping completed!`);
  console.log(`   - Total unique folders: ${totalMapped / 2}`);
  console.log(`   - Total entries (with case variants): ${totalMapped}`);
  return folderMapping;
}

async function saveFolderMapping() {
  try {
    console.log('🚀 Starting folder mapping process...');
    const startTime = Date.now();
    
    const auth = await authenticate();
    
    // Ask for parent folder ID
    const { parentFolderId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'parentFolderId',
        message: 'Enter the parent folder ID to scan:',
        validate: (input) => {
          if (!input || !input.trim()) {
            return 'Please enter a valid folder ID';
          }
          return true;
        }
      }
    ]);
    
    // Scan the parent folder
    const folderMapping = await scanParentFolder(auth, parentFolderId.trim());
    
    // Save to JSON file
    const outputDir = './cache';
    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
      // Directory already exists, ignore
    }
    
    const mappingPath = path.join(outputDir, 'folder-mapping.json');
    await fs.writeFile(mappingPath, JSON.stringify(folderMapping, null, 2));
    
    const elapsed = Date.now() - startTime;
    const totalFolders = Object.keys(folderMapping).length / 2; // Divided by 2 because we store both original and lowercase
    
    console.log(`✅ Folder mapping completed!`);
    console.log(`📊 Statistics:`);
    console.log(`   - Total folders: ${totalFolders}`);
    console.log(`   - Parent folder: ${parentFolderId.trim()}`);
    console.log(`   - Time elapsed: ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`📁 File saved: ${mappingPath}`);
    
  } catch (error) {
    console.error('❌ Error during folder mapping:', error);
    process.exit(1);
  }
}

// Run the mapping
if (require.main === module) {
  saveFolderMapping();
}

module.exports = { saveFolderMapping, scanParentFolder };
