import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const pexec = promisify(execFile);

export const HOME = os.homedir();
export const DATA_DIR = path.join(HOME, 'Library', 'Application Support', 'Pulcro');
export const DATA_VOLUME = '/System/Volumes/Data';

// Ejecuta un comando y devuelve stdout aunque termine con error (du/find fallan
// parcialmente en carpetas protegidas pero su salida sigue siendo útil).
export async function sh(cmd, args = [], { timeout = 120_000, env } = {}) {
  try {
    const { stdout } = await pexec(cmd, args, {
      maxBuffer: 128 * 1024 * 1024,
      timeout,
      env: env ?? { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
    });
    return stdout;
  } catch (err) {
    return err.stdout ?? '';
  }
}

export async function which(bin) {
  const out = await sh('/bin/sh', ['-c', `command -v ${bin}`]);
  return out.trim() || null;
}

// Tamaño en bytes de varias rutas con una sola llamada a du.
export async function duMany(paths) {
  const sizes = new Map();
  const chunkSize = 200;
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const out = await sh('du', ['-sk', ...chunk], { timeout: 600_000 });
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024);
    }
  }
  return sizes;
}

export async function du(p) {
  return (await duMany([p])).get(p) ?? 0;
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function listDir(p) {
  try { return await fs.readdir(p); } catch { return []; }
}

export async function freeBytes() {
  const s = await fs.statfs(DATA_VOLUME);
  return s.bavail * s.bsize;
}

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (Math.abs(n) >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function tilde(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

export async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}
