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

function toast(title, text = '', kind = '', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.append(document.createElement('br'), b);
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 12000 : 6000);
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
  if (view === 'organize') { loadOrganize(); loadRuns(); }
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

// ---------- organizar ----------
const org = { plan: null, selected: new Set(), open: new Set(), loading: false };

async function loadOrganize() {
  if (org.loading) return;
  org.loading = true;
  const btn = $('#btn-org-plan');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Analizando…';
  try {
    org.plan = await api('/api/organize/plan');
    org.selected = new Set(org.plan.items.map((i) => i.id));
    renderOrganize();
  } catch (e) {
    toast('No se pudo analizar', e.message, 'error');
  } finally {
    org.loading = false;
    btn.disabled = false; btn.textContent = 'Analizar';
  }
}

function renderOrganize() {
  const p = org.plan;
  const list = $('#org-list');
  const badge = $('#nav-org-badge');
  badge.hidden = !p?.items.length;
  badge.textContent = p?.items.length ?? '';
  if (!p) return;
  $('#org-sub').textContent = p.items.length
    ? `${items_(p.items.length)} por acomodar en ${p.sources.join(' y ')}`
    : `${p.sources.join(' y ')} ya están en orden.`;
  if (!p.items.length) {
    list.innerHTML = '<div class="empty card"><h3>Todo en su lugar ✨</h3><p>No hay archivos sueltos que acomodar. Las carpetas y los proyectos de código nunca se mueven.</p></div>';
    updateOrgSelection();
    return;
  }
  list.innerHTML = p.groups.map((g) => {
    const items = p.items.filter((i) => i.group === g.name);
    const all = items.every((i) => org.selected.has(i.id));
    return `<div class="card cat ${org.open.has(g.name) ? 'open' : ''}" data-group="${esc(g.name)}">
      <div class="cat-head">
        <input type="checkbox" class="cat-check" ${all ? 'checked' : ''} aria-label="Seleccionar grupo" />
        ${ICON.chev}
        <div class="titles"><h3>${esc(g.name)} <span class="muted">· ${g.count}</span></h3><p class="dest">→ ${esc(g.to)}</p></div>
        <span class="cat-size">${g.bytes ? fb(g.bytes) : ''}</span>
      </div>
      <div class="cat-items">${items.map((i) => `<label class="row" data-id="${esc(i.id)}">
        <input type="checkbox" class="item-check" ${org.selected.has(i.id) ? 'checked' : ''} />
        <div style="min-width:0"><div class="name">${esc(i.name)}</div><div class="sub">${esc(i.from)}</div></div>
        <span class="tag ${i.action === 'trash' ? 'review' : 'reason'}">${esc(i.reason)}</span>
        <span class="size">${i.bytes != null ? fb(i.bytes) : 'carpeta'}</span>
        <button class="icon-btn reveal" title="Mostrar en Finder" data-path="${esc(i.path)}">${ICON.reveal}</button>
      </label>`).join('')}</div>
    </div>`;
  }).join('');
  updateOrgSelection();
}

function updateOrgSelection() {
  const items = (org.plan?.items ?? []).filter((i) => org.selected.has(i.id));
  $('#org-bar').hidden = items.length === 0 || !$('#view-organize').classList.contains('active');
  const trash = items.filter((i) => i.action === 'trash').length;
  $('#org-sel').innerHTML = `<strong>${items_(items.length)}</strong> seleccionado${items.length === 1 ? '' : 's'}${trash ? ` · ${trash} a la Papelera` : ''}`;
}

$('#org-list').addEventListener('click', (e) => {
  const reveal = e.target.closest('.reveal');
  if (reveal) { e.preventDefault(); api('/api/reveal', { method: 'POST', body: { path: reveal.dataset.path } }).catch((err) => toast('No se pudo abrir', err.message, 'error')); return; }
  const head = e.target.closest('.cat-head');
  if (head && !e.target.classList.contains('cat-check')) {
    const card = head.parentElement;
    card.classList.toggle('open');
    org.open[card.classList.contains('open') ? 'add' : 'delete'](card.dataset.group);
  }
});
$('#org-list').addEventListener('change', (e) => {
  const card = e.target.closest('.cat');
  if (e.target.classList.contains('item-check')) {
    const id = e.target.closest('.row').dataset.id;
    e.target.checked ? org.selected.add(id) : org.selected.delete(id);
    $('.cat-check', card).checked = $$('.item-check', card).every((c) => c.checked);
  } else if (e.target.classList.contains('cat-check')) {
    $$('.row', card).forEach((r) => { $('.item-check', r).checked = e.target.checked; e.target.checked ? org.selected.add(r.dataset.id) : org.selected.delete(r.dataset.id); });
  }
  updateOrgSelection();
});
$('#btn-org-plan').addEventListener('click', loadOrganize);
$('#btn-org-all').addEventListener('click', () => { org.selected = new Set((org.plan?.items ?? []).map((i) => i.id)); renderOrganize(); });
$('#btn-org-none').addEventListener('click', () => { org.selected.clear(); renderOrganize(); });

$('#btn-org-apply').addEventListener('click', async () => {
  const items = org.plan.items.filter((i) => org.selected.has(i.id));
  if (!items.length) return;
  const byGroup = {};
  for (const i of items) byGroup[i.group] = (byGroup[i.group] ?? 0) + 1;
  const ok = await confirmModal({
    title: `Ordenar ${items_(items.length)}`,
    html: `<ul>${Object.entries(byGroup).map(([g, n]) => `<li><strong>${esc(g)}</strong>: ${n}</li>`).join('')}</ul>
           <p class="note">Puedes deshacerlo después desde “Órdenes recientes”.</p>`,
    ok: 'Ordenar', danger: false,
  });
  if (!ok) return;
  const btn = $('#btn-org-apply');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Ordenando…';
  try {
    const r = await api('/api/organize/apply', { method: 'POST', body: { ids: items.map((i) => i.id) } });
    toast(`Listo: ${items_(r.moved)} acomodado${r.moved === 1 ? '' : 's'}`,
      `${r.trashed ? `${r.trashed} a la Papelera` : ''}${r.failed.length ? ` · ${r.failed.length} con error` : ''}`,
      r.failed.length ? 'error' : '',
      r.manifestId ? { label: 'Deshacer', run: () => undoRun(r.manifestId, true) } : null);
    await Promise.all([loadOrganize(), loadRuns()]);
  } catch (e) {
    toast('No se pudo ordenar', e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Ordenar';
  }
});

async function loadRuns() {
  const runs = await api('/api/organize/runs').catch(() => []);
  const el = $('#org-runs');
  if (!runs.length) { el.innerHTML = '<div class="empty card"><p>Todavía no has ordenado nada.</p></div>'; return; }
  el.innerHTML = runs.map((r) => {
    const when = new Date(r.at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
    const what = `${items_(r.moved)} acomodado${r.moved === 1 ? '' : 's'}${r.trashed ? ` · ${r.trashed} a la Papelera` : ''}`;
    const action = r.undoneAt ? '<span class="run-status">Deshecho</span>' : `<button class="btn small" data-undo="${esc(r.id)}">Deshacer</button>`;
    return `<div class="card event"><div class="what"><strong>${esc(what)}</strong><p>${esc(when)}</p></div>${action}</div>`;
  }).join('');
}
$('#org-runs').addEventListener('click', (e) => { const b = e.target.closest('[data-undo]'); if (b) undoRun(b.dataset.undo); });

async function undoRun(id, skipConfirm = false) {
  if (!skipConfirm) {
    const ok = await confirmModal({ title: 'Deshacer este orden', html: '<p class="note">Los archivos regresan a donde estaban. Los que ya moviste o borraste después se quedan como están.</p>', ok: 'Deshacer', danger: false });
    if (!ok) return;
  }
  try {
    const r = await api('/api/organize/undo', { method: 'POST', body: { id } });
    toast('Orden deshecho', `${items_(r.restored)} regresaron a su lugar${r.skipped.length ? ` · ${r.skipped.length} se quedaron` : ''}`);
    await Promise.all([loadOrganize(), loadRuns()]);
  } catch (e) { toast('No se pudo deshacer', e.message, 'error'); }
}

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
    else if (e.type === 'organize') { what = `Ordenó ${items_(e.moved + e.trashed)}`; detail = `${e.moved} acomodados${e.trashed ? ` · ${e.trashed} a la Papelera` : ''}`; }
    else if (e.type === 'organize-undo') { what = 'Deshizo un orden'; detail = `${items_(e.restored)} regresaron a su lugar`; }
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
  api('/api/organize/plan').then((p) => { org.plan = p; org.selected = new Set(p.items.map((i) => i.id)); renderOrganize(); }).catch(() => {});
  const last = await api('/api/scan/last').catch(() => null);
  if (last?.items) { state.scan = last; renderScan(); renderSpace(); renderRecoverable(); }
  else { renderScan(); renderSpace(); }
})();
