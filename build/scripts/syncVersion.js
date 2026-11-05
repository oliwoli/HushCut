// scripts/syncVersion.js
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const wailsJsonPath = path.join(projectRoot, 'wails.json');
const configYmlPath = path.join(projectRoot, 'build', 'config.yml');
const darwinDir = path.join(projectRoot, 'build', 'darwin');
const infoPlistPath = path.join(darwinDir, 'Info.plist');
const infoDevPlistPath = path.join(darwinDir, 'Info.dev.plist');

const packageJson = require(packageJsonPath);
const newVersion = packageJson.version;

// Ensure build/darwin directory exists
if (!fs.existsSync(darwinDir)) {
  fs.mkdirSync(darwinDir, { recursive: true });
}

// 1. Sync wails.json only if version changed
if (fs.existsSync(wailsJsonPath)) {
  const originalRaw = fs.readFileSync(wailsJsonPath, 'utf8');
  const wailsJson = JSON.parse(originalRaw);
  if (!wailsJson.info || wailsJson.info.productVersion !== newVersion) {
    wailsJson.info = wailsJson.info || {};
    wailsJson.info.productVersion = newVersion;
    fs.writeFileSync(wailsJsonPath, JSON.stringify(wailsJson, null, 2));
    console.log(`Synced version to ${newVersion} in wails.json`);
  }
}

// 2. Sync build/config.yml (only under info:) if version changed
if (fs.existsSync(configYmlPath)) {
  const configYml = fs.readFileSync(configYmlPath, 'utf8');
  const updatedYml = configYml.replace(
    /(\ninfo:[\s\S]*?\n\s+version:\s*["'])[^"']+(["'])/,
    `$1${newVersion}$2`
  );
  if (configYml !== updatedYml) {
    fs.writeFileSync(configYmlPath, updatedYml);
    console.log(`Synced version to ${newVersion} in build/config.yml`);
  }
}

// 3. Generate Info.plist and Info.dev.plist dynamically for macOS bundles
function generatePlist(isDev) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
	<dict>
		<key>CFBundleExecutable</key>
		<string>HushCut</string>
		<key>CFBundleGetInfoString</key>
		<string>A Silence Remover Plugin for DaVinci Resolve.</string>
		<key>CFBundleIconFile</key>
		<string>icons</string>
		<key>CFBundleIconName</key>
		<string>appicon</string>
		<key>CFBundleIdentifier</key>
		<string>com.oliwoli.hushcut</string>
		<key>CFBundleName</key>
		<string>HushCut</string>
		<key>CFBundlePackageType</key>
		<string>APPL</string>
		<key>CFBundleShortVersionString</key>
		<string>${newVersion}</string>
		<key>CFBundleVersion</key>
		<string>${newVersion}</string>
		<key>LSMinimumSystemVersion</key>
		<string>12.0.0</string>${isDev ? `
		<key>NSAppTransportSecurity</key>
		<dict>
			<key>NSAllowsLocalNetworking</key>
			<true/>
		</dict>` : ''}
		<key>NSHighResolutionCapable</key>
		<string>true</string>
		<key>NSHumanReadableCopyright</key>
		<string>© Oliver Weiss 2025</string>
	</dict>
</plist>
`;
}

const prodPlist = generatePlist(false);
if (!fs.existsSync(infoPlistPath) || fs.readFileSync(infoPlistPath, 'utf8') !== prodPlist) {
  fs.writeFileSync(infoPlistPath, prodPlist);
  console.log(`Generated ${path.basename(infoPlistPath)} with version ${newVersion}`);
}

const devPlist = generatePlist(true);
if (!fs.existsSync(infoDevPlistPath) || fs.readFileSync(infoDevPlistPath, 'utf8') !== devPlist) {
  fs.writeFileSync(infoDevPlistPath, devPlist);
  console.log(`Generated ${path.basename(infoDevPlistPath)} with version ${newVersion}`);
}
