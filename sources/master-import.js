'use strict';
// Loads the master data out of the Finance template: MD_Final (employees, rates, designations, groups, rules, "others" deductions),
// Holiday, Audit and the letter wording / signatories of the Finance sheet. Safe to run again: each table is replaced by what the file holds.
const { db, tx, setSetting } = require('../db');

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? ('result' in v ? v.result : v.richText ? v.richText.map((t) => t.text).join('') : v.text ?? '') : v);
const str = (v) => { v = cv(v); return v == null ? '' : String(v).trim(); };
const num = (v) => { v = cv(v); const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : null; };
const iso = (v) => { v = cv(v); if (typeof v === 'number' && v > 20000 && v < 80000) v = new Date(Math.round((v - 25569) * 864e5)); /* Excel serial date */ if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10); return /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : ''; };
const idv = (v) => { v = str(v); return /^\d+(\.0+)?$/.test(v) ? String(parseInt(v, 10)) : v; };
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monIdx = (s) => (s ? MON.indexOf(String(s).slice(0, 3).toLowerCase()) : -1);
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

// holiday names often carry the whole range ("20 Mar to 23 Mar"); the sheet lists one date
function expandRange(d, name) {
  const Y = Number(d.slice(0, 4)), M = Number(d.slice(5, 7)) - 1, D = Number(d.slice(8, 10));
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s*([A-Za-z]{3,9})?\s*(?:to|and|&|-|–)\s*(\d{1,2})(?:st|nd|rd|th)?\s*([A-Za-z]{3,9})?/i.exec(name);
  if (!m) return [d, d, false];
  const d1 = Number(m[1]), d2 = Number(m[3]), mon1 = monIdx(m[2]), mon2 = monIdx(m[4]);
  let from = null, to = null;
  if (d1 === D && (mon1 < 0 || mon1 === M)) { from = d; const em = mon2 >= 0 ? mon2 : M; if (em === M && d2 > d1) to = ymd(Y, M, d2); else if (em !== M && em === (M + 1) % 12) to = ymd(Y + (em < M ? 1 : 0), em, d2); }
  else if (d2 === D && d1 < d2 && (mon2 < 0 || mon2 === M)) { from = ymd(Y, M, d1); to = d; }
  if (!from || !to || (Date.parse(to) - Date.parse(from)) / 864e5 > 8) return [d, d, false];
  return [from, to, true];
}
const companyType = (g) => { const x = String(g || '').toLowerCase().trim(); return x === 'trade' ? 'trade' : x === 'generic' ? 'generic' : x === 'healthcare' ? 'healthcare' : 'pharma'; };

async function importTemplate(file) {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: 'emit', sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore' });
  const sheets = {};
  for await (const ws of reader) {
    if (!['MD_Final', 'Holiday', 'Audit', 'Finance'].includes(ws.name)) { for await (const _ of ws) { /* skip */ } continue; }   // eslint-disable-line no-unused-vars
    const rows = []; for await (const row of ws) rows[row.number] = row.values; sheets[ws.name] = rows;
  }
  if (!sheets.MD_Final) throw new Error('This file has no "MD_Final" sheet - choose the Finance template');
  const md = sheets.MD_Final, rep = { employees: 0, designations: 0, groups: 0, rules: 0, rates: 0, others: 0, holidays: 0, audit: 0, letter: false };

  tx(() => {
    // employees (A:G) - only added when the payroll has not already supplied them
    const ie = db.prepare("INSERT OR IGNORE INTO employees(emp_id,name,designation_code,group_name,station,doj,gross,source) VALUES(?,?,?,?,?,?,?,'MD_Final')");
    for (let r = 2; r < md.length; r++) { const v = md[r]; if (!v) continue; const id = idv(v[1]); if (!/^\d+$/.test(id) || !str(v[3])) continue; ie.run(id, str(v[3]), str(v[4]), str(v[5]), str(v[6]), iso(v[2]) || null, num(v[7]) || 0); rep.employees++; }
    // designations S:T, groups O:Q, rules V:W, others Y:AA
    db.exec('DELETE FROM designations'); const idg = db.prepare('INSERT OR REPLACE INTO designations(code,title) VALUES(?,?)');
    for (let r = 2; r < Math.min(md.length, 200); r++) { const v = md[r]; if (v && str(v[19]) && str(v[20])) { idg.run(str(v[19]), str(v[20])); rep.designations++; } }
    const ig = db.prepare('INSERT OR REPLACE INTO groups(name,company_type,signatory,signatory_title) VALUES(?,?,?,?)');
    for (let r = 2; r < Math.min(md.length, 200); r++) { const v = md[r]; if (v && str(v[15]) && (str(v[16]) || str(v[17]))) { ig.run(str(v[15]), companyType(str(v[15])), str(v[16]), str(v[17])); rep.groups++; } }
    const ir = db.prepare('INSERT OR REPLACE INTO sep_rules(code,explanation,sort) VALUES(?,?,?)');
    for (let r = 2; r < Math.min(md.length, 40); r++) { const v = md[r]; if (v && str(v[22]) && str(v[23])) { ir.run(str(v[22]), str(v[23]).replace(/[^\x20-\x7E]/g, "'"), rep.rules); rep.rules++; } }
    db.exec('DELETE FROM other_deductions'); const io = db.prepare('INSERT INTO other_deductions(emp_id,remarks,amount) VALUES(?,?,?)');
    for (let r = 2; r < Math.min(md.length, 400); r++) { const v = md[r]; if (v && /^\d+/.test(str(v[25])) && num(v[27])) { io.run(idv(v[25]), str(v[26]), num(v[27])); rep.others++; } }
    // rates: blocks headed "Rates 2023 & 2024", "Rates 2022", ...; the Finance sheet uses the 2025 block for 2026 as well
    db.exec('DELETE FROM rates'); const irt = db.prepare('INSERT OR REPLACE INTO rates(year,designation,fare,daily,ex,ovn) VALUES(?,?,?,?,?,?)');
    let years = [];
    for (let r = 1; r < Math.min(md.length, 90); r++) {
      const v = md[r]; if (!v) continue; const t = str(v[9]), m = /rates\s+(\d{4})(?:\s*&\s*(\d{4}))?/i.exec(t);
      if (m) { years = [Number(m[1])]; if (m[2]) years.push(Number(m[2])); continue; }
      const fare = num(v[10]), daily = num(v[11]), ex = num(v[12]), on = num(v[13]);
      if (!t || !years.length || /^designation$/i.test(t) || fare == null || daily == null) continue;
      for (const y of years) { irt.run(y, t, fare, daily || 0, ex || 0, on || 0); rep.rates++; }
    }
    if (!db.prepare('SELECT 1 FROM rates WHERE year=2026').get()) rep.rates += db.prepare('INSERT INTO rates(year,designation,fare,daily,ex,ovn) SELECT 2026,designation,fare,daily,ex,ovn FROM rates WHERE year=2025').run().changes;

    if (sheets.Holiday) {
      db.exec('DELETE FROM holidays'); const ih = db.prepare('INSERT INTO holidays(from_date,to_date,name,kind) VALUES(?,?,?,?)'); const seen = new Set();
      for (let r = 2; r < sheets.Holiday.length; r++) { const v = sheets.Holiday[r]; if (!v) continue; const d = iso(v[3]), name = str(v[4]); if (!d || seen.has(d)) continue; seen.add(d); const [f, t] = expandRange(d, name); ih.run(f, t, name, 'public'); rep.holidays++; }
    }
    if (sheets.Audit) {
      db.exec('DELETE FROM audit_obs'); const ia = db.prepare('INSERT INTO audit_obs(month,emp_id,name,total) VALUES(?,?,?,?)');
      for (let r = 2; r < sheets.Audit.length; r++) { const v = sheets.Audit[r]; if (!v) continue; const d = iso(v[2]), id = idv(v[3]); if (!d || !/^\d+$/.test(id)) continue; ia.run(d.slice(0, 7), id, str(v[4]), num(v[5]) || 0); rep.audit++; }
    }
    if (sheets.Finance) {                                                   // wording of the letter and the two signatories
      const f = sheets.Finance, note = str((f[58] || [])[2]); if (note) { setSetting('letter_note', note); rep.letter = true; }
      const s1 = str((f[85] || [])[2]), t1 = str((f[86] || [])[2]), s2 = str((f[85] || [])[6]), t2 = str((f[86] || [])[6]);
      if (s1) { setSetting('sign1_name', s1); setSetting('sign1_title', t1); } if (s2) { setSetting('sign2_name', s2); setSetting('sign2_title', t2); }
    }
  });
  return rep;
}
module.exports = { importTemplate, expandRange, companyType };
