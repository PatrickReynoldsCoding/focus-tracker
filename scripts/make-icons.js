// Regenerates the PNG icons from the SVGs in assets/icons. Run: node scripts/make-icons.js (needs the sharp dev dependency).
const sharp = require('sharp');
const path = require('path');
const dir = path.join(__dirname, '..', 'assets', 'icons');
const jobs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon.svg', 'favicon-32.png', 32],
  ['icon.svg', 'apple-touch-icon.png', 180]
];
Promise.all(jobs.map(([src, out, size]) =>
  sharp(path.join(dir, src), { density: 384 }).resize(size, size).png().toFile(path.join(dir, out))
)).then(() => console.log('icons written'));
