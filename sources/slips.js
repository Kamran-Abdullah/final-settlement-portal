'use strict';
// Salary slips from the monthly payroll Excel files: one file per company per month, sheet "Salary", row 1-2 headers, one employee per row.
// Files are imported into the database once (so a lookup by Employee ID is instant and the figures stay on record).
const fs = require('fs');
const path = require('path');
const { db, getSetting, tx } = require('../db');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthFromName(name) {
  let m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s_.-]*(\d{4})/i.exec(name);
  if (m) return `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
  m = /(\d{4})[-_.](\d{2})/.exec(name); return m ? `${m[1]}-${m[2]}` : '';
}

// what each canonical field is called in the payroll sheet (matched on the normalised header text of row 2, then row 1)
const FIELDS = [
  ['old_id', /^old emp id$/], ['emp_id', /^(new )?emp id$/], ['name', /^name$/], ['desig', /^dsn/], ['group', /^grp$/], ['station', /^station$/], ['doj', /^j\. ?dt/],
  ['gross', /^gross salary$/], ['promo', /^promotion/], ['arrears', /^arrears$/], ['special', /^(special\/performance|special inc)/], ['conf', /^(conf\. ?incre|confirmation inc)/], ['arrears_inc', /^arrears incre/],
  ['inflation', /^inflation allowance/], ['vehicle_allow', /^vehicle allowance/], ['maint', /^main\. allow/], ['conv', /^conv/], ['fuel', /^fuel allow/], ['tel', /^tel/], ['post', /^pa\/sa/], ['ntour', /^n\.tour/],
  ['total_gross', /^total gross salary/], ['loan_ded', /^loan ded/], ['pf_loan_ded', /^pf loan ded/], ['itax', /^i tax/], ['medical', /^medical/], ['eobi', /^eobi/], ['vehicle_inst', /^vehicle instal/],
  ['basic', /^basic$/], ['emp_status', /^employee status/], ['pf_emp', /^p\.f cont\. employee/], ['pf_er', /^p\.f cont\. employer/], ['token_tax', /^(token tax|professional tax)/],
  ['other_ded', /^(other ded\/reimburs|mobile set ded)/], ['mobile', /^(othes|mobile)$/], ['audit_ded', /^audit ded/], ['absent_ded', /^absent ded/], ['imprest', /^imprest ded/], ['total_ded', /^total ded/],
  ['net', /^n\.sal/], ['cnic', /^cnic$/], ['remarks', /^remarks$/], ['bank', /^bank$/], ['account', /^verified account/],
];
const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const cellv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? ('result' in v ? v.result : v.richText ? v.richText.map((t) => t.text).join('') : v.text ?? '') : v);
const numv = (v) => { v = cellv(v); const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
const strv = (v) => { v = cellv(v); return v == null ? '' : String(v).trim(); };
const idv = (v) => { v = strv(v); return /^\d+(\.0+)?$/.test(v) ? String(parseInt(v, 10)) : v; };
const isoDate = (v) => { v = cellv(v); if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10); return /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : ''; };
const TEXT = new Set(['old_id', 'emp_id', 'name', 'desig', 'group', 'station', 'emp_status', 'cnic', 'remarks', 'bank', 'account']);

function mapColumns(row1, row2) {
  const cols = {}, incentive = [];
  const width = Math.max(row1.length, row2.length);
  for (let c = 1; c < width; c++) {
    const labels = [norm(cellv(row2[c])), norm(cellv(row1[c]))].filter(Boolean);
    if (labels.some((l) => /^incentive$/.test(l))) incentive.push(c);
    for (const [key, re] of FIELDS) if (!cols[key] && labels.some((l) => re.test(l))) { cols[key] = c; break; }
  }
  if (!cols.emp_id) throw new Error('No "Emp ID" column found in the Salary sheet');
  return { cols, incentive };
}

async function parseFile(file, sheetName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName) || wb.worksheets.find((s) => /salary/i.test(s.name));
  if (!ws) throw new Error(`No "${sheetName}" sheet in ${path.basename(file)}`);
  // the header is the row that holds "Emp ID" / "New Emp ID" (some months have a title block above it); a second header line follows
  let h = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 25) && !h; r++) if (ws.getRow(r).values.some((c) => /^(new )?emp id$/.test(norm(cellv(c))))) h = r;
  if (!h) throw new Error('No "Emp ID" header row found in the Salary sheet');
  const { cols, incentive } = mapColumns(ws.getRow(h).values, ws.getRow(h + 1).values);
  const rows = [];
  ws.eachRow((row, r) => {
    if (r < h + 2) return;
    const v = row.values, d = {};
    const id = idv(v[cols.emp_id]); if (!/^\d+$/.test(id)) return;
    for (const key of Object.keys(cols)) d[key] = key === 'doj' ? isoDate(v[cols[key]]) : TEXT.has(key) ? (key === 'old_id' ? idv(v[cols[key]]) : strv(v[cols[key]])) : numv(v[cols[key]]);
    d.emp_id = id; d.incentive = incentive.reduce((s, c) => s + numv(v[c]), 0);
    rows.push(d);
  });
  return rows;
}

// scan the folder for payroll files and import the new / changed ones
async function importFolder(folder, { sheet = getSetting('slip_sheet', 'Salary'), keyword = getSetting('trade_keyword', 'Pharmaceuticals') } = {}) {
  if (!folder || !fs.existsSync(folder)) throw Object.assign(new Error('The payroll Excel folder was not found. Check Setting > Data sources.'), { status: 400 });
  const files = fs.readdirSync(folder).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$') && monthFromName(f));
  const report = [];
  for (const f of files) {
    const full = path.join(folder, f), st = fs.statSync(full), month = monthFromName(f);
    const company = keyword && new RegExp(keyword, 'i').test(f) ? 'trade' : 'pharma';
    const old = db.prepare('SELECT * FROM payroll_files WHERE path=?').get(full);
    if (old && old.mtime === Math.round(st.mtimeMs) && old.size === st.size) { report.push({ file: f, month, company, rows: old.rows, skipped: 'unchanged' }); continue; }
    let rows;
    try { rows = await parseFile(full, sheet); } catch (e) { report.push(/No "[^"]*" sheet/.test(e.message) ? { file: f, month, skipped: 'no Salary sheet' } : { file: f, month, error: e.message }); continue; }
    tx(() => {
      if (old) db.prepare('DELETE FROM payroll_files WHERE id=?').run(old.id);
      const fid = db.prepare('INSERT INTO payroll_files(path,file_name,month,company,mtime,size,rows) VALUES(?,?,?,?,?,?,?)').run(full, f, month, company, Math.round(st.mtimeMs), st.size, rows.length).lastInsertRowid;
      const ins = db.prepare('INSERT INTO payroll_slips(file_id,emp_id,month,company,data) VALUES(?,?,?,?,?)');
      for (const r of rows) ins.run(fid, r.emp_id, month, company, JSON.stringify(r));
    });
    report.push({ file: f, month, company, rows: rows.length });
  }
  return report;
}

// the slip of an employee = the latest month in which the ID appears (a resigner is not in the month of leaving)
function latestSlip(empId) {
  const id = String(empId).trim();
  const r = db.prepare("SELECT s.*, f.file_name FROM payroll_slips s JOIN payroll_files f ON f.id=s.file_id WHERE s.emp_id=? OR json_extract(s.data,'$.old_id')=? ORDER BY s.month DESC, (f.path LIKE 'payslip:%') ASC, s.id DESC LIMIT 1").get(id, id);
  return r ? shape(r) : null;
}
function slipFor(empId, month) {
  const id = String(empId).trim();
  const r = db.prepare("SELECT s.*, f.file_name FROM payroll_slips s JOIN payroll_files f ON f.id=s.file_id WHERE (s.emp_id=? OR json_extract(s.data,'$.old_id')=?) AND s.month=? ORDER BY (f.path LIKE 'payslip:%') ASC, s.id DESC LIMIT 1").get(id, id, month);
  return r ? shape(r) : null;
}
function shape(r) {
  const d = JSON.parse(r.data), n = (k) => Number(d[k]) || 0;
  const increments = n('promo') + n('special') + n('conf');
  return {
    month: r.month, file: r.file_name, company: r.company, raw: d,
    salary: n('gross'), increments, arrears: n('arrears') + n('arrears_inc'), incentive: n('incentive'), conv: n('conv'), fuel: n('fuel'), tel: n('tel'), post: n('post'), ntour: n('ntour'),
    vehicle_allow: n('vehicle_allow'), maint: n('maint'), inflation: n('inflation'), total_gross: n('total_gross'),
    itax: n('itax'), loan: n('loan_ded'), pf_loan: n('pf_loan_ded'), medical: n('medical'), imprest: n('imprest'), eobi: n('eobi'), vehicle_inst: n('vehicle_inst'),
    other_ded: n('other_ded'), pf_emp: n('pf_emp'), pf_er: n('pf_er'), mobile: n('mobile'), audit_ded: n('audit_ded'), absent_ded: n('absent_ded'), total_ded: n('total_ded'), net: n('net'),
    emp_status: d.emp_status || '', notice_base: n('gross') + increments,
  };
}

// ---------- salary slips from the payroll databases and from uploaded Excel files
const LABEL = { marketing: 'Marketing', healthcare: 'Healthcare', admin: 'Admin', factory: 'Factory', pharma: 'Marketing (Pharma)', trade: 'Marketing (Trade)' };
function storeSlips(pathKey, fileName, month, company, rows, mtime, size) {
  tx(() => {
    const old = db.prepare('SELECT id FROM payroll_files WHERE path=?').get(pathKey);
    if (old) db.prepare('DELETE FROM payroll_files WHERE id=?').run(old.id);
    const fid = db.prepare('INSERT INTO payroll_files(path,file_name,month,company,mtime,size,rows) VALUES(?,?,?,?,?,?,?)').run(pathKey, fileName, month, company, mtime, size, rows.length).lastInsertRowid;
    const ins = db.prepare('INSERT INTO payroll_slips(file_id,emp_id,month,company,data) VALUES(?,?,?,?,?)');
    for (const r of rows) ins.run(fid, r.emp_id, month, company, JSON.stringify(r));
  });
}
const sumItems = (items, kind, re) => items.filter((i) => i.kind === kind && re.test(i.name)).reduce((s, i) => s + (Number(i.amount) || 0), 0);
function dbLine(x) {
  const n = (v) => Number(v) || 0;
  if (x.kind === 'admin') {
    const l = x.l;
    return { emp_id: String(l.emp_id), name: l.name, desig: l.designation || '', gross: n(l.gross), conf: n(l.conf_inc), promo: n(l.promo), special: n(l.special_inc), arrears: n(l.arrears), incentive: n(l.bonus) + n(l.annual_inc),
      fuel: n(l.fuel), total_gross: n(l.gross_total) || n(l.gross), itax: n(l.tax), medical: n(l.medical), eobi: n(l.eobi), absent_ded: n(l.absent), other_ded: n(l.other_ded), imprest: n(l.advance_recovery), pf_loan_ded: n(l.pf_loan),
      pf_emp: n(l.pf_emp), pf_er: n(l.pf_er), total_ded: n(l.total_ded), net: n(l.net), emp_status: l.status || '', cnic: l.cnic || '' };
  }
  const l = x.l, it = x.items, a = (re) => sumItems(it, 'allowance', re), d = (re) => sumItems(it, 'deduction', re);
  const st = x.e && x.e.employment_status;
  return { emp_id: String(x.e ? x.e.employee_code : l.employee_id), gross: n(l.gross), conf: a(/^confirmation incre/i), promo: a(/^promotion/i), special: a(/^special/i), arrears: a(/increment arrears/i),
    inflation: a(/^inflation/i), vehicle_allow: a(/^vehicle allow/i), maint: a(/^maint/i), fuel: a(/^fuel/i), tel: a(/^tel/i), total_gross: n(l.gross) + n(l.total_allowances),
    itax: n(l.tax), medical: d(/^medical/i), eobi: d(/^eobi/i), absent_ded: d(/^absent/i), audit_ded: d(/audit/i), loan_ded: d(/^loan/i), imprest: d(/^imprest/i), other_ded: d(/^other/i),
    pf_emp: n(l.pf_employee), pf_er: n(l.pf_employer), total_ded: n(l.total_deductions), net: n(l.net_pay), emp_status: st === 'confirmed' ? 'Confirmed' : st ? 'Unconfirmed' : '' };
}
// every finished payroll run of one payroll database becomes one "file" per month (replaced when it is read again)
function importPayrollDb(srcKey, file) {
  const payrollDb = require('./payroll-db'), out = [];
  for (const run of payrollDb.runsOf(file, srcKey)) {
    // Marketing keeps its Excel files (richer columns): the database is used only for months without an Excel file
    const company = srcKey === 'marketing' ? (/pvt/i.test(run.company || '') ? 'pharma' : 'trade') : srcKey;
    if (srcKey === 'marketing' && db.prepare("SELECT 1 FROM payroll_files WHERE month=? AND company=? AND path NOT LIKE 'db:%'").get(run.month, company)) { out.push({ file: `${LABEL[srcKey]} payroll ${run.month}`, month: run.month, company, skipped: 'an Excel file exists for this month' }); continue; }
    const rows = run.lines.map(dbLine).filter((r) => /^\d+$/.test(r.emp_id));
    storeSlips(`db:${srcKey}:${company}:${run.month}`, `${LABEL[company] || LABEL[srcKey]} payroll database - ${run.month}`, run.month, company, rows, Date.parse(run.stamp) || 0, rows.length);
    out.push({ file: `${LABEL[company] || LABEL[srcKey]} payroll database - ${run.month}`, month: run.month, company, rows: rows.length });
  }
  return out;
}
// an Excel file chosen by the user (any of the four payrolls)
async function importUpload(buffer, fileName, { source = 'marketing', month = '', sheet = getSetting('slip_sheet', 'Salary'), keyword = getSetting('trade_keyword', 'Pharmaceuticals') } = {}) {
  const os = require('os'), tmp = path.join(os.tmpdir(), `ufsa-up-${Date.now()}.xlsx`);
  fs.writeFileSync(tmp, buffer);
  try {
    const m = /^\d{4}-\d{2}$/.test(month) ? month : monthFromName(fileName);
    if (!m) throw Object.assign(new Error('The month could not be read from the file name (for example "Admin Sep 2026.xlsx"). Choose the month.'), { status: 400 });
    let rows; try { rows = await parseFile(tmp, sheet); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    const company = source === 'marketing' ? (keyword && new RegExp(keyword, 'i').test(fileName) ? 'trade' : 'pharma') : source;
    storeSlips(`upload:${company}:${m}:${fileName}`, fileName, m, company, rows, Date.now(), buffer.length);
    return { file: fileName, month: m, company, rows: rows.length };
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

module.exports = { LABEL, importPayrollDb, importUpload, importFolder, latestSlip, slipFor, parseFile, monthFromName, mapColumns };
