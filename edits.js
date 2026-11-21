'use strict';
// Finance can edit any figure of the letter. The edits are kept as { key: number } on the settlement and applied on top of the calculated
// statement (engine.js), so the letter, the posting, the reports and the approval snapshot all see the edited figures. Totals follow the edited lines
// automatically, unless the total itself is edited. Keys:
//   earned:<YYYY-MM>  pf  exp:<YYYY-MM>  d:<code> / r:<code>  d:other:<n> / r:other:<n>   (code = salary, notice, training, eobi, medical, imprest | imprest, notice, vehicle, pf)
//   earnedTotal  gross  totalDed  totalReim  net  pfBank  mainBank  lastDrawn
const r0 = (n) => Math.round(Number(n) || 0);
const D_CODES = [['salary', 'Salary deduction'], ['notice', 'Notice pay'], ['training', 'Training and orientation cost'], ['eobi', 'EOBI'], ['medical', 'Medical NJI'], ['imprest', 'Imprest balance']];
const R_CODES = [['imprest', 'Imprest balance'], ['notice', 'Notice pay (with allowances)'], ['vehicle', 'Vehicle instalments as per policy'], ['pf', 'Provident fund reimbursement']];
const LABEL = { 'd:salary': 'Salary deduction', 'd:notice': 'Notice pay (without allowances)', 'd:training': 'Training and orientation cost', 'd:eobi': 'EOBI', 'd:medical': 'Medical NJI', 'd:imprest': 'Imprest balance',
  'r:imprest': 'Imprest balance', 'r:notice': 'Notice pay (with allowances)', 'r:vehicle': 'Vehicle instalments as per policy', 'r:pf': 'Provident fund reimbursement' };
const sum = (l, k) => l.reduce((s, x) => s + (Number(x[k]) || 0), 0);
const KEY = /^(earned:\d{4}-\d{2}|pf|exp:\d{4}-\d{2}|[dr]:(salary|notice|training|eobi|medical|imprest|vehicle|pf)|[dr]:other:\d{1,2}|earnedTotal|gross|totalDed|totalReim|net|pfBank|mainBank|lastDrawn)$/;
const isKey = (k) => KEY.test(k);

const othersOf = (list, codes) => list.filter((x) => !codes.includes(x.code));

// every editable field of the letter with its calculated value (from the unedited statement)
function fields(st) {
  const f = [];
  for (const e of st.earned) f.push({ key: 'earned:' + e.month, group: 'Gross dues', label: `Earned salary - ${e.label} (${e.days} days)`, calc: e.amount });
  f.push({ key: 'earnedTotal', group: 'Gross dues', label: 'Total of salary', calc: sum(st.earned, 'amount'), total: true });
  f.push({ key: 'pf', group: 'Gross dues', label: 'Balance of provident fund', calc: st.pfBalance });
  for (const e of st.expenses) f.push({ key: 'exp:' + e.month, group: 'Gross dues', label: `Expenses allowed - ${e.label}`, calc: e.actualTotal });
  f.push({ key: 'gross', group: 'Gross dues', label: 'Total gross payable', calc: r0(sum(st.earned, 'amount') + st.pfBalance + sum(st.expenses, 'actualTotal')), total: true });
  const dOthers = othersOf(st.deductions, D_CODES.map((c) => c[0])), rOthers = othersOf(st.reimbursements, R_CODES.map((c) => c[0]));
  for (const [c, l] of D_CODES) f.push({ key: 'd:' + c, group: 'Deductions', label: l, calc: sum(st.deductions.filter((x) => x.code === c), 'amount') });
  dOthers.forEach((x, i) => f.push({ key: 'd:other:' + i, group: 'Deductions', label: String(x.label), calc: x.amount }));
  f.push({ key: 'totalDed', group: 'Deductions', label: 'Total deductions', calc: st.totalDeductions, total: true });
  for (const [c, l] of R_CODES) f.push({ key: 'r:' + c, group: 'Reimbursement', label: l, calc: sum(st.reimbursements.filter((x) => x.code === c), 'amount') });
  rOthers.forEach((x, i) => f.push({ key: 'r:other:' + i, group: 'Reimbursement', label: String(x.label), calc: x.amount }));
  f.push({ key: 'totalReim', group: 'Reimbursement', label: 'Total reimbursements', calc: st.totalReimbursements, total: true });
  f.push({ key: 'net', group: 'Net and bank', label: 'Net amount payable / (receivable)', calc: st.net, total: true });
  f.push({ key: 'mainBank', group: 'Net and bank', label: 'Amount through the bank (cheque)', calc: st.disbursement.mainBank, total: true });
  f.push({ key: 'pfBank', group: 'Net and bank', label: 'Amount through the PF bank', calc: st.disbursement.pfBank, total: true });
  f.push({ key: 'lastDrawn', group: 'Header', label: 'Last drawn salary with allowances', calc: st.header.lastDrawn });
  return f;
}

function editList(list, prefix, codes, e, has) {
  let out = list.map((x) => ({ ...x }));
  for (const [c] of codes) {
    const k = `${prefix}:${c}`; if (!has(k)) continue;
    const first = out.find((x) => x.code === c), v = r0(e[k]);
    out = out.filter((x) => x.code !== c);
    if (v !== 0) out.push({ label: first ? first.label : LABEL[k], amount: v, note: 'edited', code: c });
  }
  const known = codes.map((c) => c[0]);
  const others = out.filter((x) => !known.includes(x.code));
  others.forEach((x, i) => { const k = `${prefix}:other:${i}`; if (has(k)) x.amount = r0(e[k]); });
  return out.filter((x) => x.amount !== 0);
}

function applyEdits(st, edits) {
  const e = {}; for (const [k, v] of Object.entries(edits || {})) if (isKey(k) && v !== null && v !== '' && Number.isFinite(Number(v))) e[k] = Number(v);
  const keys = Object.keys(e); if (!keys.length) return { ...st, edited: false, editedKeys: [] };
  const has = (k) => k in e, out = JSON.parse(JSON.stringify(st));
  out.earned.forEach((x) => { if (has('earned:' + x.month)) x.amount = r0(e['earned:' + x.month]); });
  out.earnedTotal = has('earnedTotal') ? r0(e.earnedTotal) : sum(out.earned, 'amount');
  if (has('pf')) out.pfBalance = r0(e.pf);
  out.expenses.forEach((x) => { if (has('exp:' + x.month)) { x.actualTotal = r0(e['exp:' + x.month]); x.dedTotal = x.claimTotal - x.actualTotal; } });
  out.exp = { claimed: sum(out.expenses, 'claimTotal'), deducted: sum(out.expenses, 'dedTotal'), allowed: sum(out.expenses, 'actualTotal') };
  out.grossPayable = has('gross') ? r0(e.gross) : r0(out.exp.allowed + out.pfBalance + out.earnedTotal);
  out.deductions = editList(out.deductions, 'd', D_CODES, e, has); out.reimbursements = editList(out.reimbursements, 'r', R_CODES, e, has);
  out.totalDeductions = has('totalDed') ? r0(e.totalDed) : sum(out.deductions, 'amount');
  out.totalReimbursements = has('totalReim') ? r0(e.totalReim) : sum(out.reimbursements, 'amount');
  out.net = has('net') ? r0(e.net) : r0(out.grossPayable + out.totalReimbursements - out.totalDeductions);
  out.direction = out.net < 0 ? 'receivable' : 'payable';
  const healthcare = out.header.companyType === 'healthcare';
  let pfBank = healthcare ? 0 : (out.net < out.pfBalance ? 0 : out.pfBalance);
  let mainBank = out.net < 0 ? 0 : (pfBank === 0 ? out.net : out.net - pfBank);
  if (has('pfBank')) pfBank = r0(e.pfBank); if (has('mainBank')) mainBank = r0(e.mainBank);
  out.disbursement = { pfBank, mainBank };
  if (has('lastDrawn')) out.header.lastDrawn = r0(e.lastDrawn);
  const up = (a) => a.map((x) => x.label).join(' ').toUpperCase();
  out.narrative = { deductions: up(out.deductions), reimbursements: up(out.reimbursements) };
  out.checks = (out.checks || []).filter((c) => c.key !== 'net');
  out.checks.push({ key: 'net', label: 'Net vs disbursement', status: pfBank + mainBank === Math.max(0, out.net) ? 'ok' : 'warn', text: out.net < 0 ? `Receivable from the employee: ${-out.net}` : pfBank + mainBank === out.net ? 'OK Net vs Disbursement' : `The bank amounts (${pfBank + mainBank}) differ from the net (${out.net})` });
  out.edited = true; out.editedKeys = keys;
  return out;
}
module.exports = { applyEdits, fields, isKey };
