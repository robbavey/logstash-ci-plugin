#!/usr/bin/env node
// Fetches the latest workflow run conclusion for each plugin/branch/workflow
// combination and writes a grouped markdown status page to STATUS.md.

import { writeFileSync } from 'fs';

const ORG = 'logstash-plugins';

const PLUGINS = [
  {
    repo: 'logstash-output-elasticsearch',
    type: 'output',
    branches: ['main', '11.x', '9.x'],
    workflows: [
      { file: 'tests.yml',                    label: 'unit tests' },
      { file: 'integration-tests.yml',         label: 'integration tests' },
      { file: 'secure-integration-tests.yml',  label: 'secure integration' },
    ],
  },
  {
    repo: 'logstash-filter-grok',
    type: 'filter',
    branches: ['main'],
    workflows: [
      { file: 'tests.yml', label: 'tests' },
    ],
  },
  {
    repo: 'logstash-integration-kafka',
    type: 'integration',
    branches: ['main', '11.x'],
    workflows: [
      { file: 'tests.yml', label: 'tests' },
    ],
  },
];

// ── GitHub API helpers ────────────────────────────────────────────────────────

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

async function fetchConclusion(repo, workflowFile, branch) {
  const url =
    `https://api.github.com/repos/${ORG}/${repo}/actions/workflows/` +
    `${encodeURIComponent(workflowFile)}/runs` +
    `?branch=${encodeURIComponent(branch)}&per_page=1&exclude_pull_requests=true`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return 'no_status';

  const data = await res.json();
  const run = data.workflow_runs?.[0];
  if (!run) return 'no_status';
  if (run.status !== 'completed') return 'pending';
  return run.conclusion ?? 'no_status';
}

function rowStatus(conclusions) {
  if (conclusions.every(c => c === 'no_status')) return 'no_status';
  if (conclusions.some(c => ['failure', 'timed_out', 'startup_failure'].includes(c))) return 'failing';
  if (conclusions.every(c => ['success', 'skipped'].includes(c))) return 'passing';
  return 'no_status';
}

// ── Markdown rendering ────────────────────────────────────────────────────────

function badgeMd(repo, branch, workflow) {
  const base = `https://github.com/${ORG}/${repo}/actions/workflows/${workflow.file}`;
  const img  = `${base}/badge.svg?branch=${encodeURIComponent(branch)}`;
  const href = `${base}?query=branch%3A${encodeURIComponent(branch)}`;
  return `[![${workflow.label}](${img})](${href})`;
}

function renderGroup(title, emoji, rows) {
  const lines = [`## ${emoji} ${title} (${rows.length})\n`];

  if (rows.length === 0) {
    lines.push('_None_\n');
    return lines.join('\n');
  }

  for (const { plugin, branch } of rows) {
    const repoUrl = `https://github.com/${ORG}/${plugin.repo}`;
    const badges  = plugin.workflows.map(w => badgeMd(plugin.repo, branch, w)).join(' ');
    lines.push(`**[${plugin.repo}](${repoUrl})** — \`${branch}\``);
    lines.push(badges);
    lines.push('');
  }

  return lines.join('\n');
}

function renderMarkdown(passing, failing, noStatus) {
  const ts = new Date().toUTCString();
  return [
    '# logstash-plugins CI Status',
    '',
    `> Last updated: ${ts}`,
    '',
    '---',
    '',
    renderGroup('Passing',   '✅', passing),
    '---',
    '',
    renderGroup('Failing',   '❌', failing),
    '---',
    '',
    renderGroup('No Status', '⚪', noStatus),
  ].join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const pairs = PLUGINS.flatMap(p => p.branches.map(b => ({ plugin: p, branch: b })));

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

const output = process.env.OUTPUT_FILE ?? 'STATUS.md';
writeFileSync(output, renderMarkdown(passing, failing, noStatus));
console.log(`Written to ${output}`);
