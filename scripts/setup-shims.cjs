const fs = require('fs');
const path = require('path');

const binDir = path.resolve('node_modules/.bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const bins = [
  { name: 'tsc', target: '../typescript/bin/tsc' },
  { name: 'tsserver', target: '../typescript/bin/tsserver' },
  { name: 'tsx', target: '../tsx/dist/cli.mjs' },
  { name: 'vite', target: '../vite/bin/vite.js' },
  { name: 'tailwindcss', target: '../tailwindcss/lib/cli.js' }
];

for (const b of bins) {
  const targetWin = b.target.replace(/\//g, '\\');
  const cmd = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nnode "%dp0%\\${targetWin}" %*\r\n`;
  fs.writeFileSync(path.join(binDir, b.name + '.cmd'), cmd, 'utf8');

  const ps1 = `$basedir=Split-Path $MyInvocation.MyCommand.Path -Parent\r\n& "node" "$basedir/${b.target}" $args\r\nexit $LASTEXITCODE\r\n`;
  fs.writeFileSync(path.join(binDir, b.name + '.ps1'), ps1, 'utf8');
}

console.log('Successfully configured node_modules/.bin shims.');
