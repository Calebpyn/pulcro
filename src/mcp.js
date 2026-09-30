#!/usr/bin/env node
// Servidor MCP de Pulcro: el canal por el que Claude (Claude Code, Claude Desktop
// o el asistente dentro de la app) revisa y limpia la Mac. Todo lo que Claude
// hace aquí queda en la bitácora compartida y aparece en vivo en la app.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getHealth } from './core/health.js';
import { runScan, lastScan } from './core/scan.js';
import { cleanItems } from './core/clean.js';
import { readHistory, logEvent } from './core/history.js';
import { formatBytes as fb, tilde } from './core/util.js';
import { CATEGORIES } from './core/rules.js';

const server = new McpServer({ name: 'pulcro', version: '0.1.0' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });

server.registerTool('system_health', {
  title: 'Salud del sistema',
  description: 'Estado de la Mac: espacio en disco, S.M.A.R.T. del SSD, batería (ciclos, capacidad), RAM, swap, días sin reiniciar y recomendaciones.',
  annotations: { readOnlyHint: true },
}, async () => {
  const h = await getHealth();
  const d = h.disk; const m = h.memory; const b = h.battery;
  return text([
    `Mac: ${h.machine.model} · ${h.machine.chip} · macOS ${h.machine.macos}`,
    `Disco: ${fb(d.free)} libres de ${fb(d.total)} (${d.usedPct}% usado) · S.M.A.R.T.: ${d.smart}`,
    `RAM: ${fb(m.total)} · memoria libre ${m.freePct ?? '?'}% · swap ${fb(m.swapUsed)} / ${fb(m.swapTotal)}`,
    b ? `Batería: ${b.charge}% · capacidad máx. ${b.maxCapacity}% · ${b.cycles} ciclos · ${b.condition}` : 'Batería: no disponible',
    `Encendida: ${Math.floor(h.uptime / 86400)} días · carga ${h.load.map((l) => l.toFixed(1)).join(' ')}`,
    '', 'Recomendaciones:',
    ...h.recommendations.map((r) => `- [${r.level}] ${r.title}: ${r.detail}`),
  ].join('\n'));
});

server.registerTool('scan_cleanup', {
  title: 'Escanear espacio recuperable',
  description: 'Lista lo que se puede limpiar, con ID, tamaño y riesgo. riesgo=safe se borra directo porque se regenera sola; riesgo=review se manda a la Papelera. Por defecto usa el último escaneo si tiene menos de 30 min; fresh=true fuerza uno nuevo (tarda ~20-60 s).',
  inputSchema: {
    fresh: z.boolean().optional().describe('Forzar un escaneo nuevo'),
    category: z.enum(Object.keys(CATEGORIES)).optional().describe('Filtrar por categoría'),
    min_mb: z.number().optional().describe('Solo elementos de al menos este tamaño en MB (por defecto 10)'),
  },
  annotations: { readOnlyHint: true },
}, async ({ fresh, category, min_mb = 10 }) => {
  let scan = await lastScan();
  const stale = !scan || Date.now() - Date.parse(scan.scannedAt) > 30 * 60_000;
  if (fresh || stale) {
    scan = await runScan();
    await logEvent({ type: 'scan', actor: 'claude', safeBytes: scan.totals.safe, reviewBytes: scan.totals.review });
  }
  const items = scan.items.filter((i) => (!category || i.category === category) && (i.bytes ?? Infinity) >= min_mb * 1e6);
  const lines = [
    `Escaneo: ${new Date(scan.scannedAt).toLocaleString('es-MX')}`,
    `Recuperable seguro: ${fb(scan.totals.safe)} · A revisar: ${fb(scan.totals.review)}`,
    '',
  ];
  for (const c of scan.categories) {
    const list = items.filter((i) => i.category === c.key);
    if (!list.length) continue;
    lines.push(`## ${c.label} (${fb(c.bytes)}) — ${c.hint}`);
    for (const i of list) {
      const extra = i.meta?.inactiveDays != null ? ` · proyecto sin cambios hace ${i.meta.inactiveDays} días` : '';
      lines.push(`- ${fb(i.bytes)} · ${i.risk} · ${i.title}${i.subtitle ? ` (${i.subtitle})` : ''}${extra}\n  id: ${i.id}`);
    }
    lines.push('');
  }
  if (!items.length) lines.push('No hay elementos que cumplan el filtro.');
  return text(lines.join('\n'));
});

server.registerTool('space_breakdown', {
  title: 'Qué ocupa más espacio',
  description: 'Apps más pesadas, datos de apps en Application Support y carpetas más grandes del usuario (según el último escaneo). Es solo informativo: estas cosas no se limpian automáticamente.',
  annotations: { readOnlyHint: true },
}, async () => {
  const scan = (await lastScan()) ?? (await runScan());
  const fmt = (list) => list.map((x) => `- ${fb(x.bytes)} · ${x.name} (${tilde(x.path)})`).join('\n') || '- (nada relevante)';
  const { apps, appData, home, trash } = scan.insights;
  return text(`## Apps\n${fmt(apps)}\n\n## Datos de apps (~/Library/Application Support)\n${fmt(appData)}\n\n## Carpetas de tu usuario\n${fmt(home)}\n\nPapelera: ${trash.bytes ? fb(trash.bytes) : 'no se pudo medir'}`);
});

server.registerTool('clean_items', {
  title: 'Limpiar elementos',
  description: 'Limpia elementos por su ID (sacados de scan_cleanup). Los "safe" se borran; los "review" van a la Papelera. Pulcro vuelve a validar cada ID contra sus reglas de seguridad y rechaza rutas no permitidas. Usa dry_run=true para simular. Nunca vacía la Papelera.',
  inputSchema: {
    ids: z.array(z.string()).min(1).max(300).describe('IDs de scan_cleanup'),
    dry_run: z.boolean().optional().describe('Simular sin borrar nada'),
  },
  annotations: { destructiveHint: true, readOnlyHint: false },
}, async ({ ids, dry_run = false }) => {
  const r = await cleanItems(ids, { actor: 'claude', dryRun: dry_run });
  const lines = [
    dry_run ? 'SIMULACRO: no se borró nada.' : `Listo: ${r.ok} limpiado(s), ${r.failed} con error.`,
    `Estimado: ${fb(r.estimatedBytes)}${dry_run ? '' : ` · Espacio liberado real: ${fb(r.freedBytes)}`}`,
  ];
  if (r.inTrashBytes) lines.push(`${fb(r.inTrashBytes)} quedaron en la Papelera. Se liberan cuando el usuario la vacíe desde Pulcro o Finder.`);
  for (const x of r.results) lines.push(`- ${x.ok ? '✓' : '✗'} ${x.title}${x.ok ? ` (${fb(x.bytes)}, ${x.action})` : ` — ${x.error}`}`);
  return text(lines.join('\n'));
});

server.registerTool('get_history', {
  title: 'Historial de limpiezas',
  description: 'Últimas acciones de Pulcro (hechas por el usuario desde la app o por Claude).',
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  annotations: { readOnlyHint: true },
}, async ({ limit = 20 }) => {
  const h = await readHistory(limit);
  if (!h.length) return text('Sin historial todavía.');
  return text(h.map((e) => {
    const when = new Date(e.at).toLocaleString('es-MX');
    if (e.type === 'clean') return `- ${when} · ${e.actor} limpió ${e.items.length} elemento(s) · ${fb(e.freedBytes)} liberados`;
    if (e.type === 'empty-trash') return `- ${when} · ${e.actor} vació la Papelera · ${fb(e.freedBytes)}`;
    if (e.type === 'scan') return `- ${when} · ${e.actor} escaneó · ${fb(e.safeBytes)} recuperables`;
    return `- ${when} · ${e.type}`;
  }).join('\n'));
});

await server.connect(new StdioServerTransport());
