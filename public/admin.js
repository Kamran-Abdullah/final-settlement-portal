'use strict';
// Master Data and Setting
const MTABS = [['employees', 'Employees'], ['rates', 'Travelling rates'], ['designations', 'Designations'], ['sep_rules', 'Separation rules'], ['holidays', 'Holidays & off days'], ['other_deductions', 'Other deductions'], ['audit_obs', 'Audit observations'], ['import', 'Import from Excel']];
const CTYPES = [['pharma', 'Pharma'], ['trade', 'Trade'], ['generic', 'Generic'], ['healthcare', 'Healthcare']];
// plain list tables: columns, and which field is the key for edit / delete
const LISTS = {
  rates: { key: 'id', cols: [['year', 'Year', 'int', 90], ['designation', 'Designation', 'text'], ['fare', 'KM rate', 'num', 100], ['daily', 'Daily', 'num', 100], ['ex', 'Ex.', 'num', 100], ['ovn', 'ON', 'num', 100]], filter: 'year', note: 'Rate per KM, and per day for Daily, Ex. and ON. The rate of the year of each expense month is used; if a year is missing the latest earlier year is used.' },
  designations: { key: 'code', cols: [['code', 'Code (as in payroll)', 'text', 200], ['title', 'Full designation', 'text']], note: 'The payroll holds short codes (TM, STM, ASM ...). The full designation is used to find the travelling rate.' },
  groups: { key: 'name', cols: [['name', 'Group', 'text', 180], ['company_type', 'Company type', 'ctype', 160], ['signatory', 'Signatory', 'text'], ['signatory_title', 'Title', 'text']], note: 'Trade and Healthcare groups carry no notice-pay or training-cost recovery. Trade / Generic use the Trade heading on the letter, Healthcare its own.' },
  sep_rules: { key: 'code', cols: [['code', 'Rule', 'text', 160], ['explanation', 'Explanation', 'text'], ['sort', 'Order', 'int', 90]], note: 'The rule names are used by the calculation (Rule: 01 ... Rule: 05, Terminated, Deceased, NO). Change the wording only.' },
  holidays: { key: 'id', cols: [['from_date', 'From', 'date', 160], ['to_date', 'To', 'date', 160], ['name', 'Holiday', 'text'], ['kind', 'Type', 'kind', 140]], note: 'Shown on the Marketing window for each expense month, so claims on those days can be checked. A multi-day holiday is one row with a From and a To date.' },
  other_deductions: { key: 'id', cols: [['emp_id', 'Employee ID', 'text', 140], ['remarks', 'Reason', 'text'], ['amount', 'Amount', 'num', 140], ['active', 'Active (1/0)', 'int', 110]], note: 'An active entry is deducted automatically from that employee\'s settlement (Finance can waive it with a reason).' },
};
async function viewMaster(section, parts) {
  const tab = parts[0] || 'employees', host = $('#view'), ed = S.me.edit.includes('master');
  host.innerHTML = `<div class="row between" style="margin-bottom:16px"><div><h2>Master Data</h2><div class="muted">Rates, designations, groups, rules, holidays and the lists the settlement reads.${ed ? '' : ' You can look, not change.'}</div></div></div>
    <div class="tabs">${MTABS.filter(([k]) => k !== 'import' || ed).map(([k, l]) => `<a href="#/master/${k}"><button class="${tab === k ? 'on' : ''}" tabindex="-1">${l}</button></a>`).join('')}</div><div id="mbody"></div>`;
  if (tab === 'employees') return masterEmployees(ed);
  if (tab === 'audit_obs') return masterAudit();
  if (tab === 'import') return masterImport();
  return masterList(tab, ed);
}
const cellInput = (t, k, v, ed, w) => {
  const dis = ed ? '' : 'disabled', st = w ? `style="max-width:${w}px"` : '';
  if (t === 'ctype') return `<select data-k="${k}" ${dis}>${CTYPES.map(([a, b]) => `<option value="${a}" ${a === v ? 'selected' : ''}>${b}</option>`).join('')}</select>`;
  if (t === 'kind') return `<select data-k="${k}" ${dis}><option value="public" ${v !== 'off' ? 'selected' : ''}>Public holiday</option><option value="off" ${v === 'off' ? 'selected' : ''}>Off day</option></select>`;
  return `<input data-k="${k}" type="${t === 'date' ? 'date' : t === 'text' ? 'text' : 'number'}" ${t === 'num' ? 'step="any"' : ''} class="${t === 'text' || t === 'date' ? '' : 'num'}" value="${esc(v ?? '')}" ${st} ${dis}>`;
};
async function masterList(table, ed) {
  const cfg = LISTS[table]; let rows = await api('GET', '/api/master/' + table); const body = $('#mbody');
  let yr = table === 'rates' ? (sessionStorage.rateYear || String(new Date().getFullYear())) : '';
  const draw = () => {
    const shown = table === 'rates' ? rows.filter((r) => String(r.year) === yr) : rows, years = table === 'rates' ? [...new Set(rows.map((r) => r.year))].sort() : [];
    body.innerHTML = `<div class="card flush"><div class="card-h"><div class="muted" style="max-width:720px">${esc(cfg.note)}</div>${table === 'rates' ? `<label style="min-width:110px">Year<select id="ryr">${years.map((y) => `<option ${String(y) === yr ? 'selected' : ''}>${y}</option>`).join('')}</select></label>` : `<span class="chip gray">${rows.length} entries</span>`}</div>
      <div class="scroll"><table><thead><tr>${cfg.cols.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>
      ${ed ? `<tr data-new="1">${cfg.cols.map(([k, , t, w]) => `<td>${cellInput(t, k, k === 'year' ? yr : t === 'ctype' ? 'pharma' : t === 'int' && k === 'active' ? 1 : '', true, w)}</td>`).join('')}<td class="n"><button class="btn primary sm" data-act="ml_add" data-t="${table}">${IC.plus} Add</button></td></tr>` : ''}
      ${shown.map((r) => `<tr data-key="${esc(r[cfg.key])}">${cfg.cols.map(([k, , t, w]) => `<td>${cellInput(t, k, r[k], ed, w)}</td>`).join('')}<td class="n">${ed ? `<button class="btn sm danger" data-act="ml_del" data-t="${table}" data-key="${esc(r[cfg.key])}">${IC.trash}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nothing here yet. Import from Excel or add a row above.</td></tr>'}</tbody></table></div></div>`;
    if ($('#ryr')) $('#ryr').onchange = (e) => { yr = e.target.value; sessionStorage.rateYear = yr; draw(); };
    $$('tr[data-key] [data-k]', body).forEach((i) => i.addEventListener('change', async () => {
      const tr = i.closest('tr'), v = Object.fromEntries($$('[data-k]', tr).map((x) => [x.dataset.k, x.value]));
      if (!(await act(() => api('PUT', `/api/master/${table}/${encodeURIComponent(tr.dataset.key)}`, v)))) return; toast('Saved', 'ok'); rows = await api('GET', '/api/master/' + table);
    }));
  };
  ACT.ml_add = async (a) => { const tr = a.closest('tr'), v = Object.fromEntries($$('[data-k]', tr).map((x) => [x.dataset.k, x.value])); if (await act(() => api('POST', `/api/master/${a.dataset.t}`, v), 'Added')) { rows = await api('GET', '/api/master/' + a.dataset.t); draw(); } };
  ACT.ml_del = async (a) => { if (await confirmBox('Delete this entry?', 'This cannot be undone.', 'Delete', 'danger') && await act(() => api('DELETE', `/api/master/${a.dataset.t}/${encodeURIComponent(a.dataset.key)}`), 'Deleted')) { rows = await api('GET', '/api/master/' + a.dataset.t); draw(); } };
  draw();
}
async function masterEmployees(ed) {
  const body = $('#mbody'); let q = '';
  body.innerHTML = `<div class="card flush"><div class="card-h"><input id="eq" placeholder="Search ID or name" style="max-width:280px">${ed ? `<button class="btn primary" data-act="emp_new">${IC.plus} Add employee</button>` : ''}</div><div class="scroll" id="etab"></div></div>`;
  const load = async () => {
    const rows = await api('GET', '/api/master/employees?q=' + encodeURIComponent(q));
    $('#etab').innerHTML = `<table><thead><tr><th>ID</th><th>Name</th><th>Code</th><th>Designation</th><th>Group</th><th>Station</th><th>Joined</th><th class="n">Gross</th><th>Payroll</th><th>Source</th><th></th></tr></thead><tbody>${rows.map((e) => `<tr><td><b>${esc(e.emp_id)}</b></td><td>${esc(e.name)}</td><td>${esc(e.designation_code)}</td><td>${esc(e.designation)}</td><td>${esc(e.group_name)}</td><td>${esc(e.station)}</td><td>${esc(fdate(e.doj))}</td><td class="n">${fmt(e.gross)}</td><td>${e.payroll_status === 'resigned' ? '<span class="chip warn">resigned</span>' : esc(e.payroll_status || '')}</td><td><small>${esc(e.source || '')}</small></td><td class="n">${ed ? `<button class="btn sm" data-act="emp_edit" data-id="${esc(e.emp_id)}">Edit</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">No employee found.</td></tr>'}</tbody></table>`;
    ACT.emp_edit = (a) => empDialog(rows.find((x) => x.emp_id === a.dataset.id), load);
  };
  ACT.emp_new = () => empDialog(null, load);
  $('#eq').addEventListener('input', (e) => { q = e.target.value; clearTimeout(masterEmployees.t); masterEmployees.t = setTimeout(load, 200); }); load();
}
function empDialog(e, done) {
  const n = !e; e = e || {};
  const d = dialog(`<h3>${n ? 'Add employee' : 'Edit ' + esc(e.name)}</h3><div class="grid two"><label>Employee ID<input id="m_id" value="${esc(e.emp_id || '')}" ${n ? '' : 'disabled'}></label><label>Name<input id="m_name" value="${esc(e.name || '')}"></label>
    <label>Designation code<input id="m_code" list="dl_codes" value="${esc(e.designation_code || '')}"></label><label>Group<input id="m_grp" value="${esc(e.group_name || '')}"></label><label>Station<input id="m_st" value="${esc(e.station || '')}"></label><label>Date of joining<input id="m_doj" type="date" value="${esc(e.doj || '')}"></label>
    <label>Gross salary<input id="m_gross" type="number" class="num" value="${esc(e.gross || 0)}"></label><label>Employment status<select id="m_es"><option value="">-</option><option ${e.employment_status === 'Confirmed' ? 'selected' : ''}>Confirmed</option><option ${e.employment_status === 'Unconfirmed' ? 'selected' : ''}>Unconfirmed</option></select></label></div>
    <datalist id="dl_codes"></datalist><div class="actions"><button class="btn" id="cn">Cancel</button><button class="btn primary" id="cy">Save</button></div>`, { wide: true });
  api('GET', '/api/master/designations').then((r) => { $('#dl_codes', d.el).innerHTML = r.map((x) => `<option value="${esc(x.code)}">${esc(x.title)}</option>`).join(''); });
  $('#cn', d.el).onclick = d.close;
  $('#cy', d.el).onclick = async () => {
    const v = (i) => $('#' + i, d.el).value, b = { emp_id: v('m_id'), name: v('m_name'), designation_code: v('m_code'), group_name: v('m_grp'), station: v('m_st'), doj: v('m_doj'), gross: v('m_gross'), employment_status: v('m_es') };
    if (await act(() => (n ? api('POST', '/api/master/employees', b) : api('PUT', '/api/master/employees/' + e.emp_id, b)), 'Saved')) { d.close(); done(); }
  };
}
async function masterAudit() {
  const body = $('#mbody'); body.innerHTML = `<div class="card flush"><div class="card-h"><div class="muted">Audit totals per employee and month. They come from the Audit sheet of the Finance template (Import from Excel). A month that is not yet recovered in the payroll is deducted from the settlement.</div><input id="aq" placeholder="Employee ID or name" style="max-width:240px"></div><div class="scroll" id="atab"></div></div>`;
  const load = async () => { const rows = await api('GET', '/api/master/audit_obs?q=' + encodeURIComponent($('#aq').value.trim())); $('#atab').innerHTML = `<table><thead><tr><th>Month</th><th>Employee ID</th><th>Name</th><th class="n">Total</th>${S.me.edit.includes('master') ? '<th></th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(fmonth(r.month))}</td><td>${esc(r.emp_id)}</td><td>${esc(r.name)}</td><td class="n">${fmt(r.total)}</td>${S.me.edit.includes('master') ? `<td class="n"><button class="btn sm danger" data-act="ao_del" data-id="${r.id}" data-m="${esc(fmonth(r.month))}" data-e="${esc(r.emp_id)}" data-t="${fmt(r.total)}">Delete</button></td>` : ''}</tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing found.</td></tr>'}</tbody></table>`; };
  $('#aq').addEventListener('input', () => { clearTimeout(masterAudit.t); masterAudit.t = setTimeout(load, 250); }); load();
}
ACT.ao_del = async (a) => {
  const d = a.dataset; if (!await confirmBox('Delete this audit observation?', `${d.m}, employee ${d.e}, Rs ${d.t}. It is no longer deducted from any settlement.`, 'Delete', 'danger')) return;
  if (await act(() => api('DELETE', '/api/master/audit_obs/' + d.id), 'Deleted')) masterAudit();
};
function masterImport() {
  $('#mbody').innerHTML = `<div class="card"><h3>Load everything from the Finance template</h3><div class="sub">Reads the sheets <b>MD_Final</b> (employees, rates, designations, groups, separation rules, other deductions), <b>Holiday</b>, <b>Audit</b> and the letter wording / signatories of <b>Finance</b>. Rates, designations, groups, rules, holidays, other deductions and audit observations are replaced by what the file holds. Employees already pulled from the payroll are kept.</div>
    <label>Path of the template on this computer<input id="imp_path" value=""></label>
    <div class="row" style="margin-top:14px"><button class="btn primary" data-act="imp_go">${IC.down} Import from this path</button><span class="muted">or</span><input type="file" id="imp_file" accept=".xlsx" style="max-width:300px"><button class="btn" data-act="imp_up">Import the chosen file</button></div><div id="imp_out" style="margin-top:16px"></div></div>`;
}
const showReport = (r) => { $('#imp_out').innerHTML = `<div class="banner ok">${IC.check}<div>Imported: ${Object.entries(r).map(([k, v]) => `<b>${v === true ? 'letter wording' : v}</b> ${k.replace('_', ' ')}`).join(' &middot; ')}</div></div>`; };
ACT.imp_go = async (a) => { a.disabled = true; const r = await act(() => api('POST', '/api/master-import', { path: $('#imp_path').value })); a.disabled = false; if (r) showReport(r.report); };
ACT.imp_up = async (a) => {
  const f = $('#imp_file').files[0]; if (!f) return toast('Choose the Excel file first', 'bad');
  const data = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1]); rd.readAsDataURL(f); });
  a.disabled = true; const r = await act(() => api('POST', '/api/master-import', { data })); a.disabled = false; if (r) showReport(r.report);
};

// ================= Setting =================
const STABS = [['sources', 'Data sources'], ['company', 'Company & letter'], ['users', 'Users'], ['backup', 'Backup'], ['audit', 'Audit trail']];
async function viewSetting(section, parts) {
  const tab = parts[0] || 'sources';
  $('#view').innerHTML = `<div style="margin-bottom:16px"><h2>Setting</h2><div class="muted">Where the three sources are read from, the letter wording, the people who can sign in, and backups.</div></div><div class="tabs">${STABS.map(([k, l]) => `<a href="#/setting/${k}"><button class="${tab === k ? 'on' : ''}" tabindex="-1">${l}</button></a>`).join('')}</div><div id="sbody"></div>`;
  const cfg = await api('GET', '/api/settings');
  ({ sources: setSources, company: setCompany, users: setUsers, backup: setBackup, audit: setAudit }[tab] || setSources)(cfg);
}
const sv = (id) => $('#' + id).value;
async function saveSettings(body, msg = 'Saved') { return act(() => api('PUT', '/api/settings', body), msg); }
const PAYROLLS = [['marketing', 'Marketing', 'payroll_db_path'], ['healthcare', 'Healthcare', 'payroll_db_healthcare'], ['admin', 'Admin', 'payroll_db_admin'], ['factory', 'Factory', 'payroll_db_factory']];
function setSources(c) {
  $('#sbody').innerHTML = `<div class="card"><h3>1. Resigners - the four payroll databases</h3><div class="sub">The payroll databases are only read, never changed. Employees with the status "resigned" in Marketing, Healthcare, Admin and Factory become the queue in HR, Marketing and Finance.</div>
      ${PAYROLLS.map(([k, l, set]) => `<label>${l} payroll database file<div class="row" style="flex-wrap:nowrap"><input id="s_db_${k}" value="${esc(c[set])}" style="flex:1"><button class="btn" data-act="s_test_p" data-k="${k}">Test</button></div><small id="s_pout_${k}" class="muted"></small></label>`).join('')}
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="s_save_p">Save</button><button class="btn" data-act="sync">${IC.refresh} Pull resigners from all payrolls now</button></div></div>
    <div class="card"><h3>2. Provident fund - PF database</h3><div class="sub">The PF database file is read directly, so the PF application does <b>not</b> have to be running. Nothing in it is changed. The PF portal below is only used when no database file is found.</div>
      <label>PF database file (pf.db)<div class="row" style="flex-wrap:nowrap"><input id="s_pfdb" value="${esc(c.pf_db_path)}" style="flex:1"><button class="btn" data-act="s_test_pfdb">Test</button><button class="btn primary" data-act="s_save_pfdb">Save</button></div><small id="s_pfdbout" class="muted"></small></label>
      <h4 style="margin:16px 0 4px">PF portal (only if there is no database file)</h4>
      <div class="grid three"><label>PF portal address<input id="s_pfu" value="${esc(c.pf_url)}" placeholder="http://localhost:3000"></label><label>PF user<input id="s_pfn" value="${esc(c.pf_user)}" autocomplete="off"></label><label>PF password ${c.pf_pass_set ? '<span class="tag">saved</span>' : ''}<input id="s_pfp" type="password" placeholder="${c.pf_pass_set ? 'leave empty to keep' : ''}" autocomplete="new-password"></label></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="s_save_pf">Save</button><button class="btn" data-act="s_test_pf">Test sign-in</button><span id="s_pfout" class="muted"></span></div></div>
    <div class="card"><h3>3. Salary slips</h3><div class="sub">A resigner's slip is the latest month in which the ID appears. Slips come from the finished payroll runs of the four payroll databases, from the monthly Excel files (sheet "Salary") of a folder, and from any Excel file you upload.</div>
      <div class="row" style="margin-bottom:6px"><button class="btn primary" data-act="s_sync_slips">${IC.refresh} Read the slips from the four payroll databases</button><span id="s_dout" class="muted"></span></div>
      <div class="grid three" style="margin-top:14px;align-items:end"><label>Upload an Excel file for<select id="s_upsrc">${PAYROLLS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label><label>Month (if not in the file name)<input id="s_upmon" type="month"></label><label>Excel file (.xlsx)<input id="s_upfile" type="file" accept=".xlsx"></label></div>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="s_upload">Upload the salary file</button><span id="s_upout" class="muted"></span></div>
      <h4 style="margin:18px 0 4px">Payslip history (monthly payslip sheets)</h4><div class="sub" style="margin:0 0 8px">Excel files with one sheet per month and one printed payslip per employee (the Payslip folder). They are read in the background; it can take a few minutes for the big files, and files that did not change are skipped.</div>
      <div class="row" style="flex-wrap:nowrap"><input id="s_psf" value="${esc(c.payslip_folder)}" style="flex:1"><button class="btn primary" data-act="s_ps_import">${IC.refresh} Read the payslips now</button><button class="btn" data-act="s_ps_force" title="Read every file again, also the unchanged ones">Read everything again</button></div><div id="s_psout" class="muted" style="margin-top:8px"></div>
      <h4 style="margin:18px 0 4px">Excel folder</h4>
      <div class="grid three"><label>Folder<input id="s_fol" value="${esc(c.slip_folder)}"></label><label>Sheet name<input id="s_sheet" value="${esc(c.slip_sheet)}"></label><label>Trade company: file name contains<input id="s_kw" value="${esc(c.trade_keyword)}"></label></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="s_save_s">Save</button><button class="btn" data-act="s_scan">${IC.refresh} Scan the folder now</button><span id="s_sout" class="muted"></span></div><div id="s_files" style="margin-top:14px"></div></div>`;
  loadFiles();
}
async function loadFiles() { const f = await api('GET', '/api/settings/slip-files'); $('#s_files').innerHTML = f.length ? `<table><thead><tr><th>File</th><th>Month</th><th>Company</th><th class="n">Rows</th><th>Imported</th></tr></thead><tbody>${f.map((x) => `<tr><td>${esc(x.file_name)}</td><td>${esc(fmonth(x.month))}</td><td>${esc(({ trade: 'Marketing (Trade)', pharma: 'Marketing (Pharma)', healthcare: 'Healthcare', admin: 'Admin', factory: 'Factory' })[x.company] || x.company)}</td><td class="n">${x.rows}</td><td>${esc(x.imported_at)}</td></tr>`).join('')}</tbody></table>` : '<span class="muted">No salary files imported yet.</span>'; }
ACT.s_save_p = () => saveSettings(Object.fromEntries(PAYROLLS.map(([k, , set]) => [set, sv('s_db_' + k)])));
ACT.s_test_p = async (a) => { const k = a.dataset.k, out = $('#s_pout_' + k); const r = await act(() => api('POST', '/api/settings/test-payroll', { source: k, path: sv('s_db_' + k) })); out.innerHTML = r ? `<span class="pos">Connected: ${r.employees} employees, ${r.resigned} resigned</span>` : '<span class="neg">Not reachable</span>'; };
let psTimer = null;
function psPoll() {
  clearInterval(psTimer);
  const tick = async () => {
    const j = await api('GET', '/api/settings/payslip-history/status').catch(() => null), out = $('#s_psout'); if (!out) { clearInterval(psTimer); return; } if (!j) return;
    const done = j.report.filter((r) => r.slips != null).reduce((n, r) => n + r.slips, 0), skipped = j.report.filter((r) => r.skipped).length;
    out.innerHTML = j.running ? `<span class="pos">Reading ${esc(j.current || '...')} &middot; ${j.sheets} month sheet(s), ${j.slips.toLocaleString()} payslips so far</span>` : j.error ? `<span class="neg">${esc(j.error)}</span>` : j.finished ? `<span class="pos">Done: ${j.sheets} month sheet(s), ${done.toLocaleString()} payslips read${skipped ? `, ${skipped} file(s) unchanged` : ''}</span>` : '';
    if (!j.running) { clearInterval(psTimer); if (j.finished) loadFiles(); }
  };
  tick(); psTimer = setInterval(tick, 2500);
}
ACT.s_ps_force = async () => { const r = await act(() => api('POST', '/api/settings/payslip-history/import', { folder: sv('s_psf'), force: true })); if (r) psPoll(); };
ACT.s_ps_import = async () => { const r = await act(() => api('POST', '/api/settings/payslip-history/import', { folder: sv('s_psf') })); if (r) psPoll(); };
ACT.s_sync_slips = async (a) => {
  await saveSettings(Object.fromEntries(PAYROLLS.map(([k, , set]) => [set, sv('s_db_' + k)])), ''); a.disabled = true; $('#s_dout').textContent = 'Reading the payroll runs...';
  const r = await act(() => api('POST', '/api/settings/sync-slips', {})); a.disabled = false; if (!r) { $('#s_dout').textContent = ''; return; }
  const ok = r.report.filter((x) => x.rows != null), bad = r.report.filter((x) => x.error);
  $('#s_dout').innerHTML = `<span class="pos">${ok.length} payroll month(s) read, ${ok.reduce((n, x) => n + x.rows, 0)} slips</span>${bad.length ? ` <span class="neg">${bad.map((x) => esc(x.source + ': ' + x.error)).join('; ')}</span>` : ''}`; loadFiles();
};
ACT.s_upload = async (a) => {
  const f = $('#s_upfile').files[0]; if (!f) { toast('Choose an Excel file first', 'err'); return; }
  a.disabled = true; $('#s_upout').textContent = 'Reading the file...';
  const r = await act(async () => api('POST', '/api/slips/upload', { name: f.name, data: await readB64(f), source: sv('s_upsrc'), month: sv('s_upmon') })); a.disabled = false;
  if (!r) { $('#s_upout').textContent = ''; return; } $('#s_upout').innerHTML = `<span class="pos">${esc(r.file)}: ${r.rows} slips for ${esc(fmonth(r.month))}</span>`; $('#s_upfile').value = ''; loadFiles();
};
ACT.s_save_pfdb = () => saveSettings({ pf_db_path: sv('s_pfdb') });
ACT.s_test_pfdb = async () => { const r = await act(() => api('POST', '/api/settings/test-pf-db', { path: sv('s_pfdb') })); $('#s_pfdbout').innerHTML = r ? `<span class="pos">Connected: ${r.employees} employees, ${r.contributions} contribution rows</span>` : '<span class="neg">Not reachable</span>'; };
ACT.s_save_pf = () => saveSettings({ pf_url: sv('s_pfu'), pf_user: sv('s_pfn'), ...(sv('s_pfp') ? { pf_pass: sv('s_pfp') } : {}) }).then((r) => { if (r) $('#s_pfp').value = ''; });
ACT.s_test_pf = async () => { await saveSettings({ pf_url: sv('s_pfu'), pf_user: sv('s_pfn'), ...(sv('s_pfp') ? { pf_pass: sv('s_pfp') } : {}) }, ''); const r = await act(() => api('POST', '/api/settings/test-pf', {})); $('#s_pfout').innerHTML = r ? '<span class="pos">Signed in to the PF portal</span>' : ''; };
ACT.s_save_s = () => saveSettings({ slip_folder: sv('s_fol'), slip_sheet: sv('s_sheet'), trade_keyword: sv('s_kw') });
ACT.s_scan = async (a) => {
  await saveSettings({ slip_folder: sv('s_fol'), slip_sheet: sv('s_sheet'), trade_keyword: sv('s_kw') }, ''); a.disabled = true; $('#s_sout').textContent = 'Reading the files...';
  const r = await act(() => api('POST', '/api/settings/scan-slips', {})); a.disabled = false; if (!r) { $('#s_sout').textContent = ''; return; }
  const ok = r.report.filter((x) => x.rows != null), bad = r.report.filter((x) => x.error);
  $('#s_sout').innerHTML = `<span class="pos">${ok.length} salary file(s) read</span>${bad.length ? ` <span class="neg">${bad.map((x) => esc(x.file + ': ' + x.error)).join('; ')}</span>` : ''}`; loadFiles();
};
function setCompany(c) {
  const f = (id, l, v, extra = '') => `<label>${l}<input id="${id}" value="${esc(v)}" ${extra}></label>`;
  $('#sbody').innerHTML = `<div class="card"><h3>Company heading on the letter</h3><div class="grid three">${f('c_op', 'Pharma (Pvt.) heading', c.org_pharma)}${f('c_ot', 'Trade / Generic heading', c.org_trade)}${f('c_oh', 'Healthcare heading', c.org_healthcare)}</div></div>
    <div class="card"><h3>Banks and signatories</h3><div class="grid">${f('c_b1', 'Bank for the provident fund', c.pf_bank_name)}${f('c_b2', 'Bank for the rest', c.main_bank_name)}${f('c_s1', 'Signatory 1 name', c.sign1_name)}${f('c_t1', 'Signatory 1 title', c.sign1_title)}${f('c_s2', 'Signatory 2 name', c.sign2_name)}${f('c_t2', 'Signatory 2 title', c.sign2_title)}</div>
      <label style="margin-top:14px">Note printed on the letter<textarea id="c_note" rows="4">${esc(c.letter_note)}</textarea></label></div>
    <div class="card"><h3>Calculation</h3><div class="sub">These are the numbers hard-wired in the Finance sheet.</div><div class="grid">${f('c_dim', 'Days in a month', c.days_in_month, 'type="number"')}${f('c_tc', 'Training and orientation cost (Rs)', c.training_cost, 'type="number"')}${f('c_td', 'Training cost applies when service is under (days)', c.training_days, 'type="number"')}${f('c_em', 'Expense months shown', c.expense_months, 'type="number"')}</div></div>
    <div class="card"><h3>Posting accounts</h3><div class="sub">The ledger codes used in the posting (accounting voucher) of a final settlement. The FSA ledger depends on the employee's payroll.</div>
      <div class="grid">${f('p_fm', 'FSA ledger code - Marketing payroll', c.post_fsa_marketing)}${f('p_fa', 'FSA ledger code - Admin payroll', c.post_fsa_admin)}${f('p_ff', 'FSA ledger code - Factory payroll', c.post_fsa_factory)}${f('p_fh', 'FSA ledger code - Healthcare payroll', c.post_fsa_healthcare)}${f('p_fn', 'FSA ledger name', c.post_fsa_name)}
      ${f('p_bc', 'Bank account code', c.post_bank_code)}${f('p_bn', 'Bank account name', c.post_bank_name)}${f('p_pc', 'Provident fund payable code', c.post_pf_code)}${f('p_pn', 'Provident fund payable name', c.post_pf_name)}${f('p_rc', 'FSA receivable code', c.post_rec_code)}${f('p_rn', 'FSA receivable name', c.post_rec_name)}${f('p_sc', 'Salaries code', c.post_sal_code)}${f('p_sn', 'Salaries name', c.post_sal_name)}${f('p_in', 'Imprest ledger name', c.post_imp_name)}${f('p_bp', 'Prefix of the bank cheque number in the narration (e.g. HMB-)', c.post_bank_prefix)}${f('p_pp', 'Prefix of the PF cheque number in the narration (e.g. PF-)', c.post_pf_prefix)}</div></div>
    <button class="btn primary" data-act="c_save">Save</button>`;
}
ACT.c_save = () => saveSettings({ post_fsa_marketing: sv('p_fm'), post_fsa_admin: sv('p_fa'), post_fsa_factory: sv('p_ff'), post_fsa_healthcare: sv('p_fh'), post_fsa_name: sv('p_fn'), post_bank_code: sv('p_bc'), post_bank_name: sv('p_bn'), post_pf_code: sv('p_pc'), post_pf_name: sv('p_pn'), post_rec_code: sv('p_rc'), post_rec_name: sv('p_rn'), post_sal_code: sv('p_sc'), post_sal_name: sv('p_sn'), post_imp_name: sv('p_in'), post_bank_prefix: sv('p_bp'), post_pf_prefix: sv('p_pp'), org_pharma: sv('c_op'), org_trade: sv('c_ot'), org_healthcare: sv('c_oh'), pf_bank_name: sv('c_b1'), main_bank_name: sv('c_b2'), sign1_name: sv('c_s1'), sign1_title: sv('c_t1'), sign2_name: sv('c_s2'), sign2_title: sv('c_t2'), letter_note: sv('c_note'), days_in_month: sv('c_dim'), training_cost: sv('c_tc'), training_days: sv('c_td'), expense_months: sv('c_em') });
async function setUsers() {
  const rows = await api('GET', '/api/users'), roles = [['admin', 'Administrator (everything)'], ['hr', 'HR'], ['marketing', 'Marketing'], ['finance', 'Finance (+ Master Data)'], ['viewer', 'Viewer (read only)']];
  $('#sbody').innerHTML = `<div class="card flush"><div class="card-h"><div><h3>Users</h3><div class="sub" style="margin:0">Each role opens its own window. Passwords need 3 or more characters.</div></div></div><div class="scroll"><table><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Active</th><th>Last sign-in</th><th>New password</th></tr></thead><tbody>
    ${rows.map((u) => `<tr data-u="${u.id}"><td><b>${esc(u.username)}</b></td><td><input data-f="full_name" value="${esc(u.full_name || '')}"></td><td><select data-f="role">${roles.map(([r, l]) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''}></td><td>${esc(u.last_login || '')}</td><td><input type="password" data-f="password" placeholder="leave empty" autocomplete="new-password"></td></tr>`).join('')}</tbody></table></div><div class="card-h" style="border-top:1px solid var(--line)"><button class="btn primary" data-act="u_save">Save changes</button></div></div>
    <div class="card"><h3>Add a user</h3><div class="grid"><label>User name<input id="u_n"></label><label>Full name<input id="u_f"></label><label>Role<select id="u_r">${roles.map(([r, l]) => `<option value="${r}">${l}</option>`).join('')}</select></label><label>Password<input id="u_p" type="password" autocomplete="new-password"></label></div><div style="margin-top:14px"><button class="btn" data-act="u_add">${IC.plus} Add user</button></div></div>`;
}
ACT.u_save = async () => { for (const tr of $$('tr[data-u]')) { const b = { full_name: $('[data-f=full_name]', tr).value, role: $('[data-f=role]', tr).value, active: $('[data-f=active]', tr).checked }; const p = $('[data-f=password]', tr).value; if (p) b.password = p; try { await api('PUT', '/api/users/' + tr.dataset.u, b); } catch (e) { return fail(e); } } toast('Saved', 'ok'); setUsers(); };
ACT.u_add = async () => { if (await act(() => api('POST', '/api/users', { username: sv('u_n'), full_name: sv('u_f'), role: sv('u_r'), password: sv('u_p') }), 'User added')) setUsers(); };
async function setBackup(c) {
  const b = await api('GET', '/api/settings/backups');
  $('#sbody').innerHTML = `<div class="card"><h3>Where the data is kept</h3><p class="muted">Database file: <code>${esc(c.db_file)}</code><br>${/OneDrive/i.test(c.app_dir || '') ? '' : ''}A copy is made automatically once a day (the last 14 are kept). Close the portal before copying the database file by hand.</p><button class="btn primary" data-act="bk_now">${IC.down} Back up now</button></div>
    <div class="card flush"><div class="card-h"><h3>Backups</h3></div><table><thead><tr><th>File</th><th class="n">Size</th></tr></thead><tbody>${b.map((x) => `<tr><td>${esc(x.file)}</td><td class="n">${fmt(x.size / 1024)} KB</td></tr>`).join('') || '<tr><td colspan="2" class="empty">No backups yet.</td></tr>'}</tbody></table></div>`;
}
ACT.bk_now = async () => { if (await act(() => api('POST', '/api/settings/backup', {}), 'Backup taken')) setBackup(await api('GET', '/api/settings')); };
async function setAudit() {
  const rows = await api('GET', '/api/audit-log');
  $('#sbody').innerHTML = `<div class="card flush"><div class="card-h"><h3>Audit trail</h3><span class="muted">latest 300 actions</span></div><div class="scroll"><table><thead><tr><th>When</th><th>User</th><th>Employee</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows.map((l) => `<tr><td>${esc(l.at)}</td><td>${esc(l.user)}</td><td>${esc(l.emp_id || '')}</td><td>${esc(l.action)}</td><td><small>${esc((l.detail || '').slice(0, 160))}</small></td></tr>`).join('')}</tbody></table></div></div>`;
}
