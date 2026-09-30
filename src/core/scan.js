import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HOME, DATA_DIR, sh, which, duMany, du, exists, listDir, ensureDataDir, tilde,
} from './util.js';
import {
  CATEGORIES, KINDS, CACHE_ROOT, LOGS_ROOT, DEV_CACHES, COMMANDS, BUILD_DIRS,
  EDITOR_EXT_DIRS, INSTALLER_ROOTS, PROTECTED, projectRoots, obsoleteExtensions, isProtected,
} from './rules.js';

const MIN_BYTES = 1024 * 1024; // ignora lo que pesa menos de 1 MB
const LAST_SCAN = path.join(DATA_DIR, 'last-scan.json');

function item(kind, target, bytes, title, subtitle = '', meta = {}) {
  const rule = KINDS[kind];
  return {
    id: `${kind}:${target}`,
    kind,
    category: rule.category,
    risk: rule.risk,
    action: rule.action,
    title,
    subtitle,
    path: kind === 'cmd' ? null : target,
    bytes,
    meta,
  };
}

async function scanCaches() {
  const names = (await listDir(CACHE_ROOT)).filter((n) => !/^com\.apple\.|^CloudKit$|^FamilyCircle$|^Pulcro$/.test(n) && !n.startsWith('.'));
  const paths = names.map((n) => path.join(CACHE_ROOT, n));
  const sizes = await duMany(paths);
  return paths.map((p) => item('cache', p, sizes.get(p) ?? 0, prettyCacheName(path.basename(p)), tilde(p)));
}

function prettyCacheName(name) {
  const known = {
    'company.thebrowser.Browser': 'Arc', 'Arc': 'Arc', 'go-build': 'Go (compilaciones)',
    'com.microsoft.VSCode.ShipIt': 'VS Code (actualizaciones)', 'com.microsoft.VSCode': 'VS Code',
    'ms-playwright': 'Playwright (navegadores de prueba)', 'com.figma.Desktop.ShipIt': 'Figma (actualizaciones)',
    'Homebrew': 'Homebrew (descargas)', 'com.spotify.client': 'Spotify', 'Google': 'Google / Chrome',
    'pip': 'pip (Python)', 'Yarn': 'Yarn', 'pnpm': 'pnpm', 'node-gyp': 'node-gyp', 'CocoaPods': 'CocoaPods',
    'com.google.GeminiMacOS': 'Gemini', 'SiriTTS': 'Voces de Siri', 'JetBrains': 'JetBrains IDEs',
  };
  return known[name] ?? name;
}

async function scanLogs() {
  const paths = (await listDir(LOGS_ROOT)).map((n) => path.join(LOGS_ROOT, n));
  const sizes = await duMany(paths);
  return paths.map((p) => item('logs', p, sizes.get(p) ?? 0, path.basename(p), tilde(p)));
}

async function scanDevCaches() {
  const present = [];
  for (const d of DEV_CACHES) if (await exists(d.path)) present.push(d);
  const sizes = await duMany(present.map((d) => d.path));
  return present.map((d) => item('devcache', d.path, sizes.get(d.path) ?? 0, d.title, tilde(d.path)));
}

async function scanCommands() {
  const out = [];
  for (const [key, c] of Object.entries(COMMANDS)) {
    if (!(await which(c.bin))) continue;
    let bytes = null;
    if (c.sizePath && (await exists(c.sizePath))) bytes = await du(c.sizePath);
    if (key === 'brew') {
      const dry = await sh('brew', ['cleanup', '-n', '-s', '--prune=all'], { timeout: 90_000 });
      const m = dry.match(/free approximately ([\d.]+)\s*([KMG]B)/);
      bytes = m ? Number(m[1]) * { KB: 1e3, MB: 1e6, GB: 1e9 }[m[2]] : 0;
    }
    if (bytes === 0) continue;
    out.push(item('cmd', key, bytes, c.title, `${c.bin} ${c.args.join(' ')}`, { partial: !!c.partial }));
  }
  return out;
}

async function lastActivity(projectDir, skip) {
  let latest = 0;
  for (const name of await listDir(projectDir)) {
    if (name === skip || BUILD_DIRS[name]) continue;
    const st = await fs.stat(path.join(projectDir, name)).catch(() => null);
    if (st && st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return latest || null;
}

async function scanBuilds() {
  const roots = await projectRoots();
  if (!roots.length) return [];
  const names = Object.keys(BUILD_DIRS);
  const nameExpr = names.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
  const out = await sh('find', [
    ...roots, '(', '-name', '.git', '-o', '-name', 'Library', ')', '-prune',
    '-o', '-type', 'd', '(', ...nameExpr, ')', '-prune', '-print',
  ], { timeout: 300_000 });
  const found = [];
  for (const p of out.split('\n').filter(Boolean)) {
    if (isProtected(p)) continue;
    const spec = BUILD_DIRS[path.basename(p)];
    const dir = path.dirname(p);
    let ok = false;
    for (const f of spec.needs) if (await exists(path.join(dir, f))) ok = true;
    if (ok) found.push(p);
  }
  const sizes = await duMany(found);
  const items = [];
  for (const p of found) {
    const dir = path.dirname(p);
    const last = await lastActivity(dir, path.basename(p));
    const days = last ? Math.floor((Date.now() - last) / 86_400_000) : null;
    const project = path.relative(path.dirname(dir), dir) || dir;
    items.push(item('build', p, sizes.get(p) ?? 0, `${project} › ${path.basename(p)}`, tilde(dir), { inactiveDays: days }));
  }
  return items;
}

async function scanEditors() {
  const items = [];
  for (const dir of EDITOR_EXT_DIRS) {
    const obsolete = await obsoleteExtensions(dir);
    const sizes = await duMany(obsolete);
    const editor = dir.includes('.cursor') ? 'Cursor' : 'VS Code';
    for (const p of obsolete) items.push(item('vscode', p, sizes.get(p) ?? 0, path.basename(p), `${editor} · versión sin usar`));
  }
  return items;
}

async function scanInstallers() {
  const roots = [];
  for (const r of INSTALLER_ROOTS) if (await exists(r)) roots.push(r);
  if (!roots.length) return [];
  const out = await sh('find', [
    ...roots, '-maxdepth', '4', '-type', 'f',
    '(', '-iname', '*.dmg', '-o', '-iname', '*.pkg', '-o', '-iname', '*.iso', '-o', '-iname', '*.xip', '-o', '-iname', '*.mpkg', ')',
    '-size', '+20M',
  ]);
  const items = [];
  for (const p of out.split('\n').filter(Boolean)) {
    if (isProtected(p)) continue;
    const st = await fs.stat(p).catch(() => null);
    if (st) items.push(item('installer', p, st.size, path.basename(p), tilde(path.dirname(p))));
  }
  return items;
}

async function scanLarge() {
  const pruneExpr = PROTECTED.flatMap((p, i) => (i ? ['-o', '-path', p] : ['-path', p]));
  const out = await sh('find', [
    HOME, '-xdev', '(', ...pruneExpr, '-o', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune',
    '-o', '-type', 'f', '-size', '+1G', '-print',
  ], { timeout: 300_000 });
  const items = [];
  for (const p of out.split('\n').filter(Boolean)) {
    const st = await fs.stat(p).catch(() => null);
    if (st) items.push(item('large', p, st.size, path.basename(p), tilde(path.dirname(p)), { modified: st.mtime.toISOString() }));
  }
  return items;
}

// Solo informativo: qué ocupa más espacio aunque no se limpie automáticamente.
async function scanInsights() {
  const apps = (await listDir('/Applications')).filter((n) => n.endsWith('.app')).map((n) => path.join('/Applications', n));
  const supportRoot = path.join(HOME, 'Library', 'Application Support');
  const support = (await listDir(supportRoot)).map((n) => path.join(supportRoot, n));
  const homeTop = (await listDir(HOME)).filter((n) => n !== 'Library' && n !== '.Trash').map((n) => path.join(HOME, n));
  const [appSizes, supSizes, homeSizes] = await Promise.all([duMany(apps), duMany(support), duMany(homeTop)]);
  const top = (m, n, min) => [...m].filter(([, b]) => b >= min).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([p, bytes]) => ({ path: p, name: path.basename(p).replace(/\.app$/, ''), bytes }));
  const trashBytes = await du(path.join(HOME, '.Trash')).catch(() => null);
  return {
    apps: top(appSizes, 15, 200e6),
    appData: top(supSizes, 15, 300e6),
    home: top(homeSizes, 15, 200e6),
    trash: { bytes: trashBytes || null },
  };
}

export async function runScan({ onProgress } = {}) {
  const started = Date.now();
  const steps = [
    ['caches', scanCaches], ['logs', scanLogs], ['dev', scanDevCaches], ['cmd', scanCommands],
    ['builds', scanBuilds], ['editors', scanEditors], ['installers', scanInstallers], ['large', scanLarge],
  ];
  const results = await Promise.all(steps.map(async ([name, fn]) => {
    const r = await fn().catch((e) => { console.error(`scan ${name}:`, e); return []; });
    onProgress?.(name);
    return r;
  }));
  // Un archivo grande que ya está dentro de otro elemento (una caché, un .iso ya listado…) no se repite.
  const flat = results.flat();
  const covered = flat.filter((i) => i.kind !== 'large' && i.path).map((i) => i.path);
  const items = flat
    .filter((i) => i.kind !== 'large' || !covered.some((c) => i.path === c || i.path.startsWith(c + '/')))
    .filter((i) => i.bytes == null || i.bytes >= MIN_BYTES)
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const insights = await scanInsights();

  const categories = Object.entries(CATEGORIES).map(([key, c]) => {
    const list = items.filter((i) => i.category === key);
    return { key, ...c, count: list.length, bytes: list.reduce((s, i) => s + (i.bytes ?? 0), 0) };
  }).filter((c) => c.count > 0);

  const scan = {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    totals: {
      safe: items.filter((i) => i.risk === 'safe').reduce((s, i) => s + (i.bytes ?? 0), 0),
      review: items.filter((i) => i.risk === 'review').reduce((s, i) => s + (i.bytes ?? 0), 0),
    },
    categories,
    items,
    insights,
  };
  await ensureDataDir();
  await fs.writeFile(LAST_SCAN, JSON.stringify(scan));
  return scan;
}

// Quita del último escaneo lo que ya se limpió, para que todas las vistas muestren lo mismo.
export async function pruneLastScan(ids) {
  const scan = await lastScan();
  if (!scan?.items) return;
  const gone = new Set(ids);
  scan.items = scan.items.filter((i) => !gone.has(i.id));
  scan.totals = {
    safe: scan.items.filter((i) => i.risk === 'safe').reduce((s, i) => s + (i.bytes ?? 0), 0),
    review: scan.items.filter((i) => i.risk === 'review').reduce((s, i) => s + (i.bytes ?? 0), 0),
  };
  scan.categories = scan.categories.map((c) => {
    const list = scan.items.filter((i) => i.category === c.key);
    return { ...c, count: list.length, bytes: list.reduce((s, i) => s + (i.bytes ?? 0), 0) };
  }).filter((c) => c.count > 0);
  await fs.writeFile(LAST_SCAN, JSON.stringify(scan));
}

export async function lastScan() {
  try { return JSON.parse(await fs.readFile(LAST_SCAN, 'utf8')); } catch { return null; }
}
