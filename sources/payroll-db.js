'use strict';
// Reads the payroll databases (read-only: they are never written to): Marketing, Healthcare (same layout) and Admin, Factory (another layout).
// Used for the resigners (status resigned) and, in slips.js, for the salary slips of the finished payroll runs.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

// kind 'hcm' = employees(employee_code, date_of_joining, ...) as in Marketing / Healthcare; kind 'admin' = employees(id, doj, ...) as in Admin / Factory
const SOURCES = [
  { key: 'marketing', label: 'Marketing', kind: 'hcm', setting: 'payroll_db_path', source: 'Marketing payroll', company: '' },
  { key: 'healthcare', label: 'Healthcare', kind: 'hcm', setting: 'payroll_db_healthcare', source: 'Healthcare payroll', company: 'Northwind Healthcare Pvt Limited' },
  { key: 'admin', label: 'Admin', kind: 'admin', setting: 'payroll_db_admin', source: 'Admin payroll', company: 'ABCD Pharma Pvt Limited' },
  { key: 'factory', label: 'Factory', kind: 'admin', setting: 'payroll_db_factory', source: 'Factory payroll', company: 'ABCD Pharma Pvt Limited' },
];
const byKey = (key) => SOURCES.find((s) => s.key === key) || SOURCES[0];

function open(file, label = 'Marketing') {
  if (!file || !fs.existsSync(file)) throw Object.assign(new Error(`The ${label} payroll database was not found. Check Setting > Data sources.`), { status: 400 });
  return new DatabaseSync(file, { readOnly: true });
}
const confirmed = (s) => (/^(confirmed|director)$/i.test(String(s || '')) ? 'Confirmed' : s ? 'Unconfirmed' : '');
const mapHcm = (src) => (e) => ({
  emp_id: String(e.employee_code).trim(), name: e.name, designation_code: e.designation || '', group_name: e.department || '', station: e.station || '',
  doj: e.date_of_joining || null, company: e.company || src.company, cnic: e.cnic || '', gross: Number(e.gross_salary) || 0,
  employment_status: e.employment_status === 'confirmed' ? 'Confirmed' : e.employment_status ? 'Unconfirmed' : '', payroll_status: e.status || '', last_working_date: e.last_working_date || null,
});
const mapAdmin = (src) => (e) => ({
  emp_id: String(e.id).trim(), name: String(e.name || '').replace(/\s+/g, ' ').trim(), designation_code: String(e.designation || '').trim(), group_name: e.department || '', station: '',
  doj: e.doj || null, company: src.company, cnic: e.cnic || '', gross: Number(e.gross) || 0, employment_status: confirmed(e.status), payroll_status: String(e.status || '').toLowerCase() === 'resigned' ? 'resigned' : String(e.status || '').toLowerCase(),
  last_working_date: e.last_working_date || null,
});
const mapper = (src) => (src.kind === 'admin' ? mapAdmin(src) : mapHcm(src));
const idCol = (src) => (src.kind === 'admin' ? 'id' : 'employee_code');
const resignedWhere = (src) => (src.kind === 'admin' ? "LOWER(status)='resigned'" : "status='resigned' AND deleted_at IS NULL");

// every resigned employee of one payroll (src = a key of SOURCES; the first argument is the database file)
function resigners(file, srcKey = 'marketing') {
  const src = byKey(srcKey), db = open(file, src.label);
  try { return db.prepare(`SELECT * FROM employees WHERE ${resignedWhere(src)} ORDER BY CAST(${idCol(src)} AS INTEGER)`).all().map(mapper(src)); } finally { db.close(); }
}
// one employee by ID, whatever the status (so the person can see that somebody is still active in payroll)
function lookup(file, empId, srcKey = 'marketing') {
  const src = byKey(srcKey), db = open(file, src.label);
  try {
    const e = db.prepare(`SELECT * FROM employees WHERE ${idCol(src)} = ?${src.kind === 'hcm' ? ' AND deleted_at IS NULL' : ''}`).get(src.kind === 'admin' ? Number(empId) : String(empId).trim());
    return e ? mapper(src)(e) : null;
  } finally { db.close(); }
}
function test(file, srcKey = 'marketing') {
  const src = byKey(srcKey), db = open(file, src.label);
  try {
    const t = db.prepare('SELECT COUNT(*) n FROM employees').get().n, r = db.prepare(`SELECT COUNT(*) n FROM employees WHERE ${resignedWhere(src)}`).get().n;
    return { employees: t, resigned: r };
  } finally { db.close(); }
}
// the finished payroll runs with their lines, for the salary slips (slips.js)
function runsOf(file, srcKey) {
  const src = byKey(srcKey), db = open(file, src.label);
  try {
    if (src.kind === 'admin') {
      return db.prepare("SELECT id, month, finalized_at, status FROM payroll_runs WHERE status IN ('finalized','disbursed','paid') ORDER BY month").all().map((r) => ({
        month: r.month, stamp: r.finalized_at || '', lines: db.prepare('SELECT * FROM payroll_lines WHERE run_id=?').all(r.id).map((l) => ({ kind: 'admin', l })),
      }));
    }
    const hasCo = db.prepare('PRAGMA table_info(payroll_runs)').all().some((c) => c.name === 'company');
    return db.prepare(`SELECT id, period_month, period_year, finalized_at, ${hasCo ? 'company' : "'' AS company"} FROM payroll_runs WHERE status IN ('finalized','disbursed','paid') ORDER BY period_year, period_month`).all().map((r) => {
      const emps = new Map(db.prepare('SELECT id, employee_code, employment_status FROM employees').all().map((e) => [e.id, e]));
      const items = db.prepare('SELECT employee_id, kind, name, amount FROM payroll_line_items WHERE payroll_run_id=?').all(r.id), by = new Map();
      for (const i of items) { if (!by.has(i.employee_id)) by.set(i.employee_id, []); by.get(i.employee_id).push(i); }
      return {
        month: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`, stamp: r.finalized_at || '', company: r.company || '',
        lines: db.prepare('SELECT * FROM payroll_lines WHERE payroll_run_id=?').all(r.id).map((l) => ({ kind: 'hcm', l, e: emps.get(l.employee_id), items: by.get(l.employee_id) || [] })),
      };
    });
  } finally { db.close(); }
}
module.exports = { SOURCES, byKey, resigners, lookup, test, runsOf };
