const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const SKIP_NAMES = new Set(['__MACOSX', '.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else n++;
  }
  return n;
}

function extractZipToWorkspace(buffer, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsehost-zip-'));

  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    if (!entries.length) {
      throw new Error('Archive ZIP vide');
    }

    zip.extractAllTo(tempDir, true);

    for (const junk of SKIP_NAMES) {
      const p = path.join(tempDir, junk);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }

    let sourceDir = tempDir;
    const topEntries = fs.readdirSync(tempDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !SKIP_NAMES.has(e.name));

    // ZIP avec un seul dossier racine → on aplatit (ex: mon-bot/index.js)
    if (topEntries.length === 1 && topEntries[0].isDirectory()) {
      sourceDir = path.join(tempDir, topEntries[0].name);
    }

    copyDirRecursive(sourceDir, targetDir);

    const extracted = countFiles(targetDir);
    if (extracted === 0) {
      throw new Error('Aucun fichier extrait — vérifie le contenu du ZIP');
    }

    return { extracted, message: `${extracted} fichier(s) extrait(s)` };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { extractZipToWorkspace };
