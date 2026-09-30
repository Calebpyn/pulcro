// Panel de la barra de menús. Habla con el motor por HTTP y con la app nativa por
// window.webkit.messageHandlers.pulcro (abrir ventana, salir, ajustar alto).
const $ = (id) => document.getElementById(id);
const native = (msg) => window.webkit?.messageHandlers?.pulcro?.postMessage(msg);

function fb(bytes) {
  if (bytes == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (Math.abs(n) >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: method === 'GET' ? {} : { 'X-Pulcro': '1', 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
  return res.json();
}
const post = (path, body) => api(path, 'POST', body ? JSON.stringify(body) : undefined);

// Botones de dos pasos: el primer toque pide confirmación, el segundo ejecuta.
function twoStep(btn, confirmLabel, run) {
  let armed = null;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (!armed) {
      const original = btn.innerHTML;
      btn.classList.add('confirm');
      btn.querySelector('span') ? (btn.querySelector('span').textContent = confirmLabel) : (btn.textContent = confirmLabel);
      armed = setTimeout(() => { btn.classList.remove('confirm'); btn.innerHTML = original; armed = null; }, 4000);
      btn.dataset.original = original;
      return;
    }
    clearTimeout(armed); armed = null;
    btn.classList.remove('confirm');
    await run(btn, btn.dataset.original);
  });
}

const state = { cpu: [], safeIds: [], safeBytes: 0, timer: null };

function setBar(el, pct) {
  el.querySelector('i').style.width = `${Math.max(2, Math.min(100, pct))}%`;
  el.className = `bar${pct >= 90 ? ' bad' : pct >= 75 ? ' warn' : ''}`;
}

async function loadHealth() {
  const h = await api('/api/health');
  const d = h.disk;
  const freePct = 100 - d.usedPct;
  $('free').textContent = fb(d.free);
  $('disk-sub').textContent = `${fb(d.used)} de ${fb(d.total)} usados`;
  $('ring').style.strokeDashoffset = String(264 * (1 - freePct / 100));

  const worst = h.recommendations.find((r) => r.level === 'critical') ?? h.recommendations.find((r) => r.level === 'warn');
  const st = $('status');
  st.className = `status${worst?.level === 'critical' ? ' bad' : worst ? ' warn' : ''}`;
  $('status-text').textContent = worst ? (worst.level === 'critical' ? 'Tu Mac necesita atención' : 'Hay cosas por mejorar') : 'Tu Mac está en buena forma';
  $('alert').hidden = !worst;
  if (worst) {
    $('alert').className = `alert${worst.level === 'warn' ? ' warn' : ''}`;
    $('alert-title').textContent = worst.title;
    $('alert-text').textContent = worst.detail;
  }
  if (h.battery) $('batt-sub').dataset.health = `salud ${h.battery.maxCapacity}% · ${h.battery.cycles} ciclos`;
}

async function loadScan() {
  const s = await api('/api/scan/last');
  const safe = (s.items ?? []).filter((i) => i.risk === 'safe');
  state.safeIds = safe.map((i) => i.id);
  state.safeBytes = safe.reduce((a, i) => a + (i.bytes ?? 0), 0);
  const btn = $('clean');
  if (!s.scannedAt) {
    $('recoverable').textContent = 'Escanea para ver qué limpiar';
    btn.disabled = true; btn.textContent = 'Limpiar';
  } else if (!safe.length) {
    $('recoverable').textContent = 'Todo limpio ✨';
    btn.disabled = true; btn.textContent = 'Nada que limpiar';
  } else {
    $('recoverable').textContent = `${fb(state.safeBytes)} recuperables sin riesgo`;
    btn.disabled = false; btn.textContent = `Limpiar ${fb(state.safeBytes)}`;
  }
}

async function loadLive() {
  const l = await api('/api/live');
  const m = l.memory;
  $('mem').innerHTML = `${m.pct}<small>%</small>`;
  setBar($('mem-bar'), m.pct);
  $('mem-sub').textContent = `${fb(m.used)} de ${fb(m.total)} · swap ${fb(m.swapUsed)}`;

  $('cpu').innerHTML = `${l.cpu}<small>%</small>`;
  $('cpu-sub').textContent = `Carga ${l.load.toFixed(1)} · ${l.cores} núcleos`;
  state.cpu.push(l.cpu);
  if (state.cpu.length > 30) state.cpu.shift();
  const pts = state.cpu.map((v, i) => `${(i / 29) * 100},${24 - (v / 100) * 22}`);
  const offset = 100 - ((state.cpu.length - 1) / 29) * 100;
  const shifted = state.cpu.map((v, i) => `${offset + (i / 29) * 100},${24 - (v / 100) * 22}`).join(' ');
  $('spark').querySelector('polyline').setAttribute('points', shifted);
  $('spark').querySelector('polygon').setAttribute('points', pts.length ? `${offset},26 ${shifted} 100,26` : '');

  const b = l.battery;
  if (b) {
    $('batt').innerHTML = `${b.charge}<small>%</small>`;
    const fill = $('batt-fill');
    fill.style.width = `${b.charge}%`;
    fill.style.background = b.charge <= 20 ? 'var(--bad)' : b.charge <= 40 ? 'var(--warn)' : 'var(--ok)';
    const state_ = /charging/.test(b.state) && !/discharging/.test(b.state) ? '⚡︎ Cargando' : b.onAC ? 'Conectada' : b.remaining ? `${b.remaining} restantes` : 'Con batería';
    $('batt-sub').textContent = `${state_}${$('batt-sub').dataset.health ? ' · ' + $('batt-sub').dataset.health : ''}`;
  } else {
    $('batt').textContent = '—'; $('batt-sub').textContent = 'Sin batería';
  }

  const days = Math.floor(l.uptime / 86400);
  const hours = Math.floor((l.uptime % 86400) / 3600);
  $('uptime').innerHTML = days ? `${days}<small>${days === 1 ? 'día' : 'días'}</small>` : `${hours}<small>h</small>`;
  $('uptime-sub').textContent = days >= 14 ? 'Reinicia para liberar memoria' : 'Sin problemas';
  $('uptime-sub').style.color = days >= 30 ? 'var(--bad)' : days >= 14 ? 'var(--warn)' : '';

  const max = Math.max(...l.topApps.map((a) => a.rss), 1);
  $('apps').innerHTML = l.topApps.map((a) => `
    <div class="app"><span class="n">${a.name.replace(/[<>&]/g, '')}</span><span class="v">${fb(a.rss)} · ${a.cpu}% CPU</span>
    <div class="bar"><i style="width:${(a.rss / max) * 100}%"></i></div></div>`).join('');
  $('updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function reportHeight() {
  native({ type: 'resize', height: Math.ceil(document.getElementById('wrap').getBoundingClientRect().height) });
}

async function refreshAll() {
  await Promise.allSettled([loadHealth(), loadScan(), loadLive()]);
  reportHeight();
}

// La app nativa llama a estas funciones al abrir/cerrar el panel.
window.pulcroOpened = () => {
  refreshAll();
  clearInterval(state.timer);
  state.timer = setInterval(() => loadLive().then(reportHeight).catch(() => {}), 2000);
};
window.pulcroClosed = () => { clearInterval(state.timer); state.timer = null; };

twoStep($('clean'), '¿Seguro? Toca para confirmar', async (btn) => {
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Limpiando…';
  try {
    const r = await post('/api/clean', { ids: state.safeIds });
    btn.textContent = `✓ Liberaste ${fb(r.freedBytes || r.estimatedBytes)}`;
    setTimeout(() => Promise.allSettled([loadHealth(), loadScan()]), 2500);
  } catch (e) { btn.textContent = `Error: ${e.message}`; btn.disabled = false; }
});

twoStep($('trash'), '¿Vaciar?', async (btn, original) => {
  btn.disabled = true;
  btn.querySelector('span').innerHTML = '<span class="spin"></span>Vaciando';
  try {
    const r = await post('/api/empty-trash');
    btn.querySelector('span').textContent = `✓ ${fb(r.freedBytes)}`;
    loadHealth();
  } catch { btn.querySelector('span').textContent = 'Error'; }
  setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 3500);
});

$('scan').addEventListener('click', async () => {
  const btn = $('scan');
  if (btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.querySelector('span').innerHTML = '<span class="spin"></span>Escaneando';
  try {
    const s = await post('/api/scan');
    btn.querySelector('span').textContent = `✓ ${fb(s.totals.safe)}`;
    await loadScan();
  } catch { btn.querySelector('span').textContent = 'Error'; }
  setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 3000);
});

$('open-app').addEventListener('click', () => native({ type: 'open', view: 'overview' }));
$('quit').addEventListener('click', () => native({ type: 'quit' }));

// En un navegador normal (sin app nativa) el panel se actualiza solo.
if (!window.webkit?.messageHandlers?.pulcro) window.pulcroOpened();
