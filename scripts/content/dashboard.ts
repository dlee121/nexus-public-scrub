#!/usr/bin/env bun
/**
 * Nexus Content Dashboard
 * Serves a web UI for managing the content pipeline.
 * Usage: bun scripts/content/dashboard.ts [--port 4640]
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { listQueue, queueStats, getArticle, updateArticle } from "./queue.ts";
import { loadConfig, QUEUE_DIR, PUBLISHED_DIR } from "./config.ts";
import { publishArticle } from "./wordpress.ts";
import type { Article } from "./types.ts";

const PORT = parseInt(process.argv.find((a) => a.match(/^\d{4,5}$/)) ?? "4640");
const CORE_PATH = join(import.meta.dir, "../..");

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getPublishedArticles(): Promise<Article[]> {
  if (!existsSync(PUBLISHED_DIR)) return [];
  const files = await readdir(PUBLISHED_DIR);
  const articles: Article[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(PUBLISHED_DIR, f), "utf-8");
      articles.push(JSON.parse(raw) as Article);
    } catch {}
  }
  return articles.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

async function checkWpConnectivity(url: string, username: string, appPassword: string): Promise<boolean> {
  if (url.includes("PLACEHOLDER")) return false;
  try {
    const auth = Buffer.from(`${username}:${appPassword}`).toString("base64");
    const res = await fetch(`${url}/wp-json/wp/v2/posts?per_page=1`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getLastRunTime(): Promise<string | null> {
  const logPath = join(CORE_PATH, "data/content/logs/daily.log");
  if (!existsSync(logPath)) return null;
  try {
    const stat = await import("fs/promises").then((m) => m.stat(logPath));
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

function triggerPipelineRun(command: string): void {
  const proc = Bun.spawn(
    ["bun", join(CORE_PATH, "scripts/content/pipeline.ts"), ...command.split(" ")],
    { stdout: "ignore", stderr: "ignore", cwd: CORE_PATH }
  );
  proc.unref();
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexus Content</title>
<style>
  :root {
    --bg: #0d0d0d; --surface: #161616; --border: #262626;
    --text: #e8e8e8; --muted: #666; --accent: #7c6af7;
    --green: #22c55e; --red: #ef4444; --yellow: #f59e0b;
    --blue: #3b82f6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 'Inter', system-ui, sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px; border-bottom: 1px solid var(--border);
    background: var(--surface); position: sticky; top: 0; z-index: 10;
  }
  .topbar h1 { font-size: 15px; font-weight: 600; letter-spacing: .02em; }
  .topbar .status-row { display: flex; align-items: center; gap: 16px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dot.green { background: var(--green); }
  .dot.red { background: var(--red); }
  .dot.yellow { background: var(--yellow); }

  .main { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
  .card h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 14px; }

  .stat-big { font-size: 32px; font-weight: 700; line-height: 1; }
  .stat-label { color: var(--muted); font-size: 12px; margin-top: 4px; }

  .pipeline-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .pipeline-stat { text-align: center; padding: 12px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); }
  .pipeline-stat .num { font-size: 24px; font-weight: 700; }
  .pipeline-stat .lbl { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .num.pending { color: var(--yellow); }
  .num.ready { color: var(--blue); }
  .num.published { color: var(--green); }
  .num.failed { color: var(--red); }

  table { width: 100%; border-collapse: collapse; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 10px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .badge.ready { background: rgba(59,130,246,.15); color: var(--blue); }
  .badge.pending { background: rgba(245,158,11,.15); color: var(--yellow); }
  .badge.published { background: rgba(34,197,94,.15); color: var(--green); }
  .badge.failed { background: rgba(239,68,68,.15); color: var(--red); }

  .site-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(124,106,247,.15); color: var(--accent); }

  button {
    cursor: pointer; border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 14px; font-size: 12px; font-weight: 500;
    background: var(--surface); color: var(--text); transition: all .15s;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { opacity: .85; color: #fff; }
  button.sm { padding: 4px 10px; font-size: 11px; }
  button:disabled { opacity: .4; cursor: not-allowed; }

  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }

  .site-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .site-row:last-child { border-bottom: none; }
  .site-name { font-weight: 500; flex: 1; }
  .site-domain { color: var(--muted); font-size: 12px; }

  .section-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }

  .empty { text-align: center; padding: 32px; color: var(--muted); font-size: 13px; }

  .alert { padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .alert.warn { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.3); color: var(--yellow); }
  .alert.error { background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3); color: var(--red); }

  .last-run { color: var(--muted); font-size: 12px; }

  .tab-bar { display: flex; gap: 2px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--muted); border-bottom: 2px solid transparent; transition: all .15s; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab:hover:not(.active) { color: var(--text); }

  .panel { display: none; }
  .panel.active { display: block; }

  #toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px; font-size: 13px; transform: translateY(80px); opacity: 0; transition: all .2s; pointer-events: none; z-index: 100; }
  #toast.show { transform: translateY(0); opacity: 1; }

  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 4px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .truncate { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>

<div class="topbar">
  <h1>⚡ Nexus Content</h1>
  <div class="status-row">
    <span id="pipeline-health" style="font-size:12px;color:var(--muted)">Loading…</span>
    <span id="last-run-label" class="last-run"></span>
    <button class="primary" onclick="triggerRun('daily')">▶ Run Pipeline</button>
  </div>
</div>

<div class="main">

  <div id="alerts-container"></div>

  <div class="tab-bar">
    <div class="tab active" onclick="switchTab('pipeline')">Pipeline</div>
    <div class="tab" onclick="switchTab('articles')">Articles</div>
    <div class="tab" onclick="switchTab('sites')">Sites</div>
    <div class="tab" onclick="switchTab('controls')">Controls</div>
  </div>

  <!-- PIPELINE TAB -->
  <div id="tab-pipeline" class="panel active">
    <div class="grid2">
      <div class="card">
        <h2>Queue Status</h2>
        <div class="pipeline-stats">
          <div class="pipeline-stat"><div class="num pending" id="stat-pending">–</div><div class="lbl">Pending</div></div>
          <div class="pipeline-stat"><div class="num ready" id="stat-ready">–</div><div class="lbl">Ready</div></div>
          <div class="pipeline-stat"><div class="num published" id="stat-published">–</div><div class="lbl">Published</div></div>
          <div class="pipeline-stat"><div class="num failed" id="stat-failed">–</div><div class="lbl">Failed</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Sites</h2>
        <div id="sites-health-mini"></div>
      </div>
    </div>

    <div class="card">
      <h2>Ready for Review</h2>
      <div id="ready-articles-table">
        <div class="empty"><span class="spinner"></span> Loading…</div>
      </div>
    </div>
  </div>

  <!-- ARTICLES TAB -->
  <div id="tab-articles" class="panel">
    <div style="display:flex;gap:10px;margin-bottom:16px;align-items:center;">
      <select id="filter-site" onchange="loadArticles()" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;">
        <option value="">All Sites</option>
        <option value="ai-tools">bizrunbook.com</option>
        <option value="productivity">autoflowguide.com</option>
        <option value="saas">saassleuth.com</option>
        <option value="medium">Medium</option>
      </select>
      <select id="filter-status" onchange="loadArticles()" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;">
        <option value="">All Status</option>
        <option value="ready">Ready</option>
        <option value="pending">Pending</option>
        <option value="published">Published</option>
        <option value="failed">Failed</option>
      </select>
      <span style="margin-left:auto;color:var(--muted);font-size:12px;" id="articles-count"></span>
    </div>
    <div class="card">
      <div id="articles-table"><div class="empty"><span class="spinner"></span> Loading…</div></div>
    </div>
  </div>

  <!-- SITES TAB -->
  <div id="tab-sites" class="panel">
    <div class="card">
      <h2>WordPress Connectivity</h2>
      <div id="sites-detail"></div>
    </div>
  </div>

  <!-- CONTROLS TAB -->
  <div id="tab-controls" class="panel">
    <div class="grid2">
      <div class="card">
        <h2>Pipeline Controls</h2>
        <div style="margin-bottom:16px;">
          <p style="color:var(--muted);font-size:12px;margin-bottom:12px;">Manual pipeline triggers. Daily cron runs automatically at 2pm ET.</p>
          <div class="btn-row">
            <button onclick="triggerRun('daily')" class="primary">▶ Daily Run (all sites)</button>
            <button onclick="triggerRun('topics ai-tools')">Topics: bizrunbook</button>
            <button onclick="triggerRun('topics productivity')">Topics: autoflowguide</button>
            <button onclick="triggerRun('topics saas')">Topics: saassleuth</button>
          </div>
        </div>
        <div>
          <div class="section-title" style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Medium</div>
          <div class="btn-row" style="margin-top:8px;">
            <button onclick="triggerRun('medium --write --publish')">▶ Write + Publish Medium</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>Schedule</h2>
        <div style="font-size:13px;line-height:2;">
          <div>🕑 <strong>2:00 PM ET daily</strong> — Generate + write + publish all sites</div>
          <div>🕑 <strong>2:00 PM ET Tuesdays</strong> — Write + publish Medium article</div>
        </div>
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px;">Last Pipeline Run</div>
          <div id="last-run-time" style="font-size:13px;"></div>
        </div>
      </div>
    </div>
  </div>

</div>

<div id="toast"></div>

<script>
const SITE_NAMES = { 'ai-tools': 'bizrunbook.com', productivity: 'autoflowguide.com', saas: 'saassleuth.com', medium: 'Medium' };

let state = {};

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--red)' : 'var(--green)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector(\`.tab[onclick="switchTab('${name}')"]\`).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'articles') loadArticles();
  if (name === 'sites') loadSites();
}

async function loadState() {
  try {
    const res = await fetch('/api/status');
    state = await res.json();

    // Queue stats
    document.getElementById('stat-pending').textContent = state.queue.pending ?? 0;
    document.getElementById('stat-ready').textContent = state.queue.ready ?? 0;
    document.getElementById('stat-published').textContent = state.queue.published ?? 0;
    document.getElementById('stat-failed').textContent = state.queue.failed ?? 0;

    // Health
    const allOk = state.sites.every(s => s.connected);
    document.getElementById('pipeline-health').innerHTML =
      '<span class="dot ' + (allOk ? 'green' : 'yellow') + '"></span> ' +
      (allOk ? 'All systems OK' : 'Check sites');

    // Last run
    if (state.lastRun) {
      const d = new Date(state.lastRun);
      document.getElementById('last-run-label').textContent = 'Last run: ' + d.toLocaleString();
      document.getElementById('last-run-time').textContent = d.toLocaleString();
    } else {
      document.getElementById('last-run-time').textContent = 'Never run yet';
    }

    // Sites mini
    const mini = state.sites.map(s =>
      \`<div class="site-row">
        <div class="site-name">\${s.name}<br><span class="site-domain">\${s.domain}</span></div>
        <span class="dot \${s.connected ? 'green' : (s.configured ? 'yellow' : 'red')}"></span>
        <span style="font-size:11px;color:var(--muted)">\${s.connected ? 'Connected' : (s.configured ? 'Unreachable' : 'Not configured')}</span>
      </div>\`
    ).join('');
    document.getElementById('sites-health-mini').innerHTML = mini;

    // Alerts
    const alerts = [];
    if (state.queue.failed > 0) alerts.push({ type: 'error', msg: \`\${state.queue.failed} article(s) failed to generate or publish.\` });
    const unconfigured = state.sites.filter(s => !s.configured);
    if (unconfigured.length) alerts.push({ type: 'warn', msg: \`WordPress not configured for: \${unconfigured.map(s => s.domain).join(', ')} — add credentials to complete setup.\` });
    document.getElementById('alerts-container').innerHTML = alerts.map(a =>
      \`<div class="alert \${a.type}">\${a.msg}</div>\`
    ).join('');

    // Ready articles
    await loadReadyArticles();
  } catch (e) {
    document.getElementById('pipeline-health').innerHTML = '<span class="dot red"></span> Dashboard error';
  }
}

async function loadReadyArticles() {
  const res = await fetch('/api/articles?status=ready');
  const articles = await res.json();
  const container = document.getElementById('ready-articles-table');
  if (!articles.length) {
    container.innerHTML = '<div class="empty">No drafts ready for review. Run the pipeline to generate articles.</div>';
    return;
  }
  container.innerHTML = \`<table>
    <tr><th>Title</th><th>Site</th><th>Words</th><th>Created</th><th>Actions</th></tr>
    \${articles.map(a => \`<tr>
      <td><div class="truncate" title="\${a.title}">\${a.title}</div></td>
      <td><span class="site-badge">\${SITE_NAMES[a.siteId] || a.siteId}</span></td>
      <td>\${a.wordCount?.toLocaleString()}</td>
      <td>\${new Date(a.createdAt).toLocaleDateString()}</td>
      <td>
        <div class="btn-row">
          <button class="sm" onclick="viewArticle('\${a.id}')">Preview</button>
          <button class="sm primary" onclick="publishDraft('\${a.id}', this)">Publish</button>
        </div>
      </td>
    </tr>\`).join('')}
  </table>\`;
}

async function loadArticles() {
  const siteFilter = document.getElementById('filter-site').value;
  const statusFilter = document.getElementById('filter-status').value;
  const params = new URLSearchParams();
  if (siteFilter) params.set('siteId', siteFilter);
  if (statusFilter) params.set('status', statusFilter);

  const res = await fetch('/api/articles?' + params);
  const articles = await res.json();
  document.getElementById('articles-count').textContent = articles.length + ' articles';

  const container = document.getElementById('articles-table');
  if (!articles.length) {
    container.innerHTML = '<div class="empty">No articles found.</div>';
    return;
  }
  container.innerHTML = \`<table>
    <tr><th>Title</th><th>Site</th><th>Status</th><th>Words</th><th>Date</th><th></th></tr>
    \${articles.map(a => \`<tr>
      <td><div class="truncate" title="\${a.title}">\${a.title}</div></td>
      <td><span class="site-badge">\${SITE_NAMES[a.siteId] || a.siteId}</span></td>
      <td><span class="badge \${a.status}">\${a.status}</span></td>
      <td>\${a.wordCount?.toLocaleString()}</td>
      <td>\${new Date(a.createdAt).toLocaleDateString()}</td>
      <td>
        <div class="btn-row">
          \${a.status === 'ready' ? \`<button class="sm primary" onclick="publishDraft('\${a.id}', this)">Publish</button>\` : ''}
          \${a.publishedUrl ? \`<a href="\${a.publishedUrl}" target="_blank"><button class="sm">View ↗</button></a>\` : ''}
        </div>
      </td>
    </tr>\`).join('')}
  </table>\`;
}

async function loadSites() {
  const res = await fetch('/api/sites');
  const sites = await res.json();
  const container = document.getElementById('sites-detail');
  container.innerHTML = sites.map(s => \`
    <div class="site-row">
      <div style="flex:1">
        <div class="site-name">\${s.name}</div>
        <div style="color:var(--muted);font-size:12px;">\${s.domain} · \${s.niche}</div>
      </div>
      <div style="text-align:right">
        <span class="dot \${s.connected ? 'green' : (s.configured ? 'yellow' : 'red')}" style="margin-right:6px;"></span>
        <span style="font-size:12px;color:var(--muted)">\${s.connected ? 'WordPress connected' : (s.configured ? 'Cannot reach WordPress' : 'Credentials not set')}</span>
      </div>
    </div>
  \`).join('');
}

async function publishDraft(id, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch('/api/publish/' + id, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      toast('Published successfully');
      await loadState();
      await loadArticles();
    } else {
      toast('Publish failed: ' + data.error, true);
      btn.disabled = false;
      btn.textContent = 'Publish';
    }
  } catch {
    toast('Publish failed', true);
    btn.disabled = false;
    btn.textContent = 'Publish';
  }
}

async function triggerRun(cmd) {
  toast('Pipeline triggered…');
  await fetch('/api/run', { method: 'POST', body: JSON.stringify({ command: cmd }), headers: { 'Content-Type': 'application/json' } });
  setTimeout(loadState, 3000);
}

function viewArticle(id) {
  window.open('/article/' + id, '_blank');
}

// Load on start
loadState();
// Refresh every 30s
setInterval(loadState, 30000);
</script>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);

    // Dashboard HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(dashboardHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Article preview
    if (url.pathname.startsWith("/article/")) {
      const id = url.pathname.slice("/article/".length);
      const article = await getArticle(id);
      if (!article) return new Response("Not found", { status: 404 });
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${article.title}</title>
        <style>body{font:16px/1.7 Georgia,serif;max-width:740px;margin:40px auto;padding:0 20px;color:#222;}
        h1{font-size:28px;margin-bottom:8px;}h2{font-size:20px;margin:28px 0 8px;}
        .meta{color:#888;font-size:13px;margin-bottom:32px;}
        </style></head><body>
        <h1>${article.title}</h1>
        <div class="meta">${article.siteId} · ${article.wordCount} words · ${new Date(article.createdAt).toLocaleDateString()}</div>
        ${article.content}
        </body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // API: overall status
    if (url.pathname === "/api/status") {
      const [queueData, config, lastRun] = await Promise.all([
        queueStats(),
        loadConfig(),
        getLastRunTime(),
      ]);

      const sites = await Promise.all(
        Object.values(config.sites).map(async (site) => {
          const configured = !site.wordpress.username.includes("PLACEHOLDER");
          const connected = configured
            ? await checkWpConnectivity(site.wordpress.url, site.wordpress.username, site.wordpress.appPassword)
            : false;
          return { id: site.id, name: site.name, domain: site.domain, niche: site.niche, configured, connected };
        })
      );

      return json({ queue: queueData, sites, lastRun });
    }

    // API: articles list
    if (url.pathname === "/api/articles") {
      const status = url.searchParams.get("status") as any;
      const siteId = url.searchParams.get("siteId") ?? undefined;
      const articles = await listQueue({ status, siteId });
      // Omit full HTML content from list for performance
      return json(articles.map(({ content: _c, ...a }) => a));
    }

    // API: published articles
    if (url.pathname === "/api/published") {
      const articles = await getPublishedArticles();
      return json(articles.map(({ content: _c, ...a }) => a));
    }

    // API: sites status
    if (url.pathname === "/api/sites") {
      const config = await loadConfig();
      const sites = await Promise.all(
        Object.values(config.sites).map(async (site) => {
          const configured = !site.wordpress.username.includes("PLACEHOLDER");
          const connected = configured
            ? await checkWpConnectivity(site.wordpress.url, site.wordpress.username, site.wordpress.appPassword)
            : false;
          return { id: site.id, name: site.name, domain: site.domain, niche: site.niche, configured, connected };
        })
      );
      return json(sites);
    }

    // API: publish a single article
    if (url.pathname.startsWith("/api/publish/") && req.method === "POST") {
      const id = url.pathname.slice("/api/publish/".length);
      const article = await getArticle(id);
      if (!article) return json({ ok: false, error: "Article not found" }, 404);
      try {
        const published = await publishArticle(article);
        await updateArticle(published);
        return json({ ok: true, url: published.publishedUrl });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // API: trigger pipeline run
    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = await req.json() as { command?: string };
      const command = body.command ?? "daily";
      triggerPipelineRun(command);
      return json({ ok: true, command });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n⚡ Nexus Content Dashboard`);
console.log(`   → http://localhost:${PORT}\n`);
