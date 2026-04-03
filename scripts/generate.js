#!/usr/bin/env node
// Fetches the latest workflow run conclusion for each plugin/branch/workflow
// combination and writes a pre-grouped index.html — no client-side API calls.

import { writeFileSync } from 'fs';

const ORG = 'logstash-plugins';

const PLUGINS = [
  {
    repo: 'logstash-output-elasticsearch',
    type: 'output',
    workflows: [
      { file: 'tests.yml',                    label: 'unit tests' },
      { file: 'integration-tests.yml',         label: 'integration tests' },
      { file: 'secure-integration-tests.yml',  label: 'secure integration' },
    ],
  },
  {
    repo: 'logstash-filter-grok',
    type: 'filter',
    workflows: [
      { file: 'tests.yml', label: 'tests' },
    ],
  },
  {
    repo: 'logstash-integration-kafka',
    type: 'integration',
    workflows: [
      { file: 'tests.yml', label: 'tests' },
    ],
  },
];

// ── GitHub API ────────────────────────────────────────────────────────────────

// Matches main and version branches (e.g. 11.x, 5.2.x, 10.4, 11.4-maintenance).
// Excludes feature/fix/chore branches.
const VERSION_BRANCH = /^(main|\d+\.x|\d+\.\d+\.x|\d+\.\d+(-maintenance)?)$/;

// Sort so that main comes first, then version branches newest-first.
function sortBranches(branches) {
  return [...branches].sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return  1;
    const maj = name => parseInt(name.match(/^(\d+)/)?.[1] ?? '0', 10);
    const min = name => parseFloat(name.match(/^(\d+\.\d+)/)?.[1] ?? '0');
    return maj(b) - maj(a) || min(b) - min(a);
  });
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

// ── Version floor detection ───────────────────────────────────────────────────

// Fetch Gemfile.template from a logstash branch (the only form that exists).
async function fetchLogstashGemfile(branch) {
  const url = `https://raw.githubusercontent.com/elastic/logstash/${branch}/Gemfile.template`;
  const res = await fetch(url, { headers: HEADERS });
  return res.ok ? res.text() : null;
}

// Parse the leading major version number for a gem out of a Gemfile.template.
// Handles both "~> 11.22" and ">= 11.14.0" constraint styles.
function parseFloor(gemfile, gemName) {
  if (!gemfile) return null;
  const re = new RegExp(`["']${gemName}["'][^\\n]*?["'][~>= ]+(\\d+)\\.`);
  const m = gemfile.match(re);
  return m ? parseInt(m[1], 10) : null;
}

// Find the highest-numbered 9.N branch of elastic/logstash.
async function latestLogstash9xBranch() {
  const url = 'https://api.github.com/repos/elastic/logstash/branches?per_page=100';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const data = await res.json();
  const branches = data
    .map(b => b.name)
    .filter(n => /^9\.\d+$/.test(n))
    .sort((a, b) => parseInt(b.split('.')[1]) - parseInt(a.split('.')[1]));
  return branches[0] ?? null;
}

// Returns a map of { repoName -> minimumMajorVersion }.
// Floor = min(8.19 reference, 9.x reference) — the more inclusive of the two.
// Plugins absent from 9.x fall back to the 8.19 floor alone.
async function buildVersionFloors() {
  const [gemfile8, branch9] = await Promise.all([
    fetchLogstashGemfile('8.19'),
    latestLogstash9xBranch(),
  ]);
  const gemfile9 = branch9 ? await fetchLogstashGemfile(branch9) : null;
  console.log(`Logstash 9.x reference branch: ${branch9 ?? 'none'}`);

  return Object.fromEntries(
    PLUGINS.map(p => {
      const f8 = parseFloor(gemfile8, p.repo);
      const f9 = parseFloor(gemfile9, p.repo);
      const candidates = [f8, f9].filter(f => f !== null);
      const floor = candidates.length ? Math.min(...candidates) : 0;
      console.log(`${p.repo} version floor: ${floor} (8.19→${f8 ?? 'n/a'}, ${branch9}→${f9 ?? 'n/a'})`);
      return [p.repo, floor];
    })
  );
}

// ── Branch filtering ──────────────────────────────────────────────────────────

// Returns true if the branch has had any commits in the last 3 months.
async function hasRecentActivity(repo, branch) {
  const since = new Date();
  since.setMonth(since.getMonth() - 3);
  const url =
    `https://api.github.com/repos/${ORG}/${repo}/commits` +
    `?sha=${encodeURIComponent(branch)}&since=${since.toISOString()}&per_page=1`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function fetchBranches(repo, versionFloor) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/branches?per_page=100`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return ['main'];
  const data = await res.json();
  const candidates = data.map(b => b.name).filter(n => VERSION_BRANCH.test(n));

  const kept = await Promise.all(
    candidates.map(async name => {
      if (name === 'main') return { name, keep: true, reason: 'main' };
      const major = parseInt(name.match(/^(\d+)/)?.[1] ?? '0', 10);
      if (major >= versionFloor) return { name, keep: true, reason: `>= floor ${versionFloor}` };
      const recent = await hasRecentActivity(repo, name);
      return { name, keep: recent, reason: recent ? 'recent activity' : 'filtered out' };
    })
  );

  kept.forEach(({ name, reason }) => console.log(`  ${repo}@${name}: ${reason}`));
  return sortBranches(kept.filter(b => b.keep).map(b => b.name));
}

async function fetchConclusion(repo, workflowFile, branch) {
  const url =
    `https://api.github.com/repos/${ORG}/${repo}/actions/workflows/` +
    `${encodeURIComponent(workflowFile)}/runs` +
    `?branch=${encodeURIComponent(branch)}&per_page=1&exclude_pull_requests=true`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return 'no_status';
    const data = await res.json();
    const run = data.workflow_runs?.[0];
    if (!run) return 'no_status';
    if (run.status !== 'completed') return 'pending';
    return run.conclusion ?? 'no_status';
  } catch {
    return 'no_status';
  }
}

function rowStatus(conclusions) {
  if (conclusions.every(c => c === 'no_status')) return 'no_status';
  if (conclusions.some(c => ['failure', 'timed_out', 'startup_failure'].includes(c))) return 'failing';
  if (conclusions.every(c => ['success', 'skipped'].includes(c))) return 'passing';
  return 'no_status';
}

// ── HTML rendering ────────────────────────────────────────────────────────────

const BRANCH_SVG = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.493 2.493 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25z"/></svg>`;

const TAG_CLASS = { output: 'tag-output', filter: 'tag-filter', integration: 'tag-integration' };

function badgesHTML(repo, branch, workflows) {
  return workflows.map(w => {
    const base = `https://github.com/${ORG}/${repo}/actions/workflows/${w.file}`;
    const href = `${base}?query=branch%3A${encodeURIComponent(branch)}`;
    const img  = `${base}/badge.svg?branch=${encodeURIComponent(branch)}`;
    return `<div class="badge-item">
        <span class="badge-label">${w.label}</span>
        <a href="${href}" target="_blank" rel="noopener"><img src="${img}" alt="${w.label}"></a>
      </div>`;
  }).join('\n      ');
}

function rowHTML(plugin, branch) {
  return `<tr>
      <td>
        <div class="plugin-cell">
          <span class="plugin-type-tag ${TAG_CLASS[plugin.type]}">${plugin.type}</span>
          <span class="plugin-name"><a href="https://github.com/${ORG}/${plugin.repo}" target="_blank" rel="noopener">${plugin.repo}</a></span>
        </div>
      </td>
      <td><span class="branch-tag">${BRANCH_SVG}${branch}</span></td>
      <td><div class="badges">
        ${badgesHTML(plugin.repo, branch, plugin.workflows)}
      </div></td>
    </tr>`;
}

function groupHTML(id, label, dotClass, rows) {
  const bodyRows = rows.length
    ? rows.map(({ plugin, branch }) => rowHTML(plugin, branch)).join('\n    ')
    : `<tr class="empty-row"><td colspan="3">None</td></tr>`;
  return `<div class="group group-${dotClass}" id="group-${id}">
    <div class="group-header">
      <span class="group-label"><span class="dot"></span>${label}</span>
      <span class="count-tag">${rows.length}</span>
    </div>
    <table class="rows-table">
      <thead><tr>
        <th class="col-plugin">Plugin</th>
        <th class="col-branch">Branch</th>
        <th>Workflows</th>
      </tr></thead>
      <tbody>
    ${bodyRows}
      </tbody>
    </table>
  </div>`;
}

function renderHTML(passing, failing, noStatus, generatedAt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logstash Plugin CI Status</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface2: #21262d;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent-blue: #58a6ff;
      --green: #3fb950;
      --red: #f85149;
      --radius: 8px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      padding: 32px 24px;
      min-height: 100vh;
    }

    header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 32px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }

    .header-icon { width: 32px; height: 32px; flex-shrink: 0; color: var(--muted); }
    header h1 { font-size: 20px; font-weight: 600; }
    header p { font-size: 13px; color: var(--muted); margin-top: 2px; }

    .group { margin-bottom: 32px; }

    .group-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }

    .group-label {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .group-label .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .group-passing .dot  { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .group-failing .dot  { background: var(--red);   box-shadow: 0 0 6px var(--red); }
    .group-nostatus .dot { background: var(--muted); }

    .group-passing  .group-label { color: var(--green); }
    .group-failing  .group-label { color: var(--red); }
    .group-nostatus .group-label { color: var(--muted); }

    .count-tag {
      font-size: 11px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 10px;
      background: var(--surface2);
      border: 1px solid var(--border);
      color: var(--muted);
    }

    .rows-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .rows-table thead th {
      padding: 7px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
    }

    .rows-table tbody td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    .rows-table tbody tr:last-child td { border-bottom: none; }
    .rows-table tbody tr:hover td { background: rgba(255,255,255,0.02); }

    .plugin-cell { display: flex; align-items: center; gap: 8px; white-space: nowrap; }

    .plugin-type-tag {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 12px;
      font-weight: 500;
      border: 1px solid;
      flex-shrink: 0;
    }

    .tag-output      { background: #0c2a0c; border-color: #3fb950; color: #3fb950; }
    .tag-filter      { background: #2a1a0c; border-color: #d29922; color: #d29922; }
    .tag-integration { background: #0c1a2a; border-color: #388bfd; color: #58a6ff; }

    .plugin-name a { color: var(--accent-blue); text-decoration: none; font-weight: 500; }
    .plugin-name a:hover { text-decoration: underline; }

    .branch-tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      background: var(--surface2);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .branch-tag svg { width: 12px; height: 12px; color: var(--muted); flex-shrink: 0; }

    .badges { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
    .badge-item { display: flex; flex-direction: column; gap: 3px; }
    .badge-label { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .badge-item a { display: block; line-height: 0; }
    .badge-item img { height: 20px; }

    .empty-row td { padding: 14px 16px; color: var(--muted); font-style: italic; font-size: 13px; }

    .col-plugin { width: 300px; }
    .col-branch { width: 120px; }

    footer {
      margin-top: 48px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>

<header>
  <svg class="header-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
  </svg>
  <div>
    <h1>logstash-plugins CI Status</h1>
    <p>Test workflow status &mdash; actively maintained branches</p>
  </div>
</header>

${groupHTML('passing',  'Passing',   'passing',  passing)}
${groupHTML('failing',  'Failing',   'failing',  failing)}
${groupHTML('nostatus', 'No Status', 'nostatus', noStatus)}

<footer>
  <span>logstash-plugins &mdash; CI Status</span>
  <span>Generated ${generatedAt} &bull; badges reflect live run status</span>
</footer>

</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const versionFloors = await buildVersionFloors();

// Resolve branches for all plugins in parallel, then flatten into pairs.
const pluginsWithBranches = await Promise.all(
  PLUGINS.map(async p => {
    const branches = await fetchBranches(p.repo, versionFloors[p.repo] ?? 0);
    console.log(`${p.repo} branches: ${branches.join(', ')}`);
    return { ...p, branches };
  })
);

const pairs = pluginsWithBranches.flatMap(p => p.branches.map(b => ({ plugin: p, branch: b })));

const statuses = await Promise.all(
  pairs.map(async ({ plugin, branch }) => {
    const conclusions = await Promise.all(
      plugin.workflows.map(w => fetchConclusion(plugin.repo, w.file, branch))
    );
    const status = rowStatus(conclusions);
    console.log(`${plugin.repo}@${branch}: ${status} [${conclusions.join(', ')}]`);
    return { plugin, branch, status };
  })
);

const passing  = statuses.filter(s => s.status === 'passing');
const failing  = statuses.filter(s => s.status === 'failing');
const noStatus = statuses.filter(s => s.status !== 'passing' && s.status !== 'failing');

const generatedAt = new Date().toUTCString();
const output = process.env.OUTPUT_FILE ?? 'index.html';
writeFileSync(output, renderHTML(passing, failing, noStatus, generatedAt));
console.log(`Written to ${output}`);
