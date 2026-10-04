const fs = require('fs');
const path = require('path');

const src = 'C:/Users/wilso/AppData/Roaming/npm/node_modules/firebase-tools/node_modules/pg';
const dest = path.resolve('node_modules/pg');

console.log('Copying from:', src, 'to:', dest);
if (fs.existsSync(src)) {
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log('Successfully copied pg. Exists in node_modules/pg/package.json:', fs.existsSync(path.join(dest, 'package.json')));
} else {
  console.error('Source pg not found at:', src);
}
