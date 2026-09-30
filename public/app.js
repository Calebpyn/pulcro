// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fb(bytes) {
  if (bytes == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (Math.abs(n) >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const items_ = (n) => `${n} ${n === 1 ? 'elemento' : 'elementos'}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Pulcro': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

function toast(title, text = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

function confirmModal({ title, html, ok = 'Confirmar', danger = true }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    const okBtn = $('#modal-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#modal').hidden = false;
    const done = (v) => { $('#modal').hidden = true; okBtn.onclick = null; $('#modal-cancel').onclick = null; resolve(v); };
    okBtn.onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

const ICON = {
  reveal: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/><path d="M13 14h5m-2-2 2 2-2 2"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
};

// ---------- estado ----------
const state = { health: null, scan: null, selected: new Set(), scanning: false, open: new Set(['caches', 'builds']) };

// ---------- navegación ----------
function show(view) {
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'history') loadHistory();
}
$$('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
window.pulcroShow = show; // la app nativa la usa para abrir una sección desde la barra de menús

// ---------- resumen ----------
async function loadHealth() {
  try {
    state.health = await api('/api/health');
    renderHealth();
  } catch (e) {
    $('#overview-sub').textContent = `No se pudo leer el estado: ${e.message}`;
  }
}

function renderHealth() {
  const h = state.health;
  const d = h.disk;
  const freePct = 100 - d.usedPct;
  const ring = $('#ring-fill');
  ring.style.strokeDashoffset = String(314 * (1 - d.usedPct / 100));
  ring.style.stroke = freePct < 10 ? 'var(--danger)' : freePct < 20 ? 'var(--warn)' : 'var(--accent)';
  $('#disk-free').textContent = fb(d.free);
  $('#disk-detail').textContent = `${fb(d.used)} usados de ${fb(d.total)} · ${d.usedPct}% ocupado`;
  $('#overview-sub').textContent = `${h.machine.model} · ${h.machine.chip.replace('Apple ', '')} · macOS ${h.machine.macos}`;
  $('#machine').textContent = `macOS ${h.machine.macos} · ${fb(h.memory.total)} RAM`;

  const days = Math.floor(h.uptime / 86400);
  const b = h.battery;
  const swapRatio = h.memory.swapUsed / h.memory.total;
  const stats = [
    { label: 'SSD (S.M.A.R.T.)', value: /verified/i.test(d.smart) ? 'Sano' : d.smart, hint: 'Salud del hardware del disco', level: /verified/i.test(d.smart) ? '' : 'critical' },
    b ? { label: 'Batería', value: `${b.maxCapacity}%`, hint: `${b.cycles} ciclos · carga ${b.charge}%${b.charging ? ' ⚡︎' : ''}`, level: b.maxCapacity < 80 ? 'warn' : '' } : { label: 'Batería', value: '—', hint: 'Sin batería' },
    { label: 'Memoria swap', value: fb(h.memory.swapUsed), hint: `RAM libre ${h.memory.freePct ?? '?'}%`, level: swapRatio > 0.5 ? 'warn' : '' },
    { label: 'Sin reiniciar', value: `${days} ${days === 1 ? 'día' : 'días'}`, hint: `Carga ${h.load[0].toFixed(1)}`, level: days >= 30 ? 'critical' : days >= 14 ? 'warn' : '' },
  ];
  $('#stats').innerHTML = stats.map((s) => `<div class="card stat ${s.level ?? ''}"><span class="label">${esc(s.label)}</span><span class="value">${esc(s.value)}</span><span class="hint">${esc(s.hint)}</span></div>`).join('');
  $('#recs').innerHTML = h.recommendations.map((r) => `<div class="card rec ${r.level}"><span class="pill"></span><div><h3>${esc(r.title)}</h3><p>${esc(r.detail)}</p></div></div>`).join('');
  renderRecoverable();
}

function renderRecoverable() {
  const el = $('#disk-recoverable');
  if (!state.scan?.totals) { el.textContent = 'Escanea para ver cuánto puedes recuperar.'; el.className = 'muted'; return; }
  el.className = 'recoverable';
  el.textContent = `${fb(state.scan.totals.safe)} recuperables sin riesgo · ${fb(state.scan.totals.review)} para revisar`;
}

// ---------- limpieza ----------
async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  const btns = [$('#btn-scan'), $('#btn-scan-overview')];
  btns.forEach((b) => { b.disabled = true; b.innerHTML = '<span class="spinner"></span>Escaneando…'; });
  $('#clean-sub').textContent = 'Revisando cachés, proyectos, extensiones y archivos grandes…';
  try {
    state.scan = await api('/api/scan', { method: 'POST' });
    state.selected.clear();
    renderScan();
    renderSpace();
    renderRecoverable();
    toast('Escaneo completo', `${fb(state.scan.totals.safe)} recuperables sin riesgo`);
  } catch (e) {
    toast('Falló el escaneo', e.message, 'error');
  } finally {
    state.scanning = false;
    btns.forEach((b) => { b.disabled = false; b.textContent = b.id === 'btn-scan' ? 'Escanear' : 'Escanear ahora'; });
  }
}

function renderScan() {
  const s = state.scan;
  const list = $('#clean-list');
  if (!s?.items) {
    list.innerHTML = '<div class="empty card"><h3>Sin escaneo todavía</h3><p>Pulsa “Escanear” para ver qué se puede limpiar.</p></div>';
    return;
  }
  const when = new Date(s.scannedAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
  $('#clean-sub').textContent = `${fb(s.totals.safe + s.totals.review)} recuperables · escaneado ${when} (${Math.round(s.durationMs / 1000)} s)`;
  const badge = $('#nav-clean-badge');
  badge.hidden = s.totals.safe < 100e6;
  badge.textContent = fb(s.totals.safe);

  if (!s.items.length) {
    list.innerHTML = '<div class="empty card"><h3>Todo limpio ✨</h3><p>No encontré nada que valga la pena borrar.</p></div>';
    return;
  }
  list.innerHTML = s.categories.map((c) => {
    const items = s.items.filter((i) => i.category === c.key);
    const allSel = items.every((i) => state.selected.has(i.id));
    return `<div class="card cat ${state.open.has(c.key) ? 'open' : ''}" data-cat="${c.key}">
      <div class="cat-head">
        <input type="checkbox" class="cat-check" ${allSel ? 'checked' : ''} aria-label="Seleccionar categoría" />
        ${ICON.chev}
        <div class="titles"><h3>${esc(c.label)} <span class="muted">· ${c.count}</span></h3><p>${esc(c.hint)}</p></div>
        <span class="cat-size">${fb(c.bytes)}</span>
      </div>
      <div class="cat-items">${items.map(rowHtml).join('')}</div>
    </div>`;
  }).join('');
  updateSelection();
}

function rowHtml(i) {
  const old = i.meta?.inactiveDays != null && i.meta.inactiveDays >= 30 ? `<span class="tag old">sin usar ${i.meta.inactiveDays} d</span>` : '';
  const risk = i.risk === 'safe' ? '<span class="tag safe">Seguro</span>' : '<span class="tag review">A Papelera</span>';
  const size = i.bytes == null ? '?' : `${i.meta?.partial ? 'hasta ' : ''}${fb(i.bytes)}`;
  return `<label class="row" data-id="${esc(i.id)}">
    <input type="checkbox" class="item-check" ${state.selected.has(i.id) ? 'checked' : ''} />
    <div style="min-width:0"><div class="name">${esc(i.title)}${old}</div><div class="sub">${esc(i.subtitle)}</div></div>
    ${risk}
    <span class="size">${size}</span>
    ${i.path ? `<button class="icon-btn reveal" title="Mostrar en Finder" data-path="${esc(i.path)}">${ICON.reveal}</button>` : '<span></span>'}
  </label>`;
}

$('#clean-list').addEventListener('click', (e) => {
  const reveal = e.target.closest('.reveal');
  if (reveal) { e.preventDefault(); api('/api/reveal', { method: 'POST', body: { path: reveal.dataset.path } }).catch((err) => toast('No se pudo abrir', err.message, 'error')); return; }
  const head = e.target.closest('.cat-head');
  if (head && !e.target.classList.contains('cat-check')) {
    const cat = head.parentElement;
    cat.classList.toggle('open');
    state.open[cat.classList.contains('open') ? 'add' : 'delete'](cat.dataset.cat);
  }
});
$('#clean-list').addEventListener('change', (e) => {
  if (e.target.classList.contains('item-check')) {
    const id = e.target.closest('.row').dataset.id;
    e.target.checked ? state.selected.add(id) : state.selected.delete(id);
    const cat = e.target.closest('.cat');
    $('.cat-check', cat).checked = $$('.item-check', cat).every((c) => c.checked);
  } else if (e.target.classList.contains('cat-check')) {
    const cat = e.target.closest('.cat');
    $$('.row', cat).forEach((r) => { $('.item-check', r).checked = e.target.checked; e.target.checked ? state.selected.add(r.dataset.id) : state.selected.delete(r.dataset.id); });
  }
  updateSelection();
});

function selectedItems() {
  return (state.scan?.items ?? []).filter((i) => state.selected.has(i.id));
}

function updateSelection() {
  const items = selectedItems();
  $('#actionbar').hidden = items.length === 0;
  const bytes = items.reduce((s, i) => s + (i.bytes ?? 0), 0);
  $('#selection-label').innerHTML = `<strong>${items.length}</strong> seleccionados · <strong>${fb(bytes)}</strong>`;
}

$('#btn-select-safe').addEventListener('click', () => {
  if (!state.scan?.items) return;
  state.scan.items.filter((i) => i.risk === 'safe').forEach((i) => state.selected.add(i.id));
  renderScan();
});
$('#btn-clear-sel').addEventListener('click', () => { state.selected.clear(); renderScan(); });
$('#btn-clean').addEventListener('click', () => cleanFlow(selectedItems()));

async function cleanFlow(items) {
  if (!items.length) return;
  const safe = items.filter((i) => i.risk === 'safe');
  const review = items.filter((i) => i.risk === 'review');
  const total = items.reduce((s, i) => s + (i.bytes ?? 0), 0);
  const list = (arr) => `<ul>${arr.slice(0, 40).map((i) => `<li>${esc(i.title)} — ${fb(i.bytes)}</li>`).join('')}${arr.length > 40 ? `<li>…y ${arr.length - 40} más</li>` : ''}</ul>`;
  const ok = await confirmModal({
    title: `Limpiar ${items_(items.length)} (${fb(total)})`,
    html: `${safe.length ? `<p class="note"><strong>Se borran</strong> (se regeneran solos):</p>${list(safe)}` : ''}
           ${review.length ? `<p class="note"><strong>Van a la Papelera</strong> (puedes recuperarlos):</p>${list(review)}` : ''}`,
    ok: 'Limpiar',
  });
  if (!ok) return;
  const btn = $('#btn-clean');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Limpiando…';
  try {
    const r = await api('/api/clean', { method: 'POST', body: { ids: items.map((i) => i.id) } });
    const cleaned = new Set(r.results.filter((x) => x.ok).map((x) => x.id));
    state.scan.items = state.scan.items.filter((i) => !cleaned.has(i.id));
    recomputeScan();
    cleaned.forEach((id) => state.selected.delete(id));
    renderScan();
    loadHealth();
    const trash = r.inTrashBytes ? ` · ${fb(r.inTrashBytes)} en la Papelera` : '';
    toast(`Liberaste ${fb(r.freedBytes || r.estimatedBytes)}`, `${items_(r.ok)} limpiado${r.ok === 1 ? '' : 's'}${r.failed ? `, ${r.failed} con error` : ''}${trash}`, r.failed ? 'error' : '');
    for (const f of r.results.filter((x) => !x.ok).slice(0, 3)) toast(`No se limpió: ${f.title}`, f.error, 'error');
  } catch (e) {
    toast('Falló la limpieza', e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Limpiar';
  }
}

function recomputeScan() {
  const s = state.scan;
  s.totals.safe = s.items.filter((i) => i.risk === 'safe').reduce((a, i) => a + (i.bytes ?? 0), 0);
  s.totals.review = s.items.filter((i) => i.risk === 'review').reduce((a, i) => a + (i.bytes ?? 0), 0);
  s.categories = s.categories.map((c) => {
    const l = s.items.filter((i) => i.category === c.key);
    return { ...c, count: l.length, bytes: l.reduce((a, i) => a + (i.bytes ?? 0), 0) };
  }).filter((c) => c.count > 0);
  renderRecoverable();
}

$('#btn-scan').addEventListener('click', scan);
$('#btn-scan-overview').addEventListener('click', () => { show('clean'); scan(); });

// ---------- espacio ----------
function renderSpace() {
  const ins = state.scan?.insights;
  const grid = $('#space-grid');
  if (!ins) { grid.innerHTML = '<div class="empty card" style="grid-column:1/-1"><h3>Sin datos</h3><p>Haz un escaneo para ver qué ocupa más espacio.</p></div>'; return; }
  const block = (title, list) => {
    const max = Math.max(...list.map((x) => x.bytes), 1);
    return `<div class="card space-card"><h3>${title}</h3>${list.length ? list.map((x) => `
      <div class="bar-row"><span class="n">${esc(x.name)}</span><span class="b">${fb(x.bytes)}</span>
      <button class="icon-btn reveal" title="Mostrar en Finder" data-path="${esc(x.path)}">${ICON.reveal}</button>
      <div class="bar"><i style="width:${(x.bytes / max) * 100}%"></i></div></div>`).join('') : '<p class="muted">Nada relevante.</p>'}</div>`;
  };
  grid.innerHTML = block('Apps', ins.apps) + block('Datos de apps', ins.appData) + block('Carpetas de tu usuario', ins.home);
}
$('#space-grid').addEventListener('click', (e) => {
  const r = e.target.closest('.reveal');
  if (r) api('/api/reveal', { method: 'POST', body: { path: r.dataset.path } }).catch((err) => toast('No se pudo abrir', err.message, 'error'));
});
$('#btn-empty-trash').addEventListener('click', async () => {
  const ok = await confirmModal({ title: 'Vaciar la Papelera', html: '<p class="note">Todo lo que está en la Papelera se borrará para siempre. Esto no se puede deshacer.</p>', ok: 'Vaciar' });
  if (!ok) return;
  const btn = $('#btn-empty-trash');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Vaciando…';
  try {
    const r = await api('/api/empty-trash', { method: 'POST' });
    toast('Papelera vacía', `Liberaste ${fb(r.freedBytes)}`);
    loadHealth();
  } catch (e) { toast('No se pudo vaciar', e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Vaciar Papelera'; }
});

// ---------- historial ----------
async function loadHistory() {
  const h = await api('/api/history').catch(() => []);
  const el = $('#history');
  if (!h.length) { el.innerHTML = '<div class="empty card"><h3>Sin actividad</h3><p>Aquí verás cada escaneo y limpieza.</p></div>'; return; }
  el.innerHTML = h.map((e) => {
    const when = new Date(e.at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
    let what = '', detail = '', amount = '';
    if (e.type === 'clean') {
      what = `Limpió ${items_(e.items.length)}`;
      detail = e.items.slice(0, 4).map((i) => i.title).join(', ') + (e.items.length > 4 ? '…' : '');
      amount = fb(e.freedBytes || e.estimatedBytes);
    } else if (e.type === 'empty-trash') { what = 'Vació la Papelera'; amount = fb(e.freedBytes); }
    else if (e.type === 'scan') { what = 'Escaneó la Mac'; detail = `${fb(e.safeBytes)} recuperables sin riesgo`; }
    return `<div class="card event"><div class="what"><strong>${esc(what)}</strong><p>${esc(when)}${detail ? ' · ' + esc(detail) : ''}</p></div><span class="amount">${amount}</span></div>`;
  }).join('');
}

// ---------- eventos en vivo ----------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#channel').classList.add('on'); $('#channel-label').textContent = 'Actualización en vivo'; };
  es.onerror = () => { $('#channel').classList.remove('on'); $('#channel-label').textContent = 'Reconectando…'; };
  es.onmessage = async (msg) => {
    const e = JSON.parse(msg.data);
    if ($('#view-history').classList.contains('active')) loadHistory();
    if (e.type === 'clean' || e.type === 'scan') {
      state.scan = await api('/api/scan/last');
      renderScan(); renderSpace(); renderRecoverable();
    }
    if (e.type !== 'scan') loadHealth();
  };
}

// ---------- arranque ----------
(async () => {
  connectEvents();
  loadHealth();
  const last = await api('/api/scan/last').catch(() => null);
  if (last?.items) { state.scan = last; renderScan(); renderSpace(); renderRecoverable(); }
  else { renderScan(); renderSpace(); }
})();
