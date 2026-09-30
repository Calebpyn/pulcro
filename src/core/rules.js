// Reglas de qué se puede limpiar y cómo. Todo ID que llega a clean() se valida
// contra estas reglas otra vez, sin importar si viene de la UI o de Claude.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, DATA_DIR, exists, listDir } from './util.js';

const h = (...p) => path.join(HOME, ...p);
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CATEGORIES = {
  caches: { label: 'Cachés de apps', hint: 'Archivos temporales que cada app vuelve a generar sola.' },
  dev: { label: 'Cachés de desarrollo', hint: 'Descargas de paquetes y compilaciones de herramientas (npm, Gradle, Xcode…).' },
  builds: { label: 'Builds y dependencias', hint: 'node_modules, .next, target… Se recuperan con npm install o un nuevo build.' },
  editors: { label: 'Extensiones obsoletas', hint: 'Versiones viejas de extensiones de VS Code / Cursor que ya no se usan.' },
  logs: { label: 'Registros (logs)', hint: 'Historiales de diagnóstico de apps.' },
  installers: { label: 'Instaladores olvidados', hint: 'Archivos .dmg, .pkg, .iso que ya cumplieron su función.' },
  large: { label: 'Archivos grandes', hint: 'Archivos de más de 1 GB. Revísalos antes: van a la Papelera.' },
};

// Riesgo "safe" = se borra directo (se regenera). "review" = va a la Papelera.
export const KINDS = {
  cache: { category: 'caches', risk: 'safe', action: 'delete' },
  logs: { category: 'logs', risk: 'safe', action: 'delete' },
  devcache: { category: 'dev', risk: 'safe', action: 'delete' },
  cmd: { category: 'dev', risk: 'safe', action: 'command' },
  build: { category: 'builds', risk: 'safe', action: 'delete' },
  vscode: { category: 'editors', risk: 'safe', action: 'delete' },
  installer: { category: 'installers', risk: 'review', action: 'trash' },
  large: { category: 'large', risk: 'review', action: 'trash' },
};

export const CACHE_ROOT = h('Library', 'Caches');
export const LOGS_ROOT = h('Library', 'Logs');
const CACHE_KEEP = [/^com\.apple\./, /^CloudKit$/, /^FamilyCircle$/, /^Pulcro$/];

export const DEV_CACHES = [
  { path: h('.gradle', 'caches'), title: 'Caché de Gradle' },
  { path: h('.cache'), title: 'Caché genérica (~/.cache)' },
  { path: h('.cargo', 'registry', 'cache'), title: 'Descargas de crates (Cargo)' },
  { path: h('Library', 'Developer', 'Xcode', 'DerivedData'), title: 'Xcode DerivedData' },
  { path: h('Library', 'Developer', 'Xcode', 'iOS DeviceSupport'), title: 'Xcode iOS DeviceSupport' },
  { path: h('Library', 'Developer', 'CoreSimulator', 'Caches'), title: 'Cachés del simulador iOS' },
  { path: h('Library', 'Android', 'sdk', '.downloadIntermediates'), title: 'Descargas incompletas de Android SDK' },
  { path: h('Library', 'Android', 'sdk', '.temp'), title: 'Temporales de Android SDK' },
  { path: h('Library', 'Arduino15', 'staging'), title: 'Instaladores de Arduino (staging)' },
  { path: h('.nuget', 'packages'), title: 'Paquetes NuGet (.NET)' },
  { path: h('.m2', 'repository'), title: 'Repositorio Maven (~/.m2)' },
  { path: h('.pub-cache'), title: 'Caché de Dart/Flutter (pub)' },
];

export const COMMANDS = {
  npm: { title: 'Caché de npm', bin: 'npm', args: ['cache', 'clean', '--force'], sizePath: h('.npm', '_cacache') },
  pnpm: { title: 'Store de pnpm (paquetes sin usar)', bin: 'pnpm', args: ['store', 'prune'], sizePath: h('Library', 'pnpm', 'store'), partial: true },
  brew: { title: 'Homebrew: versiones viejas y descargas', bin: 'brew', args: ['cleanup', '-s', '--prune=all'], sizePath: null },
};

// Artefactos regenerables. `needs` = archivo hermano que confirma que es lo que creemos.
export const BUILD_DIRS = {
  node_modules: { needs: ['package.json'] },
  '.next': { needs: ['package.json'] },
  '.nuxt': { needs: ['package.json'] },
  '.svelte-kit': { needs: ['package.json'] },
  '.turbo': { needs: ['package.json'] },
  '.parcel-cache': { needs: ['package.json'] },
  '.expo': { needs: ['package.json'] },
  target: { needs: ['Cargo.toml'] },
  '.dart_tool': { needs: ['pubspec.yaml'] },
  '.venv': { needs: ['pyproject.toml', 'requirements.txt', 'setup.py'] },
};

export const EDITOR_EXT_DIRS = [h('.vscode', 'extensions'), h('.cursor', 'extensions')];
export const INSTALLER_ROOTS = [h('Downloads'), h('Desktop'), h('Library', 'Parallels', 'Downloads')];
export const INSTALLER_EXT = /\.(dmg|pkg|iso|xip|mpkg)$/i;
export const LARGE_MIN_BYTES = 500 * 1024 * 1024;

// Nunca se tocan, ni siquiera como "archivo grande".
export const PROTECTED = [
  h('Library', 'Keychains'), h('Library', 'Mobile Documents'), h('Library', 'Mail'),
  h('Library', 'Messages'), h('Library', 'Containers'), h('Library', 'Group Containers'),
  h('Library', 'Application Support', 'Claude'), h('Library', 'Application Support', 'MobileSync'),
  h('.ssh'), h('.gnupg'), h('.Trash'), h('Pictures'), DATA_DIR, APP_ROOT,
];

const DEFAULT_PROJECT_ROOTS = ['Desktop', 'Documents', 'Developer', 'Projects', 'projects', 'code', 'dev', 'src', 'repos', 'GitHub'].map((d) => h(d));

export async function projectRoots() {
  let custom = [];
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'config.json'), 'utf8'));
    custom = (cfg.projectRoots ?? []).map((p) => p.replace(/^~/, HOME));
  } catch {}
  const all = [...new Set([...DEFAULT_PROJECT_ROOTS, ...custom])];
  const out = [];
  for (const r of all) if (await exists(r)) out.push(r);
  return out;
}

const within = (p, root) => p === root || p.startsWith(root + path.sep);
const isProtected = (p) => PROTECTED.some((r) => within(p, r));

export async function obsoleteExtensions(dir) {
  let active;
  try {
    const list = JSON.parse(await fs.readFile(path.join(dir, 'extensions.json'), 'utf8'));
    active = new Set(list.map((e) => (e.location?.path ? path.basename(e.location.path.replace(/\/$/, '')) : e.relativeLocation)).filter(Boolean));
  } catch {
    return []; // sin manifiesto no sabemos cuáles están activas: no tocamos nada
  }
  if (active.size === 0) return [];
  const out = [];
  for (const name of await listDir(dir)) {
    if (name.startsWith('.') || name === 'extensions.json') continue;
    const p = path.join(dir, name);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isDirectory() && !active.has(name)) out.push(p);
  }
  return out;
}

export function parseId(id) {
  const i = id.indexOf(':');
  if (i < 0) return null;
  return { kind: id.slice(0, i), target: id.slice(i + 1) };
}

// Devuelve { ok, kind, target, rule } o { ok:false, reason }.
export async function validateId(id) {
  const parsed = parseId(String(id));
  if (!parsed || !KINDS[parsed.kind]) return { ok: false, reason: 'ID desconocido' };
  const { kind, target } = parsed;
  const rule = KINDS[kind];

  if (kind === 'cmd') {
    return COMMANDS[target] ? { ok: true, kind, target, rule } : { ok: false, reason: 'Comando no permitido' };
  }

  if (!path.isAbsolute(target) || path.resolve(target) !== target) return { ok: false, reason: 'Ruta no canónica' };
  let real;
  try { real = await fs.realpath(target); } catch { return { ok: false, reason: 'Ya no existe' }; }
  if (real !== target) return { ok: false, reason: 'La ruta pasa por un enlace simbólico' };
  if (!within(target, HOME) || target === HOME) return { ok: false, reason: 'Fuera de tu carpeta de usuario' };

  const parent = path.dirname(target);
  const base = path.basename(target);
  const st = await fs.lstat(target);

  switch (kind) {
    case 'cache':
      if (parent !== CACHE_ROOT || CACHE_KEEP.some((re) => re.test(base))) return { ok: false, reason: 'No es una caché permitida' };
      break;
    case 'logs':
      if (parent !== LOGS_ROOT) return { ok: false, reason: 'No es un log permitido' };
      break;
    case 'devcache':
      if (!DEV_CACHES.some((d) => d.path === target)) return { ok: false, reason: 'No es una caché de desarrollo conocida' };
      break;
    case 'build': {
      const spec = BUILD_DIRS[base];
      if (!spec || !st.isDirectory()) return { ok: false, reason: 'No es un artefacto de build' };
      const roots = await projectRoots();
      if (isProtected(target)) return { ok: false, reason: 'Ruta protegida' };
      if (!roots.some((r) => within(target, r))) return { ok: false, reason: 'Fuera de las carpetas de proyectos' };
      let hasManifest = false;
      for (const f of spec.needs) if (await exists(path.join(parent, f))) hasManifest = true;
      if (!hasManifest) return { ok: false, reason: `No hay ${spec.needs.join('/')} junto a la carpeta` };
      break;
    }
    case 'vscode': {
      if (!EDITOR_EXT_DIRS.includes(parent)) return { ok: false, reason: 'No es una extensión de editor' };
      const obsolete = await obsoleteExtensions(parent);
      if (!obsolete.includes(target)) return { ok: false, reason: 'La extensión está activa' };
      break;
    }
    case 'installer':
      if (!st.isFile() || !INSTALLER_EXT.test(base) || !INSTALLER_ROOTS.some((r) => within(target, r))) return { ok: false, reason: 'No es un instalador' };
      if (isProtected(target)) return { ok: false, reason: 'Ruta protegida' };
      break;
    case 'large':
      if (!st.isFile() || st.size < LARGE_MIN_BYTES) return { ok: false, reason: 'No es un archivo grande' };
      if (isProtected(target)) return { ok: false, reason: 'Ruta protegida' };
      break;
  }
  return { ok: true, kind, target, rule };
}

export { isProtected };
