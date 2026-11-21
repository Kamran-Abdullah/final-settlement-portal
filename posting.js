'use strict';
// The accounting voucher ("posting") of a final settlement, following Posting.xlsx.
//  * the FSA ledger of the employee's payroll (Admin, Factory, Marketing, Healthcare) is the balancing line,
//  * Bank (credit) carries the cheque, narration "FSA OF <NAME> # <ID>" (+ "CHQ:<cheque>" on the bank / provident fund lines),
//  * when the PF is paid through its own bank (net >= PF) it is NOT part of this voucher; when the net is smaller than the PF the PF payable is cleared here,
//  * a negative net (receivable from the employee) books Salaries and FSA Receivable,
//  * the Imprest ledger line appears only when the employee has an imprest balance (positive = deduction -> credit, negative = reimbursement -> debit).
const PLACE = '#########';

function sourceKey(emp) {
  const s = `${emp && emp.source || ''} ${emp && emp.company || ''}`.toLowerCase();
  if (/admin/.test(s)) return 'admin';
  if (/factory/.test(s)) return 'factory';
  if (/health/.test(s)) return 'healthcare';
  return 'marketing';
}

function buildPosting({ st, emp, settlement, get }) {
  const warnings = [], key = sourceKey(emp), r0 = (n) => Math.round(Number(n) || 0);
  const net = r0(st.net), pfBal = r0(st.pfBalance), pfBank = r0(st.disbursement.pfBank), mainBank = r0(st.disbursement.mainBank), imprest = r0(settlement.imprest);
  const fsaCode = get('post_fsa_' + key) || '', fsaName = get('post_fsa_name') || 'FSA';
  if (!fsaCode) warnings.push(`The FSA ledger code of the ${key} payroll is not set (Setting > Posting accounts).`);
  const vem = (settlement.vem_code || '').trim();
  const name = String(emp.name || '').replace(/\s+/g, ' ').trim().toUpperCase(), id = emp.emp_id || settlement.emp_id;
  const narr = `FSA OF ${name} # ${id}`, narrBank = `${narr}  CHQ:{CHQ}`, narrPf = `${narr}  CHQ:{CHQPF}`;
  const chq = (settlement.cheque_main || '').trim(), chqPf = (settlement.cheque_pf || '').trim();
  const prefixes = { bank: get('post_bank_prefix') || '', pf: get('post_pf_prefix') || '' };           // e.g. HMB- and PF-
  const lines = [], add = (kind, code, account, dr, cr, tpl) => lines.push({ kind, code, account, debit: dr || 0, credit: cr || 0, tpl });

  if (imprest !== 0) {
    if (!vem) warnings.push('Enter the imprest ledger (VEM) code of the employee.');
    add('imprest', vem || 'VEM Code', get('post_imp_name') || 'Imprest Ledger', imprest < 0 ? -imprest : 0, imprest > 0 ? imprest : 0, narr);
  }
  const pfInside = pfBank === 0 && pfBal > 0;
  if (pfInside) add('pf', get('post_pf_code'), get('post_pf_name'), pfBal, 0, narrPf);
  if (net < 0) {
    const x = -net;
    add('receivable', get('post_rec_code'), get('post_rec_name'), 0, x, narr);
    add('receivable', get('post_rec_code'), get('post_rec_name'), x, 0, narr);
    add('salary', get('post_sal_code'), get('post_sal_name'), x, 0, narr);
  }
  if (mainBank > 0) {
    if (!get('post_bank_code')) warnings.push('The bank account code is not set (Setting > Posting accounts).');
    add('bank', get('post_bank_code'), get('post_bank_name'), 0, mainBank, narrBank);
  }
  // the FSA ledger balances the voucher
  const dr = lines.reduce((s, l) => s + l.debit, 0), cr = lines.reduce((s, l) => s + l.credit, 0), diff = dr - cr;
  if (diff !== 0) lines.unshift({ kind: 'fsa', code: fsaCode, account: fsaName, debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, tpl: narr });
  // order as in Posting.xlsx: FSA, imprest, then the others
  const order = { fsa: 0, imprest: 1, pf: 2, receivable: 3, salary: 4, bank: 5 };
  lines.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const l of lines) { l.narrationTpl = l.tpl; l.narration = l.tpl.replace('{CHQ}', prefixes.bank + (chq || PLACE)).replace('{CHQPF}', prefixes.pf + (chqPf || PLACE)); delete l.tpl; }
  const totalDr = lines.reduce((s, l) => s + l.debit, 0), totalCr = lines.reduce((s, l) => s + l.credit, 0);
  let kind = net < 0 ? 'Receivable from the employee' : pfBank > 0 ? 'Net payable; the provident fund is paid separately by the PF bank' : pfBal > 0 ? 'Net payable is less than the provident fund: the PF payable is cleared in this voucher' : 'Net payable, no provident fund';
  if (!lines.length) warnings.push('Nothing to post: the net amount is zero.');
  return { lines, totalDr, totalCr, balanced: totalDr === totalCr, warnings, kind, source: key, hasChequeBank: mainBank > 0, cheque: chq, chequePf: chqPf, prefixes, vem, net, pfBank, mainBank, pfBal, imprest };
}
module.exports = { buildPosting, sourceKey, PLACE };
