'use strict';
// Final settlement engine. A port of the Finance sheet of "the Finance template" (cell references in the comments).
// Pure function: calc(input) -> statement. Nothing here touches the database.

const r0 = (n) => Math.sign(n) * Math.round(Math.abs(n) + 1e-9);          // Excel ROUND(x,0)
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pad = (n) => String(n).padStart(2, '0');
const parse = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? new Date(String(s).slice(0, 10) + 'T00:00:00Z') : null);
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const ym = (s) => String(s).slice(0, 7);
const addMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + n, 1)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`; };
const dim = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => (m ? `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
const monthShort = (m) => (m ? `${MON[Number(m.slice(5, 7)) - 1].slice(0, 3)}-${m.slice(2, 4)}` : '');
const HEADS = ['km', 'daily', 'ex', 'on'];

// Excel DAYS360 (US method) - used for the 180-day training-cost rule (L38 / L39)
function days360(a, b) {
  if (!a || !b) return 0;
  let [y1, m1, d1] = [a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate()], [y2, m2, d2] = [b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate()];
  if (d1 === 31) d1 = 30; if (d2 === 31 && d1 === 30) d2 = 30;
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}
// Excel DATEDIF "y", "ym", "md" -> "3 months 5 days" (Q5)
function service(a, b) {
  if (!a || !b || b < a) return '';
  // whole months first, then the days left over (the start day is clamped to the month end, e.g. 31 Jan + 1 month = 28 Feb)
  const M = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
  const t = a.getUTCMonth() + M, ay = a.getUTCFullYear() + Math.floor(t / 12), am = ((t % 12) + 12) % 12;
  const anchor = new Date(Date.UTC(ay, am, Math.min(a.getUTCDate(), new Date(Date.UTC(ay, am + 1, 0)).getUTCDate())));
  const y = Math.floor(M / 12), m = M % 12, d = Math.round((b - anchor) / 864e5);
  return [y ? `${y} year${y > 1 ? 's' : ''}` : '', m ? `${m} month${m > 1 ? 's' : ''}` : '', d ? `${d} day${d > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
}

/**
 * input = {
 *   emp: {id, name, designation, designationCode, group, station, doj},
 *   companyType: 'pharma'|'trade'|'generic'|'healthcare', org: 'ACME ... LTD.',
 *   grossMonthly (E14), noticeBase (P39+Q39), eobi (U41), medical (S41), jobStatus: 'Confirmed'|'Unconfirmed'|null,
 *   resignDate (P5), lwd (P7), lastSalaryMonth 'YYYY-MM' (P8), sepRule (P6), absentDays (N36), imprest (signed: + deduction, - reimbursement),
 *   vehicleInst (V48),
 *   pf: {balance, employee, employer, profit, withdrawal, loan, lastMonthly, portalBalance} | null,
 *   expenses: [{month, claim:{km,daily,ex,on}, ded:{km,daily,ex,on}}] (oldest first), rateFor(year) -> {fare,daily,ex,ovn} | null,
 *   adjustments: [{kind:'deduction'|'reimbursement', code, label, amount, note, waived}],
 *   auditObs: [{month, total}], slipAuditDed, slipNonTouring, slipGross (for the gross check),
 *   settings: {dim, trainingCost, trainingDays}
 * }
 */
function calc(inp) {
  const S = { dim: 30, trainingCost: 10000, trainingDays: 180, ...(inp.settings || {}) };
  const D = S.dim, notes = [], checks = [];
  const emp = inp.emp || {};
  const resign = inp.resignDate || null, lwd = inp.lwd || null, rule = inp.sepRule || 'NO';
  const E14 = num(inp.grossMonthly), noticeBase = num(inp.noticeBase);
  const dojD = parse(emp.doj), resD = parse(resign), lwdD = parse(lwd);
  const trade = inp.companyType === 'trade', healthcare = inp.companyType === 'healthcare';
  const noNotice = trade || healthcare;                                    // OR(N3="TRADE", N3="Healthcare")
  if (!resign) notes.push('Resignation / termination date is missing (HR)');
  if (!lwd) notes.push('Last working date is missing (Marketing)');
  if (!E14) notes.push('Last drawn salary is missing (no salary slip and no gross in the payroll)');

  // ---- earned salary (J18/J19, L18/L19): every month after the last salary paid, up to the last working month
  const earned = [];
  if (lwd) {
    const lm = ym(lwd), paid = inp.lastSalaryMonth ? ym(inp.lastSalaryMonth) : null;
    let m = paid ? addMonth(paid, 1) : lm;
    if (paid && paid >= lm) notes.push(`Salary is already paid up to ${monthLabel(paid)}, nothing is due for ${monthLabel(lm)}`);
    if (!paid) notes.push('Last month salary paid is unknown: only the last working month is calculated');
    if (resign === lwd && paid === lm) m = addMonth(lm, 1);              // P5=P7 in the same month -> 0
    for (let g = 0; m <= lm && g < 24; m = addMonth(m, 1), g++) {
      let days = D;
      if (m === lm) days = (lwdD.getUTCDate() >= dim(lm) || lwdD.getUTCDate() >= D) ? D : lwdD.getUTCDate();   // 31 -> 30; month end = full month
      if (dojD && m === ym(emp.doj) && !paid) days = Math.max(0, days - (dojD.getUTCDate() - 1));
      earned.push({ month: m, label: monthLabel(m), from: m === lm ? lwd : `${m}-${pad(dim(m))}`, days, amount: r0(E14 / D * days) });
    }
  }
  const earnedTotal = earned.reduce((s, x) => s + x.amount, 0);          // L20
  const unpaidDays = earned.reduce((s, x) => s + x.days, 0);             // J18+J19

  // ---- provident fund (U204:U209)
  const pf = inp.pf || null;
  if (!pf) notes.push('Provident fund has not been read from the PF portal yet');
  const pfBalance = pf ? r0(num(pf.balance)) : 0;                        // L23 = U209
  const pfReimb = pf ? r0(num(pf.lastMonthly) / D * unpaidDays) : 0;     // V6 = ROUND(U6/30*(J18+J19))

  // ---- job status (E13 = Confirmed when the PF balance is at least 1)
  const jobStatus = inp.jobStatus || (pfBalance >= 1 ? 'Confirmed' : 'Unconfirmed');
  const confirmed = jobStatus === 'Confirmed';

  // ---- travelling expenses: three months, claim vs net, valued at the rates of that year (rows 23-30)
  const expenses = [];
  for (const e of inp.expenses || []) {
    const rate = inp.rateFor ? inp.rateFor(Number(e.month.slice(0, 4))) : null;
    const rt = rate ? { km: num(rate.fare), daily: num(rate.daily), ex: num(rate.ex), on: num(rate.ovn) } : { km: 0, daily: 0, ex: 0, on: 0 };
    const ov = e.rates || {}, typed = HEADS.filter((h) => ov[h] != null && ov[h] !== '');          // rates typed in the Marketing window for this month
    for (const h of typed) rt[h] = num(ov[h]);
    const row = { month: e.month, label: monthLabel(e.month), rate: rt, rateCustom: typed.some((h) => !rate || rt[h] !== num(h === 'km' ? rate.fare : h === 'on' ? rate.ovn : rate[h])), rateMissing: !rate && typed.length < HEADS.length, claim: {}, ded: {}, actual: {}, claimAmt: {}, dedAmt: {}, actualAmt: {} };
    let c = 0, d = 0, a = 0;
    for (const h of HEADS) {
      row.claim[h] = num(e.claim && e.claim[h]); row.ded[h] = num(e.ded && e.ded[h]); row.actual[h] = row.claim[h] - row.ded[h];
      row.claimAmt[h] = r0(row.claim[h] * rt[h]); row.actualAmt[h] = r0(row.actual[h] * rt[h]); row.dedAmt[h] = r0(row.claimAmt[h] - row.actualAmt[h]);
      c += row.claimAmt[h]; a += row.actualAmt[h]; d += row.dedAmt[h];
    }
    row.claimTotal = r0(c); row.actualTotal = r0(a); row.dedTotal = r0(d); expenses.push(row);
    if (row.rateMissing && (c > 0 || row.claim.km + row.claim.daily + row.claim.ex + row.claim.on > 0)) notes.push(`No travelling rate for ${emp.designation || 'this designation'} in ${e.month.slice(0, 4)} (Master Data > Rates)`);
  }
  const exp = { claimed: expenses.reduce((s, x) => s + x.claimTotal, 0), deducted: expenses.reduce((s, x) => s + x.dedTotal, 0), allowed: expenses.reduce((s, x) => s + x.actualTotal, 0) };   // F/H/J and L30

  const grossPayable = r0(exp.allowed + pfBalance + earnedTotal);        // M32

  // ---- deductions (L36 - L42)
  const ded = [];
  const addD = (label, amount, note, extra = {}) => { amount = r0(amount); if (amount) ded.push({ label, amount, note: note || '', ...extra }); };
  const dResign = resD ? resD.getUTCDate() : 0, dLwd = lwdD ? lwdD.getUTCDate() : 0;
  const absentIn = num(inp.absentDays), absent = Math.max(0, absentIn);           // a negative value is a refund of salary (reimbursement)
  // the salary of the resignation month was already paid in full, but the last working day is earlier: the days after the last working day up to the resignation
  // date are recovered (31-day month, last day 25th, resignation 31st: 6 days; 30-day month: 5 days) - at gross / 30 a day - with the PF employer contribution of those days
  const paidM = inp.lastSalaryMonth ? ym(inp.lastSalaryMonth) : null, resM = resign ? ym(resign) : null;
  const paidResignMonth = !!(paidM && resM && paidM >= resM);
  const overDays = paidResignMonth && lwdD && resD && ym(lwd) === resM && dLwd < dResign ? dResign - dLwd : 0;
  let early = 0;
  if (!overDays && (rule === 'Rule: 03' || rule === 'Rule: 02') && lwdD && resD && dLwd < dResign) early = (E14 / D) * (dResign - dLwd - 1);   // L36 second / third term
  addD('Salary deduction', r0(E14 / D * absent) + (overDays ? r0(E14 / D * overDays) : early > 0 ? r0(early) : 0),
    `${absent} absent day(s)` + (overDays ? ` + ${overDays} day(s) after the last working day, already paid in the ${monthLabel(resM)} salary` : early > 0 ? ` + ${rule} early leaving` : ''), { code: 'salary' });
  if (overDays && inp.pf) addD('Provident fund employer contribution (' + overDays + ' days)', num(inp.pf.lastMonthly) / D * overDays, `${r0(num(inp.pf.lastMonthly))} / ${D} x ${overDays} days: contributed for days that were not worked`, { code: 'pf_overpaid' });

  const adj = (inp.adjustments || []).filter((a) => !a.waived);
  for (const a of adj.filter((x) => x.kind === 'deduction')) addD(a.label, num(a.amount), a.note, { code: a.code || 'other', manual: true, id: a.id });

  // audit observations (W14:X16): the audit total of each expense month must already be in the payroll "Audit Ded."; otherwise it is recovered here
  const auditRows = [];
  for (const e of inp.expenses || []) {
    const o = (inp.auditObs || []).filter((x) => ym(x.month) === e.month).reduce((s, x) => s + num(x.total), 0);
    const ok = r0(o) === r0(num(inp.slipAuditDed));
    auditRows.push({ month: e.month, label: monthShort(e.month), total: r0(o), status: ok ? 'OK' : 'Deduction' });
    if (!ok && r0(o) > 0 && !(inp.auditWaived || []).includes(e.month)) addD(`Audit observation ${monthShort(e.month)}`, o, 'not yet recovered in payroll', { code: 'audit' });
  }

  const svcDays = days360(dojD, resD);
  const served = lwdD && resD ? Math.round((lwdD - resD) / 864e5) : 0;                // X3
  if (!noNotice && inp.trainingApplies !== false && dojD && resD && svcDays < S.trainingDays) addD('Training and orientation cost', S.trainingCost, `service ${svcDays} days (< ${S.trainingDays})`, { code: 'training' });
  let notice = 0;
  if (!noNotice) {
    if (rule === 'Rule: 04') notice += noticeBase;
    if (rule === 'Rule: 02' && lwd === resign) notice += noticeBase;
    if (rule === 'Rule: 02' && lwd > resign) notice += noticeBase / D * Math.max(0, (D - served) - 1);
  }
  if (rule === 'Rule: 02' && lwd < resign) notice += noticeBase;                     // outside the OR(): applies to every company
  addD('Notice pay (without allowances)', notice, rule, { code: 'notice' });

  const longMonths = earned.filter((x) => x.days > 15).length;                       // IF(J18>15,..)+IF(J19>15,..)
  addD('EOBI', num(inp.eobi) * longMonths, `${longMonths} month(s) with more than 15 days`, { code: 'eobi' });
  addD('Medical NJI', num(inp.medical) * longMonths, `${longMonths} month(s) with more than 15 days`, { code: 'medical' });
  const imprest = num(inp.imprest);
  if (imprest > 0) addD('Imprest balance', imprest, 'recovered from the employee', { code: 'imprest' });
  const totalDed = ded.reduce((s, x) => s + x.amount, 0);

  // ---- reimbursements (L45 - L49)
  const reim = [];
  const addR = (label, amount, note, extra = {}) => { amount = r0(amount); if (amount) reim.push({ label, amount, note: note || '', ...extra }); };
  if (absentIn < 0) addR('Absent deduction refund', E14 / D * -absentIn, `${-absentIn} day(s) refunded`, { code: 'absent_refund' });
  for (const a of adj.filter((x) => x.kind === 'reimbursement')) addR(a.label, num(a.amount), a.note, { code: a.code || 'other', manual: true, id: a.id });
  if (imprest < 0) addR('Imprest balance', -imprest, 'paid to the employee', { code: 'imprest' });
  let noticeRe = 0, noticePaidDays = 0;
  if (rule === 'Rule: 03' && lwdD && resD) {
    if (dResign === dLwd || lwd < resign) {
      noticeRe = E14;                                                                  // paid WITH allowances (the last drawn salary), while the recovery uses the notice base
      // resignation on the 28th of a 31-day month, October already paid: 28, 29, 30, 31 = 4 days are paid, so 30 - 4 = 26 days of notice are given
      if (paidResignMonth) { noticePaidDays = dim(resM) - dResign + 1; noticeRe = E14 / D * Math.max(0, D - noticePaidDays); }
    }
    else if (lwd > resign) noticeRe = E14 / D * (D - (new Date(lwdD.getTime() + 864e5).getUTCDate() - dResign));
  }
  addR('Notice pay (with allowances)', noticeRe, rule === 'Rule: 03' ? 'released by the company' + (noticePaidDays ? `; ${noticePaidDays} day(s) of the notice were already paid in the ${monthLabel(resM)} salary` : '') : '', { code: 'notice' });
  addR('Vehicle instalments as per policy', num(inp.vehicleInst), '', { code: 'vehicle' });
  addR('Provident fund reimbursement', pfReimb, pf ? `${r0(num(pf.lastMonthly))} @ ${unpaidDays} days employer contribution` : '', { code: 'pf' });
  const totalReim = reim.reduce((s, x) => s + x.amount, 0);

  const net = r0(grossPayable + totalReim - totalDed);                   // M52
  // ---- disbursement (C68 / C69): the PF goes through the PF bank unless the settlement does not cover it
  const pfBank = healthcare ? 0 : (net < pfBalance ? 0 : pfBalance);
  const mainBank = net < 0 ? 0 : (pfBank === 0 ? net : net - pfBank);

  // ---- checks the sheet shows in red / green
  const chk = (key, label, status, text) => checks.push({ key, label, status, text });
  if (inp.slipGross != null) chk('gross', 'Gross salary', r0(E14) === r0(num(inp.slipGross)) ? 'ok' : 'error', r0(E14) === r0(num(inp.slipGross)) ? 'OK Gross Salary' : `Error in Gross: ${r0(E14)} against salary slip ${r0(num(inp.slipGross))}`);
  chk('net', 'Net vs disbursement', pfBank + mainBank === Math.max(0, net) ? 'ok' : 'error', net < 0 ? `Receivable from the employee: ${-net}` : (pfBank + mainBank === net ? 'OK Net vs Disbursement' : 'Error in Net vs Disbursement'));
  if (pf && pf.portalBalance != null) chk('pf', 'PF balance', r0(pf.balance) === r0(pf.portalBalance) ? 'ok' : 'error', r0(pf.balance) === r0(pf.portalBalance) ? 'PF working agrees with the PF portal' : `PF working ${r0(pf.balance)} differs from the portal balance ${r0(pf.portalBalance)}`);
  if (inp.slipNonTouring != null && num(inp.slipNonTouring) > 1 && expenses.some((e) => e.actual.ex + e.actual.on > 0)) chk('nontouring', 'Non-touring allowance', 'warn', 'Nontouring and Ex.: the employee was paid a non-touring allowance and claims EX / ON');
  if (!confirmed && rule !== 'NO' && rule !== 'Terminated' && rule !== 'Deceased') chk('rule', 'Separation rule', 'warn', 'Unconfirmed employees should have the rule "NO"');
  for (const a of auditRows) if (a.status === 'Deduction' && a.total > 0) chk('audit' + a.month, `Audit ${a.label}`, 'warn', `Audit observation ${a.total} for ${a.label} is not in the payroll`);
  if (lwd && resign && lwd < resign && rule === 'Rule: 01') chk('dates', 'Dates', 'warn', 'Last working day is before the resignation date but the rule says the notice was served');
  if (resign && dojD && resD < dojD) chk('dates2', 'Dates', 'error', 'Resignation date is before the joining date');

  // ---- narratives printed under the statement (F54 / F55 and O13:O18)
  const upper = (a) => a.map((x) => x.label).join(' ').toUpperCase();
  return {
    header: { org: inp.org || '', name: emp.name || '', designation: emp.designation || '', id: emp.id, station: emp.station || '', group: emp.group || '', doj: emp.doj || '', resignDate: resign, lwd, rule,
      service: service(dojD, resD), jobStatus, confirmed, lastDrawn: E14, daysServed: served, companyType: inp.companyType || 'pharma' },
    earned, earnedTotal, unpaidDays, pf: pf ? { ...pf, balance: pfBalance, reimbursement: pfReimb } : null, pfBalance,
    expenses, exp, grossPayable, deductions: ded, totalDeductions: totalDed, reimbursements: reim, totalReimbursements: totalReim,
    net, direction: net < 0 ? 'receivable' : 'payable', disbursement: { pfBank, mainBank }, auditRows, checks, notes,
    narrative: { deductions: upper(ded), reimbursements: upper(reim) },
  };
}

module.exports = { calc, r0, days360, service, monthLabel, monthShort, addMonth, dim, HEADS, num };
