#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                     # scan all enabled companies
 *   node scan.mjs --dry-run           # preview without writing files
 *   node scan.mjs --company Cohere    # scan a single company
 *   node scan.mjs --notify-telegram   # send new offers to Telegram (reads .env)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Telegram notifier ───────────────────────────────────────────────

const ENV_PATH = '.env';
const TELEGRAM_MAX_LEN = 4000; // leave headroom under 4096

function loadDotenv() {
  if (!existsSync(ENV_PATH)) return {};
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTelegramMessages(offers, date) {
  if (offers.length === 0) {
    return [`<b>career-ops scan — ${date}</b>\nNo new jobs today.`];
  }

  const header = `<b>🆕 ${offers.length} new jobs · ${date}</b>\n`;
  const blocks = offers.map((o, i) => {
    const title = escapeHtml(o.title);
    const company = escapeHtml(o.company);
    const loc = o.location ? `\n📍 ${escapeHtml(o.location)}` : '';
    const link = `<a href="${escapeHtml(o.url)}">open →</a>`;
    return `${i + 1}. <b>${company}</b> — ${title}${loc}\n${link}`;
  });

  // Chunk into messages under the limit
  const messages = [];
  let current = header;
  for (const block of blocks) {
    const piece = '\n' + block + '\n';
    if (current.length + piece.length > TELEGRAM_MAX_LEN) {
      messages.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current.trim()) messages.push(current);
  return messages;
}

async function sendTelegramMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
}

async function notifyTelegram_(offers, date) {
  const env = loadDotenv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in .env — skipping notify');
    return;
  }
  const messages = buildTelegramMessages(offers, date);
  for (const msg of messages) {
    await sendTelegramMessage(token, chatId, msg);
  }
  console.log(`Telegram: sent ${messages.length} message(s) to chat ${chatId}`);
}

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const JOBS_PATH = 'data/jobs.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  // Workday — public URL pattern: {tenant}.{shard}.myworkdayjobs.com/[en-US/]{site}
  const workdayMatch = url.match(/\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w_-]+)/);
  if (workdayMatch) {
    const [, tenant, shard, site] = workdayMatch;
    return {
      type: 'workday',
      url: `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      publicBase: `https://${tenant}.${shard}.myworkdayjobs.com/${site}`,
    };
  }

  // Workday (alt host) — {shard}.myworkdaysite.com/recruiting/{tenant}/{site}
  const workdaySiteMatch = url.match(/\/\/(wd\d+)\.myworkdaysite\.com\/recruiting\/([\w-]+)\/([\w_-]+)/);
  if (workdaySiteMatch) {
    const [, shard, tenant, site] = workdaySiteMatch;
    return {
      type: 'workday',
      url: `https://${shard}.myworkdaysite.com/wday/cxs/${tenant}/${site}/jobs`,
      publicBase: `https://${shard}.myworkdaysite.com/recruiting/${tenant}/${site}`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonPost(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Workday paginates via offset. Server caps limit at 20 per request.
// Cap at ~500 jobs per company to keep scans fast.
async function fetchAllWorkdayJobs(apiUrl, publicBase, companyName) {
  const jobs = [];
  const limit = 20;
  const MAX_PAGES = 25;
  let offset = 0;
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJsonPost(apiUrl, { appliedFacets: {}, limit, offset, searchText: '' });
    const postings = json.jobPostings || [];
    if (total === null) total = json.total ?? postings.length;
    for (const p of postings) {
      jobs.push({
        title: p.title || '',
        url: p.externalPath ? `${publicBase}${p.externalPath}` : '',
        company: companyName,
        location: p.locationsText || '',
      });
    }
    offset += postings.length;
    if (postings.length < limit || offset >= total) break;
  }
  return jobs;
}

// ── Title filter ────────────────────────────────────────────────────

// Build a word-boundary regex for a keyword. Adds \b only on edges
// where the keyword starts/ends with an alphanumeric char, so that
// "AI" matches "AI Engineer" but NOT "Télétravail" (substring 'ai'),
// while keywords like ".NET" or "Sr " still work as expected.
function makeKeywordRegex(kw) {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = /^[a-z0-9]/i.test(kw) ? '\\b' : '';
  const end = /[a-z0-9]$/i.test(kw) ? '\\b' : '';
  return new RegExp(`${start}${escaped}${end}`, 'i');
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(makeKeywordRegex);
  const negative = (titleFilter?.negative || []).map(makeKeywordRegex);

  return (title) => {
    const hasPositive = positive.length === 0 || positive.some(re => re.test(title));
    const hasNegative = negative.some(re => re.test(title));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;

  const positive = (locationFilter.positive || []).map(k => k.toLowerCase());
  const negative = (locationFilter.negative || []).map(k => k.toLowerCase());
  const allowEmpty = locationFilter.allow_empty === true;

  return (location) => {
    if (!location || location.trim() === '') return allowEmpty;
    const lower = location.toLowerCase();
    if (negative.some(k => lower.includes(k))) return false;
    if (positive.length === 0) return true;
    return positive.some(k => lower.includes(k));
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // jobs.md — single-file tracker. Extract URLs from every table row.
  if (existsSync(JOBS_PATH)) {
    const text = readFileSync(JOBS_PATH, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const urls = line.match(/https?:\/\/[^\s|)]+/g);
      if (urls) for (const u of urls) seen.add(u);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Jobs tracker writer ─────────────────────────────────────────────

// Escape pipe characters so table rows don't break
function esc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function appendToJobs(offers, date) {
  if (offers.length === 0) return;

  // Ensure file exists with header
  if (!existsSync(JOBS_PATH)) {
    const header = [
      '# Jobs Tracker',
      '',
      'Single-file tracker. Edit the **Status** column to track your applications.',
      '',
      '**Status values:** *blank* (new) · `Applied` · `SKIP` · `Responded` · `Interview` · `Offer` · `Rejected` · `Discarded`',
      '',
      '| Status | Date | Company | Role | Location | URL | Notes |',
      '|--------|------|---------|------|----------|-----|-------|',
      '',
    ].join('\n');
    writeFileSync(JOBS_PATH, header, 'utf-8');
  }

  const rows = offers.map(o =>
    `|  | ${date} | ${esc(o.company)} | ${esc(o.title)} | ${esc(o.location)} | ${o.url} |  |`
  ).join('\n') + '\n';

  // Append rows at the end of the file
  let text = readFileSync(JOBS_PATH, 'utf-8');
  if (!text.endsWith('\n')) text += '\n';
  text += rows;
  writeFileSync(JOBS_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const notifyTelegram = args.includes('--notify-telegram');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalFilteredLocation = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url, publicBase } = company._api;
    try {
      let jobs;
      if (type === 'workday') {
        jobs = await fetchAllWorkdayJobs(url, publicBase, company.name);
      } else {
        const json = await fetchJson(url);
        jobs = PARSERS[type](json, company.name);
      }
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToJobs(newOffers, date);
    appendToScanHistory(newOffers, date);
  }

  // 5b. Telegram notify (opt-in)
  if (notifyTelegram && !dryRun) {
    try {
      await notifyTelegram_(newOffers, date);
    } catch (err) {
      console.error('Telegram notify failed:', err.message);
    }
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${JOBS_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
