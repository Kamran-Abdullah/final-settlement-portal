'use strict';
// Finance window: the whole Final Settlement sheet, calculated and explained
let FT = 'settlement';
async function viewFinance(section, parts) { return viewWindow('finance', parts); }

const TABS = [['settlement', 'Settlement'], ['adjust', 'Adjustments'], ['slip', 'Salary slip'], ['pf', 'Provident fund'], ['expenses', 'Travelling expenses'], ['letter', 'Letter'], ['posting', 'Posting'], ['history', 'History']];
function renderFinance(B) {
  const st = B.statement, s = B.settlement, ed = editable(B, 'finance');
  const pending = [!s.hr_done && 'HR', !s.mkt_done && 'Marketing'].filter(Boolean);
  const errs = st.checks.filter((c) => c.status === 'error').length, warns = st.checks.filter((c) => c.status === 'warn').length + st.notes.length;
  $('#win').innerHTML = `${pending.length ? `<div class="banner warn">${IC.alert}<div><b>${pending.join(' and ')}</b> ${pending.length > 1 ? 'have' : 'has'} not completed yet. You can preview the settlement, but it cannot be approved until they do.</div></div>` : ''}
    <div class="net-card"><div class="row between"><div><small>${st.direction === 'receivable' ? 'Net amount receivable from the employee (negative)' : 'Net amount payable'}</small><b>${st.net < 0 ? '-' : ''}Rs ${fmt(Math.abs(st.net))}</b><small>Gross payable Rs ${fmt(st.grossPayable)} &nbsp;&middot;&nbsp; Deductions Rs ${fmt(st.totalDeductions)} &nbsp;&middot;&nbsp; Reimbursements Rs ${fmt(st.totalReimbursements)}</small></div>
      <div class="row no-print">${ed ? `<button class="btn" data-act="fin_refresh">${IC.refresh} Refresh PF &amp; salary slip</button>` : ''}<button class="btn" data-act="fin_print">${IC.print} Print letter</button>${ed && s.state === 'open' ? `<button class="btn ok" data-act="fin_approve">${IC.check} Approve settlement</button>` : ''}</div></div></div>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="${FT === k ? 'on' : ''}" data-act="ftab" data-t="${k}">${l}${k === 'settlement' && (errs || warns) ? ` <span class="chip ${errs ? 'bad' : 'warn'}">${errs || warns}</span>` : ''}</button>`).join('')}</div><div id="ftab"></div>`;
  ({ settlement: tSettlement, adjust: tAdjust, slip: tSlip, pf: tPF, expenses: tExpenses, letter: tLetter, posting: tPosting, history: tHistory }[FT])(B, ed);
}
ACT.ftab = (a) => { FT = a.dataset.t; renderFinance(S.B); };
// print / save as PDF: only the letter, on one A4 page (also used when Ctrl+P is pressed on an open settlement)
function preparePrint() {
  const root = $('#printRoot'); if (!S.B || !S.B.statement || !/#\/finance\/\d+/.test(location.hash)) return false;
  root.dataset.tpl = String(LTPL); root.innerHTML = [letterHtml(S.B), ...extraPages(S.B)].map((h) => `<div class="pp"><div class="pz">${h}</div></div>`).join(''); document.body.classList.add('printing-letter'); fitPrintRoot(root); return true;
}
function endPrint() { document.body.classList.remove('printing-letter', 'tpl2'); $('#printRoot').innerHTML = ''; }
window.addEventListener('beforeprint', () => { if (!document.body.classList.contains('printing-letter')) preparePrint(); });
window.addEventListener('afterprint', endPrint);
// fit again when the browser switches to the print layout (the screen measurement can differ by a line)
try { matchMedia('print').addEventListener('change', (e) => { const r = $('#printRoot'); if (e.matches && r && r.firstElementChild) fitPrintRoot(r); }); } catch { /* old browser */ }
ACT.fin_pp = (a) => { PP[a.dataset.k] = a.checked; try { localStorage.setItem('ufsa_pp', JSON.stringify(PP)); } catch { /* ignore */ } };
ACT.fin_print = () => { if (preparePrint()) { window.print(); setTimeout(endPrint, 800); } };
ACT.fin_refresh = async (a) => {
  a.disabled = true; const r = await act(() => api('POST', `/api/settlements/${S.B.settlement.id}/refresh`, {})); a.disabled = false;
  if (r) { toast(`PF: ${r.pf || 'skipped'}  |  Salary slip: ${r.slip}`, r.pfError ? 'bad' : 'ok'); route(); }
};
ACT.fin_approve = async () => {
  const B = S.B; if (!await confirmBox('Approve this settlement?', `Net ${B.statement.direction === 'receivable' ? 'receivable' : 'payable'} Rs ${fmt(Math.abs(B.statement.net))} for ${B.employee.name}. The settlement is locked after approval and a copy of the figures is kept on record.`, 'Approve', 'ok')) return;
  const r = await act(() => api('POST', `/api/settlements/${B.settlement.id}/approve`, {}), 'Approved'); if (r) { if (S.me.sections.includes('dashboard')) location.hash = '#/dashboard'; else route(); }
};

// ----- Settlement: the statement + the checks
const line = (l, a, o = {}) => `<div class="line ${o.cls || ''}"><span class="l">${l}${o.note ? `<small>${esc(o.note)}</small>` : ''}</span><span class="a ${o.neg ? 'neg' : ''}">${o.html || ''}${a === null ? '' : fmt(a)}</span></div>`;
function tSettlement(B, ed) {
  const st = B.statement, s = B.settlement, h = st.header;
  const money = (rows, kind) => rows.map((d) => line(esc(d.label), d.amount, { note: d.note, html: d.id && ed && s.state === 'open' ? `<a href="#/finance/${esc(B.employee.emp_id)}" data-act="ftab" data-t="adjust" title="Manage in Adjustments">${IC.check.replace('<path d="M20 6L9 17l-5-5"/>', '<path d="M4 20h4L19 9l-4-4L4 16z"/>')}</a>` : '' })).join('') || `<div class="line"><span class="muted">None</span><span></span></div>`;
  $('#ftab').innerHTML = `<div class="cols"><div class="card">
    <div class="row between"><div><h3>${esc(h.org)}</h3><div class="sub" style="margin:0">Final settlement &middot; ${esc(h.name)} (${esc(h.id)}) &middot; ${esc(h.designation)}</div></div></div>
    <div class="sec-t">Employee</div>${infoRows([['Resignation / termination', fdate(h.resignDate) || 'not entered'], ['Last working day', fdate(h.lwd) || 'not entered'], ['Separation rule', `${h.rule} - ${(B.rules.find((r) => r.code === h.rule) || {}).explanation || ''}`], ['Service', h.service || '-'], ['Job status', h.jobStatus], ['Last drawn salary with allowances', 'Rs ' + fmt(h.lastDrawn) + ' (' + B.inputs.grossFrom + ')']])}
    <div class="sec-t">Gross dues payable</div>
    ${st.earned.map((e) => line(`Earned salary - ${esc(e.label)}`, e.amount, { note: `${e.days} day(s) of ${fmt(h.lastDrawn)}` })).join('') || `<div class="line"><span class="muted">No unpaid salary (see notes)</span><span></span></div>`}
    ${line('Total of salary', st.earnedTotal, { cls: 'sub' })}
    ${line('Balance of provident fund', st.pfBalance, { note: B.pf ? `from the PF portal ${B.pfFetchedAt || ''}` : 'PF not read yet' })}
    ${st.expenses.map((e) => line(`Expenses - ${esc(e.label)}`, e.actualTotal, { note: `claimed ${fmt(e.claimTotal)}, deducted ${fmt(e.dedTotal)}` })).join('')}
    ${line('TOTAL GROSS PAYABLE', st.grossPayable, { cls: 'sub' })}
    <div class="sec-t">Deductions</div>${money(st.deductions)}${line('Total deductions', st.totalDeductions, { cls: 'sub' })}
    <div class="sec-t">Reimbursements</div>${money(st.reimbursements)}${line('Total reimbursements', st.totalReimbursements, { cls: 'sub' })}
    ${line(st.direction === 'receivable' ? 'NET AMOUNT RECEIVABLE FROM THE EMPLOYEE' : 'NET AMOUNT PAYABLE', st.net, { cls: 'big', neg: st.net < 0 })}
    <div class="sec-t">Disbursement</div>
    <div class="grid two" style="margin-top:6px"><div class="card" style="margin:0;padding:14px"><small>${esc(B.signatures.pfBank)} (provident fund)</small><div style="font-size:20px;font-weight:700">Rs ${fmt(st.disbursement.pfBank)}</div><label style="margin-top:8px">Cheque / reference<input id="chq_pf" value="${esc(s.cheque_pf || '')}" ${ed ? '' : 'disabled'}></label></div>
      <div class="card" style="margin:0;padding:14px"><small>${esc(B.signatures.mainBank)}</small><div style="font-size:20px;font-weight:700">Rs ${fmt(st.disbursement.mainBank)}</div><label style="margin-top:8px">Cheque / reference<input id="chq_main" value="${esc(s.cheque_main || '')}" ${ed ? '' : 'disabled'}></label></div></div>
    ${ed ? `<div style="margin-top:12px"><button class="btn sm" data-act="fin_cheques">Save cheque numbers</button></div>` : ''}
    ${st.narrative.deductions ? `<div class="sec-t">Deductions made on account of</div><p>${esc(st.narrative.deductions)}</p>` : ''}${st.narrative.reimbursements ? `<div class="sec-t">Reimbursement made on account of</div><p>${esc(st.narrative.reimbursements)}</p>` : ''}
  </div>
  <div>
    <div class="card"><h3>Checks</h3><div class="sub">What the Finance sheet shows in red and green</div>${st.notes.map((n) => `<div class="check"><span class="dot error"></span><span>${esc(n)}</span></div>`).join('')}${st.checks.map((c) => `<div class="check"><span class="dot ${c.status}"></span><span><b>${esc(c.label)}</b><br><span class="muted">${esc(c.text)}</span></span></div>`).join('') || (st.notes.length ? '' : '<span class="muted">No checks raised.</span>')}</div>
  </div></div>`;
}
const CHECKLIST = [['id', 'Employee ID is correct'], ['resign', 'Resignation date checked'], ['rule', 'Separation rule checked (notice pay or deduction)'], ['lastsalary', 'Last salary month checked against the PF working and the salary slip'], ['expenses', 'Expenses verified and the last expenses month checked'],
  ['gross', 'Salary on the slip agrees with the settlement'], ['pf', 'Provident fund balance checked'], ['imprest', 'Imprest and vehicle ledger checked (ASM)'], ['netpay', 'Net payable / receivable checked'], ['letter', 'Letter reviewed']];
ACT.fin_tick = async (a) => { await act(() => api('PUT', `/api/settlements/${S.B.settlement.id}/checks`, { item: a.dataset.k, ok: a.checked })); };
ACT.fin_ticks = async () => { if (await act(() => api('PUT', `/api/settlements/${S.B.settlement.id}/checks`, { all: true }))) route(); };
ACT.fin_cheques = async () => { const B = S.B; if (await act(() => api('PUT', `/api/settlements/${B.settlement.id}/finance`, financeInputs(B, { cheque_pf: $('#chq_pf').value, cheque_main: $('#chq_main').value })), 'Saved')) route(); };
// the Finance PUT replaces every field, so always send the current values with the change
const financeInputs = (B, over = {}) => { const s = B.settlement; return { job_status: s.job_status, gross_override: s.gross_override, notice_base_override: s.notice_base_override, vehicle_inst: s.vehicle_inst, last_salary_month: s.last_salary_month, cheque_pf: s.cheque_pf, cheque_main: s.cheque_main, finance_note: s.finance_note, ...over }; };

// ----- Adjustments
const PRESETS = [['deduction', 'mobile', 'Mobile deduction'], ['deduction', 'laptop', 'Laptop deduction'], ['deduction', 'fake_bills', 'Fake bills'], ['deduction', 'pf_inflation', 'PF deduction due to inflation allowance'], ['deduction', 'other', 'Other deduction'], ['reimbursement', 'leave', 'Leave encashment'], ['reimbursement', 'other', 'Other reimbursement']];
function tAdjust(B, ed) {
  const s = B.settlement, on = ed && s.state === 'open', dis = on ? '' : 'disabled', st = B.statement, items = B.items.filter((i) => !(i.code || '').startsWith('audit:'));
  $('#ftab').innerHTML = `<div class="card"><h3>Inputs Finance can overrule</h3><div class="sub">Leave a field empty to use the value that was read from the salary slip / payroll.</div>
    <div class="grid">
      <label>Job status<select id="f_job" ${dis}><option value="">Automatic (${esc(st.header.jobStatus)})</option><option ${s.job_status === 'Confirmed' ? 'selected' : ''}>Confirmed</option><option ${s.job_status === 'Unconfirmed' ? 'selected' : ''}>Unconfirmed</option></select></label>
      <label>Last drawn salary with allowances<input type="number" id="f_gross" class="num" value="${esc(s.gross_override ?? '')}" placeholder="${fmt(B.slip ? B.slip.total_gross : B.employee.gross)}" ${dis}></label>
      <label>Notice-pay base (salary + increment)<input type="number" id="f_notice" class="num" value="${esc(s.notice_base_override ?? '')}" placeholder="${fmt(B.slip ? B.slip.notice_base : B.employee.gross)}" ${dis}></label>
      <label>Last salary paid for<input type="month" id="f_lsm" value="${esc(s.last_salary_month || '')}" ${dis}></label>
      <label>Vehicle instalments paid back (reimbursement)<input type="number" id="f_veh" class="num" value="${esc(s.vehicle_inst || 0)}" ${dis}></label>
    </div><label style="margin-top:14px">Finance note<textarea id="f_note" ${dis}>${esc(s.finance_note || '')}</textarea></label>
    ${on ? `<div style="margin-top:14px"><button class="btn primary" data-act="fin_inputs">Save</button></div>` : ''}</div>
  <div class="card flush"><div class="card-h"><div><h3>Deductions and reimbursements added to this settlement</h3><div class="sub" style="margin:0">Mobile, laptop, fake bills, PF difference, others - plus the entries of Master Data &gt; Other deductions for this employee.</div></div></div>
    <div class="scroll"><table><thead><tr><th>Type</th><th>Description</th><th class="n">Amount</th><th>Note</th><th></th></tr></thead><tbody>
    ${items.map((i) => `<tr style="${i.waived ? 'opacity:.55' : ''}"><td><span class="chip ${i.kind === 'deduction' ? 'bad' : 'ok'}">${i.kind}</span></td><td>${i.waived ? '<s>' : ''}${esc(i.label)}${i.waived ? '</s>' : ''}${i.waived ? `<br><small>Waived: ${esc(i.waive_reason)}</small>` : ''}</td><td class="n">${fmt(i.amount)}</td><td>${esc(i.note || '')}</td>
      <td class="n">${on ? (i.waived ? `<button class="btn sm" data-act="item_waive" data-id="${i.id}" data-w="0">Restore</button>` : `<button class="btn sm" data-act="item_waive" data-id="${i.id}" data-w="1">Waive</button>`) + (String(i.code).startsWith('od:') ? '' : ` <button class="btn sm danger" data-act="item_del" data-id="${i.id}">${IC.trash}</button>`) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing added.</td></tr>'}
    </tbody></table></div>
    ${on ? `<div class="card-h" style="border-top:1px solid var(--line);border-bottom:0"><div class="row grow"><select id="n_pre" style="max-width:260px">${PRESETS.map((p, i) => `<option value="${i}">${esc(p[2])}</option>`).join('')}</select><input id="n_label" placeholder="Description (default: the choice)" style="max-width:260px"><input id="n_amt" type="number" min="0" class="num" placeholder="Amount" style="max-width:130px"><input id="n_note" placeholder="Note" style="max-width:220px"><button class="btn primary" data-act="item_add">${IC.plus} Add</button></div></div>` : ''}</div>
  <div class="card flush"><div class="card-h"><div><h3>Audit observations</h3><div class="sub" style="margin:0">The audit total of each of the three months must already be in the payroll's "Audit Ded." (Rs ${fmt(B.slip ? B.slip.audit_ded : 0)} on the slip). If not, it is recovered here.</div></div></div>
    <table><thead><tr><th>Month</th><th class="n">Audit total</th><th>Status</th><th></th></tr></thead><tbody>${st.auditRows.map((a) => { const w = B.items.find((i) => i.code === 'audit:' + a.month && i.waived); return `<tr><td>${esc(a.label)}</td><td class="n">${fmt(a.total)}</td><td>${w ? `<span class="chip gray">Waived: ${esc(w.waive_reason)}</span>` : a.status === 'OK' ? '<span class="chip ok">OK</span>' : a.total > 0 ? '<span class="chip bad">Deduction</span>' : '<span class="chip warn">Differs from the slip</span>'}</td><td class="n">${on && a.total > 0 ? (w ? `<button class="btn sm" data-act="aud_waive" data-m="${a.month}" data-w="0">Restore</button>` : a.status !== 'OK' ? `<button class="btn sm" data-act="aud_waive" data-m="${a.month}" data-w="1">Waive</button>` : '') : ''}</td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">Enter the last working date first.</td></tr>'}</tbody></table></div>`;
}
ACT.fin_inputs = async () => {
  const B = S.B; if (await act(() => api('PUT', `/api/settlements/${B.settlement.id}/finance`, financeInputs(B, { job_status: $('#f_job').value, gross_override: $('#f_gross').value, notice_base_override: $('#f_notice').value, last_salary_month: $('#f_lsm').value, vehicle_inst: $('#f_veh').value, finance_note: $('#f_note').value })), 'Saved')) route();
};
ACT.item_add = async () => {
  const B = S.B, p = PRESETS[Number($('#n_pre').value)];
  if (await act(() => api('POST', `/api/settlements/${B.settlement.id}/items`, { kind: p[0], code: p[1], label: $('#n_label').value || p[2], amount: $('#n_amt').value, note: $('#n_note').value }), 'Added')) route();
};
ACT.item_del = async (a) => { if (await confirmBox('Delete this entry?', 'It will be removed from the settlement.', 'Delete', 'danger') && await act(() => api('DELETE', '/api/items/' + a.dataset.id))) route(); };
ACT.item_waive = async (a) => {
  const w = a.dataset.w === '1', reason = w ? await askBox('Waive this amount', 'Reason (kept on record)', 'Waive') : ''; if (w && !reason) return;
  if (await act(() => api('PUT', '/api/items/' + a.dataset.id, { waived: w, waive_reason: reason }))) route();
};
ACT.aud_waive = async (a) => {
  const w = a.dataset.w === '1', reason = w ? await askBox('Waive this audit observation', 'Reason (kept on record)', 'Waive') : ''; if (w && !reason) return;
  if (await act(() => api('POST', `/api/settlements/${S.B.settlement.id}/audit-waive`, { month: a.dataset.m, waived: w, reason }))) route();
};

// ----- Salary slip (from the payroll Excel)
function tSlip(B) {
  const sl = B.slip;
  if (!sl) { $('#ftab').innerHTML = `<div class="card"><div class="empty"><b>No salary slip found for Employee ${esc(B.employee.emp_id)}.</b><br>The payroll Excel files are read from the folder set in Setting &gt; Data sources. A resigner is in the file of the month before he left.<br>${S.me.role === 'admin' ? '<a href="#/setting/sources">Open Setting</a> to scan the folder.' : 'Ask the administrator to scan the payroll folder.'}</div></div>`; return; }
  const rowsOf = (rows) => rows.filter((r) => r[1]).map(([l, v]) => [l, v]);
  const E = rowsOf([['Salary', sl.salary], ['Increment', sl.increments], ['Arrears', sl.arrears], ['Incentive', sl.incentive], ['Conveyance', sl.conv], ['Fuel allowance', sl.fuel], ['Tel / Mobile', sl.tel], ['Post / Sta.', sl.post], ['Non-touring', sl.ntour], ['Vehicle allowance', sl.vehicle_allow], ['Maintenance allowance', sl.maint], ['Inflation allowance', sl.inflation]]);
  const D = rowsOf([['Income tax', sl.itax], ['Loan', sl.loan], ['PF loan', sl.pf_loan], ['Medical', sl.medical], ['Imprest', sl.imprest], ['EOBI', sl.eobi], ['Vehicle', sl.vehicle_inst], ['Other deduction / reimbursement', sl.other_ded], ['Provident fund (employee)', sl.pf_emp], ['Mobile', sl.mobile], ['Audit deduction (expenses)', sl.audit_ded], ['Absent deduction', sl.absent_ded]]);
  const n = Math.max(E.length, D.length), cellL = (r) => (r ? `<td>${esc(r[0])}</td><td class="n">${fmt(r[1])}</td>` : '<td></td><td></td>');
  $('#ftab').innerHTML = `<div class="banner">${IC.check}<div>Salary slip of <b>${esc(fmonth(sl.month))}</b> from <b>${esc(sl.file)}</b> (${esc(({ trade: 'Marketing Trade', pharma: 'Marketing Pharma', healthcare: 'Healthcare', admin: 'Admin', factory: 'Factory' })[sl.company] || sl.company)}). This is the last month the employee was in the payroll.</div></div>
  ${expensePaidCard(B)}
  <div class="card flush"><table class="slip1"><thead><tr><th>Salary &amp; allowances</th><th class="n">Rs</th><th class="sep">Deductions</th><th class="n">Rs</th></tr></thead><tbody>${Array.from({ length: n }, (_, i) => `<tr>${cellL(E[i])}<td class="sep">${D[i] ? esc(D[i][0]) : ''}</td><td class="n">${D[i] ? fmt(D[i][1]) : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr class="total"><td>Total gross salary</td><td class="n">${fmt(sl.total_gross)}</td><td class="sep">Total deductions</td><td class="n">${fmt(sl.total_ded)}</td></tr><tr class="total"><td colspan="2"></td><td class="sep">Net salary</td><td class="n">${fmt(sl.net)}</td></tr></tfoot></table></div>
  <div class="card"><h3>What the settlement takes from this slip</h3>${infoRows([['Last drawn salary with allowances', 'Rs ' + fmt(B.inputs.gross) + ' (' + B.inputs.grossFrom + ')'], ['Notice-pay base (salary + increment)', 'Rs ' + fmt(B.inputs.noticeBase)], ['EOBI per month', 'Rs ' + fmt(sl.eobi)], ['Medical per month', 'Rs ' + fmt(sl.medical)], ['Employee status', sl.emp_status || '-'], ['Last salary paid for', fmonth(sl.month)]])}</div>`;
}

// ----- Provident fund (from the PF portal)
function tPF(B, ed) {
  const p = B.pf, btn = ed && B.settlement.state === 'open' ? `<button class="btn" data-act="fin_refresh">${IC.refresh} Read the PF now</button>` : '';
  if (!p) { $('#ftab').innerHTML = `<div class="card"><div class="empty">${B.pfError ? `<div class="banner bad" style="text-align:left">${IC.alert}<div>${esc(B.pfError)}</div></div>` : '<b>The provident fund has not been read yet.</b><br>'}It is read from the PF database file set in Setting &gt; Data sources.<br><br>${btn}</div></div>`; return; }
  const tile = (l, v, c) => `<div class="kpi" style="cursor:default"><small>${l}</small><b class="${c || ''}">${fmt(v)}</b></div>`;
  $('#ftab').innerHTML = `<div class="row between" style="margin-bottom:14px"><span class="muted">Read from the PF on ${esc(B.pfFetchedAt || '')}</span>${btn}</div>
    <div class="kpis">${tile('Employee contribution', p.employee)}${tile('Employer contribution', p.employer)}${tile('Profit', p.profit)}${tile('Permanent withdrawal', -p.withdrawal, 'neg')}${tile('PF loan outstanding', -p.loan, 'neg')}${tile('Balance payable', p.balance, 'pos')}</div>
    ${B.statement.checks.filter((c) => c.key === 'pf').map((c) => `<div class="banner ${c.status === 'ok' ? 'ok' : 'bad'}">${esc(c.text)}</div>`).join('')}
    <div class="card"><h3>PF reimbursement for the unpaid days</h3><p class="muted">The employer contribution of the last month (Rs ${fmt(p.lastMonthly)}) / 30 x ${B.statement.unpaidDays} unpaid day(s) = <b>Rs ${fmt(B.statement.pf ? B.statement.pf.reimbursement : 0)}</b> is paid to the employee.</p></div>
    <div class="card flush"><div class="card-h"><h3>Monthly contributions</h3><span class="muted">${B.pfMonthly.length} months</span></div><div class="scroll" style="max-height:420px"><table><thead><tr><th>Month</th><th class="n">Employee</th><th class="n">Employer</th><th class="n">Profit / loss</th></tr></thead><tbody>${[...B.pfMonthly].reverse().map((m) => `<tr><td>${esc(fdate(m.date))}</td><td class="n">${fmt(m.employee)}</td><td class="n">${fmt(m.employer)}</td><td class="n">${m.profit ? fmt(m.profit) : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}

// ----- Travelling expenses as the Finance sheet shows them (rows 21-30)
function tExpenses(B) {
  const st = B.statement;
  if (!st.expenses.length) { $('#ftab').innerHTML = '<div class="card"><div class="empty">Marketing has not entered the last working date yet.</div></div>'; return; }
  const meta = Object.fromEntries(B.expenseMeta.map((m) => [m.month, m]));
  $('#ftab').innerHTML = `<div class="months">${st.expenses.map((e) => `<div class="month"><div class="month-h"><b>${esc(e.label)}</b><div class="row" style="gap:6px">${(meta[e.month] ? meta[e.month].holidays : []).map((h) => `<span class="chip info">${esc(h.name)}</span>`).join('')}${e.rateMissing ? '<span class="chip bad">No rate for this designation</span>' : ''}${e.rateCustom ? '<span class="chip warn" title="Typed in the Marketing window, not the Master Data rate">Custom rate</span>' : ''}</div></div>
    <table><thead><tr><th></th>${HEADS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Total Rs</th></tr></thead><tbody>
      <tr><td>Rate</td>${HEADS.map(([k]) => `<td>${fmt2(e.rate[k])}</td>`).join('')}<td></td></tr>
      <tr><td>Claim (qty)</td>${HEADS.map(([k]) => `<td>${fmt2(e.claim[k])}</td>`).join('')}<td></td></tr>
      <tr class="ded"><td>Deduction (qty)</td>${HEADS.map(([k]) => `<td>${e.ded[k] ? fmt2(e.ded[k]) : ''}</td>`).join('')}<td></td></tr>
      <tr><td>Claimed Rs</td>${HEADS.map(([k]) => `<td>${fmt(e.claimAmt[k])}</td>`).join('')}<td><b>${fmt(e.claimTotal)}</b></td></tr>
      <tr class="ded"><td>Deducted Rs</td>${HEADS.map(([k]) => `<td>${e.dedAmt[k] ? fmt(e.dedAmt[k]) : ''}</td>`).join('')}<td><b>${fmt(e.dedTotal)}</b></td></tr>
      <tr class="net"><td>Allowed Rs</td>${HEADS.map(([k]) => `<td>${fmt(e.actualAmt[k])}</td>`).join('')}<td>${fmt(e.actualTotal)}</td></tr></tbody></table></div>`).join('')}
    <div class="card"><div class="row between"><b>Total for the three months</b><span>Claimed Rs ${fmt(st.exp.claimed)} &nbsp;&middot;&nbsp; Deducted <b class="neg">Rs ${fmt(st.exp.deducted)}</b> &nbsp;&middot;&nbsp; Allowed <b class="pos">Rs ${fmt(st.exp.allowed)}</b></span></div></div></div>`;
}

// ----- the letter (the Finance sheet as it is printed) - clean, modern layout
let LTPL = 1; try { LTPL = localStorage.getItem('ufsa_tpl') === '2' ? 2 : 1; } catch { /* no storage */ }
ACT.fin_tpl = (a) => { LTPL = Number(a.dataset.t) === 2 ? 2 : 1; try { localStorage.setItem('ufsa_tpl', String(LTPL)); } catch { /* ignore */ } tLetter(S.B, editable(S.B, 'finance')); };
function tLetter(B, ed) {
  const canEdit = ed && (B.settlement.state === 'open' || S.me.role === 'admin');
  $('#ftab').innerHTML = `${B.statement.edited ? `<div class="banner warn no-print" style="margin-bottom:12px">${IC.alert}<div>This letter contains <b>edited figures</b> (${B.statement.editedKeys.length}). The calculation is unchanged underneath; <a href="#" data-act="fin_letter_edit">edit or reset them</a>.</div></div>` : ''}<div class="row no-print between" style="margin-bottom:14px"><div class="filters" style="margin:0"><button class="${LTPL === 1 ? 'on' : ''}" data-act="fin_tpl" data-t="1">Template 1 - Finance sheet</button><button class="${LTPL === 2 ? 'on' : ''}" data-act="fin_tpl" data-t="2">Template 2 - Modern header</button></div><div class="row" style="gap:12px;flex-wrap:wrap"><span class="muted" style="font-size:12px">Also print:</span>${[['slip', 'Salary slip'], ['exp', 'Travelling expenses (same page)'], ['audit', 'Audit report']].map(([k, l]) => `<label class="row" style="gap:4px;font-weight:500"><input type="checkbox" data-act="fin_pp" data-k="${k}" ${PP[k] ? 'checked' : ''}> ${l}</label>`).join('')}${canEdit ? `<button class="btn" data-act="fin_letter_edit">Edit figures</button>` : ''}<button class="btn primary" data-act="fin_print">${IC.print} Print / save as PDF (one page)</button></div></div>${letterHtml(B)}`;
}
// ----- edit any figure of the letter
ACT.fin_letter_edit = () => {
  const B = S.B, E = B.letterEdits || {}, groups = [...new Set(B.letterFields.map((f) => f.group))];
  const d = dialog(`<h3>Edit the figures of the letter</h3><p class="muted" style="margin-bottom:10px">Change any amount. The totals follow the edited lines by themselves; type into a total only to replace it. A figure that you put back to the calculated amount is no longer an edit. The calculation itself is not changed.</p>
    <div class="scroll" style="max-height:60vh">${groups.map((g) => `<div class="sec-t">${esc(g)}</div><table class="le"><tbody>${B.letterFields.filter((f) => f.group === g).map((f) => `<tr><td>${esc(f.label)}${f.total ? ' <small class="muted">(automatic unless typed)</small>' : ''}</td><td class="n muted">${fmt(f.calc)}</td><td><input class="num le-in" data-k="${f.key}" data-calc="${f.calc}" data-total="${f.total ? 1 : 0}" value="${E[f.key] != null ? esc(String(E[f.key])) : (f.total ? '' : String(f.calc))}" placeholder="${f.total ? 'automatic' : ''}"></td></tr>`).join('')}</tbody></table>`).join('')}</div>
    <label style="margin-top:10px">Reason (kept in the history)<input id="le_note" placeholder="optional"></label>
    <div class="actions"><button class="btn" id="le_x">Cancel</button><button class="btn" id="le_reset">Reset all to the calculation</button><button class="btn primary" id="le_go">Save the figures</button></div>`, { wide: true });
  $('#le_x', d.el).onclick = d.close;
  const send = async (edits) => { if (await act(() => api('PUT', `/api/settlements/${B.settlement.id}/letter-edits`, { edits, note: $('#le_note', d.el).value }), 'Saved')) { d.close(); route(); } };
  $('#le_reset', d.el).onclick = () => send({});
  $('#le_go', d.el).onclick = () => {
    const edits = {}; $$('.le-in', d.el).forEach((i) => { const v = i.value.trim(); if (v === '') return; const x = calcExpr(v); if (i.dataset.total === '1' || x !== Number(i.dataset.calc)) edits[i.dataset.k] = x; });
    send(edits);
  };
};
function letterHtml(B) { return letterHtml1(B, LTPL === 2); }
function letterHtml1(B, modern) {
  const st = B.statement, h = st.header, sg = B.signatures, rule = B.rules.find((r) => r.code === h.rule), recv = st.direction === 'receivable';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = (iso) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || ''); return m ? `${+m[3]}-${MON[+m[2] - 1]}-${m[1].slice(2)}` : ''; };
  const dtLabel = (h.rule === 'Terminated' || B.settlement.date_kind === 'termination') ? 'Termination' : h.rule === 'Deceased' ? 'Death' : 'Resignation';      // the date is a resignation date unless the employee was terminated
  const nw = (t) => String(t || '').replace(/\s*\(without allowances\)/gi, '');
  const par = (n) => (n < 0 ? `(${fmt(-n)})` : fmt(n));
  const sumBy = (list, codes, inside) => list.filter((d) => codes.includes(d.code) === inside).reduce((s, d) => s + d.amount, 0);
  const dRow = (label, v) => `<div class="g"><span class="rt c15">${label}</span><span class="bx c6">${fmt(v)}</span></div>`;
  const extraRows = (list, listed) => { const x = list.filter((d) => !listed.includes(d.code)); return x.length ? x.map((d) => dRow(esc(String(d.label).toUpperCase()), d.amount)).join('') : dRow('OTHERS', 0); };
  const D = st.deductions, R = st.reimbursements, L = ['salary', 'notice', 'training', 'eobi', 'medical', 'imprest'], RL = ['imprest', 'notice', 'vehicle', 'pf'];
  const hd = (l, v) => `<div class="hr"><span class="lb">${l}</span><span class="vl">${esc(v || '')}</span></div>`;
  const monLbl = (e) => { const m = /^(\d{4})-(\d\d)/.exec(e.month || ''); return m ? `${MON[+m[2] - 1]}-${m[1].slice(2)}` : e.label; };
  const banks = [[sg.pfBank, st.disbursement.pfBank, B.settlement.cheque_pf || (st.disbursement.pfBank ? '' : 'NILL')], [sg.mainBank, st.disbursement.mainBank, B.settlement.cheque_main || '']];
  const expAllowed = st.expenses.reduce((s, e) => s + e.actualTotal, 0);
  const head1 = `    <div class="bar">${esc(h.org).toUpperCase()}</div><div class="subt">FINAL SETTELMENT</div>
    <div class="hdr">${hd('NAME:', h.name)}${hd('LAST DESIGNATION:', h.designation)}${hd('EMPLOYEE ID', h.id)}${hd('STATION', h.station)}${hd('DATE OF JOINING', dd(h.doj))}${hd('DATE OF ' + dtLabel.toUpperCase(), dd(h.resignDate))}${hd('JOB STATUS:', h.jobStatus)}${hd('LAST DRAWN MONTHLY SALARY WITH ALLOWANCES:', fmt(h.lastDrawn))}${hd('NOTICE GIVEN', rule ? rule.explanation : h.rule)}</div>`;
  const dl = (iso) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || ''); return m ? `${m[3]} ${MON[+m[2] - 1]} ${m[1]}` : '-'; };
  const cell = (k, v) => `<div class="cell"><div class="k">${k}</div><div class="v">${esc(v || '-')}</div></div>`;
  const bankTot = st.disbursement.pfBank + st.disbursement.mainBank, pct = (v) => (bankTot ? (v / bankTot * 100) : 0).toFixed(1);
  let dbanks = [[sg.pfBank, st.disbursement.pfBank, B.settlement.cheque_pf], [sg.mainBank, st.disbursement.mainBank, B.settlement.cheque_main]].filter((b) => b[1] > 0); if (!dbanks.length) dbanks = [[sg.mainBank, 0, B.settlement.cheque_main]];
  const disb2 = `<div class="t2 disb"><div class="dd"><div class="k">Disbursement Detail</div>${dbanks.map((b) => `<div class="bkr"><div class="bk-top"><span class="bk-name">${esc(b[0])}</span><span class="bk-amt">${fmt(b[1])}</span></div><div class="chq">Cheque # <b>${esc(b[2] || '________')}</b></div></div>`).join('')}
      <div class="bk-total"><span class="l">Total</span><span class="r">Rs ${fmt(bankTot)}</span></div></div></div>`;
  const head2 = `<div class="t2 head2"><header class="hd2"><div class="hd2-l"><div class="co">${esc(h.org)}</div><h1>Employee Final Settlement</h1><div class="hd2-sub">Statement of full &amp; final dues upon separation</div></div>
      <div class="hd2-r"><div class="hk">Employee ID</div><div class="hv">${esc(h.id)}</div><div class="hk">Employment Period</div><div class="hv">${dl(h.doj)} &mdash; ${dl(h.lwd || h.resignDate)}</div></div></header>
      <section class="emp-card"><div class="emp-top"><div class="emp-who"><div class="k">Employee Name</div><div class="emp-name">${esc(h.name)}</div><div class="emp-desig">${esc(h.designation)}</div></div>
        <div class="emp-grid">${cell('Station', h.station)}${cell('Date of Joining', dl(h.doj))}${cell('Date of ' + dtLabel, dl(h.resignDate))}${cell('Job Status', h.jobStatus)}${cell('Notice Given', rule ? rule.explanation : h.rule)}${cell('Last Drawn Salary', 'Rs ' + fmt(h.lastDrawn))}</div></div></section></div>`;
  return `<div class="letter fs${modern ? ' fs2' : ''}">
    ${modern ? head2 : head1}<div class="fsbody">
    <div class="band">GROSS DUES PAYABLE</div>
    <div class="g"><b class="c1">EARNED SALARY</b><span class="c5 ct">DAYS</span></div>
    ${[...st.earned].reverse().map((e) => `<div class="g"><span class="gy ct c4">${esc(monLbl(e))}</span><span class="c5 ct">${e.days}</span><span class="bx c6">${fmt(e.amount)}</span></div>`).join('') || '<div class="g"><span class="c6 bx">0</span></div>'}
    <div class="g"><b class="c1">TOTAL OF SALARY</b><b class="bx c6 ul">${fmt(st.earnedTotal)}</b></div>
    <div class="g sp"><b class="c1">BALANCE OF PROVIDENT FUND:</b><b class="bx c6 ul">${fmt(st.pfBalance)}</b></div>
    <div class="g sp"><b class="c1">EXPENSES :</b><b class="c3 ct">CLAIMED</b><b class="c4 ct">DED *</b><b class="c5 ct">ALLOWED</b></div>
    ${st.expenses.map((e) => `<div class="g"><span class="gy ct cell c2">${esc(e.label)}</span><span class="gy ct cell c3">${fmt(e.claimTotal)}</span><span class="gy ct cell c4">${fmt(e.dedTotal)}</span><span class="gy ct cell c5">${fmt(e.actualTotal)}</span><span class="bx c6">${fmt(e.actualTotal)}</span></div>`).join('')}
    <div class="g"><b class="bx c6">${fmt(expAllowed)}</b></div>
    <div class="g tot"><b class="c1">TOTAL GROSS PAYABLE</b><b class="bx c7">${fmt(st.grossPayable)}</b></div>
    <div class="band">DEDUCTIONS /REIMBURSEMENT</div>
    <div class="g sp"><b class="gy ct c35">DEDUCTIONS:</b></div>
    ${dRow('SALARY DEDUCTION', sumBy(D, ['salary'], true))}${extraRows(D, L)}${dRow('NOTICE PAY', sumBy(D, ['notice'], true))}${dRow('TRAINING AND ORIENTATION COST', sumBy(D, ['training'], true))}${dRow('EOBI', sumBy(D, ['eobi'], true))}${dRow('MEDICAL NJI', sumBy(D, ['medical'], true))}${dRow('IMPREST BALANCE', sumBy(D, ['imprest'], true))}
    <div class="g sp"><b class="gy ct c35">REIMBURSEMENT:</b></div>
    ${extraRows(R, RL)}${dRow('IMPREST BALANCE', sumBy(R, ['imprest'], true))}${dRow('NOTICE PAY (WITH ALLOWANCES)', sumBy(R, ['notice'], true))}${dRow('VEHICLE INSTALLMENTS AS PER POLICY', sumBy(R, ['vehicle'], true))}${dRow('PROVIDENT FUND REIMBURST', sumBy(R, ['pf'], true))}
    <div class="g"><span class="rt c15">TOTAL DEDUCTIONS / REIMBURSEMENT:</span><b class="bx c7 ul">${par(st.totalReimbursements - st.totalDeductions)}</b></div>
    <div class="band left"><span>NET AMOUNT PAYABLE /RECEIVABLE UNDER THIS SETTELMENT</span><b>${st.net < 0 ? '-' : ''}${fmt(Math.abs(st.net))}</b></div>
    <div class="det"><div class="dl">DEDUCTION &amp; REIMBURSEMENT DETAIL</div><div class="db"><div><b>DEDUCTIONS MADE ON ACCOUNT OF:</b><span>${esc(nw(st.narrative.deductions))}</span></div><div><b>REIMBURSEMENT MADE ON ACCOUNT OF:</b><span>${esc(nw(st.narrative.reimbursements))}</span></div></div></div>
    <div class="note"><b>NOTE:</b><p>${esc(sg.note).toUpperCase()}</p></div>
    ${bankTot <= 0 ? '' : modern ? disb2 : `<table class="bk"><thead><tr><th colspan="3" class="gy">Disbursement Detail</th></tr><tr><th>Bank Name</th><th>Cheque #</th><th>Amount</th></tr></thead><tbody>${banks.map((b) => `<tr><td>${esc(b[0])}</td><td>${esc(b[2])}</td><td class="n">${fmt(b[1])}</td></tr>`).join('')}<tr><td></td><td class="ct"><b>Total</b></td><td class="n"><b>${fmt(st.disbursement.pfBank + st.disbursement.mainBank)}</b></td></tr></tbody></table>`}
    <div class="sg"><div><b>${esc(sg.s1[0])}</b>${esc(sg.s1[1])}</div><div><b>${esc(sg.s2[0])}</b>${esc(sg.s2[1])}</div><div><b>${esc(h.name)}</b>${esc(h.designation)}</div></div>
  </div>  </div>`;
}
// ----- Posting: the accounting voucher of the settlement (Posting.xlsx)
function tPosting(B, ed) {
  const P = B.posting, s = B.settlement, can = ed && (s.state === 'open' || S.me.role === 'admin');
  const cnic = B.employee.cnic || (B.slip && B.slip.raw && B.slip.raw.cnic) || '', payee = `${B.employee.name}${cnic ? ' ' + cnic : ''}`;
  const dis = can ? '' : 'disabled', tpl = (t, chq, pf) => String(t).replace('{CHQ}', ((P.prefixes || {}).bank || '') + (chq || '#########')).replace('{CHQPF}', ((P.prefixes || {}).pf || '') + (pf || '#########'));
  $('#ftab').innerHTML = `<div class="card"><div class="row between"><div><h3>Posting</h3><div class="sub" style="margin:0">${esc(P.kind)}. The narration is built from the employee and the cheque number.</div></div>
      <div class="row"><button class="btn" data-act="fin_copy" data-what="posting">Copy the posting</button><a class="btn" href="/api/settlements/${s.id}/posting.xlsx" download>Download Excel</a></div></div>
      ${P.warnings.map((w) => `<div class="banner warn" style="margin-top:12px">${IC.alert}<div>${esc(w)}</div></div>`).join('')}
      <div class="grid" style="margin-top:14px"><label>Cheque number (bank) - goes into the narration<input id="pc_chq" value="${esc(s.cheque_main || '')}" placeholder="#########" ${dis}></label>
        <label>Cheque number (provident fund bank)<input id="pc_pf" value="${esc(s.cheque_pf || '')}" ${dis}></label>
        ${P.imprest !== 0 ? `<label>Imprest ledger (VEM) code<input id="pc_vem" value="${esc(s.vem_code || '')}" placeholder="VEM code" ${dis}></label>` : ''}</div>
      ${can ? '<div style="margin-top:12px"><button class="btn primary" data-act="fin_posting_save">Save</button></div>' : ''}</div>
    <div class="card"><div class="row between"><div><h3>Name &amp; CNIC</h3><div class="sub" style="margin:0">For the payee line of the cheque / bank advice - not part of the posting.</div></div><button class="btn" data-act="fin_copy" data-what="payee">${IC.copy || ''} Copy</button></div>
      <div class="payee" id="pc_payee">${esc(payee)}</div></div>
    <div class="card flush"><div class="scroll"><table class="post"><thead><tr><th>Code</th><th>Account</th><th class="n">Debit</th><th class="n">Credit</th><th>Narration</th></tr></thead><tbody>
      ${P.lines.map((l) => `<tr><td><b>${esc(l.code || '-')}</b></td><td>${esc(l.account)}</td><td class="n">${l.debit ? fmt(l.debit) : ''}</td><td class="n">${l.credit ? fmt(l.credit) : ''}</td><td class="pc-narr" data-tpl="${esc(l.narrationTpl)}">${esc(l.narration)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing to post.</td></tr>'}
      </tbody><tfoot><tr class="total"><td></td><td>Total</td><td class="n">${fmt(P.totalDr)}</td><td class="n">${fmt(P.totalCr)}</td><td>${P.balanced ? '<span class="pos">Balanced</span>' : '<span class="neg">Not balanced</span>'}</td></tr></tfoot></table></div></div>`;
  const chq = $('#pc_chq'), pfc = $('#pc_pf'), refresh = () => $$('.pc-narr').forEach((td) => { td.textContent = tpl(td.dataset.tpl, chq ? chq.value.trim() : '', pfc ? pfc.value.trim() : ''); });
  if (chq) chq.addEventListener('input', refresh); if (pfc) pfc.addEventListener('input', refresh);
}
// copy: the posting as tab-separated text (pastes straight into Excel / the accounts system) or the payee line
ACT.fin_copy = async (a) => {
  let text;
  if (a.dataset.what === 'payee') text = $('#pc_payee').textContent.trim();
  else {
    const chq = ($('#pc_chq') && $('#pc_chq').value.trim()) || '#########', pfc = ($('#pc_pf') && $('#pc_pf').value.trim()) || '#########', px = S.B.posting.prefixes || {};
    text = S.B.posting.lines.map((l) => [l.code, l.account, l.debit || '', l.credit || '', String(l.narrationTpl).replace('{CHQ}', (px.bank || '') + chq).replace('{CHQPF}', (px.pf || '') + pfc)].join('\t')).join('\n');
  }
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Copied', 'ok'); } catch { toast('Copy is not possible here - select the text and press Ctrl+C', 'err'); } t.remove(); }
};
ACT.fin_posting_save = async () => {
  const B = S.B, v = $('#pc_vem');
  if (await act(() => api('PUT', `/api/settlements/${B.settlement.id}/posting`, { cheque_main: $('#pc_chq').value, cheque_pf: $('#pc_pf').value, vem_code: v ? v.value : B.settlement.vem_code }), 'Saved')) route();
};
function tHistory(B) { $('#ftab').innerHTML = `<div class="card"><h3>History</h3><div class="sub">Every change made to this employee's settlement.</div>${timeline(B.log)}</div>`; }
