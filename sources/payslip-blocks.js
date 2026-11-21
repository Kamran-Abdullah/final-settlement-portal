'use strict';
// Payslip history: Excel files with ONE SHEET PER MONTH, each sheet holding one printed payslip "block" (about 17 rows) per employee, one under the other:
//   Empolyee ID. | NAME | DESIG. | STATION: | JOINING DATE | PAYBILL FOR | SALARY & ALLOWANCES (+values) | DEDUCTIONS (+values) | EXPENSE CLAIMED | NET SALARY ...
// The blocks are read by their labels (the sheets changed over the years: 19 to 54 columns), streamed row by row (the biggest file is 100 MB),
// and stored as salary slips (payroll_slips) exactly like the flat monthly payroll files.
const fs = require('fs');
const path = require('path');
const { db, tx } = require('../db');
const PARSER = 4;                      // raise it when the parsing changes: files imported by an older version are read again

const cv = (c) => (c && typeof c === 'object' && !(c instanceof Date) ? ('result' in c ? c.result : c.richText ? c.richText.map((t) => t.text).join('') : c.text ?? null) : c);
const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9/.\-]+/g, '');
const num = (v) => { v = cv(v); const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
const str = (v) => { v = cv(v); return v == null ? '' : String(v).trim(); };
const iso = (serial) => { const n = Number(cv(serial)); if (!Number.isFinite(n) || n < 20000 || n > 80000) return ''; return new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10); };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthOfSheet(name) {
  const m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.\-_]*'?(\d{2}|\d{4})$/i.exec(String(name).trim());
  if (!m) return '';
  const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${y}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
}
const companyOf = (title) => (/health/i.test(title) ? 'healthcare' : /\(pvt\)/i.test(title) ? 'pharma' : /pharma/i.test(title) ? 'trade' : 'pharma');

// header label -> field of the salary slip
const EARN = [[/^salary$/, 'gross'], [/^increment/, 'conf'], [/^arrears$/, 'arrears'], [/^incentives?$/, 'incentive'], [/^specialinc/, 'special'], [/^conv/, 'conv'], [/^fuelallow/, 'fuel'], [/^tel\//, 'tel'],
  [/^post\//, 'post'], [/^n\.?touring$/, 'ntour'], [/^vehicleallow/, 'vehicle_allow'], [/^maintallow/, 'maint'], [/^inflationallow/, 'inflation'], [/^total$/, 'total_gross'], [/^pfbalance/, 'pf_balance']];
const DED = [[/^i\.?tax$/, 'itax'], [/^loan$/, 'loan_ded'], [/^pf-?loan/, 'pf_loan_ded'], [/^medical/, 'medical'], [/^imprest/, 'imprest'], [/^eobi$/, 'eobi'], [/^vehicle$/, 'vehicle_inst'],
  [/^(absentded|excesssalaryded)/, 'absent_ded'], [/^p\.?fund$/, 'pf_emp'], [/^mobile$/, 'mobile'], [/^auditobservation$/, 'audit_ded'], [/^(other|otherded)/, 'other_ded']];
const EXP = [[/^k\.?m$/, 'x_km'], [/^ex-?town$/, 'x_ex'], [/^on$/, 'x_on'], [/^daily$/, 'x_daily']];

// the first non-empty cell to the right of the label cell
function after(row, label) {
  for (let i = 1; i < row.length; i++) {
    if (norm(cv(row[i])) === label) { for (let j = i + 1; j < row.length; j++) { const v = cv(row[j]); if (v !== null && v !== undefined && v !== '') return v; } return null; }
  }
  return null;
}
const has = (row, label) => row.some((c) => norm(cv(c)) === label);
function mapRow(head, vals, table, into, sum) {
  for (let c = 2; c < head.length; c++) {
    const h = norm(cv(head[c])); if (!h) continue;
    for (const [re, key] of table) if (re.test(h)) { const v = num(vals[c]); if (sum) into[key] = (into[key] || 0) + v; else if (!(key in into)) into[key] = v; break; }
  }
}

// one block (array of row value arrays) -> slip data, or null
function parseBlock(rows, title) {
  const R = (label) => { for (const r of rows) { const v = after(r, label); if (v !== null) return v; } return null; };
  const idRow = rows.findIndex((r) => has(r, 'empolyeeid.') || has(r, 'employeeid.') || has(r, 'employeeid'));
  if (idRow < 0) return null;
  const id = String(cv(after(rows[idRow], 'empolyeeid.') ?? after(rows[idRow], 'employeeid.') ?? after(rows[idRow], 'employeeid')) ?? '').trim().replace(/\.0+$/, '');
  if (!/^\d+$/.test(id)) return null;
  const d = { emp_id: id, name: str(R('name')), desig: str(R('desig.')), station: str(R('station')), group: str(after(rows[idRow], 'group')), doj: iso(R('joiningdate')), emp_status: '' };
  const js = cv(R('job.status')); if (typeof js === 'string' && js.trim()) d.emp_status = js.trim();
  const period = iso(R('paybillfor'));
  const earnAt = rows.findIndex((r) => has(r, 'salaryallowances'));
  if (earnAt >= 0 && rows[earnAt + 1]) mapRow(rows[earnAt], rows[earnAt + 1], EARN, d);
  const dedAt = rows.findIndex((r) => has(r, 'deductions') && r.some((c) => /^i\.?tax$/.test(norm(cv(c)))));
  if (dedAt >= 0 && rows[dedAt + 1]) { mapRow(rows[dedAt], rows[dedAt + 1], DED, d, true); }
  const td = after(rows[dedAt + 1] || [], 'salarydeductions'); if (td !== null) d.total_ded = num(td);
  const expAt = rows.findIndex((r) => has(r, 'expenseclaimed'));
  if (expAt >= 0) {
    const ns = after(rows[expAt], 'netsalary'); if (ns !== null) d.net = num(ns);
    if (rows[expAt + 1]) {
      mapRow(rows[expAt], rows[expAt + 1], EXP, d);
      // all the expense columns as printed (K.M, Ex - Town, ON, Daily, "JuneExpence", Incentives, Mobile Allow, Nontouring Allow, Ded/Reimburs ...)
      const items = []; for (let c = 3; c <= 11; c++) { let lab = str(rows[expAt][c]); if (!lab || norm(lab) === 'netsalary') continue;
        if (/^\d{5}$/.test(lab)) { const t = iso(lab); if (t) lab = `${MONTHS[+t.slice(5, 7) - 1][0].toUpperCase()}${MONTHS[+t.slice(5, 7) - 1].slice(1)} ${t.slice(0, 4)} expenses`; } items.push({ label: lab, value: num(rows[expAt + 1][c]) }); }
      d.exp_items = items;
    }
  }
  const tec = R('totalexpenseclaimed'); if (tec !== null) d.exp_claimed = num(tec);
  // the line below: DEDUCTIONS of the expenses (K.M, Ex - Town, ON, Daily, Audit DED, No Supp., FMPS DAILY ...) and their total
  const edAt = expAt >= 0 ? rows.findIndex((r, i) => i > expAt && has(r, 'deductions')) : -1;
  if (edAt >= 0 && rows[edAt + 1]) {
    const items = []; for (let c = 3; c <= 11; c++) { const lab = str(rows[edAt][c]); if (!lab) continue; items.push({ label: lab, value: num(rows[edAt + 1][c]) }); }
    d.exp_ded_items = items; const tot = after(rows[edAt + 1], 'expensedeductions');
    d.exp_ded_total = tot !== null && Number.isFinite(Number(cv(tot))) ? num(tot) : items.reduce((a, i) => a + i.value, 0);
  }
  const nex = R('netexpenses'); if (nex !== null) d.net_expenses = num(nex);
  const np = R('netpayment'); if (np !== null) d.net_payment = num(np);
  if (d.total_gross === undefined) d.total_gross = num(d.gross);
  if (d.total_ded === undefined) d.total_ded = 0;
  if (d.net === undefined) d.net = d.total_gross - d.total_ded;
  d.company = companyOf(title);
  return { d, period };
}

// stream a workbook: calls onSheet(name, month, slipsByCompany) for each monthly sheet
async function readWorkbook(file, onSheet, progress = () => {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore', worksheets: 'emit' });
  for await (const ws of wb) {
    const sheetMonth = monthOfSheet(ws.name);
    if (!sheetMonth) { for await (const _ of ws) { /* skip the sheet (not a month) */ } onSheet(ws.name, '', null); continue; }
    const out = [], seen = new Set(); let cur = null, title = '', last = '', rows = 0;
    const flush = () => { if (!cur) return; const b = parseBlock(cur, last); cur = null; if (b) { const k = b.d.company + ':' + b.d.emp_id; if (!seen.has(k)) { seen.add(k); b.d._period = b.period; out.push(b.d); } } };
    for await (const row of ws) {
      rows++; const v = row.values; if (rows % 4000 === 0) progress(ws.name, rows);
      const b2 = cv(v[2]);
      if (typeof b2 === 'string' && /^(abcd|northwind)/i.test(b2.trim())) { title = b2; }
      if (has(v, 'empolyeeid.') || has(v, 'employeeid.')) { flush(); cur = []; last = title; }
      if (cur) cur.push(v);
    }
    flush();
    // the month of the sheet = the month of its pay-bill date (the sheet name decides when the date is missing)
    onSheet(ws.name, sheetMonth, out);
  }
}

function store(pathKey, fileName, month, company, rows, mtime, size) {
  tx(() => {
    const old = db.prepare('SELECT id FROM payroll_files WHERE path=?').get(pathKey);
    if (old) db.prepare('DELETE FROM payroll_files WHERE id=?').run(old.id);
    const fid = db.prepare('INSERT INTO payroll_files(path,file_name,month,company,mtime,size,rows) VALUES(?,?,?,?,?,?,?)').run(pathKey, fileName, month, company, mtime, size, rows.length).lastInsertRowid;
    const ins = db.prepare('INSERT INTO payroll_slips(file_id,emp_id,month,company,data) VALUES(?,?,?,?,?)');
    for (const r of rows) { const { _period, ...data } = r; ins.run(fid, r.emp_id, month, company, JSON.stringify(data)); }
  });
}

// import every .xlsx of the folder; a file that is already imported and unchanged is skipped
const job = { running: false, started: null, finished: null, current: '', sheets: 0, slips: 0, report: [], error: '' };
async function importFolder(folder, { force = false } = {}) {
  if (job.running) return job;
  Object.assign(job, { running: true, started: new Date().toISOString(), finished: null, current: '', sheets: 0, slips: 0, report: [], error: '' });
  try {
    if (!folder || !fs.existsSync(folder)) throw Object.assign(new Error('The Payslip folder was not found. Check Setting > Data sources.'), { status: 400 });
    const files = fs.readdirSync(folder).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
    for (const f of files) {
      const full = path.join(folder, f), st = fs.statSync(full), mtime = Math.round(st.mtimeMs) + PARSER, prefix = `payslip:${f}:`;
      const done = db.prepare('SELECT COUNT(*) n, MIN(mtime) a, MAX(mtime) b, MIN(size) s FROM payroll_files WHERE path LIKE ?').get(prefix + '%');
      if (!force && done.n > 0 && done.a === mtime && done.b === mtime && done.s === st.size) { job.report.push({ file: f, skipped: 'already imported (unchanged)', sheets: done.n }); continue; }
      db.prepare('DELETE FROM payroll_files WHERE path LIKE ?').run(prefix + '%');
      let sheets = 0, slips = 0; job.current = f;
      const forced = /health/i.test(f) ? 'healthcare' : null;       // the Healthcare file is Healthcare whatever the title of a month says
      await readWorkbook(full, (name, month, list) => {
        if (!month) { job.report.push({ file: f, sheet: name, skipped: 'not a month sheet' }); return; }
        const by = {}; for (const r of list) { if (forced) r.company = forced; (by[r.company] = by[r.company] || []).push(r); }
        for (const [company, rows] of Object.entries(by)) { store(`${prefix}${name}:${company}`, `${f} - ${name}`, month, company, rows, mtime, st.size); slips += rows.length; }
        sheets++; job.sheets++; job.slips += list.length; job.current = `${f} - ${name}`;
      }, (n, r) => { job.current = `${f} - ${n} (row ${r})`; });
      job.report.push({ file: f, sheets, slips });
    }
  } catch (e) { job.error = e.message; if (process.env.UFSA_DEBUG) console.error(e.stack); } finally { job.running = false; job.finished = new Date().toISOString(); job.current = ''; }
  return job;
}
module.exports = { importFolder, job, parseBlock, readWorkbook, monthOfSheet, companyOf };
