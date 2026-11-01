// CopyTrader dashboard (vanilla JS).
// Live state arrives over Server-Sent Events (~10/sec); actions go to the JSON API.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state = { connections: [], groups: [], positions: {}, pnl: {}, metrics: {}, lastPrice: {}, contracts: {}, sim: { contracts: {} } };
let accounts = {}; // "connId:accId" -> { name, label, type, connectionId, accountId }
const history = {}; // contractId -> [{t, p}]
let selectedContract = null;
let editingGroupId = null;

// ------------------------------------------------------------------ helpers
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), level === 'error' ? 9000 : 4500);
}
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    await refreshFull();
    return r ?? true;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}
const money = (v, sign = true) => {
  const n = Number(v) || 0;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n > 0.004 && sign ? '+' : n < -0.004 ? '−' : ''}$${s}`;
};
const pnlClass = (v) => (v > 0.004 ? 'up' : v < -0.004 ? 'down' : 'zero');
const arrow = (v) => (v > 0.004 ? '▲ ' : v < -0.004 ? '▼ ' : '');
const fmtPrice = (p) => (p == null ? '–' : Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const nameOf = (key) => accounts[key]?.name || key;
const platOf = (key) => {
  const a = accounts[key];
  return a ? `${a.type === 'sim' ? 'Sim Lab' : a.type === 'projectx' ? 'TopstepX' : a.type} · ${a.label}` : '';
};
const scale = (net, f) => {
  if (!net) return 0;
  let q = Math.floor(Math.abs(net) * f.ratio + 0.5 + 1e-9);
  if (f.maxContracts) q = Math.min(q, f.maxContracts);
  return Math.sign(net) * q;
};
const groupKeys = (g) => [`${g.leader.connectionId}:${g.leader.accountId}`, ...g.followers.map((f) => f.key || `${f.connectionId}:${f.accountId}`)];
const shortC = (c) => String(c).replace(/^CON\.F\.US\./, '').replace(/^SIM\./, '');

// ------------------------------------------------------------------ data
async function refreshFull() {
  const s = await api('GET', '/api/state');
  accounts = {};
  for (const c of s.connections) for (const a of c.accounts || []) accounts[`${c.id}:${a.id}`] = { name: a.name, label: c.label, type: c.type, connectionId: c.id, accountId: a.id };
  for (const [c, h] of Object.entries(s.history || {})) history[c] = h.slice();
  state = { ...state, ...s };
  if (s.logs) setFeed(s.logs);
  render(true);
}

function mergeLive(s) {
  const sig = (list) => list.map((c) => c.id + c.status).join();
  const changed = sig(s.connections) !== sig(state.connections);
  const conns = s.connections.map((c) => ({ ...(state.connections.find((x) => x.id === c.id) || {}), ...c }));
  state = { ...state, ...s, connections: conns };
  const now = Date.now();
  for (const [c, p] of Object.entries(s.lastPrice || {})) {
    const h = (history[c] ||= []);
    const last = h[h.length - 1];
    if (last && now - last.t < 250) last.p = p;
    else h.push({ t: now, p });
    while (h.length && now - h[0].t > 15 * 60 * 1000) h.shift();
  }
  if (changed) refreshFull();
  else render(false);
}

// ------------------------------------------------------------------ render
let rafPending = false;
function render(structural) {
  if (structural) return doRender(true);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    doRender(false);
  });
}
function doRender(structural) {
  renderHeader();
  renderOnboarding();
  renderGroups(structural);
  renderChart();
  renderTicket(structural);
  renderTiles();
}

function renderHeader() {
  const live = state.connections.some((c) => c.status === 'connected');
  const running = state.groups.some((g) => g.running);
  const chip = $('#liveChip');
  chip.classList.toggle('on', live && running);
  chip.querySelector('span').textContent = !live ? 'offline' : running ? 'live · copying' : 'connected';
  const keys = new Set(state.groups.flatMap(groupKeys));
  let open = 0, closed = 0;
  for (const k of keys) {
    open += state.pnl[k]?.unrealized || 0;
    closed += state.pnl[k]?.realized || 0;
  }
  setPnlText($('#heroPnl .hp-value'), open + closed, '__hero', 'hp-value');
  $('#heroPnl [data-k=open]').textContent = money(open);
  $('#heroPnl [data-k=closed]').textContent = money(closed);
}

const lastVals = {};
function setPnlText(el, value, key, baseClass) {
  const txt = arrow(value) + money(value);
  if (el.textContent === txt) return;
  const prev = lastVals[key];
  el.textContent = txt;
  el.className = `${baseClass} ${pnlClass(value)}`;
  if (prev != null && Math.abs(prev - value) > 0.004) {
    void el.offsetWidth; // restart animation
    el.classList.add(value > prev ? 'flash-up' : 'flash-down');
  }
  lastVals[key] = value;
}

function renderOnboarding() {
  const hasConn = state.connections.length > 0;
  const hasGroup = state.groups.length > 0;
  const running = state.groups.some((g) => g.running);
  $('#onboarding').hidden = hasConn && hasGroup;
  const st = [hasConn, hasGroup, running];
  $$('.step').forEach((el, i) => {
    el.classList.toggle('done', st[i]);
    el.classList.toggle('active', !st[i] && (i === 0 || st[i - 1]));
    el.classList.toggle('locked', !st[i] && i > 0 && !st[i - 1]);
  });
}

// ---------- groups: leader -> followers flow
let groupSig = '';
function renderGroups(force) {
  const sig = JSON.stringify(state.groups.map((g) => [g.id, g.name, g.running, g.resync, g.leader, g.followers.map((f) => [f.key, f.ratio, f.maxContracts, f.paused, f.enabled])])) + Object.keys(accounts).join();
  if (force || sig !== groupSig) {
    groupSig = sig;
    $('#groups').innerHTML = state.groups.map(groupHtml).join('');
    requestAnimationFrame(drawFlowLines);
  }
  for (const g of state.groups) updateGroupLive(g);
}

function acctCard(key, role, f, g) {
  const isLeader = role === 'leader';
  if (!isLeader) {
    return `<div class="acct" data-acct="${esc(key)}">
      <div class="fid"><div class="fid-top"><span class="role">Follower</span><span class="ratio" title="Trades leader size × ${f.ratio}">×${f.ratio}${f.maxContracts ? ` · max ${f.maxContracts}` : ''}</span></div>
        <div class="acct-name" title="${esc(nameOf(key))}">${esc(nameOf(key))}</div><div class="acct-plat">${esc(platOf(key))}</div></div>
      <div class="pos" data-pos></div>
      <div class="pnl zero" data-pnl>$0.00</div>
      <div class="pnl-sub" data-sub></div>
      <div class="fsync"><div data-sync></div>${f.paused ? `<button class="btn small" data-resume="${esc(g.id)}" data-fkey="${esc(key)}">Resume</button>` : ''}</div>
    </div>`;
  }
  return `<div class="acct ${isLeader ? 'leader' : ''}" data-acct="${esc(key)}">
    <div class="acct-top"><span class="role">${isLeader ? '★ Leader' : 'Follower'}</span>
      ${isLeader ? '<span class="pill ok">you trade here</span>' : `<span class="ratio" title="Trades leader size × ${f.ratio}">×${f.ratio}${f.maxContracts ? ` · max ${f.maxContracts}` : ''}</span>`}</div>
    <div><div class="acct-name" title="${esc(nameOf(key))}">${esc(nameOf(key))}</div><div class="acct-plat">${esc(platOf(key))}</div></div>
    <div class="pos" data-pos></div>
    <div class="pnl zero" data-pnl>$0.00</div>
    <div class="pnl-sub" data-sub></div>
    ${isLeader ? '' : `<div data-sync></div>${f.paused ? `<button class="btn small" data-resume="${esc(g.id)}" data-fkey="${esc(key)}">Resume this follower</button>` : ''}`}
  </div>`;
}

function groupHtml(g) {
  const lk = `${g.leader.connectionId}:${g.leader.accountId}`;
  return `<section class="group ${g.running ? 'running' : ''}" data-group="${esc(g.id)}">
    <div class="group-top">
      <h2>${esc(g.name)}</h2>
      <div class="meta">
        <span class="pill neutral">${g.followers.length} follower${g.followers.length === 1 ? '' : 's'}</span>
        <span class="pill ${g.resync.enabled ? 'ok' : 'warn'}" title="${g.resync.enabled ? `Out-of-sync followers are fixed automatically if price is within ${g.resync.toleranceTicks} ticks of the leader's entry` : 'You get alerts only'}">${g.resync.enabled ? `↻ auto-fix · ${g.resync.toleranceTicks} ticks` : '⚠ auto-fix off'}</span>
      </div>
      <div class="actions">
        ${g.running ? '' : `<button class="btn ghost small" data-edit="${esc(g.id)}">Edit</button><button class="btn ghost small" data-delgroup="${esc(g.id)}">Delete</button>`}
        <button class="run-toggle ${g.running ? 'on' : ''}" data-toggle="${esc(g.id)}">${g.running ? 'COPYING' : 'STOPPED'}<input type="checkbox" class="switch" ${g.running ? 'checked' : ''} tabindex="-1" /></button>
      </div>
    </div>
    <div class="flow">
      ${acctCard(lk, 'leader', null, g)}
      <div class="flow-lines"><svg></svg></div>
      <div class="followers">${g.followers.map((f) => acctCard(f.key, 'follower', f, g)).join('')}</div>
    </div>
  </section>`;
}

function updateGroupLive(g) {
  const el = $(`[data-group="${CSS.escape(g.id)}"]`);
  if (!el) return;
  const lk = `${g.leader.connectionId}:${g.leader.accountId}`;
  const lpos = state.positions[lk] || {};
  const contracts = new Set(Object.keys(lpos));
  for (const f of g.followers) for (const c of Object.keys(state.positions[f.key] || {})) contracts.add(c);
  const all = [{ key: lk, leader: true }, ...g.followers.map((f) => ({ key: f.key, f }))];
  for (const a of all) {
    const card = el.querySelector(`[data-acct="${CSS.escape(a.key)}"]`);
    if (!card) continue;
    const pos = state.positions[a.key] || {};
    const entries = Object.entries(pos);
    const posHtml = entries.length
      ? entries.map(([c, p]) => `<span class="side ${p.net > 0 ? 'long' : 'short'}">${p.net > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.net)}</span><span>${esc(shortC(c))} @ ${fmtPrice(p.avgPrice)}</span>`).join(' ')
      : '<span class="side flat">FLAT</span><span>no position</span>';
    const posEl = card.querySelector('[data-pos]');
    if (posEl.innerHTML !== posHtml) posEl.innerHTML = posHtml;
    const pnl = state.pnl[a.key] || { unrealized: 0, realized: 0, trades: 0 };
    setPnlText(card.querySelector('[data-pnl]'), pnl.unrealized + pnl.realized, a.key, 'pnl');
    const subHtml = `Open <b>${money(pnl.unrealized)}</b> · Closed <b>${money(pnl.realized)}</b> · ${pnl.trades} fill${pnl.trades === 1 ? '' : 's'}`;
    const sub = card.querySelector('[data-sub]');
    if (sub.innerHTML !== subHtml) sub.innerHTML = subHtml;
    if (a.leader) continue;
    let ok = true, msg = '';
    for (const c of contracts) {
      const target = scale(lpos[c]?.net || 0, a.f);
      const net = pos[c]?.net || 0;
      if (a.f.enabled && target !== net) {
        ok = false;
        msg = `should be ${target > 0 ? 'LONG ' + target : target < 0 ? 'SHORT ' + -target : 'FLAT'}`;
      }
    }
    const html = a.f.paused ? '<span class="pill bad">⏸ Paused: needs attention</span>'
      : !g.running ? '<span class="pill neutral">○ not copying</span>'
      : ok ? '<span class="pill ok">✓ In sync</span>'
      : `<span class="pill bad">⚠ Out of sync · ${esc(msg)}</span>`;
    const sync = card.querySelector('[data-sync]');
    if (sync.innerHTML !== html) sync.innerHTML = html;
    card.classList.toggle('bad', !!a.f.paused || (g.running && !ok));
  }
}

function drawFlowLines() {
  for (const gEl of $$('.group')) {
    const host = gEl.querySelector('.flow-lines');
    const svg = host?.querySelector('svg');
    if (!svg || !host.offsetWidth) continue;
    const hb = host.getBoundingClientRect();
    const leader = gEl.querySelector('.acct.leader').getBoundingClientRect();
    const y0 = Math.min(leader.top + leader.height / 2, leader.top + 90) - hb.top;
    let d = '';
    gEl.querySelectorAll('.followers .acct').forEach((f) => {
      const r = f.getBoundingClientRect();
      const x1 = r.left - hb.left;
      const y1 = r.top + r.height / 2 - hb.top;
      d += `<path d="M0 ${y0} C ${hb.width * 0.55} ${y0}, ${hb.width * 0.45} ${y1}, ${x1} ${y1}"/>`;
    });
    svg.innerHTML = d;
  }
}
window.addEventListener('resize', () => requestAnimationFrame(drawFlowLines));

// ---------- live price chart
let hoverX = null;
const availableContracts = () => Object.keys(history).filter((c) => history[c].length);
function renderChart() {
  const list = availableContracts();
  $('#marketRow').hidden = !state.connections.length;
  $('#chartEmpty').hidden = list.length > 0;
  if (!list.length) return;
  if (!selectedContract || !list.includes(selectedContract)) {
    const lc = state.groups.map((g) => Object.keys(state.positions[`${g.leader.connectionId}:${g.leader.accountId}`] || {})[0]).find(Boolean);
    selectedContract = lc && list.includes(lc) ? lc : list[0];
  }
  const tabs = $('#contractTabs');
  const tabsHtml = list.map((c) => `<button data-contract="${esc(c)}" class="${c === selectedContract ? 'on' : ''}">${esc(shortC(c))}</button>`).join('');
  if (tabs.dataset.sig !== tabsHtml) {
    tabs.innerHTML = tabsHtml;
    tabs.dataset.sig = tabsHtml;
  }
  const now = Date.now();
  const h = history[selectedContract].filter((x) => now - x.t <= 5 * 60 * 1000);
  if (!h.length) return;
  const last = h[h.length - 1].p;
  $('#bigPrice').textContent = fmtPrice(last);
  const chg = last - h[0].p;
  const chgEl = $('#priceChg');
  chgEl.textContent = `${chg >= 0 ? '+' : '−'}${fmtPrice(Math.abs(chg))} · 5 min`;
  chgEl.className = `chg ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}`;

  const wrap = $('#chartWrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W) return;
  const pad = { l: 8, r: 76, t: 14, b: 26 };
  const entries = [];
  for (const g of state.groups) {
    const lk = `${g.leader.connectionId}:${g.leader.accountId}`;
    const p = state.positions[lk]?.[selectedContract];
    if (p) entries.push({ price: p.avgPrice, net: p.net, name: nameOf(lk) });
  }
  let lo = Math.min(...h.map((x) => x.p), ...entries.map((e) => e.price));
  let hi = Math.max(...h.map((x) => x.p), ...entries.map((e) => e.price));
  const tick = state.contracts[selectedContract]?.tickSize || state.sim.contracts[selectedContract]?.tickSize || 0.25;
  if (hi - lo < tick * 8) {
    const mid = (hi + lo) / 2;
    lo = mid - tick * 4;
    hi = mid + tick * 4;
  }
  const padY = (hi - lo) * 0.12;
  lo -= padY;
  hi += padY;
  const t0 = Math.min(h[0].t, now - 60000);
  const x = (t) => pad.l + ((t - t0) / (now - t0 || 1)) * (W - pad.l - pad.r);
  const y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const mono = 'font-family="JetBrains Mono, monospace" font-size="11"';

  let svg = `<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00e676" stop-opacity=".22"/><stop offset="1" stop-color="#00e676" stop-opacity="0"/></linearGradient></defs>`;
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4;
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(p)}" y2="${y(p)}" stroke="#1a201d"/><text x="${W - pad.r + 8}" y="${y(p) + 4}" fill="#6b7b72" ${mono}>${fmtPrice(p)}</text>`;
  }
  for (let i = 0; i <= 3; i++) {
    const t = t0 + ((now - t0) * i) / 3;
    svg += `<text x="${x(t)}" y="${H - 6}" fill="#6b7b72" ${mono} text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</text>`;
  }
  const line = `M${h.map((d) => `${x(d.t).toFixed(1)},${y(d.p).toFixed(1)}`).join('L')}`;
  svg += `<path d="${line}L${x(h[h.length - 1].t).toFixed(1)},${H - pad.b}L${x(h[0].t).toFixed(1)},${H - pad.b}Z" fill="url(#ga)"/>`;
  svg += `<path d="${line}" fill="none" stroke="#00e676" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const e of entries) {
    const yy = y(e.price);
    const winning = e.net > 0 ? last >= e.price : last <= e.price;
    const col = winning ? '#00e676' : '#ff4d5e';
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-opacity=".7" stroke-dasharray="5 5" stroke-width="1.5"/>
      <text x="${pad.l + 6}" y="${yy - 7}" fill="#d9e4dc" font-size="11" font-family="Inter, sans-serif" stroke="#0f1110" stroke-width="4" paint-order="stroke">${esc(e.name)} entry · ${e.net > 0 ? 'LONG' : 'SHORT'} ${Math.abs(e.net)} @ ${fmtPrice(e.price)}</text>`;
  }
  const lx = x(h[h.length - 1].t), ly = y(last);
  svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${ly}" y2="${ly}" stroke="#00e676" stroke-opacity=".25"/>
    <circle cx="${lx}" cy="${ly}" r="9" fill="#00e676" opacity=".18"/><circle cx="${lx}" cy="${ly}" r="4" fill="#00e676"/>
    <rect x="${W - pad.r + 3}" y="${ly - 10}" width="${pad.r - 6}" height="20" rx="5" fill="#00e676"/>
    <text x="${W - pad.r / 2}" y="${ly + 4}" fill="#00170a" font-weight="700" ${mono} text-anchor="middle">${fmtPrice(last)}</text>`;

  const tip = $('#chartTip');
  if (hoverX != null && hoverX >= pad.l && hoverX <= W - pad.r) {
    let best = h[0];
    for (const d of h) if (Math.abs(x(d.t) - hoverX) < Math.abs(x(best.t) - hoverX)) best = d;
    const cx = x(best.t), cy = y(best.p);
    svg += `<line x1="${cx}" x2="${cx}" y1="${pad.t}" y2="${H - pad.b}" stroke="#3a4a41"/><circle cx="${cx}" cy="${cy}" r="5" fill="#00e676" stroke="#0f1110" stroke-width="2"/>`;
    const b = document.createElement('b');
    b.textContent = fmtPrice(best.p);
    const s = document.createElement('span');
    s.textContent = `${shortC(selectedContract)} · ${new Date(best.t).toLocaleTimeString()}`;
    tip.replaceChildren(b, s);
    tip.hidden = false;
    tip.style.left = `${Math.min(cx + 12, W - 180)}px`;
    tip.style.top = `${Math.max(cy - 54, 4)}px`;
  } else tip.hidden = true;

  const el = $('#chart');
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = svg;
}
$('#chart').addEventListener('pointermove', (e) => {
  hoverX = e.offsetX;
  renderChart();
});
$('#chart').addEventListener('pointerleave', () => {
  hoverX = null;
  renderChart();
});
$('#contractTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-contract]');
  if (!b) return;
  selectedContract = b.dataset.contract;
  renderChart();
});

// ---------- sim order ticket
let priceTouched = false;
const simAccounts = () => Object.entries(accounts).filter(([, a]) => a.type === 'sim');
function roleOf(k) {
  for (const g of state.groups) {
    if (`${g.leader.connectionId}:${g.leader.accountId}` === k) return ' ★ leader';
    if (g.followers.some((f) => f.key === k)) return ' · follower';
  }
  return '';
}
function renderTicket(structural) {
  const sims = simAccounts();
  $('#ticket').hidden = !sims.length;
  if (!sims.length) return;
  const sel = $('#tAccount');
  const opts = sims.map(([k, a]) => `<option value="${esc(k)}">${esc(a.name)}${roleOf(k)}</option>`).join('');
  if (structural || sel.dataset.sig !== opts) {
    const prev = sel.value;
    sel.innerHTML = opts;
    sel.dataset.sig = opts;
    const leader = sims.find(([k]) => roleOf(k).includes('leader'));
    sel.value = prev && accounts[prev] ? prev : leader ? leader[0] : sims[0][0];
  }
  const cs = Object.keys(state.sim.contracts);
  const tc = $('#tContract');
  if (!tc.dataset.v || !cs.includes(tc.dataset.v)) tc.dataset.v = cs[0];
  const html = cs.map((c) => `<button type="button" data-c="${esc(c)}" class="${c === tc.dataset.v ? 'on' : ''}">${esc(shortC(c))}</button>`).join('');
  if (tc.dataset.sig !== html) {
    tc.innerHTML = html;
    tc.dataset.sig = html;
  }
  const px = state.sim.contracts[tc.dataset.v]?.price;
  $('#tAsk').textContent = `at ${fmtPrice(px)}`;
  $('#tBid').textContent = `at ${fmtPrice(px)}`;
  if (!priceTouched && px != null && document.activeElement !== $('#tPrice')) $('#tPrice').value = px;
  $('#simWalk').checked = !!state.sim.walking;
}
$('#tContract').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  $('#tContract').dataset.v = b.dataset.c;
  selectedContract = b.dataset.c;
  priceTouched = false;
  render(true);
});
$('#tPrice').addEventListener('input', () => (priceTouched = true));
$('#ticket').addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]');
  if (q) $('#tQty').value = Math.max(1, (Number($('#tQty').value) || 1) + Number(q.dataset.q));
  const p = e.target.closest('[data-p]');
  if (p) {
    const tick = state.sim.contracts[$('#tContract').dataset.v]?.tickSize || 0.25;
    $('#tPrice').value = (Number($('#tPrice').value) + Number(p.dataset.p) * tick).toFixed(2);
    priceTouched = true;
  }
  const t = e.target.closest('[data-t]');
  if (!t) return;
  const a = accounts[$('#tAccount').value];
  if (!a) return;
  const contractId = $('#tContract').dataset.v;
  const size = Number($('#tQty').value) || 1;
  const price = Number($('#tPrice').value);
  const base = { connectionId: a.connectionId, accountId: a.accountId, contractId };
  const o = (type, side, extra = {}) => api('POST', '/api/sim/order', { ...base, type, side, size, ...extra });
  const actions = {
    buy: () => o('market', 'buy'),
    sell: () => o('market', 'sell'),
    flatten: () => api('POST', '/api/sim/flatten', base),
    buyLimit: () => o('limit', 'buy', { limitPrice: price }),
    sellLimit: () => o('limit', 'sell', { limitPrice: price }),
    buyStop: () => o('stop', 'buy', { stopPrice: price }),
    sellStop: () => o('stop', 'sell', { stopPrice: price }),
    rejectNext: () => api('POST', '/api/sim/reject-next', base).then(() => toast(`Next order on ${a.name} will be rejected. Now trade the leader.`, 'warn')),
    desync: () => api('POST', '/api/sim/force-position', { ...base, net: (state.positions[`${a.connectionId}:${a.accountId}`]?.[contractId]?.net || 0) + 1 }),
  };
  act(async () => {
    await actions[t.dataset.t]();
    priceTouched = false;
    loadOrders();
  });
});
$('#tAccount').addEventListener('change', () => loadOrders());
$('#simWalk').addEventListener('change', (e) => act(() => api('POST', '/api/sim/walk', { on: e.target.checked })));

let ordersCache = [];
async function loadOrders() {
  const a = accounts[$('#tAccount').value];
  if (!a || a.type !== 'sim') return;
  ordersCache = await api('POST', '/api/sim/orders', { connectionId: a.connectionId, accountId: a.accountId }).catch(() => []);
  const html = ordersCache.length
    ? ordersCache.map((o) => `<div class="order-row"><span class="side ${o.side === 'buy' ? 'long' : 'short'}">${o.side.toUpperCase()} ${o.size}</span>
        <span>${esc(o.type)} ${esc(shortC(o.contractId))} @ ${fmtPrice(o.limitPrice ?? o.stopPrice)}</span>
        <span class="acts"><button class="btn ghost small" data-mv="${esc(o.orderId)}" data-d="1" title="Move up 1 tick">▲</button><button class="btn ghost small" data-mv="${esc(o.orderId)}" data-d="-1" title="Move down 1 tick">▼</button><button class="btn ghost small" data-cx="${esc(o.orderId)}">Cancel</button></span></div>`).join('')
    : '<div class="empty">No open orders.</div>';
  if ($('#tOrders').innerHTML !== html) $('#tOrders').innerHTML = html;
}
$('#tOrders').addEventListener('click', (e) => {
  const a = accounts[$('#tAccount').value];
  const b = e.target.closest('button');
  if (!b || !a) return;
  const base = { connectionId: a.connectionId, accountId: a.accountId };
  if (b.dataset.cx) act(async () => { await api('POST', '/api/sim/cancel', { ...base, orderId: b.dataset.cx }); loadOrders(); });
  if (b.dataset.mv) {
    const o = ordersCache.find((x) => x.orderId === b.dataset.mv);
    const tick = state.sim.contracts[o.contractId]?.tickSize || 0.25;
    const d = Number(b.dataset.d) * tick;
    const patch = o.type === 'limit' ? { limitPrice: o.limitPrice + d } : { stopPrice: o.stopPrice + d };
    act(async () => { await api('POST', '/api/sim/modify', { ...base, orderId: o.orderId, ...patch }); loadOrders(); });
  }
});

// ---------- tiles
function renderTiles() {
  const m = state.metrics || {};
  const lat = m.latency || {};
  const slip = m.slippage || {};
  const ms = (v) => (v == null ? '–' : `${v.toFixed(0)} ms`);
  const tile = (v, k, goal, good) => `<div class="tile ${goal ? (good ? 'good' : 'bad') : ''}"><div class="v">${v}</div><div class="k">${k}</div>${goal ? `<div class="g">${good ? '✓' : '✕'} ${goal}</div>` : ''}</div>`;
  const html = [
    tile(ms(lat.p50), 'Typical copy time', null),
    tile(ms(lat.p95), 'Slowest 5% of copies', 'goal under 100 ms', lat.p95 == null || lat.p95 < 100),
    tile(slip.avgTicks == null ? '–' : `${slip.avgTicks.toFixed(2)} t`, 'Avg price gap vs leader', null),
    tile(m.copies ?? 0, 'Orders copied', null),
    tile(m.failures ?? 0, 'Copies rejected', null),
    tile(m.desyncs ?? 0, 'Times out of sync', 'goal 0', !m.desyncs),
    tile(m.resyncs ?? 0, 'Auto-fixed', null),
  ].join('');
  if ($('#tiles').innerHTML !== html) $('#tiles').innerHTML = html;
}

// ---------- activity feed
let feed = [];
let importantOnly = false;
function humanize(l) {
  const msg = String(l.msg).replace(/[\w.-]+:[\w.-]+/g, (k) => nameOf(k)).replace(/\b(?:SIM|CON\.F\.US)\.([\w.]+)/g, '$1');
  let kind = l.level, ic = '•';
  if (/^Copied/.test(msg)) [kind, ic] = ['copy', '⧉'];
  else if (/FAILED|failed/.test(msg)) [kind, ic] = ['error', '✕'];
  else if (/OUT OF SYNC/.test(msg)) [kind, ic] = ['warn', '⚠'];
  else if (/Re-sync|back in sync|Restoring/.test(msg)) [kind, ic] = [l.level === 'info' ? 'copy' : 'warn', '↻'];
  else if (/KILL/.test(msg)) [kind, ic] = ['error', '■'];
  else if (/started/.test(msg)) [kind, ic] = ['copy', '▶'];
  else if (/stopped|Paused/.test(msg)) [kind, ic] = ['warn', '⏸'];
  else if (/connected/.test(msg)) ic = '⚡';
  else if (l.level === 'error') ic = '✕';
  else if (l.level === 'warn') ic = '⚠';
  return { msg, kind, ic, time: l.ts.slice(11, 19), ms: l.ms };
}
function setFeed(lines) {
  feed = lines.slice(-300);
  drawFeed();
}
function drawFeed() {
  const items = feed.filter((l) => !importantOnly || l.level !== 'info').slice(-120).reverse().map(humanize);
  $('#feed').innerHTML = items.length
    ? items.map((e) => `<div class="ev ${e.kind}"><div class="ic">${e.ic}</div><div>${esc(e.msg)}${e.ms != null ? ` <span class="ms">${e.ms} ms</span>` : ''}</div><div class="t">${e.time}</div></div>`).join('')
    : '<div class="empty">Nothing yet. Activity shows up here as it happens.</div>';
}
$('#logFilter').onclick = (e) => {
  importantOnly = !importantOnly;
  e.target.textContent = importantOnly ? 'Show everything' : 'Important only';
  drawFeed();
};

// ------------------------------------------------------------------ modals
function openModal(id) {
  $$('.modal').forEach((m) => (m.hidden = true));
  $(`#m-${id}`).hidden = false;
  if (id === 'group') buildGroupForm();
  if (id === 'accounts') buildConnList();
  if (id === 'connect') {
    $('#pxForm').hidden = true;
    $$('.choice').forEach((c) => c.classList.remove('on'));
  }
}
const closeModals = () => $$('.modal').forEach((m) => (m.hidden = true));
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModals());
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); }));

$$('.choice').forEach((c) =>
  c.addEventListener('click', async () => {
    if (c.dataset.choice === 'sim') {
      const ok = await act(() => api('POST', '/api/connections', { type: 'sim', label: 'Sim Lab' }), 'Sim Lab ready: 4 practice accounts, the market is moving');
      closeModals();
      if (ok && !state.groups.length) setTimeout(() => { editingGroupId = null; openModal('group'); }, 250);
    } else {
      $$('.choice').forEach((x) => x.classList.toggle('on', x === c));
      $('#pxForm').hidden = false;
    }
  })
);
$('#pxForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('[type=submit]');
  btn.textContent = 'Connecting…';
  btn.disabled = true;
  const ok = await act(() => api('POST', '/api/connections', { type: 'projectx', ...body }), 'TopstepX connected');
  btn.textContent = 'Connect';
  btn.disabled = false;
  if (ok) {
    e.target.reset();
    closeModals();
  }
};

// group wizard
const usedElsewhere = (key) => state.groups.some((g) => g.id !== editingGroupId && groupKeys(g).includes(key));
function buildGroupForm() {
  const f = $('#groupForm');
  const g = editingGroupId && state.groups.find((x) => x.id === editingGroupId);
  $('#m-group .eyebrow').textContent = g ? 'Edit group' : 'Step 2';
  f.name.value = g?.name || (state.groups.length ? `Group ${state.groups.length + 1}` : 'My copy group');
  f.resyncEnabled.checked = g ? g.resync.enabled : true;
  f.toleranceTicks.value = g ? g.resync.toleranceTicks : 4;
  const keys = Object.keys(accounts);
  const leaderKey = g ? `${g.leader.connectionId}:${g.leader.accountId}` : keys.find((k) => !usedElsewhere(k) && /leader/i.test(accounts[k].name)) || keys.find((k) => !usedElsewhere(k));
  $('#pickLeader').innerHTML = keys.length
    ? keys.map((k) => `<button type="button" class="pc ${k === leaderKey ? 'on' : ''} ${usedElsewhere(k) ? 'disabled' : ''}" data-lk="${esc(k)}"><span class="pc-name">${esc(nameOf(k))}</span><span class="pc-plat">${esc(platOf(k))}</span></button>`).join('')
    : '<div class="empty">Connect accounts first.</div>';
  const fmap = new Map((g?.followers || []).map((x) => [x.key || `${x.connectionId}:${x.accountId}`, x]));
  $('#pickFollowers').innerHTML = keys
    .map((k) => {
      const fx = fmap.get(k);
      const on = g ? !!fx : k !== leaderKey && !usedElsewhere(k);
      return `<div class="pc ${on ? 'on' : ''} ${usedElsewhere(k) || k === leaderKey ? 'disabled' : ''}" data-fk="${esc(k)}" tabindex="0">
        <span class="pc-name">${esc(nameOf(k))}</span><span class="pc-plat">${esc(platOf(k))}</span>
        <span class="pc-ctrl">size × <input type="number" step="0.5" min="0.1" value="${fx?.ratio ?? 1}" data-ratio /> max <input type="number" min="1" placeholder="–" value="${fx?.maxContracts ?? ''}" data-max /></span></div>`;
    })
    .join('');
  updatePreview();
}
$('#pickLeader').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lk]');
  if (!b) return;
  $$('#pickLeader .pc').forEach((x) => x.classList.toggle('on', x === b));
  $$('#pickFollowers .pc').forEach((x) => {
    const isL = x.dataset.fk === b.dataset.lk;
    x.classList.toggle('disabled', isL || usedElsewhere(x.dataset.fk));
    if (isL) x.classList.remove('on');
  });
  updatePreview();
});
$('#pickFollowers').addEventListener('click', (e) => {
  if (e.target.closest('input')) return;
  const c = e.target.closest('[data-fk]');
  if (!c) return;
  c.classList.toggle('on');
  updatePreview();
});
$('#pickFollowers').addEventListener('input', updatePreview);
function readGroupForm() {
  const lk = $('#pickLeader .pc.on')?.dataset.lk;
  const followers = $$('#pickFollowers .pc.on:not(.disabled)').map((c) => {
    const a = accounts[c.dataset.fk];
    const max = c.querySelector('[data-max]').value;
    return { connectionId: a.connectionId, accountId: a.accountId, key: c.dataset.fk, ratio: Number(c.querySelector('[data-ratio]').value) || 1, maxContracts: max ? Number(max) : null };
  });
  return { lk, followers };
}
function updatePreview() {
  const { lk, followers } = readGroupForm();
  $('#groupPreview').innerHTML = lk && followers.length
    ? `Example: when <b>${esc(nameOf(lk))}</b> buys <b>2</b> contracts → ${followers.map((f) => `${esc(nameOf(f.key))} buys <b>${scale(2, f)}</b>`).join(' · ')}`
    : '';
}
$('#groupForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const { lk, followers } = readGroupForm();
  if (!lk) return toast('Choose a leader account', 'error');
  if (!followers.length) return toast('Turn on at least one follower', 'error');
  const a = accounts[lk];
  const body = {
    name: f.name.value,
    leader: { connectionId: a.connectionId, accountId: a.accountId },
    followers: followers.map(({ key, ...rest }) => rest),
    resync: { enabled: f.resyncEnabled.checked, toleranceTicks: Number(f.toleranceTicks.value) },
  };
  const saved = await act(() => (editingGroupId ? api('PUT', `/api/groups/${editingGroupId}`, body) : api('POST', '/api/groups', body)));
  if (!saved) return;
  closeModals();
  editingGroupId = null;
  await act(() => api('POST', `/api/groups/${saved.id}/start`), 'Copying is ON: trade the leader and watch the followers');
};

function buildConnList() {
  $('#connList').innerHTML = state.connections.length
    ? state.connections.map((c) => `<div class="conn-row"><div><b>${esc(c.label)}</b><div class="muted small">${c.type === 'sim' ? 'Sim Lab' : 'TopstepX / ProjectX'} · ${(c.accounts || []).length} accounts</div></div>
        <div class="acts"><span class="pill ${c.status === 'connected' ? 'ok' : c.status === 'connecting' ? 'warn' : 'bad'}">${esc(c.status)}</span>
        <button class="btn ghost small" data-reconnect="${esc(c.id)}">Reconnect</button><button class="btn ghost small" data-delconn="${esc(c.id)}">Remove</button></div></div>`).join('')
    : '<div class="empty">No accounts connected yet.</div>';
}

// ------------------------------------------------------------------ global clicks
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open],[data-toggle],[data-edit],[data-delgroup],[data-resume],[data-reconnect],[data-delconn],[data-action]');
  if (!t) return;
  const d = t.dataset;
  if (d.open) {
    if (d.open === 'group') editingGroupId = null;
    openModal(d.open);
  }
  if (d.action === 'start-first' && state.groups[0]) act(() => api('POST', `/api/groups/${state.groups[0].id}/start`), 'Copying is ON');
  if (d.toggle) {
    const g = state.groups.find((x) => x.id === d.toggle);
    act(() => api('POST', `/api/groups/${d.toggle}/${g.running ? 'stop' : 'start'}`), g.running ? 'Copying stopped' : 'Copying is ON');
  }
  if (d.edit) {
    editingGroupId = d.edit;
    openModal('group');
  }
  if (d.delgroup && confirm('Delete this copy group? (Accounts and positions are not touched.)')) act(() => api('DELETE', `/api/groups/${d.delgroup}`));
  if (d.resume) act(() => api('POST', `/api/groups/${d.resume}/resume`, { followerKey: d.fkey }), 'Follower resumed');
  if (d.reconnect) act(() => api('POST', `/api/connections/${d.reconnect}/reconnect`), 'Reconnected').then(buildConnList);
  if (d.delconn && confirm('Remove this connection? Its stored API key is deleted.')) act(() => api('DELETE', `/api/connections/${d.delconn}`)).then(buildConnList);
});
$('#openAccounts').onclick = () => openModal('accounts');

$('#killBtn').onclick = () => {
  if (!confirm('KILL SWITCH\n\nStop all copy groups, cancel follower orders and close all FOLLOWER positions?')) return;
  const incl = confirm('Also close the LEADER positions?\n\nOK = close leaders too · Cancel = followers only');
  act(() => api('POST', '/api/kill', { includeLeader: incl }), 'Kill switch executed: everything is stopped');
};

// ------------------------------------------------------------------ live connection
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => mergeLive(JSON.parse(e.data)));
  es.addEventListener('log', (e) => {
    feed.push(JSON.parse(e.data));
    if (feed.length > 300) feed.shift();
    drawFeed();
  });
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    toast(String(a.message).replace(/[\w.-]+:[\w.-]+/g, (k) => nameOf(k)), a.level);
  });
  es.onerror = () => {
    $('#liveChip').classList.remove('on');
    $('#liveChip span').textContent = 'reconnecting…';
  };
}

refreshFull()
  .then(() => {
    if (!location.search.includes('nosse')) connectEvents();
    loadOrders();
  })
  .catch((e) => toast(e.message, 'error'));
setInterval(() => { if (!$('#ticket').hidden) loadOrders(); }, 1500);
