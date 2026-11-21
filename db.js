'use strict';
// Database layer: one SQLite file with foreign keys, indexes, an audit trail and an automatic backup on start.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');

let sea; try { sea = require('node:sea'); } catch { sea = null; }
const APP_DIR = sea && sea.isSea && sea.isSea() ? path.dirname(process.execPath) : __dirname;
// SQLite must not live in a OneDrive-synced folder (sync locks and conflict copies can corrupt it), so data goes to LOCALAPPDATA there.
const inOneDrive = /onedrive/i.test(APP_DIR);
const DATA_DIR = process.env.UFSA_DATA_DIR || (inOneDrive ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'UpdatedFSA', 'data') : path.join(APP_DIR, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'ufsa.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE, pass_hash TEXT NOT NULL, full_name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','hr','marketing','finance','viewer')),
  active INTEGER DEFAULT 1, fails INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, last_login TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, user TEXT, emp_id TEXT, action TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS ix_audit_emp ON audit_log(emp_id);

-- master data
CREATE TABLE IF NOT EXISTS designations(code TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups(name TEXT PRIMARY KEY COLLATE NOCASE, company_type TEXT NOT NULL DEFAULT 'pharma' CHECK(company_type IN ('pharma','trade','generic','healthcare')),
  signatory TEXT, signatory_title TEXT);
CREATE TABLE IF NOT EXISTS sep_rules(code TEXT PRIMARY KEY, explanation TEXT, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS rates(id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, designation TEXT NOT NULL COLLATE NOCASE,
  fare REAL DEFAULT 0, daily REAL DEFAULT 0, ex REAL DEFAULT 0, ovn REAL DEFAULT 0, UNIQUE(year, designation));
CREATE TABLE IF NOT EXISTS holidays(id INTEGER PRIMARY KEY AUTOINCREMENT, from_date TEXT NOT NULL, to_date TEXT NOT NULL, name TEXT, kind TEXT DEFAULT 'public');
CREATE INDEX IF NOT EXISTS ix_hol ON holidays(from_date, to_date);
CREATE TABLE IF NOT EXISTS other_deductions(id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT NOT NULL, remarks TEXT, amount REAL DEFAULT 0, active INTEGER DEFAULT 1);
CREATE INDEX IF NOT EXISTS ix_od ON other_deductions(emp_id);
CREATE TABLE IF NOT EXISTS audit_obs(id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, emp_id TEXT NOT NULL, name TEXT, total REAL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_aobs ON audit_obs(emp_id, month);
CREATE TABLE IF NOT EXISTS termination_reasons(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE NOT NULL);

-- employees pulled from the Marketing payroll (or the old master data)
CREATE TABLE IF NOT EXISTS employees(emp_id TEXT PRIMARY KEY, name TEXT, designation_code TEXT, designation TEXT, group_name TEXT, station TEXT, doj TEXT,
  company TEXT, cnic TEXT, gross REAL DEFAULT 0, employment_status TEXT, payroll_status TEXT, last_working_date TEXT, source TEXT, synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_emp_name ON employees(name);

-- the settlement file of one employee
CREATE TABLE IF NOT EXISTS settlements(
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT NOT NULL REFERENCES employees(emp_id),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','approved','cancelled')),
  resign_date TEXT, sep_rule TEXT, absent_days REAL DEFAULT 0, termination_reason TEXT, hr_done INTEGER DEFAULT 0, hr_by TEXT, hr_at TEXT,
  lwd TEXT, imprest REAL DEFAULT 0, imprest_note TEXT, mkt_done INTEGER DEFAULT 0, mkt_by TEXT, mkt_at TEXT,
  job_status TEXT, gross_override REAL, notice_base_override REAL, vehicle_inst REAL DEFAULT 0,
  last_salary_month TEXT, cheque_pf TEXT, cheque_main TEXT, finance_note TEXT,
  approved_by TEXT, approved_at TEXT, snapshot TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_set_emp ON settlements(emp_id, state);
CREATE TABLE IF NOT EXISTS settlement_expenses(settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE, month TEXT NOT NULL,
  claim_km REAL DEFAULT 0, claim_daily REAL DEFAULT 0, claim_ex REAL DEFAULT 0, claim_on REAL DEFAULT 0,
  ded_km REAL DEFAULT 0, ded_daily REAL DEFAULT 0, ded_ex REAL DEFAULT 0, ded_on REAL DEFAULT 0, remarks TEXT, PRIMARY KEY(settlement_id, month));
CREATE TABLE IF NOT EXISTS settlement_items(id INTEGER PRIMARY KEY AUTOINCREMENT, settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('deduction','reimbursement')), code TEXT, label TEXT NOT NULL, amount REAL DEFAULT 0, note TEXT, waived INTEGER DEFAULT 0, waive_reason TEXT);
CREATE INDEX IF NOT EXISTS ix_items ON settlement_items(settlement_id);
CREATE TABLE IF NOT EXISTS settlement_checks(settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE, item TEXT NOT NULL, ok INTEGER DEFAULT 0, by_user TEXT, at TEXT, PRIMARY KEY(settlement_id, item));

-- cached copies of what was read from the other systems, so a settlement can always be explained later
CREATE TABLE IF NOT EXISTS pf_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT NOT NULL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP, ok INTEGER DEFAULT 1, summary TEXT, contributions TEXT, withdrawals TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS ix_pf ON pf_snapshots(emp_id, id);
CREATE TABLE IF NOT EXISTS payroll_files(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, file_name TEXT, month TEXT, company TEXT, mtime INTEGER, size INTEGER, rows INTEGER, imported_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payroll_slips(id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES payroll_files(id) ON DELETE CASCADE, emp_id TEXT NOT NULL, month TEXT NOT NULL, company TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_slip ON payroll_slips(emp_id, month);
CREATE INDEX IF NOT EXISTS ix_slip_old ON payroll_slips(json_extract(data,'$.old_id'));
`);

const getSetting = (k, d = '') => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? r.v : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v == null ? '' : String(v));
const getJson = (k, d) => { try { const v = getSetting(k, ''); return v ? JSON.parse(v) : d; } catch { return d; } };
const audit = (user, empId, action, detail) => db.prepare('INSERT INTO audit_log(user,emp_id,action,detail) VALUES(?,?,?,?)').run(user || '', empId ? String(empId) : null, action, typeof detail === 'string' ? detail : JSON.stringify(detail || {}));
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// defaults that every installation needs
const DEFAULT_RULES = [['Rule: 01', 'YES AND SERVED'], ['Rule: 02', "YES, BUT DIDN'T SERVE"], ['Rule: 03', 'YES, BUT RELEASED BY COMPANY'], ['Rule: 04', 'NO'], ['Rule: 05', 'YES, BUT WAIVED OFF'], ['Terminated', 'TERMINATED'], ['Deceased', 'DECEASED'], ['NO', 'NO']];
function seedDefaults() {
  const r = db.prepare('INSERT OR IGNORE INTO sep_rules(code,explanation,sort) VALUES(?,?,?)'); DEFAULT_RULES.forEach(([c, e], i) => r.run(c, e, i));
  for (const t of ['Misconduct', 'Non-Compliance Policy', 'NILL']) db.prepare('INSERT OR IGNORE INTO termination_reasons(label) VALUES(?)').run(t);
  const d = {
    org_pharma: 'ACME PHARMACEUTICALS (PVT.) LTD.', org_trade: 'ACME PHARMACEUTICALS', org_healthcare: 'NORTHWIND HEALTHCARE (PVT.) LTD.',
    days_in_month: '30', training_cost: '10000', training_days: '180', expense_months: '3',
    pf_bank_name: 'Demo PF Bank', main_bank_name: 'Demo Bank Limited',
    sign1_name: 'Jane Doe', sign1_title: 'General Manager Finance', sign2_name: 'John Smith', sign2_title: 'Manager Internal Audit',
    letter_note: 'PLEASE SIGN THE DUPLICATE COPY OF THIS LETTER AS ACKNOWLEDGEMENT OF FINAL SETTLEMENT, AND BE ADVISED THAT RECEIVING AND SIGNING THIS DOCUMENT SHALL ENDORSE YOUR FULL, FINAL AND WILLFUL ACCEPTANCE AND RECEIPT OF ALL YOUR DUES AND CLAIMS UPON THE COMPANY.',
    payroll_db_path: '', payroll_db_healthcare: '',
    pf_db_path: '', payroll_db_admin: '', payroll_db_factory: '', pf_url: 'http://localhost:3000', pf_user: '', pf_pass: '',
    slip_folder: '', slip_sheet: 'Salary', trade_keyword: 'Pharmaceuticals',
    post_fsa_marketing: 'GL-1001', post_fsa_admin: 'GL-1002', post_fsa_factory: 'GL-1003', post_fsa_healthcare: '', post_fsa_name: 'FSA',
    post_bank_code: 'GL-2001', post_bank_name: 'Demo Bank A/C # 000000', post_pf_code: 'GL-3001', post_pf_name: 'Provident Fund Payable',
    post_rec_code: 'GL-4001', post_rec_name: 'FSA Receivable', post_sal_code: 'GL-5001', post_sal_name: 'Salaries, Wages & Benefits', post_imp_name: 'Imprest Ledger', post_bank_prefix: '', post_pf_prefix: '',
    payslip_folder: '',
    template_path: '',
  };
  for (const [k, v] of Object.entries(d)) if (db.prepare('SELECT 1 FROM settings WHERE k=?').get(k) === undefined) setSetting(k, v);
}
(function ensureColumns() {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  if (!has('settlements', 'vem_code')) db.exec('ALTER TABLE settlements ADD COLUMN vem_code TEXT');
  if (!has('settlements', 'letter_edits')) db.exec('ALTER TABLE settlements ADD COLUMN letter_edits TEXT');
  if (!has('settlements', 'date_kind')) db.exec("ALTER TABLE settlements ADD COLUMN date_kind TEXT DEFAULT 'resignation'");
  for (const c of ['rate_km', 'rate_daily', 'rate_ex', 'rate_on']) if (!has('settlement_expenses', c)) db.exec(`ALTER TABLE settlement_expenses ADD COLUMN ${c} REAL`);
})();
seedDefaults();

// automatic backup: one copy per day, the last 14 are kept
function backupNow(label = 'auto') {
  const stamp = new Date().toISOString().slice(0, 10), file = path.join(DATA_DIR, 'backups', `ufsa-${stamp}-${label}.db`);
  if (label === 'auto' && fs.existsSync(file)) return file;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); fs.copyFileSync(DB_FILE, file);
  const old = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => f.endsWith('.db')).sort().reverse().slice(14);
  for (const f of old) try { fs.unlinkSync(path.join(DATA_DIR, 'backups', f)); } catch { /* in use */ }
  return file;
}

module.exports = { db, DATA_DIR, DB_FILE, APP_DIR, getSetting, setSetting, getJson, audit, tx, backupNow, seedDefaults };
