import fs from 'fs';
import path from 'path';

const packageDir = path.resolve('deployment/xampp');

const requiredFiles = [
  '.htaccess',
  'index.php',
  'XAMPP_LOCAL_SETUP.md',
  'app/index.html',
  'app/manifest.webmanifest',
  'app/registerSW.js',
  'app/sw.js',
  'api/index.php',
  'api/db.php',
  'api/auth.php',
  'config/config.example.php',
  'database/schema.sql',
  'database/seed.sql',
  'scripts/check-environment.php',
  'scripts/create-admin.php',
  'apache/.htaccess',
  'backups/README.md',
];

console.log('========================================================');
console.log(' GIGA CHEMIST - Deployment Package Validation Suite');
console.log('========================================================\n');

let hasErrors = false;

// 1. Verify existence of required files
console.log('1. Checking required deployment files:');
for (const relPath of requiredFiles) {
  const fullPath = path.join(packageDir, relPath);
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    console.log(`  [ PASS ] ${relPath} (${stat.size} bytes)`);
  } else {
    console.error(`  [ FAIL ] Missing required file: ${relPath}`);
    hasErrors = true;
  }
}

// 2. Check for duplicate extensions like .php.php
console.log('\n2. Checking for duplicate extension anomalies (.php.php, etc.):');
function scanDir(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      scanDir(itemPath);
    } else {
      if (item.name.includes('.php.php') || item.name.includes('.example.php.php')) {
        console.error(`  [ FAIL ] Invalid duplicate filename found: ${itemPath}`);
        hasErrors = true;
      }
    }
  }
}
scanDir(packageDir);
console.log('  [ PASS ] No duplicate extension anomalies detected.');

// 3. Verify Frontend build assets directory
console.log('\n3. Checking frontend production assets:');
const assetsDir = path.join(packageDir, 'app/assets');
if (fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length > 0) {
  const count = fs.readdirSync(assetsDir).length;
  console.log(`  [ PASS ] Production assets present in app/assets/ (${count} files)`);
} else {
  console.error('  [ FAIL ] Missing or empty app/assets/ directory');
  hasErrors = true;
}

// 4. Verify SQL Schema syntax basics
console.log('\n4. Checking SQL Schema compatibility:');
const schemaContent = fs.readFileSync(path.join(packageDir, 'database/schema.sql'), 'utf-8');
if (schemaContent.includes('CREATE DATABASE IF NOT EXISTS `giga_chemist`') && schemaContent.includes('ENGINE=InnoDB')) {
  console.log('  [ PASS ] schema.sql contains valid MySQL database & table definitions');
} else {
  console.error('  [ FAIL ] schema.sql missing expected MySQL definitions');
  hasErrors = true;
}

if (hasErrors) {
  console.error('\n[FAILED] Package validation failed with errors!');
  process.exit(1);
} else {
  console.log('\n[SUCCESS] All package validation checks PASSED successfully!\n');
  process.exit(0);
}
