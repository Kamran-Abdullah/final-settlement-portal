'use strict';
// The supporting pages that are printed after the letter: the salary slip, the travelling expenses and the audit report
// (why every deduction / reimbursement was made, and what is missing or to check). Every page is one A4 page (print-fit.js scales it).
const rpHead = (B, title, sub, status) => {
  const h = B.statement.header;
  return `<div class="rp-top"><div class="rp-co">${esc(h.org)}</div><div class="rp-title">${esc(title)}</div>${sub ? `<div class="rp-sub">${esc(sub)}</div>` : ''}</div>
    <table class="rp-emp"><tr><td><small>Employee</small><b>${esc(h.name)}</b></td><td><small>Employee ID</small><b>${esc(h.id)}</b></td><td><small>Designation</small><b>${esc(h.designation)}</b></td><td><small>Station</small><b>${esc(h.station || '-')}</b></td>${status !== undefined ? `<td><small>Employee status</small><b>${esc(status || '-')}</b></td>` : ''}</tr></table>`;
};

// ---- page: salary slip + the travelling expenses (only the months that have a value)
function travelSection(B) {
  const st = B.statement, used = st.expenses.filter((e) => e.claimTotal > 0 || HEADS.some(([k]) => e.claim[k] > 0 || e.ded[k] > 0));
  if (!st.expenses.length) return '<div class="rp-h">Travelling expenses</div><p class="rp-none" style="margin:6px 0">The last working date has not been entered, so there are no expense months.</p>';
  if (!used.length) return '<div class="rp-h">Travelling expenses</div><p class="rp-none" style="margin:6px 0">No travelling expense was claimed in the last ' + st.expenses.length + ' months.</p>';
  const meta = Object.fromEntries(B.expenseMeta.map((m) => [m.month, m]));
  return `<div class="rp-h">Travelling expenses (the months with a claim)</div>${used.map((e) => `<div class="rp-m"><div class="rp-mh"><b>${esc(e.label)}</b><span>${(meta[e.month] ? meta[e.month].holidays : []).map((h) => esc(h.name)).join(', ')}${e.rateCustom ? ' &middot; custom rate' : ''}${e.rateMissing ? ' &middot; no rate for this designation' : ''}</span></div>
    <table class="rp-t fx"><thead><tr><th></th>${HEADS.map(([, l]) => `<th class="n">${l}</th>`).join('')}<th class="n">Total Rs</th></tr></thead><tbody>
      <tr><td>Rate</td>${HEADS.map(([k]) => `<td class="n">${fmt2(e.rate[k])}</td>`).join('')}<td></td></tr>
      <tr><td>Claim (qty)</td>${HEADS.map(([k]) => `<td class="n">${fmt2(e.claim[k])}</td>`).join('')}<td></td></tr>
      <tr><td>Deduction (qty)</td>${HEADS.map(([k]) => `<td class="n">${e.ded[k] ? fmt2(e.ded[k]) : ''}</td>`).join('')}<td></td></tr>
      <tr><td>Claimed Rs</td>${HEADS.map(([k]) => `<td class="n">${fmt(e.claimAmt[k])}</td>`).join('')}<td class="n"><b>${fmt(e.claimTotal)}</b></td></tr>
      <tr><td>Deducted Rs</td>${HEADS.map(([k]) => `<td class="n">${e.dedAmt[k] ? fmt(e.dedAmt[k]) : ''}</td>`).join('')}<td class="n"><b>${fmt(e.dedTotal)}</b></td></tr>
      <tr class="tot"><td>Allowed Rs</td>${HEADS.map(([k]) => `<td class="n">${fmt(e.actualAmt[k])}</td>`).join('')}<td class="n">${fmt(e.actualTotal)}</td></tr></tbody></table></div>`).join('')}
    <table class="rp-t kv"><tbody><tr class="tot"><td>Claimed ${fmt(st.exp.claimed)} - deducted ${fmt(st.exp.deducted)} = allowed (added to the gross payable)</td><td class="n">Rs ${fmt(st.exp.allowed)}</td></tr></tbody></table>`;
}
function slipPage(B) {
  const sl = B.slip, withSlip = PP.slip, withExp = PP.exp;
  const head = rpHead(B, withSlip && withExp ? 'Salary slip & travelling expenses' : withSlip ? 'Salary slip' : 'Travelling expenses', sl && withSlip ? `${fmonth(sl.month)} - ${sl.file}` : '', withSlip && sl ? (sl.emp_status || B.statement.header.jobStatus) : undefined);
  let body = '';
  if (withSlip) {
    if (!sl) body += '<p class="rp-none">No salary slip was found for this Employee ID.</p>';
    else {
      const rows = (list) => list.filter((r) => r[1]).map(([l, v]) => [l, v]);
      const E = rows([['Salary', sl.salary], ['Increment', sl.increments], ['Arrears', sl.arrears], ['Incentive', sl.incentive], ['Conveyance', sl.conv], ['Fuel allowance', sl.fuel], ['Tel / Mobile', sl.tel], ['Post / Sta.', sl.post], ['Non-touring', sl.ntour], ['Vehicle allowance', sl.vehicle_allow], ['Maintenance allowance', sl.maint], ['Inflation allowance', sl.inflation]]);
      const D = rows([['Income tax', sl.itax], ['Loan', sl.loan], ['PF loan', sl.pf_loan], ['Medical', sl.medical], ['Imprest', sl.imprest], ['EOBI', sl.eobi], ['Vehicle', sl.vehicle_inst], ['Other deduction / reimbursement', sl.other_ded], ['Provident fund (employee)', sl.pf_emp], ['Mobile', sl.mobile], ['Audit deduction (expenses)', sl.audit_ded], ['Absent deduction', sl.absent_ded]]);
      const n = Math.max(E.length, D.length), ep = B.expensePaid;
      body += `<table class="rp-t"><thead><tr><th>Salary &amp; allowances</th><th class="n">Rs</th><th class="sep">Deductions</th><th class="n">Rs</th></tr></thead><tbody>
        ${Array.from({ length: n }, (_, i) => `<tr><td>${E[i] ? esc(E[i][0]) : ''}</td><td class="n">${E[i] ? fmt(E[i][1]) : ''}</td><td class="sep">${D[i] ? esc(D[i][0]) : ''}</td><td class="n">${D[i] ? fmt(D[i][1]) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total gross salary</td><td class="n">${fmt(sl.total_gross)}</td><td class="sep">Total deductions</td><td class="n">${fmt(sl.total_ded)}</td></tr><tr><td colspan="2"></td><td class="sep">Net salary</td><td class="n">${fmt(sl.net)}</td></tr></tfoot></table>
        ${ep ? `<div class="rp-h">Expenses already paid in this payslip (the expenses of ${esc(fmonth(ep.paidFor))})</div>
        <table class="rp-t fx"><thead><tr><th></th>${ep.items.map((i) => `<th class="n">${esc(i.label)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody><tr><td><b>Expenses claimed</b></td>${ep.items.map((i) => `<td class="n">${i.value ? fmt(i.value) : '-'}</td>`).join('')}<td class="n"><b>${fmt(ep.claimed)}</b></td></tr></tbody></table>
        ${(ep.dedItems || []).length ? `<table class="rp-t fx" style="margin-top:6px"><thead><tr><th></th>${ep.dedItems.map((i) => `<th class="n">${esc(i.label)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody><tr><td><b>Deductions of the expenses</b></td>${ep.dedItems.map((i) => `<td class="n">${i.value ? fmt(i.value) : '-'}</td>`).join('')}<td class="n"><b>${fmt(ep.deducted)}</b></td></tr></tbody></table>` : ''}
        <table class="rp-t kv" style="margin-top:6px"><tbody><tr><td>Net expenses</td><td class="n">Rs ${fmt(ep.net)}</td></tr><tr class="tot"><td>Net payment of that payslip</td><td class="n">Rs ${fmt(ep.netPayment)}</td></tr></tbody></table>
        ${ep.nontouring > 0 ? `<p class="rp-warn">A non-touring allowance of Rs ${fmt(ep.nontouring)} was paid in this payslip.</p>` : ''}` : ''}`;
    }
  }
  if (withExp) body += travelSection(B);
  return `<div class="rp">${head}${body}</div>`;
}

// ---- page: audit report - why every amount was made, what is missing / to check
function whyOf(B, kind, d) {
  const h = B.statement.header, s = B.settlement, gross = h.lastDrawn, rule = B.rules.find((r) => r.code === h.rule), note = d.note ? ` (${d.note})` : '';
  if (kind === 'd') {
    if (d.code === 'salary') return `${fmt2(s.absent_days || 0)} absent day(s) x Rs ${fmt(gross)} / 30${/early/i.test(d.note || '') ? ' + early leaving before the resignation date' : ''}.`;
    if (d.code === 'notice') return `${rule ? rule.explanation : h.rule}. Notice base Rs ${fmt(B.inputs.noticeBase)} (salary + increment, without allowances).`;
    if (d.code === 'training') return `Training and orientation cost: Marketing staff of ABCD Pharma Pvt Limited who resign within 6 months of joining${note}.`;
    if (d.code === 'eobi') return `EOBI per month from the salary slip x the months with more than 15 days${note}.`;
    if (d.code === 'medical') return `Medical per month from the salary slip x the months with more than 15 days${note}.`;
    if (d.code === 'imprest') return `Imprest balance from Marketing${s.imprest_note ? ' - ' + s.imprest_note : ''}: a positive balance is recovered from the employee.`;
    if (d.code === 'audit') return `Audit observation not yet recovered in the payroll${note}.`;
    return d.manual ? `Added by Finance${d.note ? ': ' + d.note : ''}.` : `${d.note || 'As calculated.'}`;
  }
  if (d.code === 'notice') return `Notice pay WITH allowances: the company released the employee early; last drawn salary Rs ${fmt(gross)} for the remaining days${note}.`;
  if (d.code === 'pf') return `Employer provident fund contribution of the last month / 30 x the unpaid days${note}.`;
  if (d.code === 'vehicle') return 'Vehicle instalments paid back to the employee (entered by Finance).';
  if (d.code === 'imprest') return `Imprest balance paid to the employee (a negative balance in Marketing)${s.imprest_note ? ' - ' + s.imprest_note : ''}.`;
  if (d.code === 'absent_refund') return `Salary refunded for ${fmt2(-(s.absent_days || 0))} day(s) (HR entered a negative absent deduction).`;
  return d.manual ? `Added by Finance${d.note ? ': ' + d.note : ''}.` : `${d.note || 'As calculated.'}`;
}
function issuesOf(B) {
  const st = B.statement, s = B.settlement, L = [], add = (lvl, text) => L.push([lvl, text]);
  if (!s.hr_done) add('Missing', 'HR has not completed the settlement.'); if (!s.mkt_done) add('Missing', 'Marketing has not completed the settlement.');
  if (!s.resign_date) add('Missing', 'The resignation / termination date is not entered.'); if (!s.lwd) add('Missing', 'The last working date is not entered.');
  if (!B.slip) add('Missing', 'No salary slip was found: the last drawn salary comes from payroll or Finance.');
  if (B.pfError) add('Missing', 'The provident fund could not be read: ' + B.pfError); else if (!B.pf) add('Missing', 'The provident fund has not been read yet.');
  st.expenses.filter((e) => e.rateMissing).forEach((e) => add('Missing', `No travelling rate for this designation in ${e.label}.`));
  if (st.expenses.length && st.exp.claimed === 0) add('Check', 'No travelling expense was entered for any of the months (nothing is added to the gross payable).');
  const d = st.disbursement; if (d.mainBank > 0 && !(s.cheque_main || '').trim()) add('Missing', 'The cheque number of the bank is not entered (Finance > Posting).'); if (d.pfBank > 0 && !(s.cheque_pf || '').trim()) add('Missing', 'The cheque number of the PF bank is not entered.');
  (st.notes || []).forEach((n) => add('Check', n));
  (st.checks || []).filter((c) => c.status !== 'ok').forEach((c) => add(c.status === 'error' ? 'Error' : 'Check', c.text));
  ((B.posting && B.posting.warnings) || []).forEach((w) => add('Check', 'Posting: ' + w));
  B.items.filter((i) => i.waived).forEach((i) => add('Info', `Waived: ${i.label}${i.waive_reason ? ' - ' + i.waive_reason : ''}.`));
  if (st.expenses.some((e) => e.rateCustom)) add('Info', 'A travelling rate typed in the Marketing window (not the Master Data rate) is used.');
  if (B.expensePaid && B.expensePaid.nontouring > 0) add('Info', `A non-touring allowance of Rs ${fmt(B.expensePaid.nontouring)} was paid in the last payslip.`);
  if (st.edited) add('Info', `${st.editedKeys.length} figure(s) of the letter were edited by Finance (the calculation underneath is unchanged).`);
  return L;
}
function auditPage(B) {
  const st = B.statement, h = st.header, s = B.settlement, rule = B.rules.find((r) => r.code === h.rule), issues = issuesOf(B);
  const line = (sec, label, amount, why) => `<tr><td>${esc(label)}</td><td class="n">${fmt(amount)}</td><td class="why">${esc(why)}</td></tr>`;
  const calcF = Object.fromEntries((B.letterFields || []).map((f) => [f.key, f])), edited = Object.entries(B.letterEdits || {});
  return `<div class="rp">${rpHead(B, 'Audit report', 'How every amount of the settlement was made')}
    <table class="rp-t kv"><tbody><tr><td>${h.rule === 'Terminated' || s.date_kind === 'termination' ? 'Termination' : 'Resignation'} date / last working day / joining</td><td class="n">${esc(fdate(h.resignDate) || '-')} / ${esc(fdate(h.lwd) || '-')} / ${esc(fdate(h.doj) || '-')}</td></tr>
      <tr><td>Separation rule</td><td class="n">${esc(rule ? rule.explanation : h.rule || '-')}</td></tr><tr><td>Job status / last drawn salary</td><td class="n">${esc(h.jobStatus || '-')} / Rs ${fmt(h.lastDrawn)}</td></tr></tbody></table>
    <div class="rp-h">Gross dues payable</div><table class="rp-t why"><tbody>
      ${st.earned.map((e) => line('g', `Earned salary - ${e.label} (${e.days} days)`, e.amount, `Rs ${fmt(h.lastDrawn)} / 30 x ${e.days} day(s).`)).join('')}
      ${line('g', 'Balance of provident fund', st.pfBalance, B.pf ? `Employee ${fmt(B.pf.employee)} + employer ${fmt(B.pf.employer)} + profit ${fmt(B.pf.profit)} - withdrawals ${fmt(B.pf.withdrawal)} - loan ${fmt(B.pf.loan)}.` : 'The provident fund was not read.')}
      ${st.expenses.map((e) => line('g', `Travelling expenses - ${e.label}`, e.actualTotal, `Claimed Rs ${fmt(e.claimTotal)} - deducted Rs ${fmt(e.dedTotal)} at the rates of the year${e.rateCustom ? ' (custom rate)' : ''}.`)).join('')}
      <tr class="tot"><td>Total gross payable</td><td class="n">${fmt(st.grossPayable)}</td><td></td></tr></tbody></table>
    <div class="rp-h">Deductions - why</div><table class="rp-t why"><tbody>${st.deductions.map((d) => line('d', d.label, d.amount, whyOf(B, 'd', d))).join('') || '<tr><td colspan="3" class="muted">No deduction.</td></tr>'}<tr class="tot"><td>Total deductions</td><td class="n">${fmt(st.totalDeductions)}</td><td></td></tr></tbody></table>
    <div class="rp-h">Reimbursements - why</div><table class="rp-t why"><tbody>${st.reimbursements.map((d) => line('r', d.label, d.amount, whyOf(B, 'r', d))).join('') || '<tr><td colspan="3" class="muted">No reimbursement.</td></tr>'}<tr class="tot"><td>Total reimbursements</td><td class="n">${fmt(st.totalReimbursements)}</td><td></td></tr></tbody></table>
    <table class="rp-t kv"><tbody><tr class="tot"><td>Net amount ${st.net < 0 ? 'receivable from the employee' : 'payable'}: gross payable ${fmt(st.grossPayable)} + reimbursements ${fmt(st.totalReimbursements)} - deductions ${fmt(st.totalDeductions)}</td><td class="n">Rs ${fmt(st.net)}</td></tr></tbody></table>
    ${edited.length ? `<div class="rp-h">Figures edited by Finance</div><table class="rp-t why"><tbody>${edited.map(([k, v]) => `<tr><td>${esc((calcF[k] || {}).label || k)}</td><td class="n">${fmt(v)}</td><td class="why">Calculated ${fmt((calcF[k] || {}).calc)}.</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="rp-h">What is missing or has to be checked</div>
    ${issues.length ? `<table class="rp-t iss"><tbody>${issues.map(([l, t]) => `<tr class="lvl-${l.toLowerCase()}"><td class="lv">${l}</td><td>${esc(t)}</td></tr>`).join('')}</tbody></table>` : '<p class="rp-ok">Nothing is missing: every input is present and all the checks are OK.</p>'}</div>`;
}

// the pages to print after the letter (the choice is kept on this computer)
const PP = { slip: true, exp: true, audit: true };
try { Object.assign(PP, JSON.parse(localStorage.getItem('ufsa_pp') || '{}')); } catch { /* none */ }
function extraPages(B) { const p = []; if (PP.slip || PP.exp) p.push(slipPage(B)); if (PP.audit) p.push(auditPage(B)); return p; }
