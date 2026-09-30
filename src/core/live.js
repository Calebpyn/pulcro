// Métricas ligeras para el panel de la barra de menús (se consultan cada pocos segundos).
import os from 'node:os';
import { sh } from './util.js';

let lastCpu = null;
function cpuTimes() {
  return os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

async function cpuUsage() {
  let prev = lastCpu;
  if (!prev) { prev = cpuTimes(); await new Promise((r) => setTimeout(r, 250)); }
  const now = cpuTimes();
  lastCpu = now;
  const total = now.total - prev.total;
  return total > 0 ? Math.round((1 - (now.idle - prev.idle) / total) * 100) : 0;
}

async function memory() {
  const out = await sh('vm_stat');
  const pageSize = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = (label) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0) * pageSize;
  const used = pages('Anonymous pages') + pages('Pages wired down') + pages('Pages occupied by compressor');
  const total = os.totalmem();
  const swapRaw = await sh('sysctl', ['-n', 'vm.swapusage']);
  const swapUsed = Number(swapRaw.match(/used = ([\d.]+)M/)?.[1] ?? 0) * 1024 * 1024;
  return { used: Math.min(used, total), total, pct: Math.round((Math.min(used, total) / total) * 100), swapUsed };
}

async function battery() {
  const out = await sh('pmset', ['-g', 'batt']);
  const m = out.match(/(\d+)%;\s*([^;]+);\s*([^\s]+)?/);
  if (!m) return null;
  return {
    charge: Number(m[1]),
    state: m[2].trim(), // charging | discharging | charged | finishing charge | AC attached
    remaining: /^\d+:\d+$/.test(m[3] ?? '') ? m[3] : null,
    onAC: /AC Power/.test(out),
  };
}

const ALIAS = { Browser: 'Arc', claude: 'Claude Code', 'Google Chrome': 'Chrome', 'Code': 'VS Code' };

// Agrupa procesos auxiliares ("Claude Helper (Renderer)") bajo su app.
async function topApps(limit = 4) {
  const out = await sh('ps', ['-Aceo', 'rss=,pcpu=,comm=']);
  const groups = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!m) continue;
    let name = m[3].replace(/\s+(Helper|Web Content|Networking|GPU Process|Graphics and Media).*$/i, '').trim();
    if (!name || name === 'kernel_task' || name === 'WindowServer') continue;
    name = ALIAS[name] ?? name;
    const g = groups.get(name) ?? { name, rss: 0, cpu: 0 };
    g.rss += Number(m[1]) * 1024;
    g.cpu += Number(m[2]);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.rss - a.rss).slice(0, limit)
    .map((g) => ({ ...g, cpu: Math.round(g.cpu) }));
}

export async function getLive() {
  const [cpu, mem, bat, apps] = await Promise.all([cpuUsage(), memory(), battery(), topApps()]);
  return { cpu, load: os.loadavg()[0], cores: os.cpus().length, memory: mem, battery: bat, topApps: apps, uptime: os.uptime() };
}
