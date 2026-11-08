// Self-contained live dashboard served at GET / in server mode.
// It holds no data itself: it polls /status (passing ?token= if the page URL has one).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>keyhopper</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#262a33; --text:#e6e8eb; --dim:#8b919c;
          --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#7aa2f7; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --card:#fff; --line:#e3e5e8; --text:#1c1f24; --dim:#6a707a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:1100px; margin:0 auto; padding:24px 20px 48px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  h1 { font-size:20px; margin:0; } h1 span { color:var(--accent); }
  .meta { color:var(--dim); font-size:13px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .tile b { display:block; font-size:22px; } .tile small { color:var(--dim); }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:20px; overflow:auto; }
  h2 { font-size:14px; margin:0; padding:12px 14px; border-bottom:1px solid var(--line); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:8px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-flex; align-items:center; gap:6px; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .ready .dot { background:var(--ok); } .cooling .dot { background:var(--warn); } .disabled .dot { background:var(--bad); }
  .dim { color:var(--dim); } .err { color:var(--bad); }
  code { font:12px ui-monospace,SFMono-Regular,Consolas,monospace; }
  #error { color:var(--bad); margin-bottom:12px; }
</style>
</head>
<body>
<main>
  <header><h1>key<span>hopper</span></h1><span class="meta" id="meta">connecting…</span></header>
  <div id="error"></div>
  <div class="tiles" id="tiles"></div>
  <section><h2>Keys</h2><table id="keys"></table></section>
  <section><h2>Recent requests</h2><table id="recent"></table></section>
</main>
<script>
const token = new URLSearchParams(location.search).get('token');
const fmt = (ms) => { if (ms == null) return ''; if (ms < 1000) return Math.round(ms) + 'ms';
  const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const time = (iso) => iso ? new Date(iso).toLocaleTimeString() : '';
async function tick() {
  try {
    const r = await fetch('/status' + (token ? '?token=' + encodeURIComponent(token) : ''));
    if (r.status === 401) throw new Error('Unauthorized — open this page as /?token=YOUR_KEYHOPPER_TOKEN');
    const d = await r.json();
    document.getElementById('error').textContent = '';
    const keys = d.keys, recent = d.recent;
    const count = (s) => keys.filter((k) => k.state === s).length;
    const okReq = recent.filter((x) => x.ok).length;
    document.getElementById('meta').textContent = 'strategy: ' + d.strategy + ' · updated ' + new Date().toLocaleTimeString();
    document.getElementById('tiles').innerHTML = [
      [count('ready'), 'ready'], [count('cooling'), 'cooling down'], [count('disabled'), 'disabled'],
      [recent.length ? Math.round(okReq / recent.length * 100) + '%' : '–', 'success (last ' + recent.length + ')'],
      [keys.reduce((a, k) => a + k.rateLimited, 0), 'rate limits hit'],
    ].map(([v, l]) => '<div class="tile"><b>' + v + '</b><small>' + l + '</small></div>').join('');
    document.getElementById('keys').innerHTML =
      '<tr><th>Provider / model</th><th>Key</th><th>State</th><th>Back in</th><th>Requests left</th><th>Tokens left</th><th>OK</th><th>429s</th><th>Failed</th><th>Last used</th><th>Last error</th></tr>' +
      keys.map((k) => '<tr><td>' + esc(k.provider) + ' <span class="dim">/ ' + esc(k.model) + '</span></td>' +
        '<td><code>' + esc(k.key) + '</code></td>' +
        '<td class="' + k.state + '"><span class="pill"><span class="dot"></span>' + k.state + '</span></td>' +
        '<td>' + (k.state === 'cooling' ? fmt(k.cooldownMs) + ' <span class="dim">(' + time(k.resetsAt) + ')</span>' : k.state === 'disabled' ? esc(k.disabledReason) : '<span class="dim">–</span>') + '</td>' +
        '<td>' + (k.requestsLeft != null ? k.requestsLeft + (k.requestsLimit != null ? '/' + k.requestsLimit : '') + (k.requestsResetMs ? ' <span class="dim">reset ' + fmt(k.requestsResetMs) + '</span>' : '') : '<span class="dim">–</span>') + '</td>' +
        '<td>' + (k.tokensLeft != null ? k.tokensLeft + (k.tokensLimit != null ? '/' + k.tokensLimit : '') : '<span class="dim">–</span>') + '</td>' +
        '<td>' + k.ok + '</td><td>' + k.rateLimited + '</td><td>' + k.failed + '</td>' +
        '<td class="dim">' + time(k.lastUsed) + '</td>' +
        '<td class="err" title="' + esc(k.lastError) + '">' + esc((k.lastError || '').slice(0, 60)) + '</td></tr>').join('');
    document.getElementById('recent').innerHTML =
      '<tr><th>Time</th><th>Result</th><th>Answered by</th><th>Key</th><th>Latency</th><th>Failovers</th></tr>' +
      (recent.length ? recent.map((x) => '<tr><td class="dim">' + time(x.time) + '</td>' +
        '<td class="' + (x.ok ? 'ready' : 'disabled') + '"><span class="pill"><span class="dot"></span>' + (x.ok ? 'ok' : 'failed') + '</span></td>' +
        '<td>' + (x.ok ? esc(x.provider) + ' <span class="dim">/ ' + esc(x.model) + '</span>' : '<span class="err">' + esc(x.error) + '</span>') + '</td>' +
        '<td><code>' + esc(x.key || '') + '</code></td><td>' + (x.ms != null ? x.ms + 'ms' : '') + '</td><td>' + (x.failovers || '') + '</td></tr>').join('')
        : '<tr><td colspan="6" class="dim">No requests yet</td></tr>');
  } catch (e) { document.getElementById('error').textContent = e.message; }
}
tick(); setInterval(tick, 2000);
</script>
</body>
</html>`;
