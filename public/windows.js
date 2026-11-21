'use strict';
// HR window and Marketing window (and the queue of resigners that Finance uses too)
const Q = { dashboard: { filter: '', q: '' }, finance: { filter: 'finance', q: '' } };
const FIN_FILTERS = [['finance', 'Ready for Finance'], ['approved', 'Approved'], ['', 'All resigners']];
const FILTERS = [['', 'All resigners'], ['new', 'Not started'], ['hr', 'Waiting for HR'], ['marketing', 'Waiting for Marketing'], ['finance', 'Ready for Finance'], ['approved', 'Approved']];

// HR and Marketing have no dashboard: the window opens on an Employee ID box. The dashboard belongs to Finance.
async function viewWindow(section, parts) { return parts[0] ? employeeView(section, parts[0]) : section === 'finance' ? queueView('finance') : lookupView(section); }
async function viewDashboard() { return queueView('dashboard'); }
function lookupView(section) {
  const names = { hr: 'HR', marketing: 'Marketing', finance: 'Finance' };
  $('#view').innerHTML = `<div class="card lookup"><h3>Open an employee</h3><div class="sub">Type the Employee ID (or part of the name) of the person who resigned, then press Enter.</div>
    <div class="row"><input id="lk" class="grow" placeholder="Employee ID or name" autocomplete="off" autofocus><button class="btn primary" id="lkgo">Open ${names[section] || ''} window</button></div><div id="lkres" class="lk-res"></div><div class="lk-add"><span class="muted">Not in the list?</span> <a href="#" data-act="add_resigner">Add the resigner manually</a></div></div>`;
  const inp = $('#lk'), res = $('#lkres'); let t = null;
  const go = (id) => { location.hash = `#/${section}/${id}`; };
  $('#lkgo').onclick = () => { const v = inp.value.trim(); if (v) go(/^\d+$/.test(v) ? v : (res.querySelector('[data-id]') || {}).dataset?.id || v); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#lkgo').click(); });
  inp.addEventListener('input', () => { clearTimeout(t); const q = inp.value.trim(); if (!q) { res.innerHTML = ''; return; } t = setTimeout(async () => {
    const rows = await api('GET', '/api/employees/search?q=' + encodeURIComponent(q)).catch(() => []);
    res.innerHTML = rows.map((e) => `<div class="lk-row" data-id="${esc(e.emp_id)}"><span><b>${esc(e.emp_id)}</b> &nbsp;${esc(e.name)}</span><span class="muted">${esc(e.designation || e.designation_code)} &middot; ${esc(e.station || '')} ${e.payroll_status === 'resigned' ? '<span class="chip warn">resigned</span>' : ''}</span></div>`).join('') || `<div class="muted" style="padding:10px">No employee matches. <a href="#" data-act="add_resigner" data-id="${/^\d+$/.test(q) ? esc(q) : ''}">Add this resigner manually</a></div>`;
  }, 180); });
  res.addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) go(r.dataset.id); });
}

async function queueView(section) {
  const q = Q[section], d = await api('GET', '/api/dashboard'), host = $('#view');
  const canSync = ['admin', 'hr', 'finance'].includes(S.me.role), fin = section === 'finance', flt = fin ? FIN_FILTERS : FILTERS;
  const kpi = (f, label, n) => `<div class="kpi ${q.filter === f ? 'on' : ''}" data-act="filter" data-f="${f}" data-s="${section}"><small>${label}</small><b>${n}</b></div>`;
  host.innerHTML = `<div class="row between" style="margin-bottom:16px"><div><h2>${fin ? 'Finance' : 'Dashboard'}</h2><div class="muted">${fin ? 'The settlements that are ready for Finance and the approved ones. Pick one to work on.' : 'Every resigner from the Marketing, Healthcare, Admin and Factory payrolls and where the final settlement stands. Pick one to work on.'}</div></div>
    ${canSync ? `<div class="row"><small>${d.payroll_synced_at ? 'Pulled ' + esc(d.payroll_synced_at) : 'Not pulled yet'}</small><button class="btn" data-act="sync">${IC.refresh} Pull resigners from all payrolls</button><button class="btn primary" data-act="add_resigner">${IC.plus} Add resigner manually / bulk upload</button></div>` : ''}</div>
    <div class="kpis">${fin ? kpi('finance', 'Ready for Finance', d.finance_waiting) + kpi('approved', 'Approved', d.approved) : kpi('', 'Resigners in payroll', d.resigners) + kpi('hr', 'Waiting for HR', d.hr_waiting) + kpi('marketing', 'Waiting for Marketing', d.marketing_waiting) + kpi('finance', 'Ready for Finance', d.finance_waiting) + kpi('approved', 'Approved', d.approved)}</div>
    <div class="card flush"><div class="card-h"><div class="filters" style="margin:0">${flt.map(([f, l]) => `<button class="${q.filter === f ? 'on' : ''}" data-act="filter" data-f="${f}" data-s="${section}">${l}</button>`).join('')}</div><input id="qsearch" placeholder="Search ID or name" value="${esc(q.q)}" style="max-width:240px"></div><div class="scroll" id="qtable"></div></div>`;
  $('#qsearch').addEventListener('input', (e) => { q.q = e.target.value; clearTimeout(queueView.t); queueView.t = setTimeout(() => fillQueue(section), 200); });
  await fillQueue(section);
}
async function fillQueue(section) {
  const q = Q[section], rows = await api('GET', `/api/queue?filter=${q.filter}&q=${encodeURIComponent(q.q)}`);
  $('#qtable').innerHTML = rows.length ? `<table><thead><tr><th>ID</th><th>Name</th><th>Designation</th><th>Group</th><th>Station</th><th>Last working day</th><th>Status</th></tr></thead><tbody>${rows.map((r) => `<tr class="click" data-act="open_next" data-id="${esc(r.emp_id)}" data-state="${esc(r.state)}" data-hr="${r.hr_done}" data-mkt="${r.mkt_done}"><td><b>${esc(r.emp_id)}</b></td><td>${esc(r.name)}</td><td>${esc(r.designation)}</td><td>${esc(r.group_name)}</td><td>${esc(r.station)}</td><td>${esc(fdate(r.last_working_date))}</td><td>${stateChip(r)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${S.me.role === 'viewer' ? 'Nothing here.' : 'No resigners match. Use <b>Pull resigners from all payrolls</b>, or type an Employee ID at the top.'}</div>`;
}
ACT.filter = (a) => { Q[a.dataset.s].filter = a.dataset.f; route(); };
// a click on the dashboard opens the window that has to act next (the login's own window when it is one of them)
ACT.open_next = (a) => {
  const d = a.dataset, can = S.me.sections, needs = d.state === 'approved' ? ['finance'] : [d.hr === '1' ? null : 'hr', d.mkt === '1' ? null : 'marketing', d.hr === '1' && d.mkt === '1' ? 'finance' : null].filter(Boolean);
  const pick = (needs.includes(S.me.role) ? S.me.role : needs.find((k) => can.includes(k))) || ['hr', 'marketing', 'finance'].find((k) => can.includes(k)) || 'hr';
  location.hash = `#/${pick}/${d.id}`;
};
ACT.add_resigner = (a) => { addResignerDialog(a && a.dataset ? a.dataset.id : ''); };
async function addResignerDialog(prefill = '') {
  const [des, grp] = await Promise.all([api('GET', '/api/master/designations').catch(() => []), api('GET', '/api/master/groups').catch(() => [])]);
  const d = dialog(`<h3>Add resigners</h3><div class="filters" style="margin:10px 0 14px"><button class="on" id="tab_one">One resigner</button><button id="tab_bulk">Bulk upload (Excel / CSV)</button></div>
    <div id="mr_one"><p class="muted" style="margin-bottom:14px">For somebody who is not in the payroll lists. Finance can still correct any figure later.</p>
    <div class="grid two"><label>Employee ID *<input id="mr_id" inputmode="numeric" value="${esc(prefill)}"></label><label>Name *<input id="mr_name"></label>
    <label>Designation code<input id="mr_code" list="mr_codes" placeholder="TM, STM, ASM ..."></label><label>Group<input id="mr_grp" list="mr_grps"></label>
    <label>Station<input id="mr_st"></label><label>Date of joining<input id="mr_doj" type="date"></label>
    <label>Last working date<input id="mr_lwd" type="date"></label><label>Gross salary (if no salary slip)<input id="mr_gross" type="number" min="0" class="num"></label>
    <label>CNIC<input id="mr_cnic" placeholder="xxxxx-xxxxxxx-x"></label><label>Job status<select id="mr_es"><option value="">Not known</option><option>Confirmed</option><option>Unconfirmed</option></select></label></div>
    <datalist id="mr_codes">${des.map((x) => `<option value="${esc(x.code)}">${esc(x.title)}</option>`).join('')}</datalist><datalist id="mr_grps">${grp.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
    <div class="actions"><button class="btn" id="cn">Cancel</button><button class="btn primary" id="cy">Add resigner</button></div></div>
    <div id="mr_bulk" class="hidden"><p class="muted" style="margin-bottom:12px">One row per resigner. Columns: Employee ID, Name, Designation, Group, Station, Date of joining, Last working date, Gross salary, Job status, CNIC, Company. An ID added by hand earlier is corrected from the file; an ID that comes from a payroll is skipped and listed.</p>
      <div class="row" style="margin-bottom:12px"><a class="btn" href="/api/employees/bulk-template" download>Download the Excel template</a></div>
      <label>Excel (.xlsx) or CSV file<input id="mb_file" type="file" accept=".xlsx,.csv"></label><div id="mb_out" style="margin-top:12px"></div>
      <div class="actions"><button class="btn" id="cn2">Close</button><button class="btn primary" id="mb_go">Upload resigners</button></div></div>`, { wide: true });
  $('#mr_id', d.el).focus(); $('#cn', d.el).onclick = d.close; $('#cn2', d.el).onclick = d.close;
  const tab = (bulk) => { $('#mr_one', d.el).classList.toggle('hidden', bulk); $('#mr_bulk', d.el).classList.toggle('hidden', !bulk); $('#tab_one', d.el).classList.toggle('on', !bulk); $('#tab_bulk', d.el).classList.toggle('on', bulk); };
  $('#tab_one', d.el).onclick = () => tab(false); $('#tab_bulk', d.el).onclick = () => tab(true);
  $('#mb_go', d.el).onclick = async (ev) => {
    const f = $('#mb_file', d.el).files[0]; if (!f) { toast('Choose a file first', 'err'); return; }
    ev.target.disabled = true; const r = await act(async () => api('POST', '/api/employees/bulk', { name: f.name, data: await readB64(f) })); ev.target.disabled = false; if (!r) return;
    $('#mb_out', d.el).innerHTML = `<div class="banner ${r.added ? 'ok' : 'warn'}"><div><b>${r.added} resigner(s) added</b>${r.updated ? `, ${r.updated} corrected` : ''}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.</div></div>${r.skipped.length ? `<div class="scroll" style="max-height:200px;margin-top:8px"><table><thead><tr><th>Row</th><th>ID</th><th>Name</th><th>Reason</th></tr></thead><tbody>${r.skipped.map((x) => `<tr><td>${x.row}</td><td>${esc(x.emp_id)}</td><td>${esc(x.name)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    if (r.added || r.updated) { toast(`${r.added} added, ${r.updated || 0} corrected`, 'ok'); route(); }
  };
  $('#cy', d.el).onclick = async () => {
    const v = (i) => $('#' + i, d.el).value.trim();
    const r = await act(() => api('POST', '/api/employees/manual', { emp_id: v('mr_id'), name: v('mr_name'), designation_code: v('mr_code'), group_name: v('mr_grp'), station: v('mr_st'), doj: v('mr_doj'), last_working_date: v('mr_lwd'), gross: v('mr_gross'), cnic: v('mr_cnic'), employment_status: v('mr_es') }), 'Resigner added');
    if (r) { d.close(); location.hash = `#/${ownWindow()}/${r.emp_id}`; }
  };
}
// thousand separators for the number boxes: thou(12345.5) = "12,346" (typing: keeps a leading minus and an empty box)
function unthou(v) { const x = Number(String(v == null ? '' : v).replace(/,/g, '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : 0; }
function thou(v, typing) { let t = String(v == null ? '' : v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''); if (typing) { const neg = t.startsWith('-'); t = t.replace(/-/g, ''); const [i = '', ...d] = t.split('.'); return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d.length ? '.' + d.join('') : ''); } return unthou(t).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function readB64(file) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(new Error('The file could not be read')); fr.readAsDataURL(file); }); }
ACT.sync = async (a) => {
  a.disabled = true; const r = await act(() => api('POST', '/api/employees/sync', {})); a.disabled = false; if (!r) return;
  const bad = Object.values(r.sources || {}).filter((x) => x.error);
  toast(`${r.total} resigners read (${r.added} new)${bad.length ? ' - not reachable: ' + bad.map((x) => x.label).join(', ') : ''}`, bad.length ? 'err' : 'ok'); route();
};

async function employeeView(section, id) {
  const host = $('#view'), r = await api('GET', '/api/employee/' + encodeURIComponent(id));
  if (!r.settlement) {
    const e = r.employee;
    host.innerHTML = `${section === 'finance' ? `<div class="row" style="margin-bottom:12px"><a class="btn sm ghost" href="#/finance">${IC.back} Back to the Finance list</a></div>` : ''}
      <div class="card"><div class="emp"><div class="av">${esc(initials(e.name))}</div><div><h2>${esc(e.name)} <span class="chip gray">ID ${esc(e.emp_id)}</span></h2><div class="meta"><span>${esc(e.designation || e.designation_code)}</span><span>Group ${esc(e.group_name || '-')}</span><span>${esc(e.station || '-')}</span><span>${esc(e.company || '')}</span></div></div></div>
      ${r.warning ? `<div class="banner warn" style="margin-top:16px">${IC.alert}<div>${esc(r.warning)}</div></div>` : ''}
      <p class="muted" style="margin:16px 0">No settlement has been started for this employee.${e.last_working_date ? ` The last working day on record is <b>${esc(fdate(e.last_working_date))}</b>.` : ''}</p>
      ${['admin', 'hr', 'marketing', 'finance'].includes(S.me.role) ? `<button class="btn primary lg" data-act="start" data-id="${esc(e.emp_id)}" data-s="${section}">Start the settlement</button>` : ''}</div>`;
    return;
  }
  const B = await openSettlement(r.settlement.id);
  host.innerHTML = `${section === 'finance' ? `<div class="row" style="margin-bottom:12px"><a class="btn sm ghost" href="#/finance">${IC.back} Back to the Finance list</a></div>` : ''}${empHeader(B, section)}${lockedBanner(B)}<div id="win"></div>`;
  (section === 'hr' ? renderHR : section === 'marketing' ? renderMarketing : renderFinance)(B);
}
ACT.start = async (a) => { const r = await act(() => api('POST', '/api/settlements', { emp_id: a.dataset.id })); if (r) route(); };

const editable = (B, section) => S.me.edit.includes(section) && (B.settlement.state === 'open' || S.me.role === 'admin');
const RULE_TEXT = {
  'Rule: 01': 'Notice was given and served. Nothing is recovered.', 'Rule: 02': 'Notice was given but not served. The unserved notice days are recovered (notice pay without allowances).',
  'Rule: 03': 'The company released the employee before the notice ended. Notice pay for the remaining days is paid to the employee.', 'Rule: 04': 'No notice was given. Notice pay (without allowances) is recovered.',
  'Rule: 05': 'Notice was waived off. Nothing is recovered.', Terminated: 'Terminated. A reason is required.', Deceased: 'Deceased.', NO: 'No separation rule. Use this for unconfirmed employees.',
};

// ================= HR =================
function renderHR(B) {
  const s = B.settlement, ed = editable(B, 'hr'), st = B.statement, dis = ed ? '' : 'disabled';
  $('#win').innerHTML = `<div class="cols"><div>
    <div class="card"><h3>Resignation / Termination</h3><div class="sub">What HR confirms for this employee. Marketing and Finance read these three values.</div>
      <div class="grid">
        <label><span>Date of <select id="hr_kind" class="inline" ${dis}><option value="resignation" ${s.date_kind !== 'termination' ? 'selected' : ''}>resignation</option><option value="termination" ${s.date_kind === 'termination' ? 'selected' : ''}>termination</option></select></span><input type="date" id="hr_date" value="${esc(s.resign_date || '')}" ${dis}></label>
        <label>Separation rule<select id="hr_rule" ${dis}><option value="">Select rule</option>${B.rules.map((r) => `<option value="${esc(r.code)}" ${r.code === s.sep_rule ? 'selected' : ''}>${esc(r.code)} - ${esc(r.explanation)}</option>`).join('')}</select></label>
        <label>Absent deduction (days; negative = refund)<input type="number" min="-400" step="0.5" id="hr_abs" class="num mid" value="${esc(s.absent_days || 0)}" ${dis}></label>
        <label id="hr_reason_w" class="${s.sep_rule === 'Terminated' ? '' : 'hidden'}">Termination reason<select id="hr_reason" ${dis}><option value="">Select</option>${B.reasons.map((r) => `<option ${r === s.termination_reason ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
      </div>
      <div id="hr_hints"></div>
      ${ed ? `<div class="row" style="margin-top:18px"><button class="btn" data-act="hr_save" data-done="0">Save</button><button class="btn primary" data-act="hr_save" data-done="1">${IC.check} Save &amp; mark HR complete</button>${s.hr_done ? `<span class="chip ok">HR completed ${esc(s.hr_at || '')} by ${esc(s.hr_by || '')}</span>` : ''}</div>` : `<p class="hint">${s.hr_done ? `HR completed ${esc(s.hr_at || '')} by ${esc(s.hr_by || '')}.` : 'HR has not completed this yet.'}</p>`}
    </div>
    <div class="card"><h3>Guidance</h3><ul class="muted" style="padding-left:18px;display:grid;gap:4px;margin-top:6px"><li>Select a separation rule for <b>confirmed</b> employees; select <b>NO</b> for unconfirmed employees.</li><li>Unconfirmed employees are allowed only one leave each month.</li><li>If a confirmed or unconfirmed employee takes leave next to a public holiday, the holiday is clubbed with the leave (count it as absent).</li></ul></div>
  </div>
  <div><div class="card"><h3>From the payroll</h3><div class="sub">Read-only</div>${infoRows([['Last working day (payroll)', fdate(B.employee.last_working_date) || '-'], ['Job status', st.header.jobStatus + (B.slip ? ' (salary slip)' : '')], ['Last drawn salary', 'Rs ' + fmt(st.header.lastDrawn)], ['Last salary paid for', fmonth(B.inputs.lastSalaryMonth) || '-'], ['CNIC', B.employee.cnic || '-'], ['Service', st.header.service || '-']])}</div>
  <div class="card"><h3>History</h3>${timeline(B.log)}</div></div></div>`;
  const upd = () => {
    const rule = $('#hr_rule').value, days = Number($('#hr_abs').value) || 0, gross = B.inputs.gross, dt = $('#hr_date').value; let h = '';
    $('#hr_reason_w').classList.toggle('hidden', rule !== 'Terminated');
    if (rule) h += `<p class="hint">${esc(RULE_TEXT[rule] || '')}</p>`;
    if (!st.header.confirmed && rule && !['NO', 'Terminated', 'Deceased'].includes(rule)) h += `<p class="hint warn">${IC.alert} This employee is <b>unconfirmed</b> (${esc(st.header.jobStatus)}). The rule should be "NO".</p>`;
    if (days > 0) h += `<p class="hint">Absent deduction: ${fmt2(days)} day(s) x Rs ${fmt(gross)} / 30 = <b>Rs ${fmt(gross / 30 * days)}</b>.</p>`;
    if (days < 0) h += `<p class="hint"><span class="pos"><b>Reimbursement</b></span> of ${fmt2(-days)} day(s) x Rs ${fmt(gross)} / 30 = <b>Rs ${fmt(gross / 30 * -days)}</b> is paid to the employee.</p>`;
    if (dt && B.employee.doj && dt < B.employee.doj) h += `<p class="hint bad">The date is before the joining date (${fdate(B.employee.doj)}).</p>`;
    if (dt && s.lwd && s.lwd < dt && rule === 'Rule: 01') h += `<p class="hint warn">The last working day (${fdate(s.lwd)}) is before the resignation date but the rule says the notice was served.</p>`;
    $('#hr_hints').innerHTML = h;
  };
  ['hr_date', 'hr_rule', 'hr_abs'].forEach((i) => $('#' + i).addEventListener('input', upd)); upd();
}
// after "Save & complete" the employee moves on to the next window (when this user can see it), otherwise back to the dashboard
function advance(id, next) {
  const can = S.me.sections, to = can.includes(next) ? `#/${next}/${id}` : (can.includes('dashboard') ? '#/dashboard' : null);
  if (to && location.hash !== to) location.hash = to; else route();
}
ACT.hr_save = async (a) => {
  const B = S.B, body = { resign_date: $('#hr_date').value, date_kind: $('#hr_kind').value, sep_rule: $('#hr_rule').value, absent_days: $('#hr_abs').value, termination_reason: $('#hr_reason').value, done: a.dataset.done === '1' };
  if (await act(() => api('PUT', `/api/settlements/${B.settlement.id}/hr`, body), body.done ? 'HR complete - moving to Marketing' : 'Saved')) body.done ? advance(B.employee.emp_id, B.settlement.mkt_done ? 'finance' : 'marketing') : route();
};
const infoRows = (rows) => `<div class="lines">${rows.map(([l, v]) => `<div class="line"><span class="muted">${esc(l)}</span><span class="a">${esc(v)}</span></div>`).join('')}</div>`;
const timeline = (log) => `<div class="timeline">${log.slice(0, 12).map((l) => `<div class="tl"><time>${esc((l.at || '').slice(0, 16))}</time><div><b>${esc(l.user)}</b> ${esc(l.action)}</div></div>`).join('') || '<span class="muted">Nothing yet</span>'}</div>`;

// ================= Marketing =================
function renderMarketing(B) {
  const s = B.settlement, ed = editable(B, 'marketing'), dis = ed ? '' : 'disabled';
  $('#win').innerHTML = `<div class="cols"><div>
    <div class="card"><h3>Last working day &amp; imprest</h3><div class="sub">The last working day decides which three months of travelling expenses are claimed.</div>
      <div class="grid">
        <label>Last working date${B.employee.last_working_date && B.employee.last_working_date === s.lwd ? '<span class="tag">from payroll</span>' : ''}<input type="date" id="mk_lwd" value="${esc(s.lwd || '')}" ${dis}></label>
        <label>Imprest balance (Rs)<input type="text" inputmode="decimal" id="mk_imp" class="num mid" value="${esc(thou(s.imprest || 0))}" ${dis}></label>
        <label>Imprest note<input id="mk_note" value="${esc(s.imprest_note || '')}" placeholder="optional" ${dis}></label>
      </div>
      <p class="hint" id="mk_imp_hint"></p></div>
    ${expensePaidCard(B)}
    <div class="card"><h3>Travelling expenses</h3><div class="sub">Claim, deduction and net for KM, Daily, Ex. and ON in each of the last three months. Rates are those of the year and the employee's designation (${esc(B.inputs.designationTitle || B.employee.designation_code || 'designation not set')}).</div>
      <div id="mk_months" class="months"></div></div>
    ${ed ? `<div class="row"><button class="btn" data-act="mk_save" data-done="0">Save</button><button class="btn primary" data-act="mk_save" data-done="1">${IC.check} Save &amp; mark Marketing complete</button>${s.mkt_done ? `<span class="chip ok">Marketing completed ${esc(s.mkt_at || '')} by ${esc(s.mkt_by || '')}</span>` : ''}</div>` : `<p class="hint">${s.mkt_done ? `Marketing completed ${esc(s.mkt_at || '')} by ${esc(s.mkt_by || '')}.` : 'Marketing has not completed this yet.'}</p>`}
  </div>
  <div><div class="card"><h3>HR has recorded</h3>${infoRows([[s.date_kind === 'termination' ? 'Termination date' : 'Resignation date', fdate(s.resign_date) || 'not yet'], ['Separation rule', s.sep_rule || 'not yet'], ['Absent days', String(s.absent_days || 0)]])}</div>
  <div class="card"><h3>History</h3>${timeline(B.log)}</div></div></div>`;
  drawMonths(B.expenseMeta, B.expenses, ed);
  const hint = () => { const v = unthou($('#mk_imp').value); $('#mk_imp_hint').innerHTML = v > 0 ? `<span class="warn"><b>Deduction</b> of Rs ${fmt(v)}: this amount is recovered from the employee.</span>` : v < 0 ? `<span class="pos"><b>Reimbursement</b> of Rs ${fmt(-v)}: this amount is paid to the employee.</span>` : 'No imprest balance. Enter a positive number for a deduction, a negative number for a reimbursement.'; };
  $('#mk_imp').addEventListener('input', (e) => { const el = e.target, before = el.value.length, pos = el.selectionStart; el.value = thou(el.value, true); const p = Math.max(0, pos + el.value.length - before); el.setSelectionRange(p, p); hint(); });
  $('#mk_imp').addEventListener('blur', (e) => { e.target.value = thou(unthou(e.target.value)); }); hint();
  $('#mk_lwd').addEventListener('change', async () => {
    const v = $('#mk_lwd').value; if (!v) return;
    const keep = readMonths(); const meta = await act(() => api('GET', `/api/settlements/${s.id}/months?lwd=${v}`)); if (!meta) return;
    drawMonths(meta, meta.map((m) => ({ month: m.month, claim: (keep[m.month] || {}).claim || {}, ded: (keep[m.month] || {}).ded || {}, rates: (keep[m.month] || {}).rates || null })), ed);
  });
}
const HEADS = [['km', 'KM'], ['daily', 'Daily'], ['ex', 'Ex.'], ['on', 'ON']];
// the expenses that the last payslip already paid (and a non-touring allowance)
function expensePaidCard(B) {
  const e = B.expensePaid; if (!e) return '';
  const shown = e.items.filter((i) => i.value), nt = e.nontouring > 0;
  return `<div class="card"><h3>Expenses already paid in the last payslip</h3><div class="sub">The ${esc(fmonth(e.month))} payslip paid the expenses of <b>${esc(fmonth(e.paidFor))}</b>. Claim only the months after that.</div>
    ${nt ? `<div class="banner warn" style="margin:10px 0">${IC.alert}<div>A <b>non-touring allowance of Rs ${fmt(e.nontouring)}</b> was paid in the ${esc(fmonth(e.month))} payslip.</div></div>` : ''}
    <div class="scroll"><table><thead><tr><th></th>${e.items.map((i) => `<th class="n">${esc(i.label)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>
      <tr><td><b>Expenses claimed</b></td>${e.items.map((i) => `<td class="n">${i.value ? fmt(i.value) : '-'}</td>`).join('')}<td class="n"><b>${fmt(e.claimed)}</b></td></tr></tbody></table></div>
    ${(e.dedItems || []).length ? `<div class="scroll" style="margin-top:8px"><table><thead><tr><th></th>${e.dedItems.map((i) => `<th class="n">${esc(i.label)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody><tr><td><b>Deductions of the expenses</b></td>${e.dedItems.map((i) => `<td class="n">${i.value ? fmt(i.value) : '-'}</td>`).join('')}<td class="n"><b>${fmt(e.deducted)}</b></td></tr></tbody></table></div>` : ''}
    <p class="muted" style="margin-top:8px">Net expenses <b>Rs ${fmt(e.net)}</b> &middot; net payment of that payslip <b>Rs ${fmt(e.netPayment)}</b></p>
    ${shown.length ? '' : '<p class="muted" style="margin-top:8px">Nothing was claimed in that payslip.</p>'}</div>`;
}
function drawMonths(meta, vals, ed) {
  const host = $('#mk_months');
  if (!meta.length) { host.innerHTML = '<div class="empty">Enter the last working date to see the three months.</div>'; return; }
  host.innerHTML = meta.map((m) => {
    const v = vals.find((x) => x.month === m.month) || { claim: {}, ded: {} }, rt = m.rate;
    const row = (kind, label) => `<tr class="${kind}"><td>${label}</td>${HEADS.map(([k]) => `<td><input type="text" inputmode="decimal" autocomplete="off" class="num" data-m="${m.month}" data-r="${kind}" data-k="${k}" value="${esc((v[kind] || {})[k] || '')}" placeholder="0" title="You can add several amounts: 450+50+60" ${ed ? '' : 'disabled'}><small class="xsum"></small></td>`).join('')}</tr>`;
    return `<div class="month" data-month="${m.month}"><div class="month-h"><b>${esc(m.label)}</b><div class="row" style="gap:6px">${m.holidays.map((h) => `<span class="chip info" title="${esc(h.from_date)} to ${esc(h.to_date)}">${esc(h.name)}</span>`).join('')}<span class="rates" title="${rt ? 'Master Data rates of ' + rt.year + '. Type another rate to use it for this month only.' : 'No Master Data rate for this designation: type the rates'}">${[['km', 'KM', rt && rt.fare], ['daily', 'Daily', rt && rt.daily], ['ex', 'Ex', rt && rt.ex], ['on', 'ON', rt && rt.ovn]].map(([k, l, mv]) => `<label>${l}<input type="text" inputmode="decimal" class="rate" data-rm="${m.month}" data-rk="${k}" data-master="${mv == null ? '' : mv}" value="${esc(((v.rates || {})[k] != null && (v.rates || {})[k] !== '') ? v.rates[k] : (mv == null ? '' : mv))}" ${ed ? '' : 'disabled'}></label>`).join('')}${ed ? `<button type="button" class="btn sm ghost" data-act="mk_rate_reset" data-m="${m.month}" title="Back to the Master Data rates">Master</button>` : ''}</span></div></div>
      <table><thead><tr><th></th>${HEADS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${row('claim', 'Claim')}${row('ded', 'Deduction')}<tr class="net"><td>Net expenses</td>${HEADS.map(([k]) => `<td data-net="${k}">0</td>`).join('')}</tr></tbody></table>
      <div class="amt" data-amt></div></div>`;
  }).join('');
  $$('#mk_months input').forEach((i) => i.addEventListener('input', () => calcMonth(i.closest('.month'), meta)));
  $$('#mk_months .month').forEach((m) => calcMonth(m, meta));
}
// an amount may be several values added together: 450+50+60+40 = 600 (only digits, a decimal point, + and - are accepted)
function calcExpr(v) {
  const t = String(v == null ? '' : v).replace(/[,\s]/g, ''); if (!t || !/^[0-9.+\-]+$/.test(t)) return 0;
  const parts = t.match(/[+-]?(\d+\.?\d*|\.\d+)/g); return parts ? Math.round(parts.reduce((a, p) => a + Number(p), 0) * 100) / 100 : 0;
}
const exprOk = (v) => { const t = String(v == null ? '' : v).replace(/[,\s]/g, ''); return !t || /^[+-]?(\d+\.?\d*|\.\d+)([+-](\d+\.?\d*|\.\d+))*$/.test(t); };
function calcMonth(el, meta) {
  const m = meta.find((x) => x.month === el.dataset.month); const rin = (k) => { const i = $(`[data-rk=${k}]`, el), v = i ? calcExpr(i.value) : 0; return v; }; const rt = { fare: rin('km'), daily: rin('daily'), ex: rin('ex'), ovn: rin('on') }; let c = 0, d = 0, bad = false;
  for (const [k] of HEADS) {
    const cl = calcExpr($(`[data-r=claim][data-k=${k}]`, el).value), dd = calcExpr($(`[data-r=ded][data-k=${k}]`, el).value), rate = rt ? (k === 'km' ? rt.fare : k === 'on' ? rt.ovn : rt[k]) : 0;
    $(`[data-net=${k}]`, el).textContent = fmt2(cl - dd); const over = dd > cl; $(`[data-r=ded][data-k=${k}]`, el).classList.toggle('bad', over); bad = bad || over; c += Math.round(cl * rate); d += Math.round(dd * rate);
  }
  $$('input:not(.rate)', el).forEach((i) => { const sm = i.nextElementSibling, multi = /\d\s*[+-]\s*\d/.test(i.value); if (sm) sm.textContent = multi && exprOk(i.value) ? '= ' + fmt2(calcExpr(i.value)) : ''; i.classList.toggle('bad', !exprOk(i.value) || (i.dataset.r === 'ded' && calcExpr(i.value) > calcExpr($(`[data-r=claim][data-k=${i.dataset.k}]`, el).value))); });
  $('[data-amt]', el).innerHTML = `<span>Claimed <b>Rs ${fmt(c)}</b></span><span>Deducted <b class="neg">Rs ${fmt(d)}</b></span><span>Allowed <b class="pos">Rs ${fmt(c - d)}</b></span>${bad ? '<span class="neg">A deduction is larger than its claim</span>' : ''}`;
}
function readMonths() {
  const out = {};
  $$('#mk_months .month').forEach((el) => { const m = el.dataset.month; out[m] = { claim: {}, ded: {}, rates: {} }; $$('input:not(.rate)', el).forEach((i) => { out[m][i.dataset.r][i.dataset.k] = calcExpr(i.value); }); $$('input.rate', el).forEach((i) => { out[m].rates[i.dataset.rk] = i.value.trim() === '' ? '' : calcExpr(i.value); }); });
  return out;
}
// "Master": the rates of this month go back to the Master Data rates
ACT.mk_rate_reset = (a) => {
  const el = $(`#mk_months .month[data-month="${a.dataset.m}"]`); if (!el) return;
  $$('input.rate', el).forEach((i) => { i.value = i.dataset.master; }); const first = $('input.rate', el); if (first) first.dispatchEvent(new Event('input', { bubbles: true }));
};
ACT.mk_save = async (a) => {
  const B = S.B, ex = readMonths(), body = { lwd: $('#mk_lwd').value, imprest: unthou($('#mk_imp').value), imprest_note: $('#mk_note').value, done: a.dataset.done === '1', expenses: Object.entries(ex).map(([month, v]) => ({ month, ...v })) };
  if (await act(() => api('PUT', `/api/settlements/${B.settlement.id}/marketing`, body), body.done ? (B.settlement.hr_done ? 'Marketing complete - moving to Finance' : 'Marketing complete - waiting for HR') : 'Saved')) body.done ? advance(B.employee.emp_id, B.settlement.hr_done ? 'finance' : 'hr') : route();
};
