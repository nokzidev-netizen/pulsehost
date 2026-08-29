const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractZipToWorkspace } = require('./zipExtract');

const SKIP_NAMES = new Set(['__MACOSX', '.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function flattenSingleRootDir(tempDir) {
  for (const junk of SKIP_NAMES) {
    const p = path.join(tempDir, junk);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  let sourceDir = tempDir;
  const topEntries = fs.readdirSync(tempDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !SKIP_NAMES.has(e.name));

  if (topEntries.length === 1 && topEntries[0].isDirectory()) {
    sourceDir = path.join(tempDir, topEntries[0].name);
  }
  return sourceDir;
}

function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

async function extractRarToWorkspace(buffer, targetDir) {
  let createExtractorFromData;
  try {
    ({ createExtractorFromData } = require('node-unrar-js'));
  } catch {
    throw new Error('Support RAR indisponible sur ce serveur');
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsehost-rar-'));

  try {
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const extractor = await createExtractorFromData({ data });
    const extracted = extractor.extract();
    const fileHeaders = [...extracted.files];

    if (!fileHeaders.length) throw new Error('Archive RAR vide');

    for (const file of fileHeaders) {
      if (file.fileHeader.flags.directory) continue;
      const name = file.fileHeader.name.replace(/\\/g, '/');
      if (!name || name.includes('..') || SKIP_NAMES.has(name.split('/')[0])) continue;

      const dest = path.join(tempDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(file.extraction));
    }

    const sourceDir = flattenSingleRootDir(tempDir);
    copyDirRecursive(sourceDir, targetDir);

    const total = countFiles(targetDir);
    if (total === 0) throw new Error('Aucun fichier extrait — vérifie le contenu du RAR');

    return { extracted: total, message: `${total} fichier(s) extrait(s) depuis RAR` };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function extractArchiveToWorkspace(buffer, filename, targetDir) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.rar')) return extractRarToWorkspace(buffer, targetDir);
  if (lower.endsWith('.zip')) return extractZipToWorkspace(buffer, targetDir);
  throw new Error('Archive non supportée — utilise ZIP ou RAR');
}

module.exports = { extractArchiveToWorkspace, extractRarToWorkspace };
