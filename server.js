'use strict';
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, DB_FILE, getSetting, setSetting, audit, tx, backupNow } = require('./db');
const { calc, addMonth, monthLabel, dim } = require('./engine');
const payrollDb = require('./sources/payroll-db');
const pf = require('./sources/pf');
const slips = require('./sources/slips');
const payslipBlocks = require('./sources/payslip-blocks');
const { buildPosting, sourceKey } = require('./posting');
const reportsLib = require('./reports');
const letterEdits = require('./edits');
const { importTemplate } = require('./sources/master-import');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const txt = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const nn = (v, { min = 0, max = 1e10, label = 'Number' } = {}) => { const x = Number(v === '' || v == null ? 0 : v); if (!Number.isFinite(x) || x < min || x > max) throw bad(`${label} must be between ${min} and ${max}`); return x; };
const wrap = (fn) => async (req, res, next) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); } };

// ---------- who may see / change what
const ROLES = ['admin', 'hr', 'marketing', 'finance', 'viewer'];
const SECTIONS = { dashboard: ['hr', 'marketing', 'finance', 'viewer'], hr: ['hr', 'finance', 'viewer'], marketing: ['marketing', 'finance', 'viewer'], finance: ['finance', 'viewer'], report: ['finance', 'viewer'], master: ['finance', 'hr', 'marketing', 'viewer'], setting: [] };
const canSee = (u, section) => u.role === 'admin' || (SECTIONS[section] || []).includes(u.role);
const canEdit = (u, section) => u.role === 'admin' || (section === 'master' ? u.role === 'finance' : u.role === section);

// ---------- master data tables that are edited as plain lists
const MASTER = {
  rates: { cols: { year: 'int', designation: 'text', fare: 'num', daily: 'num', ex: 'num', ovn: 'num' }, order: 'year DESC, designation', key: 'id' },
  designations: { cols: { code: 'text', title: 'text' }, order: 'code', key: 'code' },
  groups: { cols: { name: 'text', company_type: 'ctype', signatory: 'text', signatory_title: 'text' }, order: 'name', key: 'name' },
  sep_rules: { cols: { code: 'text', explanation: 'text', sort: 'int' }, order: 'sort, code', key: 'code' },
  holidays: { cols: { from_date: 'date', to_date: 'date', name: 'text', kind: 'kind' }, order: 'from_date DESC', key: 'id' },
  other_deductions: { cols: { emp_id: 'text', remarks: 'text', amount: 'num', active: 'int' }, order: 'emp_id', key: 'id' },
  termination_reasons: { cols: { label: 'text' }, order: 'label', key: 'id' },
};
function cleanCol(type, v, name) {
  if (type === 'text') { v = txt(v, 200); if (!v && ['code', 'name', 'title', 'designation', 'emp_id', 'label'].includes(name)) throw bad(`${name} is required`); return v; }
  if (type === 'int') return Math.round(nn(v, { min: -1e6, max: 1e6, label: name }));
  if (type === 'num') return nn(v, { min: -1e9, max: 1e9, label: name });
  if (type === 'date') { if (!isDate(v)) throw bad(`${name} must be a date (YYYY-MM-DD)`); return v; }
  if (type === 'ctype') { if (!['pharma', 'trade', 'generic', 'healthcare'].includes(v)) throw bad('Company type must be pharma, trade, generic or healthcare'); return v; }
  if (type === 'kind') return v === 'off' ? 'off' : 'public';
  return v;
}

// ---------- helpers that build a settlement from everything we know
const get = (id) => { const s = db.prepare('SELECT * FROM settlements WHERE id=?').get(Number(id)); if (!s) throw bad('Settlement not found', 404); return s; };
const getEmp = (id) => db.prepare('SELECT * FROM employees WHERE emp_id=?').get(String(id));
const desigTitle = (code) => { if (!code) return ''; const r = db.prepare('SELECT title FROM designations WHERE code=? COLLATE NOCASE').get(code); return r ? r.title : code; };
const groupOf = (name) => (name ? db.prepare('SELECT * FROM groups WHERE name=? COLLATE NOCASE').get(name) : null);
function ratesFor(title) {
  const rows = db.prepare('SELECT * FROM rates WHERE designation=? COLLATE NOCASE ORDER BY year').all(title || '');
  return (year) => { let best = null; for (const r of rows) if (r.year <= year) best = r; return best || rows[0] || null; };       // the latest rate at or before that year
}
function expenseMonths(s, n = Number(getSetting('expense_months', '3')) || 3) {
  if (!s.lwd) return [];
  const last = s.lwd.slice(0, 7), out = []; for (let i = 0; i < n; i++) out.push(addMonth(last, -i)); return out;
}
// the three expense months for a last working date, with the holidays of each month and the rates of its year
function monthsMeta(s, title) {
  const rf = ratesFor(title);
  return expenseMonths(s).map((m) => { const r = rf(Number(m.slice(0, 4))); return { month: m, label: monthLabel(m), holidays: holidaysIn(m), rate: r ? { fare: r.fare, daily: r.daily, ex: r.ex, ovn: r.ovn, year: r.year } : null }; });
}
function holidaysIn(month) {
  const from = `${month}-01`, to = `${month}-${String(dim(month)).padStart(2, '0')}`;
  return db.prepare('SELECT from_date,to_date,name,kind FROM holidays WHERE from_date<=? AND to_date>=? ORDER BY from_date').all(to, from);
}
// "Others" in the master list are deducted automatically for that employee (V8); materialised once so Finance can edit or waive them
function materialiseOthers(s) {
  for (const o of db.prepare('SELECT * FROM other_deductions WHERE emp_id=? AND active=1').all(s.emp_id)) {
    const code = 'od:' + o.id;
    if (!db.prepare('SELECT 1 FROM settlement_items WHERE settlement_id=? AND code=?').get(s.id, code)) db.prepare("INSERT INTO settlement_items(settlement_id,kind,code,label,amount,note) VALUES(?,'deduction',?,?,?,'from Master Data > Other deductions')").run(s.id, code, o.remarks || 'Other deduction', o.amount);
  }
}

// what the last payslip says about expenses: the expenses claimed and paid with it (they are those of the month before), and a non-touring allowance
function expensePaidOf(empId, month) {
  if (!month) return null;
  const r = db.prepare("SELECT s.data FROM payroll_slips s JOIN payroll_files f ON f.id=s.file_id WHERE s.emp_id=? AND s.month=? AND f.path LIKE 'payslip:%' ORDER BY s.id DESC LIMIT 1").get(String(empId), month);
  if (!r) return null; let d; try { d = JSON.parse(r.data); } catch { return null; }
  if (!Array.isArray(d.exp_items) || !d.exp_items.length) return null;
  const nt = d.exp_items.find((i) => /non-?touring/i.test(i.label));
  return { month, paidFor: addMonth(month, -1), items: d.exp_items, claimed: d.exp_claimed || 0, dedItems: d.exp_ded_items || [], deducted: d.exp_ded_total || 0, net: d.net_expenses || 0, netPayment: d.net_payment || 0, nontouring: nt ? nt.value : 0 };
}
function assemble(sid) {
  let s = get(sid); materialiseOthers(s);
  const emp = getEmp(s.emp_id) || {}, title = desigTitle(emp.designation_code), grp = groupOf(emp.group_name), ctype = grp ? grp.company_type : (/health/i.test(emp.company || '') ? 'healthcare' : /pvt/i.test(emp.company || '') || !emp.company ? 'pharma' : 'trade');
  const slip = (s.last_salary_month && slips.slipFor(s.emp_id, s.last_salary_month)) || slips.latestSlip(s.emp_id);
  const snap = db.prepare('SELECT * FROM pf_snapshots WHERE emp_id=? ORDER BY id DESC LIMIT 1').get(s.emp_id);
  const pfData = snap && snap.ok ? JSON.parse(snap.summary) : null;
  const months = expenseMonths(s), stored = db.prepare('SELECT * FROM settlement_expenses WHERE settlement_id=?').all(s.id);
  const expenses = months.map((m) => { const r = stored.find((x) => x.month === m) || {}; return { month: m, claim: { km: r.claim_km || 0, daily: r.claim_daily || 0, ex: r.claim_ex || 0, on: r.claim_on || 0 }, ded: { km: r.ded_km || 0, daily: r.ded_daily || 0, ex: r.ded_ex || 0, on: r.ded_on || 0 }, remarks: r.remarks || '', holidays: holidaysIn(m), rates: [r.rate_km, r.rate_daily, r.rate_ex, r.rate_on].some((v) => v != null) ? { km: r.rate_km, daily: r.rate_daily, ex: r.rate_ex, on: r.rate_on } : null }; });
  const items = db.prepare('SELECT * FROM settlement_items WHERE settlement_id=? ORDER BY id').all(s.id);
  const auditObs = months.length ? db.prepare(`SELECT month, SUM(total) total FROM audit_obs WHERE emp_id=? AND month IN (${months.map(() => '?').join(',')}) GROUP BY month`).all(s.emp_id, ...months) : [];
  const auditWaived = items.filter((i) => i.code && i.code.startsWith('audit:') && i.waived).map((i) => i.code.slice(6));
  const gross = s.gross_override != null ? s.gross_override : slip ? slip.total_gross : emp.gross || 0;
  const noticeBase = s.notice_base_override != null ? s.notice_base_override : slip ? slip.notice_base : emp.gross || 0;
  const lastSalaryMonth = s.last_salary_month || (slip ? slip.month : null);
  const org = ctype === 'healthcare' ? getSetting('org_healthcare') : ctype === 'trade' || ctype === 'generic' ? getSetting('org_trade') : getSetting('org_pharma');
  const trainingApplies = sourceKey(emp) === 'marketing' && (!emp.company || /pvt/i.test(emp.company));        // only Marketing staff of Acme Pharmaceuticals Pvt Limited pay the training cost
  const statementCalc = calc({
    trainingApplies,
    emp: { id: s.emp_id, name: emp.name, designation: title, designationCode: emp.designation_code, group: emp.group_name, station: emp.station, doj: emp.doj }, companyType: ctype, org,
    grossMonthly: gross, noticeBase, eobi: slip ? slip.eobi : 0, medical: slip ? slip.medical : 0, jobStatus: s.job_status || (slip && slip.emp_status) || emp.employment_status || null,
    resignDate: s.resign_date, lwd: s.lwd, lastSalaryMonth, sepRule: s.sep_rule || 'NO', absentDays: s.absent_days, imprest: s.imprest, vehicleInst: s.vehicle_inst,
    pf: pfData ? { balance: pfData.balance, employee: pfData.employee, employer: pfData.employer, profit: pfData.profit, withdrawal: pfData.withdrawal, loan: pfData.loan, lastMonthly: pfData.lastMonthly, portalBalance: pfData.portalBalance } : null,
    expenses, rateFor: ratesFor(title), adjustments: items.filter((i) => !(i.code || '').startsWith('audit:')).map((i) => ({ id: i.id, kind: i.kind, code: i.code, label: i.label, amount: i.amount, note: i.note, waived: !!i.waived })),
    auditObs, auditWaived, slipAuditDed: slip ? slip.audit_ded : 0, slipNonTouring: slip ? slip.ntour : null, slipGross: slip ? slip.total_gross : null,
    settings: { dim: Number(getSetting('days_in_month', '30')) || 30, trainingCost: Number(getSetting('training_cost', '10000')), trainingDays: Number(getSetting('training_days', '180')) },
  });
  let edits = {}; try { edits = s.letter_edits ? JSON.parse(s.letter_edits) : {}; } catch { edits = {}; }
  const statement = letterEdits.applyEdits(statementCalc, edits);        // Finance may edit any figure of the letter
  const checks = db.prepare('SELECT item, ok, by_user, at FROM settlement_checks WHERE settlement_id=?').all(s.id);
  return {
    statementCalc, letterEdits: edits, letterFields: letterEdits.fields(statementCalc),
    settlement: s, employee: { ...emp, designation: title, company_type: ctype, org }, group: grp, slip, pf: pfData, pfFetchedAt: snap ? snap.fetched_at : null, pfError: snap && !snap.ok ? snap.error : null, pfMonthly: snap && snap.ok ? JSON.parse(snap.contributions || '[]') : [],
    rules: db.prepare('SELECT code,explanation FROM sep_rules ORDER BY sort, code').all(), reasons: db.prepare('SELECT label FROM termination_reasons ORDER BY label').all().map((r) => r.label),
    expenses, expenseMeta: monthsMeta(s, title), items, statement, checks, inputs: { gross, noticeBase, lastSalaryMonth, jobStatus: statement.header.jobStatus, grossFrom: s.gross_override != null ? 'Finance' : slip ? `salary slip ${slip.month}` : 'payroll', designationTitle: title },
    signatures: { s1: [getSetting('sign1_name'), getSetting('sign1_title')], s2: [getSetting('sign2_name'), getSetting('sign2_title')], note: getSetting('letter_note'), pfBank: getSetting('pf_bank_name'), mainBank: getSetting('main_bank_name') },
    log: db.prepare('SELECT at,user,action,detail FROM audit_log WHERE emp_id=? ORDER BY id DESC LIMIT 60').all(s.emp_id),
    expensePaid: expensePaidOf(s.emp_id, lastSalaryMonth),
    posting: buildPosting({ st: statement, emp, settlement: s, get: (k) => getSetting(k, '') }),
  };
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '40mb' }));
  let secret = getSetting('session_secret'); if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', secret); }
  app.use(session({ name: 'ufsa.sid', secret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 } }));
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' }); next(); });

  // ---------- sign in
  app.post('/api/login', wrap((req) => {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(txt(req.body.username, 60)), now = Date.now();
    if (u && u.locked_until > now) throw bad('Account locked for a few minutes after too many wrong passwords', 429);
    if (!u || !u.active || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) {
      if (u) db.prepare('UPDATE users SET fails=fails+1, locked_until=CASE WHEN fails+1>=5 THEN ? ELSE 0 END WHERE id=?').run(now + 10 * 60000, u.id);
      throw bad('Wrong user name or password', 401);
    }
    db.prepare('UPDATE users SET fails=0, locked_until=0, last_login=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
    req.session.user = { id: u.id, username: u.username, name: u.full_name || u.username, role: u.role };
    audit(u.username, null, 'login', ''); return meOf(req.session.user);
  }));
  app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  const meOf = (u) => ({ ...u, sections: Object.keys(SECTIONS).filter((s) => canSee(u, s)), edit: Object.keys(SECTIONS).filter((s) => canEdit(u, s)) });
  app.get('/api/me', (req, res) => res.json(req.session.user ? meOf(req.session.user) : null));
  app.use('/api', (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: 'Please sign in' })));
  const U = (req) => req.session.user;
  const need = (req, section) => { if (!canEdit(U(req), section)) throw bad('Your login cannot change this section', 403); };
  const see = (req, section) => { if (!canSee(U(req), section)) throw bad('Your login cannot open this section', 403); };
  const open = (req, s, section) => { need(req, section); if (s.state !== 'open' && U(req).role !== 'admin') throw bad('This settlement is ' + s.state + ' and locked', 403); };
  const touch = (id) => db.prepare('UPDATE settlements SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);

  app.post('/api/me/password', wrap((req) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(U(req).id);
    if (!bcrypt.compareSync(String(req.body.old || ''), u.pass_hash)) throw bad('Current password is wrong', 401);
    if (String(req.body.new || '').length < 3) throw bad('New password must be at least 3 characters');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(String(req.body.new), 10), u.id); audit(U(req).username, null, 'password changed', ''); return { ok: true };
  }));

  // ---------- employees and the resigner list
  const brief = (e) => ({ emp_id: e.emp_id, name: e.name, designation: desigTitle(e.designation_code), designation_code: e.designation_code, group_name: e.group_name, station: e.station, company: e.company, payroll_status: e.payroll_status, last_working_date: e.last_working_date, source: e.source });
  app.get('/api/dashboard', wrap(() => {
    // a resigner whose settlement has not been started is waiting for HR and for Marketing as well
    const c = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN s.id IS NULL THEN 1 ELSE 0 END) new_n, SUM(CASE WHEN s.id IS NULL OR (s.state='open' AND s.hr_done=0) THEN 1 ELSE 0 END) hr_n,
        SUM(CASE WHEN s.id IS NULL OR (s.state='open' AND s.mkt_done=0) THEN 1 ELSE 0 END) mk_n, SUM(CASE WHEN s.state='open' AND s.hr_done=1 AND s.mkt_done=1 THEN 1 ELSE 0 END) fin_n,
        SUM(CASE WHEN s.state='approved' THEN 1 ELSE 0 END) appr FROM employees e LEFT JOIN settlements s ON s.emp_id=e.emp_id AND s.state!='cancelled' WHERE e.payroll_status='resigned'`).get();
    return { resigners: c.total, not_started: c.new_n || 0, hr_waiting: c.hr_n || 0, marketing_waiting: c.mk_n || 0, finance_waiting: c.fin_n || 0, approved: c.appr || 0,
      payroll_synced_at: getSetting('payroll_synced_at', ''), slip_months: db.prepare('SELECT DISTINCT month FROM payroll_files ORDER BY month DESC LIMIT 4').all().map((x) => x.month) };
  }));
  // queue for HR / Marketing / Finance: resigners with the state of their settlement
  app.get('/api/queue', wrap((req) => {
    const q = txt(req.query.q, 60), f = txt(req.query.filter, 20);
    const rows = db.prepare(`SELECT e.*, s.id sid, s.state, s.hr_done, s.mkt_done, s.resign_date, s.lwd, s.sep_rule FROM employees e LEFT JOIN settlements s ON s.emp_id=e.emp_id AND s.state!='cancelled'
      WHERE e.payroll_status='resigned' AND (?='' OR e.emp_id LIKE ? OR e.name LIKE ?) ORDER BY e.last_working_date DESC, CAST(e.emp_id AS INTEGER) DESC LIMIT 400`).all(q, `${q}%`, `%${q}%`);
    const out = rows.map((r) => ({ ...brief(r), settlement_id: r.sid, state: r.state || 'new', hr_done: r.hr_done || 0, mkt_done: r.mkt_done || 0, resign_date: r.resign_date, lwd: r.lwd, sep_rule: r.sep_rule }));
    return out.filter((r) => !f || (f === 'new' && r.state === 'new') || (f === 'hr' && (r.state === 'new' || (r.state === 'open' && !r.hr_done))) || (f === 'marketing' && (r.state === 'new' || (r.state === 'open' && !r.mkt_done))) || (f === 'finance' && r.state === 'open' && r.hr_done && r.mkt_done) || (f === 'approved' && r.state === 'approved'));
  }));
  app.get('/api/employees/search', wrap((req) => {
    const q = txt(req.query.q, 60); if (!q) return [];
    return db.prepare("SELECT * FROM employees WHERE emp_id LIKE ? OR name LIKE ? ORDER BY (payroll_status='resigned') DESC, name LIMIT 25").all(`${q}%`, `%${q}%`).map(brief);
  }));
  const upsertEmployee = (e, source) => db.prepare(`INSERT INTO employees(emp_id,name,designation_code,group_name,station,doj,company,cnic,gross,employment_status,payroll_status,last_working_date,source,synced_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(emp_id) DO UPDATE SET name=excluded.name,designation_code=excluded.designation_code,group_name=excluded.group_name,station=excluded.station,doj=excluded.doj,
    company=excluded.company,cnic=excluded.cnic,gross=excluded.gross,employment_status=excluded.employment_status,payroll_status=excluded.payroll_status,last_working_date=excluded.last_working_date,source=excluded.source,synced_at=CURRENT_TIMESTAMP`)
    .run(e.emp_id, e.name, e.designation_code, e.group_name, e.station, e.doj, e.company, e.cnic, e.gross, e.employment_status, e.payroll_status, e.last_working_date, source);
  // pull the resigners from the four payrolls (Marketing, Healthcare, Admin, Factory); a payroll that cannot be read is reported, the others still load
  const sourceFile = (src) => getSetting(src.setting);
  app.post('/api/employees/sync', wrap((req) => {
    if (!['admin', 'hr', 'finance'].includes(U(req).role)) throw bad('Your login cannot pull resigners', 403);
    const want = Array.isArray(req.body && req.body.sources) && req.body.sources.length ? req.body.sources : payrollDb.SOURCES.map((x) => x.key);
    const per = {}; let total = 0, added = 0, updated = 0, okCount = 0, firstErr = null;
    for (const src of payrollDb.SOURCES.filter((x) => want.includes(x.key))) {
      try {
        const list = payrollDb.resigners(sourceFile(src), src.key); let a = 0, u = 0;
        tx(() => { for (const e of list) { const had = getEmp(e.emp_id); upsertEmployee(e, src.source); had ? u++ : a++; } });
        per[src.key] = { label: src.label, total: list.length, added: a, updated: u }; total += list.length; added += a; updated += u; okCount++;
      } catch (e) { per[src.key] = { label: src.label, error: e.message }; firstErr = firstErr || e; }
    }
    if (!okCount) throw firstErr || bad('No payroll selected');
    setSetting('payroll_synced_at', new Date().toISOString().slice(0, 19).replace('T', ' ')); audit(U(req).username, null, 'resigners pulled from the payrolls', { added, updated, total, sources: per });
    return { ok: true, total, added, updated, sources: per };
  }));
  // add a resigner by hand (somebody who is not in the Marketing payroll list)
  app.post('/api/employees/manual', wrap((req) => {
    if (!['admin', 'hr', 'marketing', 'finance'].includes(U(req).role)) throw bad('Your login cannot add a resigner', 403);
    const b = req.body, id = txt(b.emp_id, 20);
    if (!/^\d{1,9}$/.test(id)) throw bad('Employee ID must be a number');
    if (!txt(b.name, 120)) throw bad('Name is required');
    const ex = getEmp(id); if (ex) throw bad(`Employee ${id} already exists (${ex.name}). Search for the ID and open it instead.`, 409);
    for (const k of ['doj', 'last_working_date']) if (b[k] && !isDate(b[k])) throw bad(`${k === 'doj' ? 'Joining date' : 'Last working date'} must be a date`);
    const es = ['Confirmed', 'Unconfirmed', ''].includes(b.employment_status) ? b.employment_status : '';
    db.prepare("INSERT INTO employees(emp_id,name,designation_code,group_name,station,doj,company,cnic,gross,employment_status,payroll_status,last_working_date,source) VALUES(?,?,?,?,?,?,?,?,?,?,'resigned',?,'manual')")
      .run(id, txt(b.name, 120), txt(b.designation_code, 40), txt(b.group_name, 60), txt(b.station, 80), b.doj || null, txt(b.company, 120), txt(b.cnic, 20), nn(b.gross, { label: 'Gross salary' }), es, b.last_working_date || null);
    audit(U(req).username, id, 'resigner added by hand', `${txt(b.name, 120)}`); return { ok: true, emp_id: id };
  }));
  // add many resigners at once from an Excel (.xlsx) or CSV file
  const BULK = [['emp_id', 'Employee ID', /^(new )?(emp(loyee)? ?(id|code)|id)$/], ['name', 'Name', /^(employee )?name$/], ['designation_code', 'Designation', /^desig/], ['group_name', 'Group', /^(group|grp|department)$/], ['station', 'Station', /^station$/],
    ['doj', 'Date of joining', /(join|^doj)/], ['last_working_date', 'Last working date', /(last working|^lwd|last day)/], ['gross', 'Gross salary', /^gross/], ['employment_status', 'Job status', /(job|employ).*status|^status$/], ['cnic', 'CNIC', /^cnic/], ['company', 'Company', /^company$/]];
  const normH = (v) => String(v == null ? '' : (typeof v === 'object' && v !== null && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : '')) : v)).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const bulkDate = (v) => {
    if (v == null || v === '') return null; if (typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    v = String(v).trim(); let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(v); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})$/.exec(v); if (m) { const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()); if (mo >= 0) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    return undefined;
  };
  const csvRows = (text) => { const rows = []; let row = [], cur = '', q = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; } if (cur || row.length) { row.push(cur); rows.push(row); } return rows; };
  async function readBulk(name, buf) {
    if (/\.csv$/i.test(name)) return csvRows(buf.toString('utf8').replace(/^\uFEFF/, ''));
    const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.worksheets[0]; if (!ws) throw bad('The file has no sheet'); const rows = []; ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1))); return rows;
  }
  app.get('/api/employees/bulk-template', wrap(async (req, res) => {
    const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Resigners');
    ws.addRow(BULK.map((c) => c[1])); ws.getRow(1).font = { bold: true }; ws.columns = BULK.map((c) => ({ width: Math.max(16, c[1].length + 4) }));
    ws.addRow(['99001', 'Example Name', 'TM', 'Group A', 'Lahore', '2024-03-01', '2026-10-31', 85000, 'Confirmed', '35202-1234567-1', 'Acme Pharmaceuticals Pvt Limited']);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename="resigners-template.xlsx"');
    await wb.xlsx.write(res); res.end();
  }, true));
  app.post('/api/employees/bulk', wrap(async (req) => {
    if (!['admin', 'hr', 'marketing', 'finance'].includes(U(req).role)) throw bad('Your login cannot add resigners', 403);
    const b = req.body || {}, name = txt(b.name, 200); if (!/\.(xlsx|csv)$/i.test(name)) throw bad('Choose an Excel (.xlsx) or CSV file'); if (!b.data) throw bad('The file is empty');
    const rows = await readBulk(name, Buffer.from(String(b.data), 'base64'));
    let h = -1, col = {};
    for (let r = 0; r < Math.min(rows.length, 15) && h < 0; r++) { const c = {}; rows[r].forEach((v, i) => { const t = normH(v); for (const [k, , re] of BULK) if (!(k in c) && t && re.test(t)) { c[k] = i; break; } }); if ('emp_id' in c && 'name' in c) { h = r; col = c; } }
    if (h < 0) throw bad('No header row with "Employee ID" and "Name" was found. Download the template and use its columns.');
    const added = [], updated = [], skipped = [], seen = new Set();
    // a cell can be a number, a date, a formula {result}, a rich text or a hyperlink: always read it as plain text
    const cellText = (c) => {
      if (c == null) return ''; if (c instanceof Date) return Number.isNaN(c.getTime()) ? '' : c.toISOString().slice(0, 10);
      if (typeof c === 'object') return cellText(c.result !== undefined ? c.result : c.richText ? c.richText.map((t) => t.text).join('') : c.text !== undefined ? c.text : c.hyperlink ? c.hyperlink : '');
      return String(c).replace(/\s+/g, ' ').trim();
    };
    const cnicText = (c) => { const t = cellText(c).replace(/\.0+$/, ''); return /^\d{13}$/.test(t) ? `${t.slice(0, 5)}-${t.slice(5, 12)}-${t.slice(12)}` : t; };
    tx(() => {
      for (let r = h + 1; r < rows.length; r++) {
        const v = rows[r], g = (k) => (k in col ? v[col[k]] : undefined), T = (k) => cellText(g(k)), line = r + 1;
        const raw = T('emp_id').replace(/\.0+$/, '');
        if (!raw && !T('name')) continue;
        const sk = (reason) => skipped.push({ row: line, emp_id: raw, name: T('name'), reason });
        if (!/^\d{1,9}$/.test(raw)) { sk('Employee ID must be a number'); continue; }
        const nm = T('name'); if (!nm) { sk('Name is missing'); continue; }
        if (seen.has(raw)) { sk('The ID appears twice in the file'); continue; } seen.add(raw);
        const doj = bulkDate(g('doj')), lwd = bulkDate(g('last_working_date')); if (doj === undefined) { sk('Joining date is not a date'); continue; } if (lwd === undefined) { sk('Last working date is not a date'); continue; }
        const gt = T('gross').replace(/,/g, ''), gr = gt === '' ? 0 : Number(gt); if (!Number.isFinite(gr) || gr < 0) { sk('Gross salary is not a number'); continue; }
        const js = T('employment_status'), es = /^conf/i.test(js) ? 'Confirmed' : /^unconf|probation/i.test(js) ? 'Unconfirmed' : '';
        const vals = { name: nm.slice(0, 120), designation_code: T('designation_code').slice(0, 40), group_name: T('group_name').slice(0, 60), station: T('station').slice(0, 80), company: T('company').slice(0, 120), cnic: cnicText(g('cnic')).slice(0, 20) };
        const ex = getEmp(raw);
        if (ex) {
          // somebody added by hand earlier is corrected by the new file (only the cells that are filled); a payroll employee is left alone
          if (ex.source !== 'manual') { sk(`Already exists in the payroll (${ex.name})`); continue; }
          const set = [], args = [];
          for (const [k, val] of Object.entries(vals)) if (val) { set.push(`${k}=?`); args.push(val); }
          if (doj) { set.push('doj=?'); args.push(doj); } if (lwd) { set.push('last_working_date=?'); args.push(lwd); } if (gr) { set.push('gross=?'); args.push(gr); } if (es) { set.push('employment_status=?'); args.push(es); }
          if (set.length) db.prepare(`UPDATE employees SET ${set.join(',')} WHERE emp_id=?`).run(...args, raw);
          updated.push(raw); continue;
        }
        db.prepare("INSERT INTO employees(emp_id,name,designation_code,group_name,station,doj,company,cnic,gross,employment_status,payroll_status,last_working_date,source) VALUES(?,?,?,?,?,?,?,?,?,?,'resigned',?,'manual')")
          .run(raw, vals.name, vals.designation_code, vals.group_name, vals.station, doj, vals.company, vals.cnic, gr, es, lwd);
        added.push(raw);
      }
    });
    audit(U(req).username, null, 'resigners added from a file', `${name}: ${added.length} added, ${updated.length} updated, ${skipped.length} skipped`);
    return { ok: true, added: added.length, updated: updated.length, skipped, file: name };
  }));
  // open any Employee ID: local first, then the Marketing payroll
  app.get('/api/employee/:id', wrap((req) => {
    const id = txt(req.params.id, 20); if (!/^\d{1,9}$/.test(id)) throw bad('Enter a numeric Employee ID');
    let e = getEmp(id), fromPayroll = false;
    if (!e || e.source === 'MD_Final') { for (const src of payrollDb.SOURCES) { try { const p = payrollDb.lookup(sourceFile(src), id, src.key); if (p) { upsertEmployee(p, src.source); e = getEmp(id); fromPayroll = true; break; } } catch { /* this payroll is not reachable: try the next */ } } }
    if (!e) throw bad(`Employee ${id} was not found in the Marketing, Healthcare, Admin or Factory payroll or in Master Data`, 404);
    const s = db.prepare("SELECT id,state,hr_done,mkt_done FROM settlements WHERE emp_id=? AND state!='cancelled' ORDER BY id DESC LIMIT 1").get(id);
    return { employee: brief(e), fromPayroll, settlement: s || null, warning: e.payroll_status && e.payroll_status !== 'resigned' ? `Payroll shows this employee as "${e.payroll_status}", not resigned` : '' };
  }));

  // ---------- the settlement file
  app.post('/api/settlements', wrap((req) => {
    const u = U(req); if (!['admin', 'hr', 'marketing', 'finance'].includes(u.role)) throw bad('Your login cannot start a settlement', 403);
    const id = txt(req.body.emp_id, 20), e = getEmp(id); if (!e) throw bad('Open the employee first', 404);
    const ex = db.prepare("SELECT id FROM settlements WHERE emp_id=? AND state!='cancelled' ORDER BY id DESC LIMIT 1").get(id); if (ex) return { id: ex.id, existed: true };
    const slip = slips.latestSlip(id);
    const sid = db.prepare('INSERT INTO settlements(emp_id,lwd,last_salary_month,created_by) VALUES(?,?,?,?)').run(id, e.last_working_date || null, slip ? slip.month : null, u.username).lastInsertRowid;
    audit(u.username, id, 'settlement started', `last working date from payroll: ${e.last_working_date || '-'}`); return { id: sid, existed: false };
  }));
  app.get('/api/settlements', wrap((req) => {
    const st = txt(req.query.state, 12), q = txt(req.query.q, 60);
    return db.prepare(`SELECT s.id,s.emp_id,s.state,s.hr_done,s.mkt_done,s.resign_date,s.lwd,s.sep_rule,s.approved_at,s.updated_at,e.name,e.group_name FROM settlements s JOIN employees e ON e.emp_id=s.emp_id
      WHERE s.state!='cancelled' AND (?='' OR s.state=?) AND (?='' OR s.emp_id LIKE ? OR e.name LIKE ?) ORDER BY s.updated_at DESC LIMIT 300`).all(st, st, q, `${q}%`, `%${q}%`);
  }));
  // opening a settlement in Finance reads the PF again from the PF database file (offline, instant) so the figure is always current
  app.get('/api/settlements/:id', wrap(async (req) => { const s0 = get(req.params.id); const f = getSetting('pf_db_path'); if (s0.state === 'open' && f && fs.existsSync(f) && req.query.pf !== '0') { try { await pullPf(s0.emp_id); } catch { /* keep the last snapshot */ } } return assemble(req.params.id); }));

  app.get('/api/settlements/:id/months', wrap((req) => {
    const s = get(req.params.id), lwd = txt(req.query.lwd, 10); const emp = getEmp(s.emp_id) || {};
    return monthsMeta({ ...s, lwd: isDate(lwd) ? lwd : s.lwd }, desigTitle(emp.designation_code));
  }));
  // HR window: resignation / termination date, separation rule, absent deduction
  app.put('/api/settlements/:id/hr', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'hr'); const b = req.body;
    const rule = txt(b.sep_rule, 20); if (rule && !db.prepare('SELECT 1 FROM sep_rules WHERE code=?').get(rule)) throw bad('Unknown separation rule');
    if (b.resign_date && !isDate(b.resign_date)) throw bad('Resignation / termination date must be a date');
    const reason = txt(b.termination_reason, 100); if (rule === 'Terminated' && !reason && b.done) throw bad('Give the termination reason');
    if (b.done && (!b.resign_date || !rule)) throw bad('Enter the resignation / termination date and the separation rule first');
    db.prepare('UPDATE settlements SET resign_date=?, date_kind=?, sep_rule=?, absent_days=?, termination_reason=?, hr_done=?, hr_by=?, hr_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(b.resign_date || null, b.date_kind === 'termination' ? 'termination' : 'resignation', rule || null, nn(b.absent_days, { min: -400, max: 400, label: 'Absent days' }), reason || null, b.done ? 1 : 0, U(req).username, s.id);
    audit(U(req).username, s.emp_id, b.done ? 'HR completed' : 'HR saved', { resign_date: b.resign_date, rule, absent: b.absent_days }); return { ok: true };
  }));
  // Marketing window: last working date, imprest balance, three months of travelling expenses
  app.put('/api/settlements/:id/marketing', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'marketing'); const b = req.body;
    if (b.lwd && !isDate(b.lwd)) throw bad('Last working date must be a date');
    const imprest = nn(b.imprest, { min: -1e9, label: 'Imprest balance' });
    if (b.done && !b.lwd) throw bad('Enter the last working date first');
    tx(() => {
      db.prepare('UPDATE settlements SET lwd=?, imprest=?, imprest_note=?, mkt_done=?, mkt_by=?, mkt_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.lwd || null, imprest, txt(b.imprest_note, 200) || null, b.done ? 1 : 0, U(req).username, s.id);
      const allowed = new Set(expenseMonths({ lwd: b.lwd || s.lwd }));
      db.prepare('DELETE FROM settlement_expenses WHERE settlement_id=?').run(s.id);
      for (const e of Array.isArray(b.expenses) ? b.expenses : []) {
        if (!isMonth(e.month) || !allowed.has(e.month)) continue;
        const c = e.claim || {}, d = e.ded || {}, h = (v) => nn(v, { max: 1e6, label: 'Quantity' });
        if (h(d.km) > h(c.km) || h(d.daily) > h(c.daily) || h(d.ex) > h(c.ex) || h(d.on) > h(c.on)) throw bad(`${monthLabel(e.month)}: a deduction is larger than the claim`);
        // a rate typed for this month is kept only when it differs from the Master Data rate
        const mr = ratesFor(desigTitle((getEmp(s.emp_id) || {}).designation_code))(Number(e.month.slice(0, 4))), rv = (k, mk) => { const v = (e.rates || {})[k]; if (v === '' || v == null) return null; const x = nn(v, { max: 1e6, label: 'Rate' }); return mr && Number(mr[mk]) === x ? null : x; };
        db.prepare('INSERT INTO settlement_expenses(settlement_id,month,claim_km,claim_daily,claim_ex,claim_on,ded_km,ded_daily,ded_ex,ded_on,rate_km,rate_daily,rate_ex,rate_on,remarks) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(s.id, e.month, h(c.km), h(c.daily), h(c.ex), h(c.on), h(d.km), h(d.daily), h(d.ex), h(d.on), rv('km', 'fare'), rv('daily', 'daily'), rv('ex', 'ex'), rv('on', 'ovn'), txt(e.remarks, 200) || null);
      }
    });
    audit(U(req).username, s.emp_id, b.done ? 'Marketing completed' : 'Marketing saved', { lwd: b.lwd, imprest }); return { ok: true };
  }));
  // Finance window: everything else on the sheet
  // ---------- Report window: live reports over the settlements
  const reportItems = (o) => {
    const states = o.state === 'open' ? ['open'] : o.state === 'approved' ? ['approved'] : o.state === 'cancelled' ? ['cancelled'] : o.state === 'all' ? ['open', 'approved', 'cancelled'] : ['open', 'approved'];
    const list = db.prepare(`SELECT id FROM settlements WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`).all(...states), out = [];
    const q = String(o.q || '').toLowerCase(), bank = getSetting('main_bank_name'), pfBankName = getSetting('pf_bank_name'), get = (k) => getSetting(k, '');
    for (const { id } of list) {
      const s = db.prepare('SELECT * FROM settlements WHERE id=?').get(id), emp = getEmp(s.emp_id); if (!emp) continue;
      const src = sourceKey(emp); if (o.source && o.source !== src) continue;
      if (q && !(String(s.emp_id).includes(q) || String(emp.name || '').toLowerCase().includes(q))) continue;
      const day = String(s.approved_at || s.updated_at || '').slice(0, 10); if ((o.from && day < o.from) || (o.to && day > o.to)) continue;
      let st, posting; const snap = s.state === 'approved' && s.snapshot ? (() => { try { return JSON.parse(s.snapshot); } catch { return null; } })() : null;
      if (snap && snap.statement) { st = snap.statement; posting = buildPosting({ st, emp, settlement: s, get }); } else { const a = assemble(id); st = a.statement; posting = a.posting; }
      out.push({ s, emp: { ...emp, designation: desigTitle(emp.designation_code) }, st, posting, src, bank, pfBankName });
    }
    return out;
  };
  const statusRows = (o) => {
    const q = String(o.q || '').toLowerCase();
    return db.prepare("SELECT e.*, s.state, s.hr_done, s.mkt_done FROM employees e LEFT JOIN settlements s ON s.emp_id=e.emp_id AND s.state!='cancelled' WHERE e.payroll_status='resigned' ORDER BY CAST(e.emp_id AS INTEGER)").all()
      .filter((e) => (!o.source || o.source === sourceKey(e)) && (!q || String(e.emp_id).includes(q) || String(e.name || '').toLowerCase().includes(q)))
      .map((e) => ({ emp_id: e.emp_id, name: e.name, designation: desigTitle(e.designation_code), payroll: reportsLib.SRC[sourceKey(e)], lwd: e.last_working_date,
        stage: !e.state ? 'Not started' : e.state === 'approved' ? 'Approved' : !e.hr_done ? 'Waiting for HR' : !e.mkt_done ? 'Waiting for Marketing' : 'Ready for Finance' }))
      .filter((r) => !o.stage || r.stage === o.stage);
  };
  app.get('/api/reports', wrap((req) => { if (!canSee(U(req), 'report')) throw bad('Your login cannot open the reports', 403); return reportsLib.REPORTS; }));
  app.get('/api/reports/:key', wrap(async (req, res) => {
    if (!canSee(U(req), 'report')) throw bad('Your login cannot open the reports', 403);
    const key = req.params.key, meta = reportsLib.REPORTS.find((r) => r.key === key); if (!meta) throw bad('Unknown report', 404);
    const o = { state: txt(req.query.state, 12), source: txt(req.query.source, 12), q: txt(req.query.q, 60), from: txt(req.query.from, 10), to: txt(req.query.to, 10), cheque: txt(req.query.cheque, 10), stage: txt(req.query.stage, 30) };
    let out;
    if (key === 'status') {
      const rows = statusRows(o), columns = [{ k: 'emp_id', label: 'ID', type: 'text' }, { k: 'name', label: 'Name', type: 'text' }, { k: 'designation', label: 'Designation', type: 'text' }, { k: 'payroll', label: 'Payroll', type: 'text' }, { k: 'lwd', label: 'Last working day', type: 'date' }, { k: 'stage', label: 'Stage', type: 'text' }];
      out = { columns, rows, totals: {}, count: rows.length };
    } else out = reportsLib.build(key, reportItems(o), o);
    out = { ...out, key, title: meta.title, note: meta.note, generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
    if (req.query.format === 'xlsx') {
      const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(meta.title.slice(0, 30));
      ws.addRow([meta.title]).font = { bold: true, size: 13 }; ws.addRow([`Generated ${out.generatedAt}`]); ws.addRow([]);
      ws.addRow(out.columns.map((c) => c.label)).font = { bold: true };
      for (const r of out.rows) ws.addRow(out.columns.map((c) => (r[c.k] === '' || r[c.k] == null ? null : r[c.k])));
      if (Object.keys(out.totals).length) ws.addRow(out.columns.map((c, i) => (i === 0 ? 'Total' : c.type === 'num' ? out.totals[c.k] : null))).font = { bold: true };
      out.columns.forEach((c, i) => { const w = ws.getColumn(i + 1); w.width = c.type === 'num' ? 16 : c.k === 'narration' ? 60 : Math.max(14, c.label.length + 4); if (c.type === 'num') w.numFmt = '#,##0'; });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="report-${key}.xlsx"`);
      await wb.xlsx.write(res); return res.end();
    }
    return out;
  }));
  // posting (accounting voucher) of the settlement: the cheque number and the imprest ledger code that go into the narration / lines
  // edit any figure of the letter (kept apart from the calculation; totals follow the edited lines)
  app.put('/api/settlements/:id/letter-edits', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const b = req.body || {}, src = b.edits && typeof b.edits === 'object' ? b.edits : {}, clean = {};
    for (const [k, v] of Object.entries(src)) { if (!letterEdits.isKey(k)) throw bad('Unknown figure: ' + k); if (v === null || v === '') continue; const x = Number(v); if (!Number.isFinite(x) || Math.abs(x) > 1e10) throw bad('Figure ' + k + ' must be a number'); clean[k] = Math.round(x); }
    const calcFields = Object.fromEntries(letterEdits.fields(assemble(s.id).statementCalc).map((f) => [f.key, f.calc]));
    db.prepare('UPDATE settlements SET letter_edits=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Object.keys(clean).length ? JSON.stringify(clean) : null, s.id);
    audit(U(req).username, s.emp_id, Object.keys(clean).length ? 'letter figures edited' : 'letter figures reset', Object.entries(clean).map(([k, v]) => `${k}: ${calcFields[k] ?? '-'} -> ${v}`).join('; ').slice(0, 450) + (b.note ? ` | ${txt(b.note, 150)}` : ''));
    return { ok: true, edited: Object.keys(clean).length };
  }));
  app.put('/api/settlements/:id/posting', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const b = req.body || {};
    db.prepare('UPDATE settlements SET cheque_main=?, cheque_pf=?, vem_code=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(txt(b.cheque_main, 40) || null, txt(b.cheque_pf, 40) || null, txt(b.vem_code, 40) || null, s.id);
    audit(U(req).username, s.emp_id, 'posting details saved', { cheque: txt(b.cheque_main, 40), pfCheque: txt(b.cheque_pf, 40), vem: txt(b.vem_code, 40) }); return { ok: true };
  }));
  app.get('/api/settlements/:id/posting.xlsx', wrap(async (req, res) => {
    const a = assemble(req.params.id), p = a.posting, ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Posting');
    ws.columns = [{ width: 14 }, { width: 38 }, { width: 14 }, { width: 14 }, { width: 62 }];
    ws.addRow([`Final settlement posting - ${a.employee.name} (${a.employee.emp_id})`]).font = { bold: true }; ws.addRow([]);
    const h = ws.addRow(['Code', 'Account', 'Debit', 'Credit', 'Narration']); h.font = { bold: true };
    for (const l of p.lines) ws.addRow([l.code, l.account, l.debit || null, l.credit || null, l.narration]);
    const t = ws.addRow(['', 'Total', p.totalDr, p.totalCr, '']); t.font = { bold: true };
    ['C', 'D'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0'; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="posting-${a.employee.emp_id}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  }));
  app.put('/api/settlements/:id/finance', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const b = req.body;
    const ov = (v, label) => (v === '' || v == null ? null : nn(v, { label }));
    if (b.last_salary_month && !isMonth(b.last_salary_month)) throw bad('Last salary month must be YYYY-MM');
    if (b.job_status && !['Confirmed', 'Unconfirmed'].includes(b.job_status)) throw bad('Job status must be Confirmed or Unconfirmed');
    db.prepare('UPDATE settlements SET job_status=?, gross_override=?, notice_base_override=?, vehicle_inst=?, last_salary_month=?, cheque_pf=?, cheque_main=?, finance_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(b.job_status || null, ov(b.gross_override, 'Gross'), ov(b.notice_base_override, 'Notice base'), nn(b.vehicle_inst, { label: 'Vehicle instalments' }), b.last_salary_month || null, txt(b.cheque_pf, 40) || null, txt(b.cheque_main, 40) || null, txt(b.finance_note, 500) || null, s.id);
    audit(U(req).username, s.emp_id, 'Finance saved', Object.keys(b)); return { ok: true };
  }));
  // manual deductions / reimbursements
  app.post('/api/settlements/:id/items', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const b = req.body;
    if (!['deduction', 'reimbursement'].includes(b.kind)) throw bad('Kind must be deduction or reimbursement'); if (!txt(b.label)) throw bad('Describe the amount');
    const id = db.prepare('INSERT INTO settlement_items(settlement_id,kind,code,label,amount,note) VALUES(?,?,?,?,?,?)').run(s.id, b.kind, txt(b.code, 20) || 'other', txt(b.label, 150), nn(b.amount, { label: 'Amount' }), txt(b.note, 200) || null).lastInsertRowid;
    audit(U(req).username, s.emp_id, 'adjustment added', `${b.kind} ${b.label} ${b.amount}`); return { ok: true, id };
  }));
  app.put('/api/items/:iid', wrap((req) => {
    const it = db.prepare('SELECT * FROM settlement_items WHERE id=?').get(Number(req.params.iid)); if (!it) throw bad('Not found', 404);
    const s = get(it.settlement_id); open(req, s, 'finance'); const b = req.body;
    if ('waived' in b && b.waived && !txt(b.waive_reason)) throw bad('Give a reason for waiving');
    db.prepare('UPDATE settlement_items SET label=?, amount=?, note=?, waived=?, waive_reason=? WHERE id=?').run(txt(b.label ?? it.label, 150), 'amount' in b ? nn(b.amount, { label: 'Amount' }) : it.amount, txt(b.note ?? it.note, 200) || null, 'waived' in b ? (b.waived ? 1 : 0) : it.waived, 'waived' in b ? txt(b.waive_reason, 200) || null : it.waive_reason, it.id);
    audit(U(req).username, s.emp_id, 'waived' in b ? (b.waived ? 'adjustment waived' : 'adjustment restored') : 'adjustment changed', it.label); return { ok: true };
  }));
  app.delete('/api/items/:iid', wrap((req) => {
    const it = db.prepare('SELECT * FROM settlement_items WHERE id=?').get(Number(req.params.iid)); if (!it) throw bad('Not found', 404);
    const s = get(it.settlement_id); open(req, s, 'finance'); db.prepare('DELETE FROM settlement_items WHERE id=?').run(it.id); audit(U(req).username, s.emp_id, 'adjustment deleted', it.label); return { ok: true };
  }));
  // an audit observation can be waived for one month (stored as an item with code audit:YYYY-MM)
  app.post('/api/settlements/:id/audit-waive', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const m = txt(req.body.month, 7); if (!isMonth(m)) throw bad('Bad month');
    const code = 'audit:' + m, ex = db.prepare('SELECT id FROM settlement_items WHERE settlement_id=? AND code=?').get(s.id, code);
    if (req.body.waived) { if (!txt(req.body.reason)) throw bad('Give a reason for waiving'); if (ex) db.prepare('UPDATE settlement_items SET waived=1, waive_reason=? WHERE id=?').run(txt(req.body.reason, 200), ex.id); else db.prepare("INSERT INTO settlement_items(settlement_id,kind,code,label,amount,waived,waive_reason) VALUES(?,'deduction',?,?,0,1,?)").run(s.id, code, 'Audit observation ' + m, txt(req.body.reason, 200)); }
    else if (ex) db.prepare('DELETE FROM settlement_items WHERE id=?').run(ex.id);
    audit(U(req).username, s.emp_id, req.body.waived ? 'audit observation waived' : 'audit observation restored', m); return { ok: true };
  }));
  app.put('/api/settlements/:id/checks', wrap((req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const items = req.body.all ? ['id', 'resign', 'rule', 'lastsalary', 'expenses', 'gross', 'pf', 'imprest', 'netpay', 'letter'] : [txt(req.body.item, 20)];
    for (const it of items) { if (!it) continue; if (req.body.ok === false) db.prepare('DELETE FROM settlement_checks WHERE settlement_id=? AND item=?').run(s.id, it); else db.prepare('INSERT INTO settlement_checks(settlement_id,item,ok,by_user,at) VALUES(?,?,1,?,CURRENT_TIMESTAMP) ON CONFLICT(settlement_id,item) DO UPDATE SET ok=1,by_user=excluded.by_user,at=excluded.at').run(s.id, it, U(req).username); }
    return { ok: true };
  }));
  // PF: first from the PF database file (works while the PF application is closed), otherwise from the PF portal
  async function pullPf(empId) {
    const out = {}, file = getSetting('pf_db_path'), useDb = file && fs.existsSync(file);
    try {
      const r = useDb ? pf.fetchFromDb(file, empId) : await pf.fetchEmployee({ url: getSetting('pf_url'), user: getSetting('pf_user'), pass: getSetting('pf_pass') }, empId);
      const where = useDb ? 'the PF database' : 'the PF portal';
      if (!r.found) { db.prepare('INSERT INTO pf_snapshots(emp_id,ok,error) VALUES(?,0,?)').run(empId, 'This employee is not in ' + where); out.pf = 'not found in ' + where; out.pfError = true; }
      else {
        const sum = JSON.stringify(r), last = db.prepare('SELECT id, ok, summary FROM pf_snapshots WHERE emp_id=? ORDER BY id DESC LIMIT 1').get(empId);
        if (last && last.ok && last.summary === sum) db.prepare('UPDATE pf_snapshots SET fetched_at=CURRENT_TIMESTAMP WHERE id=?').run(last.id);
        else db.prepare('INSERT INTO pf_snapshots(emp_id,ok,summary,contributions,withdrawals) VALUES(?,1,?,?,?)').run(empId, sum, JSON.stringify(r.monthly), JSON.stringify(r.withdrawals));
        out.pf = `balance ${r.balance}`;
      }
    } catch (e) { db.prepare('INSERT INTO pf_snapshots(emp_id,ok,error) VALUES(?,0,?)').run(empId, e.message); out.pf = e.message; out.pfError = true; }
    return out;
  }
  // re-read the PF (and re-pick the salary slip)
  app.post('/api/settlements/:id/refresh', wrap(async (req) => {
    const s = get(req.params.id); open(req, s, 'finance'); const out = {};
    if (req.body.pf !== false) Object.assign(out, await pullPf(s.emp_id));
    const slip = slips.latestSlip(s.emp_id); out.slip = slip ? `${slip.month} (${slip.file})` : 'no salary slip found for this ID';
    if (slip && !s.last_salary_month) db.prepare('UPDATE settlements SET last_salary_month=? WHERE id=?').run(slip.month, s.id);
    audit(U(req).username, s.emp_id, 'sources refreshed', out); return { ok: true, ...out };
  }));
  app.post('/api/settlements/:id/approve', wrap((req) => {
    const s = get(req.params.id); need(req, 'finance'); if (s.state !== 'open') throw bad('Already ' + s.state);
    if (!s.hr_done) throw bad('HR has not completed this settlement'); if (!s.mkt_done) throw bad('Marketing has not completed this settlement');
    const a = assemble(s.id), st = a.statement;
    if (st.notes.length) throw bad('Fix these first: ' + st.notes.join('; '));
    if (st.checks.some((c) => c.status === 'error')) throw bad('There are errors in the checks: ' + st.checks.filter((c) => c.status === 'error').map((c) => c.text).join('; '));
    db.prepare("UPDATE settlements SET state='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, snapshot=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(U(req).username, JSON.stringify({ statement: st, employee: a.employee, inputs: a.inputs, slip: a.slip && { month: a.slip.month, file: a.slip.file }, pfFetchedAt: a.pfFetchedAt }), s.id);
    audit(U(req).username, s.emp_id, 'approved', { net: st.net }); return { ok: true, net: st.net };
  }));
  app.post('/api/settlements/:id/reopen', wrap((req) => {
    const s = get(req.params.id); if (U(req).role !== 'admin') throw bad('Only the administrator can reopen an approved settlement', 403);
    db.prepare("UPDATE settlements SET state='open', approved_by=NULL, approved_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(s.id); audit(U(req).username, s.emp_id, 'reopened', txt(req.body.reason, 200)); return { ok: true };
  }));
  app.post('/api/settlements/:id/cancel', wrap((req) => {
    const s = get(req.params.id); if (!['admin', 'finance'].includes(U(req).role)) throw bad('Only Finance can cancel a settlement', 403); if (!txt(req.body.reason)) throw bad('Give the reason');
    db.prepare("UPDATE settlements SET state='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(s.id); audit(U(req).username, s.emp_id, 'cancelled', txt(req.body.reason, 200)); return { ok: true };
  }));

  // ---------- Master Data
  app.get('/api/master/employees', wrap((req) => {
    see(req, 'master'); const q = txt(req.query.q, 60);
    return db.prepare('SELECT * FROM employees WHERE (?=\'\' OR emp_id LIKE ? OR name LIKE ?) ORDER BY (payroll_status=\'resigned\') DESC, CAST(emp_id AS INTEGER) LIMIT 200').all(q, `${q}%`, `%${q}%`).map((e) => ({ ...e, designation: desigTitle(e.designation_code) }));
  }));
  app.put('/api/master/employees/:id', wrap((req) => {
    need(req, 'master'); const e = getEmp(req.params.id); if (!e) throw bad('Not found', 404); const b = req.body;
    db.prepare('UPDATE employees SET name=?, designation_code=?, group_name=?, station=?, doj=?, gross=?, employment_status=? WHERE emp_id=?').run(txt(b.name ?? e.name, 120), txt(b.designation_code ?? e.designation_code, 40), txt(b.group_name ?? e.group_name, 60), txt(b.station ?? e.station, 80), isDate(b.doj) ? b.doj : e.doj, 'gross' in b ? nn(b.gross, { label: 'Gross' }) : e.gross, ['Confirmed', 'Unconfirmed', ''].includes(b.employment_status) ? b.employment_status : e.employment_status, e.emp_id);
    audit(U(req).username, e.emp_id, 'employee edited', Object.keys(b)); return { ok: true };
  }));
  app.post('/api/master/employees', wrap((req) => {
    need(req, 'master'); const b = req.body, id = txt(b.emp_id, 20); if (!/^\d{1,9}$/.test(id)) throw bad('Employee ID must be a number'); if (getEmp(id)) throw bad('That Employee ID exists', 409); if (!txt(b.name)) throw bad('Name is required');
    db.prepare("INSERT INTO employees(emp_id,name,designation_code,group_name,station,doj,gross,employment_status,payroll_status,source) VALUES(?,?,?,?,?,?,?,?,'resigned','manual')").run(id, txt(b.name, 120), txt(b.designation_code, 40), txt(b.group_name, 60), txt(b.station, 80), isDate(b.doj) ? b.doj : null, nn(b.gross, { label: 'Gross' }), txt(b.employment_status, 20));
    audit(U(req).username, id, 'employee added by hand', b.name); return { ok: true };
  }));
  app.get('/api/master/audit_obs', wrap((req) => { see(req, 'master'); const q = txt(req.query.q, 40); return db.prepare("SELECT * FROM audit_obs WHERE (?='' OR emp_id=? OR name LIKE ?) ORDER BY month DESC, emp_id LIMIT 300").all(q, q, `%${q}%`); }));
  app.get('/api/master/:table', wrap((req) => { const m = MASTER[req.params.table]; if (!m) throw bad('Unknown table', 404); see(req, 'master'); return db.prepare(`SELECT * FROM ${req.params.table} ORDER BY ${m.order}`).all(); }));
  const rowOf = (m, b) => Object.fromEntries(Object.entries(m.cols).map(([k, t]) => [k, cleanCol(t, b[k], k)]));
  app.post('/api/master/:table', wrap((req) => {
    const m = MASTER[req.params.table]; if (!m) throw bad('Unknown table', 404); need(req, 'master'); const r = rowOf(m, req.body), ks = Object.keys(r);
    try { db.prepare(`INSERT INTO ${req.params.table}(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`).run(...ks.map((k) => r[k])); } catch (e) { if (/UNIQUE|PRIMARY/.test(e.message)) throw bad('That entry already exists', 409); throw e; }
    audit(U(req).username, null, 'master data added', req.params.table + ' ' + JSON.stringify(r).slice(0, 150)); return { ok: true };
  }));
  app.put('/api/master/:table/:key', wrap((req) => {
    const m = MASTER[req.params.table]; if (!m) throw bad('Unknown table', 404); need(req, 'master'); const r = rowOf(m, req.body), ks = Object.keys(r);
    db.prepare(`UPDATE ${req.params.table} SET ${ks.map((k) => k + '=?').join(',')} WHERE ${m.key}=?`).run(...ks.map((k) => r[k]), req.params.key);
    audit(U(req).username, null, 'master data changed', req.params.table + ' ' + req.params.key); return { ok: true };
  }));
  // an audit observation can be deleted (a wrong or duplicated entry); the history of the employee keeps a note
  app.delete('/api/master/audit_obs/:id', wrap((req) => {
    need(req, 'master'); const r = db.prepare('SELECT * FROM audit_obs WHERE id=?').get(Number(req.params.id)); if (!r) throw bad('This audit observation does not exist', 404);
    db.prepare('DELETE FROM audit_obs WHERE id=?').run(r.id); audit(U(req).username, r.emp_id, 'audit observation deleted', `${r.month} Rs ${Math.round(r.total)}`); return { ok: true };
  }));
  app.delete('/api/master/:table/:key', wrap((req) => {
    const m = MASTER[req.params.table]; if (!m) throw bad('Unknown table', 404); need(req, 'master');
    db.prepare(`DELETE FROM ${req.params.table} WHERE ${m.key}=?`).run(req.params.key); audit(U(req).username, null, 'master data deleted', req.params.table + ' ' + req.params.key); return { ok: true };
  }));
  app.post('/api/master-import', wrap(async (req) => {
    need(req, 'master'); let file = txt(req.body.path, 400), tmp = null;
    if (req.body.data) { tmp = path.join(DATA_DIR, 'upload-template.xlsx'); fs.writeFileSync(tmp, Buffer.from(String(req.body.data), 'base64')); file = tmp; }
    if (!file || !fs.existsSync(file)) throw bad('Choose the Finance template Excel file');
    const rep = await importTemplate(file); if (tmp) try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    audit(U(req).username, null, 'master data imported from Excel', rep); return { ok: true, report: rep };
  }));

  // ---------- Setting (administrator)
  const adminOnly = (req) => { if (U(req).role !== 'admin') throw bad('Only the administrator can open Setting', 403); };
  const SETTING_KEYS = ['post_bank_prefix', 'post_pf_prefix', 'payslip_folder', 'post_fsa_marketing', 'post_fsa_admin', 'post_fsa_factory', 'post_fsa_healthcare', 'post_fsa_name', 'post_bank_code', 'post_bank_name', 'post_pf_code', 'post_pf_name', 'post_rec_code', 'post_rec_name', 'post_sal_code', 'post_sal_name', 'post_imp_name', 'pf_db_path', 'payroll_db_path', 'payroll_db_healthcare', 'payroll_db_admin', 'payroll_db_factory', 'pf_url', 'pf_user', 'slip_folder', 'slip_sheet', 'trade_keyword', 'org_pharma', 'org_trade', 'org_healthcare', 'pf_bank_name', 'main_bank_name', 'sign1_name', 'sign1_title', 'sign2_name', 'sign2_title', 'letter_note', 'days_in_month', 'training_cost', 'training_days', 'expense_months', 'template_path'];
  app.get('/api/settings', wrap((req) => { adminOnly(req); return { ...Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(k)])), pf_pass_set: !!getSetting('pf_pass'), data_dir: DATA_DIR, db_file: DB_FILE }; }));
  app.put('/api/settings', wrap((req) => {
    adminOnly(req); for (const k of SETTING_KEYS) if (k in req.body) setSetting(k, txt(req.body[k], k === 'letter_note' ? 2000 : 400));
    if (req.body.pf_pass) setSetting('pf_pass', txt(req.body.pf_pass, 200)); if (req.body.clear_pf_pass) setSetting('pf_pass', '');
    for (const k of ['days_in_month', 'training_cost', 'training_days', 'expense_months']) if (k in req.body) nn(req.body[k], { min: 0, max: 1e6, label: k });
    audit(U(req).username, null, 'settings changed', Object.keys(req.body).filter((k) => k !== 'pf_pass')); return { ok: true };
  }));
  app.post('/api/settings/test-payroll', wrap((req) => { adminOnly(req); const src = payrollDb.byKey(req.body.source); return payrollDb.test(txt(req.body.path, 400) || getSetting(src.setting), src.key); }));
  // salary slips: from the finished runs of the payroll databases, or from an Excel file chosen by the user
  app.post('/api/settings/sync-slips', wrap((req) => {
    if (!['admin', 'finance'].includes(U(req).role)) throw bad('Your login cannot read the payroll slips', 403);
    const report = []; const want = Array.isArray(req.body && req.body.sources) && req.body.sources.length ? req.body.sources : payrollDb.SOURCES.map((x) => x.key);
    for (const src of payrollDb.SOURCES.filter((x) => want.includes(x.key))) { try { report.push(...slips.importPayrollDb(src.key, sourceFile(src)).map((r) => ({ ...r, source: src.label }))); } catch (e) { report.push({ source: src.label, file: src.label + ' payroll', error: e.message }); } }
    audit(U(req).username, null, 'salary slips read from the payroll databases', report.map((r) => `${r.file}:${r.rows ?? r.error ?? r.skipped}`).join('; ').slice(0, 500)); return { report };
  }));
  // payslip history: the monthly payslip sheets (one block per employee) of the files in the Payslip folder; runs in the background (the files are big)
  app.post('/api/settings/payslip-history/import', wrap((req) => {
    if (!['admin', 'finance'].includes(U(req).role)) throw bad('Your login cannot read the payslip files', 403);
    const folder = txt(req.body.folder, 400) || getSetting('payslip_folder'); if (req.body.folder) setSetting('payslip_folder', folder);
    if (!payslipBlocks.job.running) { payslipBlocks.importFolder(folder, { force: !!req.body.force }).then((j) => audit(U(req).username, null, 'payslip history read', j.error || j.report.map((r) => `${r.file}:${r.slips ?? r.skipped}`).join('; ').slice(0, 400))).catch(() => {}); }
    return payslipBlocks.job;
  }));
  app.get('/api/settings/payslip-history/status', wrap((req) => { if (!['admin', 'finance'].includes(U(req).role)) throw bad('Not allowed', 403); return payslipBlocks.job; }));
  app.post('/api/slips/upload', wrap(async (req) => {
    if (!['admin', 'finance'].includes(U(req).role)) throw bad('Your login cannot upload salary files', 403);
    const b = req.body || {}, name = txt(b.name, 200); if (!/\.xlsx$/i.test(name)) throw bad('Choose an Excel (.xlsx) file'); if (!b.data) throw bad('The file is empty');
    const r = await slips.importUpload(Buffer.from(String(b.data), 'base64'), name, { source: payrollDb.byKey(b.source).key, month: txt(b.month, 7) });
    audit(U(req).username, null, 'salary file uploaded', `${r.file} (${r.company} ${r.month}, ${r.rows} rows)`); return r;
  }));
  app.post('/api/settings/test-pf-db', wrap((req) => { adminOnly(req); return pf.testDb(txt(req.body.path, 400) || getSetting('pf_db_path')); }));
  app.post('/api/settings/test-pf', wrap(async (req) => { adminOnly(req); return pf.test({ url: txt(req.body.url, 200) || getSetting('pf_url'), user: txt(req.body.user, 100) || getSetting('pf_user'), pass: req.body.pass || getSetting('pf_pass') }); }));
  app.post('/api/settings/scan-slips', wrap(async (req) => { adminOnly(req); const rep = await slips.importFolder(txt(req.body.folder, 400) || getSetting('slip_folder')); audit(U(req).username, null, 'salary files scanned', rep.map((r) => `${r.file}:${r.rows ?? r.error ?? r.skipped}`).join('; ').slice(0, 500)); return { report: rep }; }));
  app.get('/api/settings/slip-files', wrap((req) => { adminOnly(req); return db.prepare('SELECT file_name,month,company,rows,imported_at FROM payroll_files ORDER BY month DESC, file_name').all(); }));
  app.post('/api/settings/backup', wrap((req) => { adminOnly(req); const f = backupNow('manual-' + Date.now()); audit(U(req).username, null, 'backup', f); return { ok: true, file: f }; }));
  app.get('/api/settings/backups', wrap((req) => { adminOnly(req); return fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, size: fs.statSync(path.join(DATA_DIR, 'backups', f)).size })); }));
  app.get('/api/users', wrap((req) => { adminOnly(req); return db.prepare('SELECT id,username,full_name,role,active,last_login FROM users ORDER BY username').all(); }));
  app.post('/api/users', wrap((req) => {
    adminOnly(req); const u = txt(req.body.username, 40), p = String(req.body.password || '');
    if (!/^[A-Za-z0-9_.@-]{2,40}$/.test(u)) throw bad('User name: 2-40 letters, digits, . _ - @'); if (p.length < 3) throw bad('Password must be at least 3 characters'); if (!ROLES.includes(req.body.role)) throw bad('Unknown role');
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(u)) throw bad('That user name exists', 409);
    db.prepare('INSERT INTO users(username,pass_hash,full_name,role) VALUES(?,?,?,?)').run(u, bcrypt.hashSync(p, 10), txt(req.body.full_name, 80), req.body.role); audit(U(req).username, null, 'user created', u + ' ' + req.body.role); return { ok: true };
  }));
  app.put('/api/users/:id', wrap((req) => {
    adminOnly(req); const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id)); if (!u) throw bad('Not found', 404);
    const role = req.body.role || u.role; if (!ROLES.includes(role)) throw bad('Unknown role'); const active = 'active' in req.body ? (req.body.active ? 1 : 0) : u.active;
    if (u.id === U(req).id && (!active || role !== 'admin')) throw bad('You cannot remove your own administrator access');
    db.prepare('UPDATE users SET role=?, active=?, full_name=? WHERE id=?').run(role, active, txt(req.body.full_name ?? u.full_name, 80), u.id);
    if (req.body.password) { if (String(req.body.password).length < 3) throw bad('Password must be at least 3 characters'); db.prepare('UPDATE users SET pass_hash=?, fails=0, locked_until=0 WHERE id=?').run(bcrypt.hashSync(String(req.body.password), 10), u.id); }
    audit(U(req).username, null, 'user changed', u.username); return { ok: true };
  }));
  app.get('/api/audit-log', wrap((req) => { adminOnly(req); const e = txt(req.query.emp, 20); return db.prepare("SELECT * FROM audit_log WHERE (?='' OR emp_id=?) ORDER BY id DESC LIMIT 300").all(e, e); }));

  const pub = path.join(APP_ROOT(), 'public');
  app.use(express.static(pub));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
    const status = err.status || 500; if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong on the server' : err.message });
  });
  return app;
}
function APP_ROOT() { try { const sea = require('node:sea'); if (sea.isSea()) return path.dirname(process.execPath); } catch { /* not packaged */ } return __dirname; }

function ensureAdmin() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return false;
  db.prepare("INSERT INTO users(username,pass_hash,full_name,role) VALUES('admin',?,'Administrator','admin')").run(bcrypt.hashSync(process.env.UFSA_ADMIN_PASS || 'admin123', 10)); return true;
}
// first start: Master Data and the salary files are loaded by themselves when they are still empty (so rates, designations and slips are never "missing")
async function autoSetup() {
  if (process.env.UFSA_NO_AUTOSETUP) return;
  try {
    const tpl = getSetting('template_path');
    if (!db.prepare('SELECT 1 FROM designations LIMIT 1').get() && tpl && fs.existsSync(tpl)) { const r = await importTemplate(tpl); audit('system', null, 'master data loaded on first start', r); console.log('Master Data loaded from the Finance template:', JSON.stringify(r)); }
    const folder = getSetting('slip_folder');
    if (!db.prepare('SELECT 1 FROM payroll_files LIMIT 1').get() && folder && fs.existsSync(folder)) { const r = await slips.importFolder(folder); audit('system', null, 'salary files read on first start', r.map((x) => `${x.file}:${x.rows ?? x.skipped ?? x.error}`).join('; ').slice(0, 400)); console.log('Salary files read:', r.filter((x) => x.rows).length); }
  } catch (e) { console.error('First-start setup skipped:', e.message); }
}
async function start(port = Number(process.env.PORT) || 4900) {
  backupNow('auto'); const first = ensureAdmin();
  if (first) console.log('First sign-in: user "admin", password "' + (process.env.UFSA_ADMIN_PASS ? '(from UFSA_ADMIN_PASS)' : 'admin123') + '" - change it in Setting > Users.');
  const app = createApp();
  return new Promise((resolve) => { const srv = app.listen(port, () => { console.log(`Updated FSA on http://localhost:${port}   data: ${DATA_DIR}`); resolve(srv); autoSetup(); }); });
}
module.exports = { createApp, start, assemble };
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
