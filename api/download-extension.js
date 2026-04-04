// api/download-extension.js
// Vercel serverless function — zips the /extension folder and streams it to the browser.
// Uses the built-in Node.js `zlib` + `stream` modules; no extra dependencies required.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Recursively collect all files under `dir`.
 * Returns an array of { abs, rel } where `rel` is the path inside the zip.
 */
function walk(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(abs, rel));
    } else {
      results.push({ abs, rel });
    }
  }
  return results;
}

/**
 * Build a ZIP file buffer in pure Node.js (no npm packages needed).
 * Uses DEFLATE compression via zlib.deflateRawSync.
 */
function buildZip(files) {
  const centralDir = [];
  const chunks     = [];
  let offset       = 0;

  const writeUInt16LE = (buf, val, pos) => { buf.writeUInt16LE(val, pos); };
  const writeUInt32LE = (buf, val, pos) => { buf.writeUInt32LE(val, pos); };

  function crc32(buf) {
    const table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })();
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const dosDate = () => {
    const d = new Date();
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    return { date, time };
  };

  for (const { abs, rel } of files) {
    const content    = fs.readFileSync(abs);
    const compressed = zlib.deflateRawSync(content, { level: 6 });
    const crc        = crc32(content);
    const nameBytes  = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
    const { date, time } = dosDate();

    // Local file header
    const lh = Buffer.alloc(30 + nameBytes.length);
    writeUInt32LE(lh, 0x04034b50, 0);   // signature
    writeUInt16LE(lh, 20, 4);            // version needed
    writeUInt16LE(lh, 0, 6);             // flags
    writeUInt16LE(lh, 8, 8);             // deflate
    writeUInt16LE(lh, time, 10);
    writeUInt16LE(lh, date, 12);
    writeUInt32LE(lh, crc, 14);
    writeUInt32LE(lh, compressed.length, 18);
    writeUInt32LE(lh, content.length, 22);
    writeUInt16LE(lh, nameBytes.length, 26);
    writeUInt16LE(lh, 0, 28);
    nameBytes.copy(lh, 30);

    chunks.push(lh, compressed);

    // Central directory entry
    const cd = Buffer.alloc(46 + nameBytes.length);
    writeUInt32LE(cd, 0x02014b50, 0);   // signature
    writeUInt16LE(cd, 20, 4);            // version made by
    writeUInt16LE(cd, 20, 6);            // version needed
    writeUInt16LE(cd, 0, 8);             // flags
    writeUInt16LE(cd, 8, 10);            // deflate
    writeUInt16LE(cd, time, 12);
    writeUInt16LE(cd, date, 14);
    writeUInt32LE(cd, crc, 16);
    writeUInt32LE(cd, compressed.length, 20);
    writeUInt32LE(cd, content.length, 24);
    writeUInt16LE(cd, nameBytes.length, 28);
    writeUInt16LE(cd, 0, 30);            // extra len
    writeUInt16LE(cd, 0, 32);            // comment len
    writeUInt16LE(cd, 0, 34);            // disk start
    writeUInt16LE(cd, 0, 36);            // internal attrs
    writeUInt32LE(cd, 0, 38);            // external attrs
    writeUInt32LE(cd, offset, 42);       // local header offset
    nameBytes.copy(cd, 46);

    centralDir.push(cd);
    offset += lh.length + compressed.length;
  }

  const cdBuf   = Buffer.concat(centralDir);
  const eocd    = Buffer.alloc(22);
  writeUInt32LE(eocd, 0x06054b50, 0);
  writeUInt16LE(eocd, 0, 4);
  writeUInt16LE(eocd, 0, 6);
  writeUInt16LE(eocd, centralDir.length, 8);
  writeUInt16LE(eocd, centralDir.length, 10);
  writeUInt32LE(eocd, cdBuf.length, 12);
  writeUInt32LE(eocd, offset, 16);
  writeUInt16LE(eocd, 0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

module.exports = function handler(req, res) {
  try {
    // Resolve the extension folder relative to the project root
    const extDir = path.resolve(process.cwd(), 'extension');

    if (!fs.existsSync(extDir)) {
      return res.status(404).json({ error: 'extension folder not found' });
    }

    const files  = walk(extDir, 'extension');
    const zipBuf = buildZip(files);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="directcast-extension.zip"');
    res.setHeader('Content-Length', zipBuf.length);
    res.setHeader('Cache-Control', 'no-store');
    res.end(zipBuf);
  } catch (err) {
    console.error('[download-extension]', err);
    res.status(500).json({ error: err.message });
  }
};
