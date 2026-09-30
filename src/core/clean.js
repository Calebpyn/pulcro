import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME, sh, du, freeBytes, exists } from './util.js';
import { validateId, COMMANDS } from './rules.js';
import { lastScan, pruneLastScan } from './scan.js';
import { logEvent } from './history.js';

const TRASH = path.join(HOME, '.Trash');

async function moveToTrash(p) {
  let dest = path.join(TRASH, path.basename(p));
  if (await exists(dest)) {
    const ext = path.extname(p);
    const stem = path.basename(p, ext);
    dest = path.join(TRASH, `${stem} ${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`);
  }
  await fs.rename(p, dest);
  return dest;
}

/**
 * Limpia los elementos indicados por ID. Cada ID se valida de nuevo contra las
 * reglas (rules.js) antes de tocar nada.
 * @param {string[]} ids
 * @param {{actor?: string, dryRun?: boolean}} opts
 */
export async function cleanItems(ids, { actor = 'usuario', dryRun = false } = {}) {
  const scan = await lastScan();
  const titles = new Map(scan?.items.map((i) => [i.id, i.title]) ?? []);
  const before = await freeBytes();
  const results = [];

  for (const id of [...new Set(ids)]) {
    const v = await validateId(id);
    const title = titles.get(id) ?? path.basename(id.split(':').slice(1).join(':'));
    if (!v.ok) { results.push({ id, title, ok: false, error: v.reason }); continue; }

    try {
      if (v.kind === 'cmd') {
        const c = COMMANDS[v.target];
        const bytes = c.sizePath && (await exists(c.sizePath)) ? await du(c.sizePath) : null;
        if (!dryRun) await sh(c.bin, c.args, { timeout: 600_000 });
        results.push({ id, title, ok: true, action: 'command', bytes });
        continue;
      }
      const bytes = await du(v.target);
      if (!dryRun) {
        if (v.rule.action === 'trash') await moveToTrash(v.target);
        else await fs.rm(v.target, { recursive: true, force: true, maxRetries: 2 });
      }
      results.push({ id, title, ok: true, action: v.rule.action, bytes });
    } catch (err) {
      results.push({ id, title, ok: false, error: err.code === 'EPERM' || err.code === 'EACCES' ? 'macOS no dio permiso' : err.message });
    }
  }

  const after = await freeBytes();
  const estimated = results.filter((r) => r.ok).reduce((s, r) => s + (r.bytes ?? 0), 0);
  const trashed = results.filter((r) => r.ok && r.action === 'trash').reduce((s, r) => s + (r.bytes ?? 0), 0);
  const summary = {
    dryRun,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    estimatedBytes: estimated,
    freedBytes: dryRun ? 0 : Math.max(0, after - before),
    inTrashBytes: trashed,
    results,
  };
  if (!dryRun && summary.ok > 0) {
    await pruneLastScan(results.filter((r) => r.ok).map((r) => r.id));
    await logEvent({
      type: 'clean', actor,
      freedBytes: summary.freedBytes, estimatedBytes: estimated, inTrashBytes: trashed,
      items: results.filter((r) => r.ok).map((r) => ({ title: r.title, bytes: r.bytes, action: r.action })),
      failed: summary.failed,
    });
  }
  return summary;
}

export async function emptyTrash({ actor = 'usuario' } = {}) {
  const before = await freeBytes();
  await sh('osascript', ['-e', 'tell application "Finder" to empty trash'], { timeout: 600_000 });
  const freed = Math.max(0, (await freeBytes()) - before);
  await logEvent({ type: 'empty-trash', actor, freedBytes: freed });
  return { freedBytes: freed };
}
