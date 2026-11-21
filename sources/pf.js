'use strict';
// Reads an employee's provident fund from the PF portal (it signs in like a user; nothing is changed in the PF portal).
let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => { fetchImpl = f; };
const cfgErr = (m) => Object.assign(new Error(m), { status: 400 });
const jars = new Map();                                    // base url -> cookie header

const reach = async (base, url, opts) => { try { return await fetchImpl(url, opts); } catch (e) { throw cfgErr(`The PF portal at ${base} did not answer. Is the PF application running? Start it (PF-Management-System.exe), then try again.`); } };
const cookieOf = (res) => { const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : []; return raw.map((c) => c.split(';')[0]).join('; '); };
async function login(base, user, pass) {
  const res = await reach(base, base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user, password: pass }), signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw cfgErr('PF portal sign-in failed: ' + (j.error || res.status));
  jars.set(base, cookieOf(res)); return jars.get(base);
}
async function get(cfg, path) {
  const base = String(cfg.url || '').replace(/\/+$/, '');
  if (!base) throw cfgErr('PF portal address is not set (Setting > Data sources)');
  if (!cfg.user || !cfg.pass) throw cfgErr('PF portal user and password are not set (Setting > Data sources)');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!jars.get(base) || attempt) await login(base, cfg.user, cfg.pass);
    const res = await reach(base, base + path, { headers: { cookie: jars.get(base), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) { jars.delete(base); continue; }
    return res;
  }
  throw cfgErr('PF portal refused the sign-in');
}
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// the PF balance exactly as the template builds it (U204:U209): employee + employer + profit - permanent withdrawal - loan
async function fetchEmployee(cfg, empId) {
  const res = await get(cfg, '/api/employees/' + encodeURIComponent(String(empId).trim()) + '/ledger');
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error('PF portal answered ' + res.status);
  const j = await res.json(), s = j.summary || {}, c = (j.contributions || []).filter((x) => x && !x.deleted_at);
  const monthly = c.map((x) => ({ date: String(x.date || x.month || '').slice(0, 10), employee: n(x.employee_contribution), employer: n(x.employer_contribution), profit: n(x.profit_loss), loanRecovered: n(x.pf_loan_recover) }));
  const lastNonZero = [...monthly].reverse().find((m) => m.employee > 0);
  const employee = n(s.totalEmployeeContribution), employer = n(s.totalEmployerContribution), profit = n(s.profitLoss), withdrawal = n(s.permanentWithdrawal), loan = n(s.pendingLoan);
  return {
    found: true, employee, employer, profit, withdrawal, loan, balance: Math.round(employee + employer + profit - withdrawal - loan), portalBalance: n(s.netBalance),
    lastMonthly: lastNonZero ? lastNonZero.employee : 0, months: monthly.length, monthly, withdrawals: (j.withdrawals || []).map((w) => ({ date: String(w.date || '').slice(0, 10), amount: n(w.amount), purpose: w.purpose || '', status: w.cheque_status || w.status || '' })),
    name: j.employee && (j.employee.name || j.employee.employee_name) || '',
  };
}
// The PF database file is read directly (read-only), so the PF application does not have to be running. The figures are those of the PF Dashboard & Ledger.
function openDb(file) {
  const fs = require('fs'), { DatabaseSync } = require('node:sqlite');
  if (!file || !fs.existsSync(file)) throw cfgErr('The PF database file was not found. Check Setting > Data sources.');
  return new DatabaseSync(file, { readOnly: true });
}
function fetchFromDb(file, empId) {
  const db = openDb(file);
  try {
    const emp = db.prepare('SELECT * FROM employees WHERE UPPER(employee_id) = UPPER(?)').get(String(empId).trim());
    if (!emp) return { found: false };
    const c = db.prepare('SELECT * FROM contributions WHERE employee_id = ? AND deleted_at IS NULL ORDER BY date ASC, id ASC').all(emp.employee_id);
    const w = db.prepare('SELECT * FROM withdrawals WHERE employee_id = ? AND deleted_at IS NULL ORDER BY date ASC, id ASC').all(emp.employee_id);
    let ec = 0, emc = 0, total = 0, pl = 0, rec = 0;
    for (const x of c) { const a = n(x.employee_contribution), b = n(x.employer_contribution); ec += a; emc += b; total += n(x.contribution_amount) || a + b; pl += n(x.profit_loss); rec += n(x.pf_loan_recover); }
    const active = w.filter((x) => !['void', 'cancelled'].includes(String(x.cheque_status || x.status || '').toLowerCase()) && x.impact_balance !== 0 && x.impact_balance !== '0');
    const loanTaken = active.filter((x) => x.purpose === 'loan').reduce((s, x) => s + n(x.amount), 0), withdrawal = active.filter((x) => x.purpose !== 'loan').reduce((s, x) => s + n(x.amount), 0);
    const monthly = c.map((x) => ({ date: String(x.date || '').slice(0, 10), employee: n(x.employee_contribution), employer: n(x.employer_contribution), profit: n(x.profit_loss), loanRecovered: n(x.pf_loan_recover) }));
    const lastNonZero = [...monthly].reverse().find((m) => m.employee > 0);
    const R = Math.round, employee = R(ec), employer = R(emc), profit = R(pl), wd = R(withdrawal), loan = R(loanTaken - rec);
    return {
      found: true, employee, employer, profit, withdrawal: wd, loan, balance: employee + employer + profit - wd - loan, portalBalance: R(total + pl - withdrawal - (loanTaken - rec)),
      lastMonthly: lastNonZero ? lastNonZero.employee : 0, months: monthly.length, monthly,
      withdrawals: active.map((x) => ({ date: String(x.date || '').slice(0, 10), amount: n(x.amount), purpose: x.purpose || '', status: x.cheque_status || x.status || '' })), name: emp.name || '', source: 'database',
    };
  } finally { db.close(); }
}
function testDb(file) { const db = openDb(file); try { return { employees: db.prepare('SELECT COUNT(*) n FROM employees').get().n, contributions: db.prepare('SELECT COUNT(*) n FROM contributions WHERE deleted_at IS NULL').get().n }; } finally { db.close(); } }
async function test(cfg) { const base = String(cfg.url || '').replace(/\/+$/, ''); jars.delete(base); await login(base, cfg.user, cfg.pass); return { ok: true }; }
module.exports = { fetchEmployee, fetchFromDb, testDb, test, setFetch };
