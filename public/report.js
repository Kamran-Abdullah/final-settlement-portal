'use strict';
// Report window: pick a report, filter it, and watch it update in real time (cheque numbers, amounts ...).
const R = { key: 'cheques', state: '', source: '', q: '', from: '', to: '', cheque: '', stage: '', live: true, timer: null, last: null, list: null };
try { Object.assign(R, JSON.parse(localStorage.getItem('ufsa_report') || '{}'), { timer: null, last: null, list: null }); } catch { /* no storage */ }
const saveR = () => { try { localStorage.setItem('ufsa_report', JSON.stringify({ key: R.key, state: R.state, source: R.source, live: R.live })); } catch { /* ignore */ } };
const rQuery = (extra = '') => `state=${encodeURIComponent(R.state)}&source=${encodeURIComponent(R.source)}&q=${encodeURIComponent(R.q)}&from=${R.from}&to=${R.to}&cheque=${R.cheque}&stage=${encodeURIComponent(R.stage)}${extra}`;

async function viewReport(section, parts) {
  if (parts[0]) R.key = parts[0];
  if (!R.list) R.list = await api('GET', '/api/reports');
  if (!R.list.some((x) => x.key === R.key)) R.key = R.list[0].key;
  saveR();
  const sel = (id, label, opts, v) => `<label>${label}<select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  $('#view').innerHTML = `<div class="row between" style="margin-bottom:14px"><div><h2>Report</h2><div class="muted">Pick a report. The figures are read from the live settlements every time.</div></div></div>
    <div class="rpt-pick">${R.list.map((x) => `<button class="${x.key === R.key ? 'on' : ''}" data-act="rpt_pick" data-k="${x.key}"><b>${esc(x.title)}</b><small>${esc(x.note)}</small></button>`).join('')}</div>
    <div class="card"><div class="grid rpt-f">
      ${R.key === 'status' ? sel('rf_stage', 'Stage', [['', 'All'], ['Not started', 'Not started'], ['Waiting for HR', 'Waiting for HR'], ['Waiting for Marketing', 'Waiting for Marketing'], ['Ready for Finance', 'Ready for Finance'], ['Approved', 'Approved']], R.stage)
      : sel('rf_state', 'Settlements', [['', 'Open + approved'], ['open', 'Open (in progress)'], ['approved', 'Approved'], ['cancelled', 'Cancelled']], R.state)}
      ${sel('rf_source', 'Payroll', [['', 'All payrolls'], ['marketing', 'Marketing'], ['healthcare', 'Healthcare'], ['admin', 'Admin'], ['factory', 'Factory']], R.source)}
      ${R.key === 'cheques' ? sel('rf_cheque', 'Cheques', [['', 'All'], ['missing', 'Missing only'], ['entered', 'Entered only']], R.cheque) : ''}
      ${R.key === 'status' ? '' : `<label>From (approved / last change)<input id="rf_from" type="date" value="${esc(R.from)}"></label><label>To<input id="rf_to" type="date" value="${esc(R.to)}"></label>`}
      <label>Search ID or name<input id="rf_q" value="${esc(R.q)}" placeholder="ID or name"></label></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="rpt_refresh">${IC.refresh} Refresh</button>
        <label class="row" style="gap:6px;font-weight:500"><input type="checkbox" id="rf_live" ${R.live ? 'checked' : ''}> Live (every 10 s)</label>
        <button class="btn" data-act="rpt_xlsx">Export Excel</button><button class="btn" data-act="rpt_copy">Copy</button><button class="btn" data-act="rpt_print">Print</button><span id="rpt_when" class="muted"></span></div></div>
    <div class="card flush" id="rpt_card"><div class="empty">Loading...</div></div>`;
  const re = () => { R.state = $('#rf_state') ? $('#rf_state').value : R.state; R.stage = $('#rf_stage') ? $('#rf_stage').value : ''; R.source = $('#rf_source').value; R.cheque = $('#rf_cheque') ? $('#rf_cheque').value : ''; R.from = $('#rf_from') ? $('#rf_from').value : ''; R.to = $('#rf_to') ? $('#rf_to').value : ''; saveR(); loadReport(); };
  ['rf_state', 'rf_stage', 'rf_source', 'rf_cheque', 'rf_from', 'rf_to'].forEach((id) => { const el = $('#' + id); if (el) el.addEventListener('change', re); });
  let t = null; $('#rf_q').addEventListener('input', (e) => { R.q = e.target.value.trim(); clearTimeout(t); t = setTimeout(loadReport, 250); });
  $('#rf_live').addEventListener('change', (e) => { R.live = e.target.checked; saveR(); schedule(); });
  await loadReport(); schedule();
}
function schedule() {
  clearInterval(R.timer); R.timer = null; if (!R.live) return;
  R.timer = setInterval(() => { if (!/^#\/report/.test(location.hash)) { clearInterval(R.timer); R.timer = null; return; } if (!document.querySelector('.modal, .overlay')) loadReport(true); }, 10000);
}
async function loadReport(quiet) {
  const card = $('#rpt_card'); if (!card) return;
  try {
    const d = await api('GET', `/api/reports/${R.key}?${rQuery()}`); if (!$('#rpt_card')) return; R.last = d;
    const cell = (c, v) => (c.type === 'num' ? `<td class="n">${v === '' || v == null ? '' : fmt(v)}</td>` : c.type === 'date' ? `<td>${esc(fdate(v) || '')}</td>` : `<td>${esc(v == null ? '' : String(v))}</td>`);
    const flag = (r) => (r.status === 'Cheque missing' ? ' class="rpt-warn"' : '');
    card.innerHTML = d.rows.length ? `<div class="card-h"><div><h3>${esc(d.title)}</h3><span class="muted">${d.count} row(s)</span></div></div><div class="scroll"><table class="rpt"><thead><tr>${d.columns.map((c) => `<th class="${c.type === 'num' ? 'n' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
      ${d.rows.map((r) => `<tr${flag(r)}>${d.columns.map((c) => cell(c, r[c.k])).join('')}</tr>`).join('')}</tbody>
      ${Object.keys(d.totals).length ? `<tfoot><tr class="total">${d.columns.map((c, i) => (i === 0 ? '<td>Total</td>' : c.type === 'num' ? `<td class="n">${fmt(d.totals[c.k])}</td>` : '<td></td>')).join('')}</tr></tfoot>` : ''}</table></div>`
      : '<div class="empty">Nothing matches these filters.</div>';
    $('#rpt_when').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) { if (!quiet) card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
ACT.rpt_pick = (a) => { R.key = a.dataset.k; R.cheque = ''; saveR(); location.hash = '#/report/' + R.key; route(); };
ACT.rpt_refresh = () => loadReport();
ACT.rpt_xlsx = () => { const a = document.createElement('a'); a.href = `/api/reports/${R.key}?${rQuery('&format=xlsx')}`; a.download = `report-${R.key}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); };
ACT.rpt_copy = async () => {
  const d = R.last; if (!d) return;
  const text = [d.columns.map((c) => c.label).join('\t'), ...d.rows.map((r) => d.columns.map((c) => (r[c.k] == null ? '' : r[c.k])).join('\t'))].join('\n');
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Copied', 'ok'); } catch { toast('Copy is not possible here', 'err'); } t.remove(); }
};
ACT.rpt_print = () => { document.body.classList.add('printing-report'); setTimeout(() => { window.print(); setTimeout(() => document.body.classList.remove('printing-report'), 500); }, 80); };
