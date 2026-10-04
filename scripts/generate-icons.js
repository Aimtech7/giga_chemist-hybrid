import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// 1. Create clean Brand SVG: Medical Cross + Pill + AIM
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f766e"/>
      <stop offset="100%" stop-color="#042f2e"/>
    </linearGradient>
    <linearGradient id="crossGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <!-- Background with subtle border -->
  <rect width="512" height="512" rx="104" fill="url(#brandGrad)"/>
  
  <!-- Outer Glow circle -->
  <circle cx="256" cy="256" r="190" fill="#ffffff" fill-opacity="0.06"/>
  
  <!-- Pharmacy Cross -->
  <path d="M 216 112 H 296 V 216 H 400 V 296 H 296 V 400 H 216 V 296 H 112 V 216 H 216 Z" fill="url(#crossGrad)" rx="24"/>
  
  <!-- Inner White Accent Cross Core -->
  <circle cx="256" cy="256" r="28" fill="#ffffff"/>
  
  <!-- Prescription Rx badge bottom right -->
  <circle cx="368" cy="368" r="54" fill="#0284c7" stroke="#ffffff" stroke-width="6"/>
  <text x="368" y="378" font-family="system-ui, sans-serif" font-weight="900" font-size="34" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">GC</text>
</svg>`;

fs.writeFileSync(path.join(publicDir, 'icon.svg'), svgContent);

// Helper function to create clean PNG icon buffers
function generatePngIcon(size, isMaskable = false) {
  const png = new PNG({ width: size, height: size });
  const center = size / 2;
  const radius = size * (isMaskable ? 0.42 : 0.48);
  const crossWidth = size * 0.16;
  const crossLength = size * (isMaskable ? 0.54 : 0.62);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Background: deep teal
      let r = 15, g = 118, b = 110, a = 255;

      if (!isMaskable) {
        // Squircle corner rounding for standard icons
        const cornerR = size * 0.18;
        const inCornerX = x < cornerR || x > size - cornerR;
        const inCornerY = y < cornerR || y > size - cornerR;
        if (inCornerX && inCornerY) {
          const cx = x < cornerR ? cornerR : size - cornerR;
          const cy = y < cornerR ? cornerR : size - cornerR;
          const cDist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
          if (cDist > cornerR) {
            a = 0; // transparent outside rounded box
          }
        }
      }

      if (a > 0) {
        // Subtle circular glow
        if (dist < radius) {
          r = Math.min(255, r + 15);
          g = Math.min(255, g + 25);
          b = Math.min(255, b + 25);
        }

        // Green pharmacy cross: vertical bar or horizontal bar
        const inVertCross = Math.abs(dx) <= crossWidth / 2 && Math.abs(dy) <= crossLength / 2;
        const inHorizCross = Math.abs(dy) <= crossWidth / 2 && Math.abs(dx) <= crossLength / 2;

        if (inVertCross || inHorizCross) {
          r = 16;
          g = 185;
          b = 129;
        }

        // White center disc
        if (dist <= crossWidth * 0.38) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }

  return PNG.sync.write(png);
}

fs.writeFileSync(path.join(publicDir, 'pwa-192x192.png'), generatePngIcon(192, false));
fs.writeFileSync(path.join(publicDir, 'pwa-512x512.png'), generatePngIcon(512, false));
fs.writeFileSync(path.join(publicDir, 'pwa-maskable-512x512.png'), generatePngIcon(512, true));
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), generatePngIcon(180, false));
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), generatePngIcon(32, false));

console.log('PWA icons created successfully.');
