// Organizar: acomoda los archivos sueltos de Descargas y Escritorio en carpetas por tipo,
// con reglas personales opcionales y un registro de cada orden para poder deshacerlo.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HOME, DATA_DIR, exists, ensureDataDir } from './util.js';
import { logEvent } from './history.js';

const h = (...p) => path.join(HOME, ...p);
export const SOURCES = [h('Downloads'), h('Desktop')];
const MANIFESTS = path.join(DATA_DIR, 'organize');
const TRASH = h('.Trash');
const RECENT_MS = 10 * 60_000; // no se tocan archivos modificados en los últimos 10 minutos

// Categorías por defecto: [clave, etiqueta, destino, prueba(nombre, ext)]
const CATEGORIES = [
  ['screenshots', 'Capturas de pantalla', h('Pictures', 'Capturas de pantalla'),
    (n) => /^(Screenshot|Captura de pantalla|Screen Shot|Grabación de pantalla|Screen Recording)\b/i.test(n)],
  ['ai-art', 'Arte IA', h('Pictures', 'Arte IA'),
    (n, e) => IMAGE.has(e) && /midjourney|mj\.run|dall-?e|_imagine_|stable.?diffusion/i.test(n)],
  ['images', 'Imágenes', h('Pictures', 'Imágenes'), (n, e) => IMAGE.has(e)],
  ['video', 'Videos', h('Movies', 'Videos'), (n, e) => VIDEO.has(e)],
  ['audio', 'Audio', h('Music', 'Audio'), (n, e) => AUDIO.has(e)],
  ['sheets', 'Hojas de cálculo', h('Documents', 'Hojas de cálculo'), (n, e) => SHEETS.has(e)],
  ['slides', 'Presentaciones', h('Documents', 'Presentaciones'), (n, e) => SLIDES.has(e)],
  ['docs', 'Documentos', h('Documents', 'Documentos'), (n, e) => DOCS.has(e)],
  ['fonts', 'Fuentes', h('Documents', 'Fuentes'), (n, e) => FONTS.has(e)],
  ['archives', 'Comprimidos', h('Documents', 'Comprimidos'), (n, e) => ARCHIVES.has(e)],
];
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'tiff', 'tif', 'bmp', 'svg', 'raf', 'cr2', 'nef', 'arw', 'dng']);
const VIDEO = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm']);
const AUDIO = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'aiff', 'ogg']);
const SHEETS = new Set(['xlsx', 'xls', 'csv', 'numbers', 'ods', 'tsv']);
const SLIDES = new Set(['pptx', 'ppt', 'key', 'odp']);
const DOCS = new Set(['pdf', 'doc', 'docx', 'pages', 'txt', 'rtf', 'md', 'odt', 'epub', 'drawio']);
const FONTS = new Set(['otf', 'ttf', 'woff', 'woff2']);
const ARCHIVES = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);

// Basura segura de mandar a la Papelera.
const JUNK = [
  [/^desktop\.ini$|^Thumbs\.db$|^\$RECYCLE\.BIN$/i, 'Resto de Windows'],
  [/\.(crdownload|part|download)$/i, 'Descarga incompleta'],
  [/^~\$|^\.~/, 'Archivo temporal de Office/Tableau'],
  [/^\.com\.[\w.]+\.[A-Za-z]{6}$/, 'Archivo temporal de una app'],
];
const SKIP = new Set(['.DS_Store', '.localized']);
// Credenciales: nunca se mueven aunque coincidan con una regla.
const SENSITIVE = /recovery.?codes|password|contraseñ|\.pem$|\.key$|id_rsa|secret|token/i;

const norm = (s) => s.normalize('NFC');
const CODE_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'Package.swift', 'pyproject.toml', 'go.mod', 'pubspec.yaml', 'Gemfile', 'pom.xml', 'build.gradle'];
async function isCodeProject(dir) {
  for (const m of CODE_MARKERS) if (await exists(path.join(dir, m))) return true;
  try { return (await fs.readdir(dir)).some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace')); } catch { return false; }
}
const ext = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const tilde = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const within = (p, root) => p === root || p.startsWith(root + path.sep);
// Destinos válidos: carpetas normales de tu usuario (nada en Library, ocultas ni dentro de la fototeca).
const okDestination = (to) => within(to, HOME) && to !== HOME && !within(to, h('Library'))
  && !path.relative(HOME, to).split(path.sep).some((seg) => seg.startsWith('.') || seg.endsWith('.photoslibrary'));

async function config() {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch { return {}; }
}

// Reglas personales: { "organizeRules": [ { "match": "regex", "to": "~/Documents/Trabajo/X", "label": "…", "folders": false } ] }
// Con "folders": true la regla también mueve carpetas (nunca proyectos de código).
async function customRules() {
  const cfg = await config();
  const out = [];
  for (const r of cfg.organizeRules ?? []) {
    try {
      const to = path.resolve(String(r.to).replace(/^~/, HOME));
      if (!okDestination(to)) continue;
      out.push({ re: new RegExp(r.match, 'i'), to, label: r.label ?? path.basename(to), folders: r.folders === true });
    } catch {}
  }
  return out;
}

async function md5(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

// Duplicados exactos: mismo contenido; se conserva el de nombre más corto (el "original").
async function findDuplicates(files) {
  const bySize = new Map();
  for (const f of files) {
    if (f.size === 0) continue;
    const list = bySize.get(f.size) ?? [];
    list.push(f);
    bySize.set(f.size, list);
  }
  const dupes = new Map();
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map();
    for (const f of group) {
      const k = await md5(f.path).catch(() => null);
      if (!k) continue;
      byHash.set(k, [...(byHash.get(k) ?? []), f]);
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      same.sort((a, b) => a.name.length - b.name.length || a.mtime - b.mtime);
      for (const d of same.slice(1)) dupes.set(d.path, same[0]);
    }
  }
  return dupes;
}

/** Calcula qué haría "Organizar" sin mover nada. */
export async function planOrganize() {
  const rules = await customRules();
  const entries = [];
  for (const src of SOURCES) {
    let names = [];
    try { names = await fs.readdir(src); } catch { continue; }
    for (const raw of names) {
      if (SKIP.has(raw)) continue;
      const p = path.join(src, raw);
      const st = await fs.lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      entries.push({ path: p, name: norm(raw), source: src, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
    }
  }

  const dupes = await findDuplicates(entries.filter((e) => !e.isDir));
  const items = [];
  for (const e of entries) {
    const base = { id: e.path, path: e.path, name: e.name, from: tilde(e.source), isDir: e.isDir, bytes: e.isDir ? null : e.size };
    if (Date.now() - e.mtime < RECENT_MS || SENSITIVE.test(e.name)) continue;

    const junk = JUNK.find(([re]) => re.test(e.name));
    if (junk) { items.push({ ...base, action: 'trash', group: 'Papelera', reason: junk[1], to: TRASH }); continue; }
    if (dupes.has(e.path)) {
      items.push({ ...base, action: 'trash', group: 'Papelera', reason: `Duplicado exacto de "${dupes.get(e.path).name}"`, to: TRASH });
      continue;
    }

    const rule = rules.find((r) => r.re.test(e.name) && (!e.isDir || r.folders));
    if (rule && e.isDir && (await isCodeProject(e.path))) continue;
    if (rule) { items.push({ ...base, action: 'move', group: rule.label, reason: 'Regla personal', to: rule.to }); continue; }

    // Las carpetas solo se mueven con una regla personal: pueden ser proyectos.
    if (e.isDir) continue;
    const e2 = ext(e.name);
    const cat = CATEGORIES.find(([, , , test]) => test(e.name, e2));
    if (!cat) continue;
    // En el Escritorio solo se ordenan capturas y basura; el resto se queda a menos que haya regla.
    if (e.source === h('Desktop') && cat[0] !== 'screenshots') continue;
    items.push({ ...base, action: 'move', group: cat[1], reason: e2 ? `.${e2}` : 'Tipo de archivo', to: cat[2] });
  }

  items.sort((a, b) => a.group.localeCompare(b.group, 'es') || a.name.localeCompare(b.name, 'es'));
  const groups = {};
  for (const i of items) {
    const g = (groups[i.group] ??= { name: i.group, to: tilde(i.to), count: 0, bytes: 0, action: i.action });
    g.count++;
    g.bytes += i.bytes ?? 0;
  }
  return { plannedAt: new Date().toISOString(), sources: SOURCES.map(tilde), items, groups: Object.values(groups) };
}

async function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!(await exists(dest))) return dest;
  const e = path.extname(name);
  const stem = path.basename(name, e);
  for (let i = 2; ; i++) {
    dest = path.join(dir, `${stem} (${i})${e}`);
    if (!(await exists(dest))) return dest;
  }
}

/**
 * Aplica el orden a los elementos indicados. Los destinos se recalculan aquí (nunca
 * vienen del cliente), así que solo se mueve lo que el plan propone.
 */
export async function applyOrganize(ids, { actor = 'usuario' } = {}) {
  const plan = await planOrganize();
  const wanted = new Set(ids);
  const moves = [];
  const failed = [];
  for (const item of plan.items.filter((i) => wanted.has(i.id))) {
    try {
      await fs.mkdir(item.to, { recursive: true });
      const dest = await uniqueDest(item.to, path.basename(item.path));
      await fs.rename(item.path, dest);
      moves.push({ from: item.path, to: dest, trash: item.action === 'trash', group: item.group, bytes: item.bytes });
    } catch (err) {
      failed.push({ name: item.name, error: err.code === 'EPERM' || err.code === 'EACCES' ? 'macOS no dio permiso' : err.message });
    }
  }
  let manifestId = null;
  if (moves.length) {
    await ensureDataDir();
    await fs.mkdir(MANIFESTS, { recursive: true });
    const at = new Date().toISOString();
    manifestId = at.replace(/[:.]/g, '-');
    await fs.writeFile(path.join(MANIFESTS, `${manifestId}.json`), JSON.stringify({ at, actor, moves }, null, 1));
    await logEvent({
      type: 'organize', actor, manifestId,
      moved: moves.filter((m) => !m.trash).length, trashed: moves.filter((m) => m.trash).length,
    });
  }
  return { manifestId, moved: moves.filter((m) => !m.trash).length, trashed: moves.filter((m) => m.trash).length, failed };
}

const validManifestId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id);

export async function listOrganizeRuns(limit = 10) {
  let files = [];
  try { files = (await fs.readdir(MANIFESTS)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const runs = [];
  for (const f of files.sort().reverse().slice(0, limit)) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(MANIFESTS, f), 'utf8'));
      runs.push({
        id: f.replace(/\.json$/, ''), at: m.at, undoneAt: m.undoneAt ?? null,
        moved: m.moves.filter((x) => !x.trash).length, trashed: m.moves.filter((x) => x.trash).length,
      });
    } catch {}
  }
  return runs;
}

/** Regresa cada archivo a donde estaba (si sigue en el destino y el origen está libre). */
export async function undoOrganize(id, { actor = 'usuario' } = {}) {
  if (!validManifestId(id)) throw new Error('Registro no válido');
  const file = path.join(MANIFESTS, `${id}.json`);
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  if (m.undoneAt) throw new Error('Este orden ya se deshizo');
  let restored = 0;
  const skipped = [];
  for (const mv of [...m.moves].reverse()) {
    // Solo se restaura dentro de tu carpeta de usuario.
    if (!within(mv.from, HOME) || !within(mv.to, HOME)) { skipped.push(path.basename(mv.from)); continue; }
    if (!(await exists(mv.to)) || (await exists(mv.from))) { skipped.push(path.basename(mv.from)); continue; }
    try {
      await fs.mkdir(path.dirname(mv.from), { recursive: true });
      await fs.rename(mv.to, mv.from);
      restored++;
    } catch { skipped.push(path.basename(mv.from)); }
  }
  // Quita carpetas de destino que quedaron vacías.
  const dirs = [...new Set(m.moves.filter((x) => !x.trash).map((x) => path.dirname(x.to)))].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      const left = (await fs.readdir(d)).filter((n) => n !== '.DS_Store');
      // Solo carpetas creadas por el orden (al menos dos niveles bajo tu usuario, p. ej. ~/Documents/Trabajo).
      if (!left.length && okDestination(d) && path.relative(HOME, d).split(path.sep).length >= 2) await fs.rm(d, { recursive: true });
    } catch {}
  }
  m.undoneAt = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify(m, null, 1));
  await logEvent({ type: 'organize-undo', actor, manifestId: id, restored, skipped: skipped.length });
  return { restored, skipped };
}
