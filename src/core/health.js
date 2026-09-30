import fs from 'node:fs/promises';
import os from 'node:os';
import { sh, DATA_VOLUME, formatBytes } from './util.js';

async function disk() {
  const s = await fs.statfs(DATA_VOLUME);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const info = await sh('diskutil', ['info', '/']);
  const smart = info.match(/SMART Status:\s*(.+)/)?.[1]?.trim() ?? 'Desconocido';
  return { total, free, used: total - free, usedPct: Math.round(((total - free) / total) * 100), smart };
}

async function battery() {
  const raw = await sh('system_profiler', ['SPPowerDataType', '-json']);
  try {
    const entries = JSON.parse(raw).SPPowerDataType ?? [];
    const b = entries.find((e) => e.sppower_battery_health_info);
    if (!b) return null;
    const h = b.sppower_battery_health_info;
    const c = b.sppower_battery_charge_info ?? {};
    return {
      cycles: h.sppower_battery_cycle_count ?? null,
      condition: h.sppower_battery_health ?? null,
      maxCapacity: parseInt(h.sppower_battery_health_maximum_capacity, 10) || null,
      charge: c.sppower_battery_state_of_charge ?? null,
      charging: c.sppower_battery_is_charging === 'TRUE',
    };
  } catch {
    return null;
  }
}

async function memory() {
  const swapRaw = await sh('sysctl', ['-n', 'vm.swapusage']);
  const mb = (key) => Number(swapRaw.match(new RegExp(`${key} = ([\\d.]+)M`))?.[1] ?? 0) * 1024 * 1024;
  const pressure = await sh('memory_pressure', [], { timeout: 10_000 });
  const freePct = Number(pressure.match(/free percentage: (\d+)%/)?.[1] ?? NaN);
  return {
    total: os.totalmem(),
    swapUsed: mb('used'),
    swapTotal: mb('total'),
    freePct: Number.isNaN(freePct) ? null : freePct,
  };
}

async function machine() {
  const [model, os_] = await Promise.all([
    sh('sysctl', ['-n', 'hw.model']),
    sh('sw_vers', ['-productVersion']),
  ]);
  return {
    model: model.trim(),
    chip: os.cpus()[0]?.model ?? '',
    cores: os.cpus().length,
    macos: os_.trim(),
    hostname: os.hostname(),
  };
}

function recommendations({ disk, battery, memory, uptime }) {
  const recs = [];
  const freePct = 100 - disk.usedPct;
  if (freePct < 10) recs.push({ level: 'critical', title: 'Disco casi lleno', detail: `Solo queda ${formatBytes(disk.free)} libre (${freePct}%). macOS necesita al menos 10–15% libre para funcionar bien.` });
  else if (freePct < 20) recs.push({ level: 'warn', title: 'Poco espacio libre', detail: `Queda ${formatBytes(disk.free)} (${freePct}%). Conviene mantener más de 20% libre.` });

  if (!/verified/i.test(disk.smart)) recs.push({ level: 'critical', title: 'Estado S.M.A.R.T. anómalo', detail: `El SSD reporta "${disk.smart}". Haz un respaldo cuanto antes.` });

  const days = Math.floor(uptime / 86400);
  if (days >= 14) recs.push({ level: days >= 30 ? 'critical' : 'warn', title: `${days} días sin reiniciar`, detail: 'Reiniciar libera la memoria swap, aplica actualizaciones pendientes y limpia procesos colgados.' });

  if (memory.swapUsed > memory.total * 0.5) recs.push({ level: 'warn', title: 'Uso alto de swap', detail: `${formatBytes(memory.swapUsed)} de memoria virtual en disco. Cierra apps pesadas o reinicia.` });

  if (battery?.maxCapacity && battery.maxCapacity < 80) recs.push({ level: 'warn', title: 'Batería degradada', detail: `Capacidad máxima ${battery.maxCapacity}%. Apple recomienda reemplazo por debajo del 80%.` });
  else if (battery?.maxCapacity && battery.maxCapacity < 88) recs.push({ level: 'info', title: 'Batería con desgaste normal', detail: `Capacidad máxima ${battery.maxCapacity}% con ${battery.cycles} ciclos.` });

  if (!recs.some((r) => r.level !== 'info')) recs.push({ level: 'ok', title: 'Todo en orden', detail: 'No hay problemas de salud importantes.' });
  return recs;
}

export async function getHealth() {
  const [d, b, m, mac] = await Promise.all([disk(), battery(), memory(), machine()]);
  const uptime = os.uptime();
  const load = os.loadavg();
  const health = { disk: d, battery: b, memory: m, machine: mac, uptime, load, checkedAt: new Date().toISOString() };
  health.recommendations = recommendations(health);
  return health;
}
