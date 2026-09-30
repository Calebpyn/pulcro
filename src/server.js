#!/usr/bin/env node
// Servidor local de Pulcro (solo escucha en 127.0.0.1). Sirve la interfaz, la API
// y el canal en vivo con lo que Claude hace vía MCP.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHealth } from './core/health.js';
import { getLive } from './core/live.js';
import { runScan, lastScan } from './core/scan.js';
import { cleanItems, emptyTrash } from './core/clean.js';
import { readHistory, logEvent, HISTORY_FILE } from './core/history.js';
import { HOME, sh } from './core/util.js';

const PORT = Number(process.env.PULCRO_PORT ?? 4747);
const HOST = '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

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
