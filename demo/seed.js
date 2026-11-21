'use strict';
// Fills a NEW, empty data folder with made-up demo data (no real people or companies).
//   set UFSA_DATA_DIR=C:\temp\ufsa-demo   (required: the script refuses to touch any other folder by accident)
//   set UFSA_NO_AUTOSETUP=1
//   node demo/seed.js                       -> master data, employees, salary slips, PF balances
//   npm start   (in another window, same UFSA_DATA_DIR)
//   node demo/seed.js http://localhost:4900 -> creates settlements at different stages through the API
if (!process.env.UFSA_DATA_DIR) { console.error('Set UFSA_DATA_DIR to an empty demo folder first.'); process.exit(1); }
process.env.UFSA_NO_AUTOSETUP = '1';
const base = process.argv[2];

const EMP = [
  ['90001', 'Imran Sample', 'TM', 'Group A', 'Lahore', '2022-03-01', 85000, 'Confirmed', '2026-10-31'],
  ['90002', 'Sana Example', 'STM', 'Group A', 'Karachi', '2021-07-15', 120000, 'Confirmed', '2026-10-15'],
  ['90003', 'Bilal Demo', 'TM', 'Group B', 'Islamabad', '2024-01-10', 70000, 'Unconfirmed', '2026-11-05'],
  ['90004', 'Nadia Test', 'ASM', 'Group A', 'Multan', '2019-05-20', 210000, 'Confirmed', '2026-11-10'],
  ['90005', 'Farhan Sample', 'TM', 'Group B', 'Faisalabad', '2023-09-01', 78000, 'Confirmed', '2026-11-12'],
  ['90006', 'Ayesha Example', 'RM', 'Group A', 'Lahore', '2018-02-12', 320000, 'Confirmed', '2026-11-14'],
  ['90007', 'Hina Test', 'TM', 'Group A', 'Peshawar', '2025-01-06', 65000, 'Unconfirmed', '2026-11-17'],
  ['90008', 'Kashif Demo', 'STM', 'Group B', 'Quetta', '2020-11-03', 105000, 'Confirmed', '2026-11-18'],
];
const TITLES = { TM: 'Territory Manager', STM: 'Senior Territory Manager', ASM: 'Area Sales Manager', RM: 'Regional Manager' };
const COMPANY = 'ABCD Pharma Pvt Limited';

function seedDirect() {
  const { db, setSetting } = require('../db');
  if (db.prepare('SELECT COUNT(*) n FROM employees').get().n) { console.log('Demo data already present - nothing to do.'); return; }
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  for (const [c, t] of Object.entries(TITLES)) ins('INSERT OR IGNORE INTO designations(code,title) VALUES(?,?)', c, t);
  ins("INSERT OR IGNORE INTO groups(name,company_type,signatory,signatory_title) VALUES('Group A','pharma','Jane Doe','General Manager Finance')");
  ins("INSERT OR IGNORE INTO groups(name,company_type,signatory,signatory_title) VALUES('Group B','trade','Jane Doe','General Manager Finance')");
  const rates = { TM: [14, 900, 1200, 700], STM: [15, 1000, 1400, 800], ASM: [17, 1200, 1700, 900], RM: [20, 1500, 2000, 1100] };
  for (const y of [2025, 2026]) for (const [c, r] of Object.entries(rates)) ins('INSERT OR IGNORE INTO rates(year,designation,fare,daily,ex,ovn) VALUES(?,?,?,?,?,?)', y, TITLES[c], r[0] + (y === 2026 ? 1 : 0), r[1], r[2], r[3]);
  for (const [f, t, n] of [['2026-09-06', '2026-09-06', 'Defence Day'], ['2026-10-30', '2026-10-30', 'Local holiday'], ['2026-11-09', '2026-11-09', 'Iqbal Day']]) ins("INSERT INTO holidays(from_date,to_date,name,kind) VALUES(?,?,?,'public')", f, t, n);
  const doj = (d) => d, cn = (i) => `35202-000000${i}-1`;
  EMP.forEach((e, i) => ins('INSERT INTO employees(emp_id,name,designation_code,designation,group_name,station,doj,company,cnic,gross,employment_status,payroll_status,last_working_date,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    e[0], e[1], e[2], TITLES[e[2]], e[3], e[4], doj(e[5]), COMPANY, cn(i + 1), e[6], e[7].toLowerCase(), 'resigned', e[8], 'Marketing payroll'));
  // salary slips (two months) - a made-up payroll file per month
  for (const [m, name] of [['2026-09', 'Marketing Sep-2026.xlsx'], ['2026-10', 'Marketing Oct-2026.xlsx']]) {
    const fid = Number(ins('INSERT INTO payroll_files(path,file_name,month,company,rows) VALUES(?,?,?,?,?)', 'demo:' + name, name, m, 'pharma', EMP.length).lastInsertRowid);
    for (const e of EMP) {
      const gross = e[6], allow = Math.round(gross * 0.18), total = gross + allow, eobi = 407, med = 500, tax = Math.round(total * 0.02), ded = eobi + med + tax + Math.round(gross * 0.08);
      const data = { emp_id: e[0], name: e[1], desig: e[2], group: e[3], station: e[4], doj: e[5], gross, promo: 0, special: 0, conf: 0, arrears: 0, ntour: Math.round(allow * 0.4), total_gross: total, itax: tax, medical: med, eobi, pf_emp: Math.round(gross * 0.08), pf_er: Math.round(gross * 0.08), audit_ded: 0, absent_ded: 0, total_ded: ded, net: total - ded, emp_status: e[7] };
      ins('INSERT INTO payroll_slips(file_id,emp_id,month,company,data) VALUES(?,?,?,?,?)', fid, e[0], m, 'pharma', JSON.stringify(data));
    }
  }
  // PF balances as the PF portal would answer
  EMP.forEach((e, i) => {
    const mo = Math.round(e[6] * 0.08), months = 18 + i * 4, employee = mo * months, employer = employee, profit = Math.round(employee * 0.09), loan = i % 3 === 0 ? 40000 : 0, withdrawal = 0;
    const monthly = Array.from({ length: Math.min(months, 12) }, (_, k) => ({ date: new Date(Date.UTC(2026, 10 - k, 1)).toISOString().slice(0, 10), employee: mo, employer: mo, profit: 0, loanRecovered: 0 })).reverse();
    const sum = { found: true, employee, employer, profit, withdrawal, loan, balance: employee + employer + profit - withdrawal - loan, portalBalance: employee + employer + profit - withdrawal - loan, lastMonthly: mo, months, monthly, withdrawals: [], name: e[1] };
    ins('INSERT INTO pf_snapshots(emp_id,ok,summary,contributions,withdrawals) VALUES(?,?,?,?,?)', e[0], 1, JSON.stringify(sum), JSON.stringify(monthly), '[]');
  });
  ins("INSERT INTO audit_obs(month,emp_id,name,total) VALUES('2026-10','90002','Sana Example',3200)");
  ins("INSERT INTO other_deductions(emp_id,remarks,amount,active) VALUES('90004','Mobile handset recovery',6500,1)");
  console.log(`Demo data loaded: ${EMP.length} employees, 2 salary months, PF balances, rates, holidays.`);
}

async function seedApi() {
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p}: ${j.error || r.status}`); return j;
  };
  await call('POST', '/api/login', { username: 'admin', password: process.env.UFSA_ADMIN_PASS || 'admin123' });
  const exp = (m, k) => ({ month: m, claim: { km: 120 * k, daily: 14, ex: 6, on: 2 }, ded: { km: 0, daily: 0, ex: 0, on: 0 } });
  const plan = [
    // emp, resign date, rule, lwd, stage: 'approved' | 'finance' | 'mkt' | 'hr'
    ['90001', '2026-10-01', 'Rule: 01', '2026-10-31', 'approved'],
    ['90002', '2026-09-15', 'Rule: 01', '2026-10-15', 'approved'],
    ['90003', '2026-10-05', 'Rule: 02', '2026-11-05', 'finance'],
    ['90004', '2026-10-10', 'Rule: 01', '2026-11-10', 'finance'],
    ['90005', '2026-11-12', 'Rule: 03', '2026-11-12', 'mkt'],
    ['90006', '2026-11-14', 'Terminated', '2026-11-14', 'mkt'],
    ['90007', '2026-11-17', 'Rule: 04', '2026-11-17', 'hr'],
  ];
  for (const [id, rd, rule, lwd, stage] of plan) {
    const { id: sid } = await call('POST', '/api/settlements', { emp_id: id });
    await call('PUT', `/api/settlements/${sid}/hr`, { resign_date: rd, sep_rule: rule, absent_days: 0, termination_reason: rule === 'Terminated' ? 'Misconduct' : '', date_kind: rule === 'Terminated' ? 'termination' : 'resignation', done: stage !== 'hr' ? 1 : 0 });
    if (stage === 'hr') continue;
    if (stage === 'mkt') { continue; }
    const m = lwd.slice(0, 7), pm = (k) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 - k, 1)); return d.toISOString().slice(0, 7); };
    await call('PUT', `/api/settlements/${sid}/marketing`, { lwd, imprest: id === '90004' ? 4200 : 0, imprest_note: id === '90004' ? 'Unadjusted imprest' : '', expenses: [exp(m, 1), exp(pm(1), 1.2), exp(pm(2), 0.9)], done: 1 });
    await call('PUT', `/api/settlements/${sid}/finance`, { last_salary_month: stage === 'approved' ? pm(1) : '2026-10', cheque_pf: stage === 'approved' ? 'PF-0001' : '', cheque_main: stage === 'approved' ? 'CH-0001' : '', finance_note: '' });
    if (stage === 'approved') {
      await call('PUT', `/api/settlements/${sid}/checks`, { all: true, ok: true });
      try { await call('POST', `/api/settlements/${sid}/approve`); console.log('approved', id); } catch (e) { console.log('not approved', id, '-', e.message); }
    }
  }
  console.log('Settlements created at different stages.');
}

(base ? seedApi() : Promise.resolve(seedDirect())).catch((e) => { console.error(e.message); process.exit(1); });
