'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-PK'); };
const fmt2 = (n) => (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fdate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? `${s.slice(8, 10)} ${MON[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}` : '');
const fmonth = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : '');
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const svg = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const IC = {
  dashboard: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  hr: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 010 5.5M18 14.4c2 .7 3.4 2.6 3.4 4.8"/>'),
  marketing: svg('<path d="M3 11v3a1 1 0 001 1h2l4 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M14 9a4 4 0 010 6M17 6.5a7.5 7.5 0 010 11"/>'),
  finance: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>'),
  report: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  master: svg('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  setting: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'), x: svg('<path d="M18 6L6 18M6 6l12 12"/>'), print: svg('<path d="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-6a1 1 0 011-1h16a1 1 0 011 1v6a1 1 0 01-1 1h-2"/><rect x="6" y="14" width="12" height="7"/>'),
  refresh: svg('<path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'), back: svg('<path d="M19 12H5m6-6l-6 6 6 6"/>'), alert: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'), down: svg('<path d="M12 4v12m-5-5l5 5 5-5M5 20h14"/>'),
};
let S = { me: null, B: null };

// ---------- talking to the server
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Error ' + r.status); e.status = r.status; if (r.status === 401 && url !== '/api/login') showLogin(); throw e; }
  return j;
}
function toast(msg, kind) { const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + (kind || ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), kind === 'bad' ? 7000 : 3200); }
const fail = (e) => toast(e.message || String(e), 'bad');
async function act(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r === undefined ? true : r; } catch (e) { fail(e); return null; } }
function dialog(html, { wide = false } = {}) {
  const o = document.createElement('div'); o.className = 'overlay'; o.innerHTML = `<div class="dlg ${wide ? 'wide' : ''}">${html}</div>`; $('#modalRoot').appendChild(o);
  const close = () => o.remove(); o.addEventListener('mousedown', (e) => { if (e.target === o) close(); }); return { el: o, close };
}
const confirmBox = (title, text, ok = 'Confirm', kind = 'primary') => new Promise((res) => { const d = dialog(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="actions"><button class="btn" id="cn">Cancel</button><button class="btn ${kind}" id="cy">${esc(ok)}</button></div>`); $('#cn', d.el).onclick = () => { d.close(); res(false); }; $('#cy', d.el).onclick = () => { d.close(); res(true); }; });
const askBox = (title, label, ok = 'Save') => new Promise((res) => { const d = dialog(`<h3>${esc(title)}</h3><label>${esc(label)}<textarea id="av" rows="3"></textarea></label><div class="actions"><button class="btn" id="cn">Cancel</button><button class="btn primary" id="cy">${esc(ok)}</button></div>`); $('#av', d.el).focus(); $('#cn', d.el).onclick = () => { d.close(); res(null); }; $('#cy', d.el).onclick = () => { const v = $('#av', d.el).value.trim(); if (!v) return toast('Please write a reason', 'bad'); d.close(); res(v); }; });

// ---------- click handlers by name:  <button data-act="save" data-id="3">
const ACT = {};
document.addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (a && ACT[a.dataset.act]) { e.preventDefault(); ACT[a.dataset.act](a, e); } });

// ---------- sign in and the shell
function showLogin() { S.me = null; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#lu').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#lerr').textContent = '';
  try { S.me = await api('POST', '/api/login', { username: $('#lu').value, password: $('#lp').value }); $('#lp').value = ''; location.hash = ''; await enter(); } catch (x) { $('#lerr').textContent = x.message; }
});
$('#outBtn').onclick = async () => { await api('POST', '/api/logout'); location.hash = ''; showLogin(); };
$('#pwBtn').onclick = () => {
  const d = dialog(`<h3>Change password</h3><div class="grid" style="grid-template-columns:1fr"><label>Current password<input id="p0" type="password"></label><label>New password (3+ characters)<input id="p1" type="password"></label></div><div class="actions"><button class="btn" id="cn">Cancel</button><button class="btn primary" id="cy">Change</button></div>`);
  $('#cn', d.el).onclick = d.close; $('#cy', d.el).onclick = async () => { if (await act(() => api('POST', '/api/me/password', { old: $('#p0', d.el).value, new: $('#p1', d.el).value }), 'Password changed')) d.close(); };
};
const NAV = [['dashboard', 'Dashboard'], ['hr', 'HR'], ['marketing', 'Marketing'], ['finance', 'Finance'], ['report', 'Report'], ['master', 'Master Data'], ['setting', 'Setting']];
async function boot() { try { S.me = await api('GET', '/api/me'); } catch { S.me = null; } if (S.me) await enter(); else showLogin(); }
async function enter() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#whoName').textContent = S.me.name; $('#whoRole').textContent = S.me.role; $('#avatar').textContent = initials(S.me.name);
  $('#nav').innerHTML = NAV.filter(([k]) => S.me.sections.includes(k)).map(([k, l]) => `<a href="#/${k}" data-nav="${k}">${IC[k]}<span>${l}</span></a>`).join('');
  if (!location.hash || location.hash === '#/') location.hash = '#/' + defaultSection();
  route();
}
const defaultSection = () => 'dashboard';
// the window that belongs to this login (admin: HR)
const ownWindow = () => (['hr', 'marketing', 'finance'].includes(S.me.role) ? S.me.role : 'hr');
window.addEventListener('hashchange', () => S.me && route());
async function route() {
  const parts = location.hash.replace(/^#\//, '').split('/').filter(Boolean), sec = parts[0] || defaultSection();
  if (!S.me.sections.includes(sec)) { location.hash = '#/' + defaultSection(); return; }
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === sec));
  const names = Object.fromEntries(NAV); $('#crumb').innerHTML = `<b>${names[sec]}</b>`;
  const VIEWS = { dashboard: viewDashboard, hr: viewWindow, marketing: viewWindow, finance: viewFinance, report: viewReport, master: viewMaster, setting: viewSetting };
  const host = $('#view'); host.innerHTML = '<div class="empty">Loading...</div>';
  try { await VIEWS[sec](sec, parts.slice(1)); } catch (e) { host.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
}
// the Employee ID box on top: opens that employee in the current window
(function finder() {
  const inp = $('#finder'), list = $('#finderList'); let t = null, items = [];
  const go = (id) => { list.classList.add('hidden'); inp.value = ''; const cur = (location.hash.replace(/^#\//, '').split('/')[0]) || defaultSection(); location.hash = `#/${['hr', 'marketing', 'finance'].includes(cur) ? cur : ownWindow()}/${id}`; };
  inp.addEventListener('input', () => { clearTimeout(t); const q = inp.value.trim(); if (!q) return list.classList.add('hidden'); t = setTimeout(async () => { try { items = await api('GET', '/api/employees/search?q=' + encodeURIComponent(q)); } catch { items = []; } list.innerHTML = items.map((e) => `<div data-id="${esc(e.emp_id)}"><span><b>${esc(e.emp_id)}</b> ${esc(e.name)}</span><small>${esc(e.designation_code || '')}</small></div>`).join('') || `<div data-id="${esc(q)}">Open Employee ID <b>${esc(q)}</b></div>`; list.classList.remove('hidden'); }, 180); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = inp.value.trim(); if (q) go(items.length && !/^\d+$/.test(q) ? items[0].emp_id : q); } if (e.key === 'Escape') list.classList.add('hidden'); });
  list.addEventListener('mousedown', (e) => { const d = e.target.closest('[data-id]'); if (d) go(d.dataset.id); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.finder')) list.classList.add('hidden'); });
})();

// ---------- pieces used by several windows
const stateChip = (r) => (r.state === 'approved' ? '<span class="chip ok">Approved</span>' : r.state === 'new' || !r.state ? '<span class="chip gray">Not started</span>' : r.hr_done && r.mkt_done ? '<span class="chip info">Ready for Finance</span>' : `<span class="chip warn">${!r.hr_done && !r.mkt_done ? 'Waiting for HR &amp; Marketing' : !r.hr_done ? 'Waiting for HR' : 'Waiting for Marketing'}</span>`);
function empHeader(B, section) {
  const e = B.employee, s = B.settlement, can = S.me.sections;
  const step = (label, done, cur) => `<span class="step ${done ? 'done' : cur ? 'cur' : ''}">${done ? IC.check : ''}${label}</span>`;
  const tenure = B.statement.header.service;
  const links = (section === 'finance' ? ['hr', 'marketing'] : []).filter((k) => can.includes(k) && k !== section).map((k) => `<a class="btn sm ghost" href="#/${k}/${esc(e.emp_id)}">${(NAV.find((n) => n[0] === k) || [])[1]} &rarr;</a>`).join('');
  return `<div class="card"><div class="emp"><div class="av">${esc(initials(e.name))}</div>
    <div><h2>${esc(e.name)} <span class="chip gray">ID ${esc(e.emp_id)}</span></h2><div class="meta"><span>${esc(e.designation || e.designation_code || '-')}</span><span>Group ${esc(e.group_name || '-')}</span><span>${esc(e.station || '-')}</span><span>Joined ${esc(fdate(e.doj) || '-')}${tenure ? ' (' + esc(tenure) + ')' : ''}</span><span>${esc(e.company || '')}</span></div></div>
    <div class="steps">${step('HR', s.hr_done, !s.hr_done)}${step('Marketing', s.mkt_done, !s.mkt_done)}${step('Finance', s.state === 'approved', s.hr_done && s.mkt_done && s.state !== 'approved')}${s.state === 'approved' ? '<span class="step done">' + IC.check + 'Approved</span>' : ''}</div></div>
    ${links ? `<div class="row no-print" style="margin-top:12px">${links}</div>` : ''}</div>`;
}
async function openSettlement(id) { const B = await api('GET', '/api/settlements/' + id); S.B = B; return B; }
const lockedBanner = (B) => (B.settlement.state === 'approved' ? `<div class="banner ok">${IC.check}<div>This settlement was approved by <b>${esc(B.settlement.approved_by)}</b> on ${esc(B.settlement.approved_at)} and is locked.${S.me.role === 'admin' ? ' <a href="#" data-act="reopen" data-id="' + B.settlement.id + '">Reopen</a>' : ''}</div></div>` : '');
ACT.reopen = async (a) => { const r = await askBox('Reopen settlement', 'Reason'); if (r && await act(() => api('POST', `/api/settlements/${a.dataset.id}/reopen`, { reason: r }), 'Reopened')) route(); };
