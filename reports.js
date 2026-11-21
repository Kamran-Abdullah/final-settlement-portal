'use strict';
// The Report window: several reports over the live settlements (cheque numbers, amounts, deductions, PF, vouchers, status ...).
// `items` = one entry per settlement: { s (settlement row), emp, st (statement), posting, src, bank, pfBank }.
const SRC = { marketing: 'Marketing', healthcare: 'Healthcare', admin: 'Admin', factory: 'Factory' };
const STATE = { open: 'Open', approved: 'Approved', cancelled: 'Cancelled' };
const sum = (list, codes, inside) => (list || []).filter((d) => codes.includes(d.code) === inside).reduce((a, d) => a + (Number(d.amount) || 0), 0);
const D_LISTED = ['salary', 'notice', 'training', 'eobi', 'medical', 'imprest'], R_LISTED = ['imprest', 'notice', 'vehicle', 'pf', 'absent_refund'];

const REPORTS = [
  { key: 'summary', title: 'Settlement summary', note: 'Every settlement with its gross payable, deductions, reimbursements and net.' },
  { key: 'cheques', title: 'Cheque register', note: 'Cheque numbers and amounts of the bank and the provident fund bank; shows which cheques are still missing.' },
  { key: 'disbursement', title: 'Disbursement by bank', note: 'How much goes through each bank and how much is receivable from employees.' },
  { key: 'deductions', title: 'Deductions & reimbursements', note: 'The deduction and reimbursement lines of every settlement, side by side.' },
  { key: 'pf', title: 'Provident fund', note: 'PF balance, what the PF bank pays, what is cleared in the voucher and the PF reimbursement.' },
  { key: 'posting', title: 'Posting register', note: 'The accounting voucher lines of every settlement (code, account, debit, credit, narration).' },
  { key: 'status', title: 'Status of all resigners', note: 'Where every resigner stands: not started, waiting for HR / Marketing, ready for Finance, approved.' },
];

const col = (k, label, type = 'text') => ({ k, label, type });
const base = (it) => ({ emp_id: it.s.emp_id, name: it.emp.name, payroll: SRC[it.src] || it.src, state: STATE[it.s.state] || it.s.state, designation: it.emp.designation || it.emp.designation_code || '' });

function build(key, items, extra = {}) {
  const t = (k, n) => n; // readability
  let columns = [], rows = [];
  if (key === 'summary') {
    columns = [col('emp_id', 'ID'), col('name', 'Name'), col('designation', 'Designation'), col('payroll', 'Payroll'), col('resign', 'Resignation', 'date'), col('lwd', 'Last working day', 'date'), col('gross', 'Gross payable', 'num'), col('ded', 'Deductions', 'num'), col('reim', 'Reimbursements', 'num'), col('net', 'Net payable / (receivable)', 'num'), col('state', 'State')];
    rows = items.map((it) => ({ ...base(it), resign: it.s.resign_date, lwd: it.s.lwd, gross: it.st.grossPayable, ded: it.st.totalDeductions, reim: it.st.totalReimbursements, net: it.st.net }));
  } else if (key === 'cheques') {
    columns = [col('emp_id', 'ID'), col('name', 'Name'), col('payroll', 'Payroll'), col('state', 'State'), col('net', 'Net', 'num'), col('bank', 'Bank'), col('bankAmt', 'Bank amount', 'num'), col('chq', 'Cheque no.'), col('pfBank', 'PF bank'), col('pfAmt', 'PF amount', 'num'), col('pfChq', 'PF cheque no.'), col('status', 'Cheque status')];
    rows = items.map((it) => {
      const d = it.st.disbursement, chq = (it.s.cheque_main || '').trim(), pc = (it.s.cheque_pf || '').trim();
      const need = (d.mainBank > 0 && !chq) || (d.pfBank > 0 && !pc);
      return { ...base(it), net: it.st.net, bank: d.mainBank > 0 ? it.bank : '', bankAmt: d.mainBank, chq, pfBank: d.pfBank > 0 ? it.pfBankName : '', pfAmt: d.pfBank, pfChq: pc, status: d.mainBank + d.pfBank === 0 ? (it.st.net < 0 ? 'Receivable' : 'No payment') : need ? 'Cheque missing' : 'Cheque entered' };
    });
    if (extra.cheque === 'missing') rows = rows.filter((r) => r.status === 'Cheque missing');
    if (extra.cheque === 'entered') rows = rows.filter((r) => r.status === 'Cheque entered');
  } else if (key === 'disbursement') {
    columns = [col('bank', 'Bank / account'), col('kind', 'What'), col('count', 'Payments', 'num'), col('amount', 'Amount', 'num'), col('chq', 'Cheques entered', 'num'), col('missing', 'Cheques missing', 'num')];
    const main = { bank: items[0] ? items[0].bank : '', kind: 'Net payable (cheque)', count: 0, amount: 0, chq: 0, missing: 0 }, pf = { bank: items[0] ? items[0].pfBankName : '', kind: 'Provident fund paid by the PF bank', count: 0, amount: 0, chq: 0, missing: 0 }, rec = { bank: 'Employees', kind: 'Receivable from employees', count: 0, amount: 0, chq: 0, missing: 0 };
    for (const it of items) {
      const d = it.st.disbursement; main.bank = main.bank || it.bank; pf.bank = pf.bank || it.pfBankName;
      if (d.mainBank > 0) { main.count++; main.amount += d.mainBank; (it.s.cheque_main || '').trim() ? main.chq++ : main.missing++; }
      if (d.pfBank > 0) { pf.count++; pf.amount += d.pfBank; (it.s.cheque_pf || '').trim() ? pf.chq++ : pf.missing++; }
      if (it.st.net < 0) { rec.count++; rec.amount += -it.st.net; }
    }
    rows = [main, pf, rec];
  } else if (key === 'deductions') {
    columns = [col('emp_id', 'ID'), col('name', 'Name'), col('payroll', 'Payroll'), col('salary', 'Salary ded.', 'num'), col('notice', 'Notice pay', 'num'), col('training', 'Training cost', 'num'), col('eobi', 'EOBI', 'num'), col('medical', 'Medical', 'num'), col('imprest', 'Imprest', 'num'), col('others', 'Other ded.', 'num'), col('ded', 'Total deductions', 'num'),
      col('rnotice', 'Notice pay (reimb.)', 'num'), col('rimprest', 'Imprest (reimb.)', 'num'), col('rpf', 'PF reimb.', 'num'), col('rothers', 'Other reimb.', 'num'), col('reim', 'Total reimbursements', 'num')];
    const one = (l, c) => sum(l, [c], true);
    rows = items.map((it) => ({ ...base(it), salary: one(it.st.deductions, 'salary'), notice: one(it.st.deductions, 'notice'), training: one(it.st.deductions, 'training'), eobi: one(it.st.deductions, 'eobi'), medical: one(it.st.deductions, 'medical'), imprest: one(it.st.deductions, 'imprest'), others: sum(it.st.deductions, D_LISTED, false), ded: it.st.totalDeductions,
      rnotice: one(it.st.reimbursements, 'notice'), rimprest: one(it.st.reimbursements, 'imprest'), rpf: one(it.st.reimbursements, 'pf'), rothers: sum(it.st.reimbursements, ['notice', 'imprest', 'pf'], false), reim: it.st.totalReimbursements }));
  } else if (key === 'pf') {
    columns = [col('emp_id', 'ID'), col('name', 'Name'), col('payroll', 'Payroll'), col('state', 'State'), col('pfBal', 'PF balance', 'num'), col('pfBank', 'Paid by the PF bank', 'num'), col('inVoucher', 'Cleared in the voucher', 'num'), col('pfReim', 'PF reimbursement', 'num'), col('pfChq', 'PF cheque no.')];
    rows = items.map((it) => ({ ...base(it), pfBal: it.st.pfBalance, pfBank: it.st.disbursement.pfBank, inVoucher: it.st.disbursement.pfBank === 0 ? it.st.pfBalance : 0, pfReim: sum(it.st.reimbursements, ['pf'], true), pfChq: it.s.cheque_pf || '' })).filter((r) => r.pfBal || r.pfReim);
  } else if (key === 'posting') {
    columns = [col('emp_id', 'ID'), col('name', 'Name'), col('code', 'Code'), col('account', 'Account'), col('debit', 'Debit', 'num'), col('credit', 'Credit', 'num'), col('narration', 'Narration')];
    rows = items.flatMap((it) => it.posting.lines.map((l) => ({ emp_id: it.s.emp_id, name: it.emp.name, code: l.code, account: l.account, debit: l.debit, credit: l.credit, narration: l.narration })));
  }
  const totals = {}; for (const c of columns) if (c.type === 'num') totals[c.k] = rows.reduce((a, r) => a + (Number(r[c.k]) || 0), 0);
  return { columns, rows, totals, count: rows.length };
}
module.exports = { REPORTS, build, SRC };
