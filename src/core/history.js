// Bitácora de escaneos y limpiezas. El servidor la vigila y avisa a la interfaz en vivo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, ensureDataDir } from './util.js';

export const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

export async function logEvent(event) {
  await ensureDataDir();
  const entry = { at: new Date().toISOString(), ...event };
  await fs.appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

export async function readHistory(limit = 100) {
  try {
    const lines = (await fs.readFile(HISTORY_FILE, 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}
