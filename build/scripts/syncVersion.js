// scripts/syncVersion.js
const fs = require('fs');
const path = require('path');

// Paths to your files
const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
const wailsJsonPath = path.join(__dirname, '..', '..', 'wails.json');

// Read both files
const packageJson = require(packageJsonPath);
const wailsJson = JSON.parse(fs.readFileSync(wailsJsonPath, 'utf8'));

const newVersion = packageJson.version;

// Update the version in the wails.json object
wailsJson.info.productVersion = newVersion;

// Write the updated wails.json file back to disk
fs.writeFileSync(wailsJsonPath, JSON.stringify(wailsJson, null, 2));

console.log(`Synced version to ${newVersion} in wails.json`);