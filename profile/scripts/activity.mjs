// Draws the activity graphs shown on github.com/incordai.
// Counts commits (no merges, no bots) on the default branch of every public,
// non-fork repository in the organisation, then writes four SVGs to OUT_DIR:
//   activity-dark.svg / activity-light.svg  — a 12-month heatmap with totals
//   repos-dark.svg    / repos-light.svg     — commits per repository, last 90 days
// No dependencies: Node 18+ and git.
//
// Env: ORG (default incordai), OUT_DIR (default assets), GITHUB_TOKEN (optional),
//      REPOS (optional comma list, skips the API — for local runs),
//      AUTHORS (comma list; a commit counts only if its author name or email
//               contains one of these — keeps history inherited from other
//               projects out of the count; empty counts everyone),
//      EXCLUDE (comma list of repositories to skip).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORG = process.env.ORG || 'incordai';
const OUT = process.env.OUT_DIR || 'assets';
const TOKEN = process.env.GITHUB_TOKEN || '';
const DAY = 86400000;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUTHORS = list(process.env.AUTHORS).map((s) => s.toLowerCase());
const EXCLUDE = new Set(list(process.env.EXCLUDE).map((s) => s.toLowerCase()));
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const THEMES = {
  dark: {
    bg: '#0B0D12', border: '#22262F', text: '#F2F4F8', muted: '#8A93A3',
    empty: '#171B23', scale: ['#4A2A12', '#8A4613', '#CC6116', '#FF7A1A'], bar: '#FF7A1A', track: '#171B23',
  },
  light: {
    bg: '#FFFFFF', border: '#E3E6EC', text: '#0B0D12', muted: '#5E6675',
    empty: '#EEF0F3', scale: ['#FFE3CC', '#FFB673', '#FF8A2E', '#D85F05'], bar: '#FF7A1A', track: '#EEF0F3',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtNum = (n) => n.toLocaleString('en-US');
const utcMidnight = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

async function listRepos() {
  if (process.env.REPOS) return process.env.REPOS.split(',').map((s) => s.trim()).filter(Boolean);
  const names = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/orgs/${ORG}/repos?type=public&per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    for (const r of batch) if (!r.fork && !r.archived && !r.private) names.push(r.name);
    if (batch.length < 100) break;
  }
  return names;
}

function commitTimes(name, workDir, since) {
  const path = join(workDir, name.replace(/[^\w.-]/g, '_'));
  try {
    execFileSync('git', ['clone', '--quiet', '--bare', '--filter=blob:none',
      `--shallow-since=${since.toISOString().slice(0, 10)}`, `https://github.com/${ORG}/${name}.git`, path], { stdio: 'pipe' });
  } catch {
    return []; // empty repository, or nothing since the cut-off
  }
  let log = '';
  try {
    log = execFileSync('git', ['-C', path, 'log', '--no-merges', `--since=${since.toISOString()}`, '--format=%ct%x09%ae%x09%an', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  return log.split('\n').filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, email = '', author = '']) => !/\[bot\]/i.test(email + author))
    .filter(([, email = '', author = '']) => {
      if (!AUTHORS.length) return true;
      const who = `${author} ${email}`.toLowerCase();
      return AUTHORS.some((a) => who.includes(a));
    })
    .map(([ts]) => Number(ts) * 1000);
}

function heatmapSvg(theme, data) {
  const T = THEMES[theme];
  const { start, days, counts, total, activeRepos, busiest, lastCommit, updated } = data;
  const cell = 11, step = 14, left = 56, top = 164, W = 840;
  const nonZero = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))] : 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (c) => (c === 0 ? -1 : c <= cuts[0] ? 0 : c <= cuts[1] ? 1 : c <= cuts[2] ? 2 : 3);

  let cells = '';
  let months = '';
  let lastMonth = -1;
  for (let i = 0; i < days; i++) {
    const t = start + i * DAY;
    const d = new Date(t);
    const col = Math.floor(i / 7), row = i % 7;
    const lv = level(counts[i]);
    const fill = lv < 0 ? T.empty : T.scale[lv];
    cells += `<rect x="${left + col * step}" y="${top + row * step}" width="${cell}" height="${cell}" rx="2" fill="${fill}"><title>${counts[i]} commit${counts[i] === 1 ? '' : 's'} on ${fmtDate(d)}</title></rect>`;
    if (row === 0 && d.getUTCMonth() !== lastMonth && col < 52) {
      lastMonth = d.getUTCMonth();
      months += `<text x="${left + col * step}" y="${top - 8}" font-size="11" fill="${T.muted}">${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</text>`;
    }
  }
  const dayLabels = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]
    .map(([r, n]) => `<text x="${left - 10}" y="${top + r * step + 9}" font-size="11" text-anchor="end" fill="${T.muted}">${n}</text>`).join('');

  const stats = [
    [fmtNum(total), 'commits in the last 12 months'],
    [String(activeRepos), 'repositories with new work'],
    [busiest ? fmtNum(busiest.count) : '0', busiest ? `busiest week, from ${fmtDate(new Date(busiest.start))}` : 'busiest week'],
  ].map(([big, small], i) => {
    const x = 24 + i * 270;
    return `<text x="${x}" y="108" font-size="24" font-weight="600" fill="${T.text}">${esc(big)}</text><text x="${x}" y="128" font-size="12" fill="${T.muted}">${esc(small)}</text>`;
  }).join('');

  const legendX = W - 24 - (5 * 14 + 70);
  const legend = `<text x="${legendX}" y="${top + 7 * step + 22}" font-size="11" fill="${T.muted}">Less</text>`
    + [T.empty, ...T.scale].map((c, i) => `<rect x="${legendX + 32 + i * 14}" y="${top + 7 * step + 13}" width="11" height="11" rx="2" fill="${c}"/>`).join('')
    + `<text x="${legendX + 32 + 5 * 14 + 4}" y="${top + 7 * step + 22}" font-size="11" fill="${T.muted}">More</text>`;

  const H = top + 7 * step + 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="Commit activity across ${esc(ORG)} public repositories, last 12 months">
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${T.bg}" stroke="${T.border}"/>
<text x="24" y="42" font-size="18" font-weight="600" fill="${T.text}">Activity across Incord AI</text>
<text x="24" y="62" font-size="12" fill="${T.muted}">Commits by the Incord team in every public repository · last commit ${esc(lastCommit ? fmtDate(new Date(lastCommit)) : 'none')}</text>
${stats}
${months}${dayLabels}${cells}
<text x="24" y="${top + 7 * step + 22}" font-size="11" fill="${T.muted}">Updated daily · ${esc(fmtDate(new Date(updated)))}</text>
${legend}
</svg>
`;
}

function reposSvg(theme, rows, updated) {
  const T = THEMES[theme];
  const W = 840, top = 96, rowH = 30, nameW = 190, barX = 24 + nameW, barMax = 430;
  const max = Math.max(1, ...rows.map((r) => r.recent));
  const ago = (t) => {
    const d = Math.round((utcMidnight(updated) - utcMidnight(t)) / DAY);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const body = rows.length ? rows.map((r, i) => {
    const y = top + i * rowH;
    const w = Math.max(4, Math.round((r.recent / max) * barMax));
    return `<text x="24" y="${y + 14}" font-size="13" font-weight="500" fill="${T.text}">${esc(r.name)}</text>`
      + `<rect x="${barX}" y="${y + 3}" width="${barMax}" height="14" rx="7" fill="${T.track}"/>`
      + `<rect x="${barX}" y="${y + 3}" width="${w}" height="14" rx="7" fill="${T.bar}"/>`
      + `<text x="${barX + barMax + 12}" y="${y + 14}" font-size="12" font-weight="600" fill="${T.text}">${fmtNum(r.recent)}</text>`
      + `<text x="${W - 24}" y="${y + 14}" font-size="12" text-anchor="end" fill="${T.muted}">${esc(ago(r.last))}</text>`;
  }).join('') : `<text x="24" y="${top + 14}" font-size="13" fill="${T.muted}">No commits in the last 90 days.</text>`;
  const H = top + Math.max(1, rows.length) * rowH + 18;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="Commits per repository in the last 90 days">
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${T.bg}" stroke="${T.border}"/>
<text x="24" y="42" font-size="18" font-weight="600" fill="${T.text}">Where the work is</text>
<text x="24" y="62" font-size="12" fill="${T.muted}">Commits by the Incord team, last 90 days · most recent commit on the right · updated ${esc(fmtDate(new Date(updated)))}</text>
${body}
</svg>
`;
}

async function main() {
  const now = Date.now();
  const today = utcMidnight(now);
  const start = today - 364 * DAY - new Date(today).getUTCDay() * DAY; // a Sunday, 53 columns ending this week
  const days = Math.round((today - start) / DAY) + 1;
  const recentFrom = now - 90 * DAY;

  const names = (await listRepos()).filter((n) => !EXCLUDE.has(n.toLowerCase()));
  const work = mkdtempSync(join(tmpdir(), 'incord-activity-'));
  const counts = new Array(days).fill(0);
  const repos = [];
  try {
    for (const name of names) {
      const times = commitTimes(name, work, new Date(start));
      let recent = 0, last = 0, inRange = 0;
      for (const t of times) {
        const i = Math.floor((utcMidnight(t) - start) / DAY);
        if (i >= 0 && i < days) { counts[i]++; inRange++; }
        if (t >= recentFrom) recent++;
        if (t > last) last = t;
      }
      repos.push({ name, inRange, recent, last });
      console.log(`${name}: ${inRange} commits in range, ${recent} in 90 days`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  let busiest = null;
  for (let w = 0; w * 7 < days; w++) {
    const c = counts.slice(w * 7, w * 7 + 7).reduce((a, b) => a + b, 0);
    if (!busiest || c > busiest.count) busiest = { count: c, start: start + w * 7 * DAY };
  }
  if (busiest && busiest.count === 0) busiest = null;

  const data = {
    start, days, counts,
    total: counts.reduce((a, b) => a + b, 0),
    activeRepos: repos.filter((r) => r.inRange > 0).length,
    busiest,
    lastCommit: Math.max(0, ...repos.map((r) => r.last)),
    updated: now,
  };
  const rows = repos.filter((r) => r.recent > 0).sort((a, b) => b.recent - a.recent).slice(0, 8);

  mkdirSync(OUT, { recursive: true });
  for (const theme of Object.keys(THEMES)) {
    writeFileSync(join(OUT, `activity-${theme}.svg`), heatmapSvg(theme, data));
    writeFileSync(join(OUT, `repos-${theme}.svg`), reposSvg(theme, rows, now));
  }
  console.log(`Wrote graphs for ${names.length} repositories to ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
