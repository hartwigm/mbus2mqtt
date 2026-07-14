import * as fs from 'fs';
import * as path from 'path';

// Version comes from package.json (single source of truth). The build date is
// derived from the mtime of this compiled file — `npm run build` rewrites it,
// so it reflects when the running instance was actually built/deployed. If the
// update flow left a .version file (short git SHA), we surface that too.

function pkgVersion(): string {
  try {
    const p = path.resolve(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function gitRef(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '.version'),
    '/opt/mbus2mqtt/.version',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const v = fs.readFileSync(p, 'utf8').trim();
        if (v) return v;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function buildDate(): Date {
  try {
    return fs.statSync(__filename).mtime;
  } catch {
    return new Date();
  }
}

export const VERSION = pkgVersion();
export const GIT_REF = gitRef();
export const BUILD_DATE = buildDate();

// e.g. "v1.0.0 · 2026-07-14" or "v1.0.0 · a4d6f31 · 2026-07-14"
export function versionLabel(): string {
  const date = BUILD_DATE.toISOString().slice(0, 10);
  return GIT_REF ? `v${VERSION} · ${GIT_REF} · ${date}` : `v${VERSION} · ${date}`;
}
