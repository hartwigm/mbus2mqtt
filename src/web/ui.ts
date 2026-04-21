export function loginHtml(error?: string): string {
  const msg = error
    ? `<div class="err">${error.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c] as string))}</div>`
    : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mbus2mqtt — Login</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { padding: 2rem; border: 1px solid #ccc; border-radius: 8px; min-width: 280px; }
  @media (prefers-color-scheme: dark) { .card { border-color: #444; } }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  label { display: block; font-size: .85rem; margin-bottom: .3rem; color: #666; }
  input { width: 100%; padding: .5rem; font-size: 1rem; box-sizing: border-box; border: 1px solid #aaa; border-radius: 4px; background: transparent; color: inherit; }
  button { margin-top: 1rem; width: 100%; padding: .6rem; font-size: 1rem; border: 1px solid #666; background: #f5f5f5; cursor: pointer; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { button { background: #333; color: #eee; border-color: #555; } }
  .err { padding: .5rem; margin-bottom: 1rem; background: #f8d7da; color: #721c24; border-radius: 4px; font-size: .9rem; }
  @media (prefers-color-scheme: dark) { .err { background: #3a1e22; color: #e09aa0; } }
</style>
</head>
<body>
  <form class="card" method="POST" action="/login" autocomplete="off">
    <h1>mbus2mqtt</h1>
    ${msg}
    <label for="pw">Passwort</label>
    <input id="pw" name="password" type="password" autofocus required>
    <button type="submit">Anmelden</button>
  </form>
</body>
</html>
`;
}

export const INDEX_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mbus2mqtt</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; max-width: 900px; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
  .sub { color: #888; font-size: .9rem; margin-bottom: 1rem; }
  .bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  button { padding: .5rem 1rem; border: 1px solid #666; background: #f5f5f5; cursor: pointer; border-radius: 4px; font-size: .95rem; }
  button:hover { background: #e8e8e8; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  @media (prefers-color-scheme: dark) { button { background: #333; color: #eee; border-color: #555; } button:hover { background: #444; } }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #333; } }
  th { font-weight: 600; background: rgba(0,0,0,.03); }
  @media (prefers-color-scheme: dark) { th { background: rgba(255,255,255,.05); } }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #888; }
  .ok   { color: #2a8a2a; }
  .warn { color: #c07000; }
  .err  { color: #c02020; }
  .badge { display: inline-block; padding: .1rem .4rem; border-radius: 3px; font-size: .75rem; font-weight: 600; }
  .b-found   { background: #d4edda; color: #155724; }
  .b-missing { background: #f8d7da; color: #721c24; }
  .b-new     { background: #cce5ff; color: #004085; }
  @media (prefers-color-scheme: dark) {
    .b-found   { background: #1e3a24; color: #8fd39a; }
    .b-missing { background: #3a1e22; color: #e09aa0; }
    .b-new     { background: #1e2f4a; color: #9ab8d9; }
  }
  .section { margin-top: 1.5rem; }
  .section h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
  .status { padding: .4rem .6rem; border-radius: 4px; font-size: .9rem; background: #fff3cd; color: #856404; margin-left: .5rem; }
  @media (prefers-color-scheme: dark) { .status { background: #3a3620; color: #e0d28a; } }
  .spinner { display: inline-block; width: .8rem; height: .8rem; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -1px; margin-right: .3rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h1>mbus2mqtt — <span id="prop">…</span></h1>
  <div class="sub" id="sub">Lade…</div>

  <div class="bar">
    <button id="refresh">Aktualisieren</button>
    <button id="scan">Rescan</button>
    <button id="restart">Neustart</button>
    <button id="update">Update</button>
    <span id="scan-status"></span>
    <span style="margin-left:auto"><button id="logout">Abmelden</button></span>
  </div>

  <div class="section">
    <h2>Konfigurierte Geräte</h2>
    <table id="devtable">
      <thead><tr>
        <th>Name</th><th>Medium</th><th>Port</th><th class="num">Wert</th><th>Letzte Lesung</th><th>Status</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="section" id="scan-section" style="display:none">
    <h2>Scan-Ergebnis</h2>
    <div id="scan-summary" class="sub"></div>
    <table id="scantable">
      <thead><tr>
        <th>Secondary Address</th><th>Port</th><th>Name</th><th>Status</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>

<script>
const $ = (sel) => document.querySelector(sel);
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('de-DE') : '—';
const fmtValue = (v, u) => v == null ? '—' : (Number(v).toLocaleString('de-DE', { maximumFractionDigits: 4 }) + (u ? ' ' + u : ''));

async function loadDevices() {
  const r = await fetch('/api/devices');
  const data = await r.json();
  $('#prop').textContent = data.property;
  const count = data.devices.length;
  $('#sub').textContent = count + ' Gerät(e) konfiguriert';
  const tbody = $('#devtable tbody');
  tbody.innerHTML = '';
  for (const d of data.devices) {
    const tr = document.createElement('tr');
    const statusCell = d.errors > 0
      ? '<span class="err">' + d.errors + ' Fehler</span>'
      : (d.last_read ? '<span class="ok">OK</span>' : '<span class="muted">—</span>');
    tr.innerHTML =
      '<td>' + escapeHtml(d.name) + '<br><span class="muted">' + d.secondary_address + '</span></td>' +
      '<td>' + d.medium + '</td>' +
      '<td>' + d.port + '</td>' +
      '<td class="num">' + fmtValue(d.last_value, d.last_unit) + '</td>' +
      '<td>' + fmtTime(d.last_read) + '</td>' +
      '<td>' + statusCell + '</td>';
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function startScan() {
  $('#scan').disabled = true;
  $('#refresh').disabled = true;
  $('#scan-status').innerHTML = '<span class="status"><span class="spinner"></span>Scan läuft — kann mehrere Minuten dauern</span>';
  try {
    const r = await fetch('/api/scan', { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      throw new Error(err.error || 'Scan fehlgeschlagen');
    }
    // Poll until done
    while (true) {
      await new Promise(res => setTimeout(res, 2000));
      const s = await fetch('/api/scan').then(x => x.json());
      if (s.status === 'done') {
        renderScan(s);
        break;
      }
      if (s.status === 'error') {
        $('#scan-status').innerHTML = '<span class="status err">Fehler: ' + escapeHtml(s.error || 'unbekannt') + '</span>';
        break;
      }
      const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
      $('#scan-status').innerHTML = '<span class="status"><span class="spinner"></span>Scan läuft… ' + elapsed + 's</span>';
    }
  } catch (e) {
    $('#scan-status').innerHTML = '<span class="status err">' + escapeHtml(e.message) + '</span>';
  } finally {
    $('#scan').disabled = false;
    $('#refresh').disabled = false;
    await loadDevices();
  }
}

function renderScan(job) {
  $('#scan-section').style.display = '';
  const rows = [];
  let foundCount = 0, missingCount = 0, newCount = 0;
  for (const entry of job.entries) {
    let badge = '';
    if (entry.state === 'found')   { badge = '<span class="badge b-found">✓ gefunden</span>';   foundCount++; }
    if (entry.state === 'missing') { badge = '<span class="badge b-missing">✗ nicht gefunden</span>'; missingCount++; }
    if (entry.state === 'new')     { badge = '<span class="badge b-new">+ neu</span>';          newCount++; }
    rows.push(
      '<tr>' +
      '<td>' + entry.secondary_address + '</td>' +
      '<td>' + (entry.port || '—') + '</td>' +
      '<td>' + escapeHtml(entry.name || '') + '</td>' +
      '<td>' + badge + '</td>' +
      '</tr>'
    );
  }
  $('#scantable tbody').innerHTML = rows.join('');
  const elapsed = job.finished_at
    ? Math.round((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000)
    : null;
  $('#scan-summary').textContent =
    foundCount + ' gefunden, ' + missingCount + ' fehlend, ' + newCount + ' neu' +
    (elapsed !== null ? ' (Dauer ' + elapsed + 's)' : '');
  $('#scan-status').innerHTML = '<span class="status ok">Scan abgeschlossen</span>';
}

$('#refresh').addEventListener('click', loadDevices);
$('#scan').addEventListener('click', startScan);
$('#logout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login';
});

async function waitForServer(maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('/api/devices', { cache: 'no-store' });
      if (r.ok) return true;
      if (r.status === 401) { location.href = '/login'; return true; }
    } catch (_) { /* server down, keep polling */ }
    await new Promise(res => setTimeout(res, 1500));
  }
  return false;
}

$('#restart').addEventListener('click', async () => {
  if (!confirm('Dienst neu starten?')) return;
  $('#scan-status').innerHTML = '<span class="status"><span class="spinner"></span>Neustart läuft…</span>';
  await fetch('/api/restart', { method: 'POST' }).catch(() => {});
  const ok = await waitForServer(60000);
  if (ok) {
    $('#scan-status').innerHTML = '<span class="status ok">Dienst läuft wieder</span>';
    await loadDevices();
  } else {
    $('#scan-status').innerHTML = '<span class="status err">Dienst antwortet nicht — bitte manuell prüfen</span>';
  }
});

$('#update').addEventListener('click', async () => {
  if (!confirm('mbus2mqtt von GitHub aktualisieren und neu starten?\\n(Kann 1–3 Minuten dauern)')) return;
  $('#scan-status').innerHTML = '<span class="status"><span class="spinner"></span>Update läuft — Dienst wird gestoppt, gebaut und neu gestartet…</span>';
  await fetch('/api/update', { method: 'POST' }).catch(() => {});
  const ok = await waitForServer(5 * 60 * 1000);
  if (ok) {
    $('#scan-status').innerHTML = '<span class="status ok">Update abgeschlossen — Dienst läuft</span>';
    await loadDevices();
  } else {
    $('#scan-status').innerHTML = '<span class="status err">Update-Timeout — per SSH prüfen: <code>journalctl -u mbus2mqtt -f</code></span>';
  }
});

// On load: show devices + any recent scan result
loadDevices().catch(e => $('#sub').textContent = 'Fehler: ' + e.message);
fetch('/api/scan').then(r => r.json()).then(s => {
  if (s.status === 'done' || s.status === 'running') renderScan(s);
});
</script>
</body>
</html>
`;
