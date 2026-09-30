#!/usr/bin/env node
// Servidor local de Pulcro (solo escucha en 127.0.0.1). Sirve la interfaz, la API
// y el puente hacia Claude Code para el asistente integrado.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHealth } from './core/health.js';
import { getLive } from './core/live.js';
import { runScan, lastScan } from './core/scan.js';
import { cleanItems, emptyTrash } from './core/clean.js';
import { readHistory, logEvent, HISTORY_FILE } from './core/history.js';
import { HOME, DATA_DIR, sh, ensureDataDir } from './core/util.js';

const PORT = Number(process.env.PULCRO_PORT ?? 4747);
const HOST = '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp.js');
const PATH_ENV = [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ---------- utilidades HTTP ----------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e6) throw new Error('Body demasiado grande'); }
  return data ? JSON.parse(data) : {};
}

// Evita que una página web cualquiera le hable a Pulcro (DNS rebinding / CSRF).
function trusted(req) {
  const host = req.headers.host ?? '';
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return false;
  if (req.method !== 'GET' && req.headers['x-pulcro'] !== '1') return false;
  return true;
}

// ---------- escaneo compartido ----------
let scanning = null;
function scanOnce(actor) {
  scanning ??= runScan()
    .then(async (s) => { await logEvent({ type: 'scan', actor, safeBytes: s.totals.safe, reviewBytes: s.totals.review }); return s; })
    .finally(() => { scanning = null; });
  return scanning;
}

// ---------- canal en vivo (SSE) ----------
const clients = new Set();
let knownLines = 0;
async function countLines() {
  try { return (await fsp.readFile(HISTORY_FILE, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
}
async function pollHistory() {
  try {
    const lines = (await fsp.readFile(HISTORY_FILE, 'utf8')).split('\n').filter(Boolean);
    const fresh = lines.slice(knownLines);
    knownLines = lines.length;
    for (const l of fresh) for (const c of clients) c.write(`data: ${l}\n\n`);
  } catch {}
}

// ---------- asistente: puente a Claude Code ----------
const ASSISTANT_PROMPT = `Eres el asistente de Pulcro, una app de limpieza y salud para la Mac del usuario.
Responde en español, claro y breve, con listas cuando ayuden. Usa las herramientas de Pulcro (system_health, scan_cleanup, space_breakdown, get_history) para basarte en datos reales.
Desde aquí NO puedes limpiar nada: el usuario confirma en la app. Cuando recomiendes limpiar elementos concretos, termina tu respuesta con una línea exacta:
PULCRO_SUGERENCIAS: ["id1","id2"]
usando los IDs tal cual aparecen en scan_cleanup. Prioriza lo de riesgo "safe" y explica lo de riesgo "review" antes de sugerirlo.`;

async function claudeBin() {
  const local = path.join(HOME, '.local', 'bin', 'claude');
  if (fs.existsSync(local)) return local;
  const found = (await sh('/bin/sh', ['-c', 'command -v claude'], { env: { ...process.env, PATH: PATH_ENV } })).trim();
  return found || null;
}

async function ask(req, res) {
  const { prompt, sessionId } = await readBody(req);
  if (!prompt || typeof prompt !== 'string') return send(res, 400, { error: 'Falta la pregunta' });
  const bin = await claudeBin();
  if (!bin) return send(res, 500, { error: 'No encontré el CLI de Claude Code (claude). Instálalo desde claude.com/code.' });

  await ensureDataDir();
  const mcpConfig = JSON.stringify({ mcpServers: { pulcro: { command: process.execPath, args: [MCP_ENTRY] } } });
  const readOnly = ['system_health', 'scan_cleanup', 'space_breakdown', 'get_history'].map((t) => `mcp__pulcro__${t}`);
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', ...readOnly,
    '--disallowedTools', 'mcp__pulcro__clean_items', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
    '--append-system-prompt', ASSISTANT_PROMPT,
  ];
  if (sessionId && /^[\w-]+$/.test(sessionId)) args.push('--resume', sessionId);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const child = spawn(bin, args, { cwd: DATA_DIR, env: { ...process.env, PATH: PATH_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  res.on('close', () => { if (child.exitCode == null) child.kill('SIGTERM'); });

  let buf = '';
  let full = '';
  let sid = sessionId ?? null;
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.session_id) sid = msg.session_id;
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) { full += (full ? '\n\n' : '') + block.text; emit({ type: 'text', text: block.text }); }
          if (block.type === 'tool_use') emit({ type: 'tool', name: String(block.name).replace('mcp__pulcro__', '') });
        }
      } else if (msg.type === 'result' && msg.is_error) {
        const raw = String(msg.result || 'Claude devolvió un error');
        emit({ type: 'error', error: /authenticat|401|login/i.test(raw) ? 'Tu sesión de Claude Code expiró. Abre Terminal, ejecuta `claude`, escribe /login y vuelve a intentarlo.' : raw });
      }
    }
  });
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (code) => {
    const m = full.match(/PULCRO_SUGERENCIAS:\s*(\[[\s\S]*?\])/);
    let suggestions = [];
    try { suggestions = m ? JSON.parse(m[1]).filter((x) => typeof x === 'string') : []; } catch {}
    if (code && !full) emit({ type: 'error', error: stderr.trim().split('\n').slice(-3).join(' ') || `claude terminó con código ${code}` });
    emit({ type: 'done', sessionId: sid, suggestions });
    res.end();
  });
}

// ---------- rutas ----------
async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === '/api/health' && req.method === 'GET') return send(res, 200, await getHealth());
  if (p === '/api/live' && req.method === 'GET') return send(res, 200, await getLive());
  if (p === '/api/scan/last' && req.method === 'GET') return send(res, 200, (await lastScan()) ?? {});
  if (p === '/api/scan' && req.method === 'POST') return send(res, 200, await scanOnce('usuario'));
  if (p === '/api/history' && req.method === 'GET') return send(res, 200, await readHistory(200));
  if (p === '/api/clean' && req.method === 'POST') {
    const { ids, dryRun } = await readBody(req);
    if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: 'No hay elementos seleccionados' });
    return send(res, 200, await cleanItems(ids.map(String), { actor: 'usuario', dryRun: !!dryRun }));
  }
  if (p === '/api/empty-trash' && req.method === 'POST') return send(res, 200, await emptyTrash({ actor: 'usuario' }));
  if (p === '/api/reveal' && req.method === 'POST') {
    const { path: target } = await readBody(req);
    const ok = typeof target === 'string' && path.isAbsolute(target) && (target.startsWith(HOME + '/') || target.startsWith('/Applications/')) && fs.existsSync(target);
    if (!ok) return send(res, 400, { error: 'Ruta no válida' });
    await sh('open', ['-R', target]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/ask' && req.method === 'POST') return ask(req, res);
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': conectado\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  if (req.method !== 'GET') return send(res, 404, { error: 'No encontrado' });
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Prohibido', 'text/plain');
  try {
    return send(res, 200, await fsp.readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    return send(res, 404, 'No encontrado', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  if (!trusted(req)) return send(res, 403, { error: 'Origen no permitido' });
  try { await route(req, res); } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message }); else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') { console.log(`Pulcro ya está corriendo en http://${HOST}:${PORT}`); process.exit(0); }
  throw err;
});

knownLines = await countLines();
fs.watchFile(HISTORY_FILE, { interval: 800 }, pollHistory);
server.listen(PORT, HOST, () => console.log(`Pulcro listo en http://${HOST}:${PORT}`));
