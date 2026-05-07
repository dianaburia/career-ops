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
 *   node scan.mjs --snapshot data/jobs2.md  # write all current ATS matches, no history dedupe
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
const JD_ARCHIVE_PATH = 'data/jd-archive.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 30_000;

// ── API detection ───────────────────────────────────────────────────

function workdayFacetsFromUrl(url) {
  const facets = {};
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!value || key === 'source') continue;
      if (!facets[key]) facets[key] = [];
      facets[key].push(value);
    }
  } catch {
    // Ignore malformed URLs; the API URL construction will fail later if needed.
  }
  return facets;
}

function detectApi(company) {
  if (company.scan_method === 'automattic') {
    return {
      type: 'automattic',
      url: company.careers_url,
    };
  }

  if (company.scan_method === 'jibe') {
    const sourceUrl = company.careers_url || '';
    let apiUrl = sourceUrl;
    try {
      const parsed = new URL(sourceUrl);
      apiUrl = `${parsed.origin}/api/jobs?${parsed.searchParams.toString()}`;
    } catch {
      // Keep the configured URL; fetchJson will report a useful error.
    }
    return {
      type: 'jibe',
      url: apiUrl,
      sourceUrl,
      publicBase: sourceUrl,
    };
  }

  if (company.scan_method === 'eightfold') {
    const url = company.careers_url || '';
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      origin = url;
    }
    return {
      type: 'eightfold',
      url: `${origin}/api/pcsx/search`,
      sourceUrl: url,
      domain: company.eightfold_domain || '',
      location: company.eightfold_location || '',
    };
  }

  if (company.scan_method === 'njoyn') {
    return {
      type: 'njoyn',
      url: company.careers_url,
      keyword: company.njoyn_keyword || '',
      city: company.njoyn_city || '',
    };
  }

  if (company.scan_method === 'phenom') {
    const sourceUrl = company.careers_url || '';
    let origin = '';
    try {
      origin = new URL(sourceUrl).origin;
    } catch {
      origin = sourceUrl;
    }
    return {
      type: 'phenom',
      url: `${origin}/widgets`,
      publicBase: sourceUrl,
      keyword: company.phenom_keyword || '',
      location: company.phenom_location || '',
    };
  }

  if (company.scan_method === 'adp_wfn') {
    return {
      type: 'adp_wfn',
      url: company.careers_url,
      cid: company.adp_cid || '',
      ccId: company.adp_ccid || '',
      lang: company.adp_lang || 'en_CA',
      query: company.adp_query || '',
    };
  }

  if (company.scan_method === 'workable') {
    const account = company.workable_account || (company.careers_url || '').match(/apply\.workable\.com\/([^/?#]+)/)?.[1] || '';
    return {
      type: 'workable',
      url: `https://apply.workable.com/api/v3/accounts/${account}/jobs`,
      publicBase: `https://apply.workable.com/${account}`,
    };
  }

  if (company.scan_method === 'workable_widget') {
    return {
      type: 'workable_widget',
      url: `https://apply.workable.com/api/v1/widget/accounts/${company.workable_widget_account}?origin=embed&details=true`,
      publicBase: 'https://apply.workable.com',
    };
  }

  if (company.scan_method === 'rippling') {
    return {
      type: 'rippling',
      url: company.careers_url,
    };
  }

  if (company.scan_method === 'avature') {
    return {
      type: 'avature',
      url: company.careers_url,
      publicBase: company.careers_url,
    };
  }

  if (company.scan_method === 'jazzhr') {
    return {
      type: 'jazzhr',
      url: company.careers_url,
      publicBase: company.careers_url,
    };
  }

  if (company.scan_method === 'icims') {
    return {
      type: 'icims',
      url: company.careers_url,
      publicBase: company.careers_url,
    };
  }

  if (company.scan_method === 'successfactors') {
    return {
      type: 'successfactors',
      url: company.careers_url,
      publicBase: company.careers_url,
      queries: company.successfactors_queries || [],
    };
  }

  if (company.scan_method === 'amazon') {
    return {
      type: 'amazon',
      url: company.careers_url,
      publicBase: 'https://www.amazon.jobs',
    };
  }

  if (company.scan_method === 'oracle_ce') {
    return {
      type: 'oracle_ce',
      url: company.careers_url,
      apiOrigin: company.oracle_api_origin || 'https://eeho.fa.us2.oraclecloud.com',
      siteNumber: company.oracle_site_number || 'CX_45001',
    };
  }

  if (company.scan_method === 'rss') {
    return {
      type: 'rss',
      url: company.rss_url || company.careers_url,
      publicBase: company.careers_url,
    };
  }

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

  // SmartRecruiters — jobs.smartrecruiters.com/{slug} or api.smartrecruiters.com path
  const smartMatch = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)/)
    || url.match(/api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)/);
  if (smartMatch) {
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${smartMatch[1]}/postings?limit=100`,
      publicBase: `https://jobs.smartrecruiters.com/${smartMatch[1]}`,
    };
  }

  // BambooHR — {slug}.bamboohr.com/careers(/list)
  const bambooMatch = url.match(/\/\/([\w-]+)\.bamboohr\.com\/careers/);
  if (bambooMatch) {
    const slug = bambooMatch[1];
    return {
      type: 'bamboohr',
      url: `https://${slug}.bamboohr.com/careers/list`,
      publicBase: `https://${slug}.bamboohr.com/careers`,
    };
  }

  // Workable — apply.workable.com/{account}
  const workableMatch = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (workableMatch) {
    return {
      type: 'workable',
      url: `https://apply.workable.com/api/v3/accounts/${workableMatch[1]}/jobs`,
      publicBase: `https://apply.workable.com/${workableMatch[1]}`,
    };
  }

  // Rippling — ats.rippling.com/{slug}/jobs
  const ripplingMatch = url.match(/ats\.rippling\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?([^/?#]+)\/jobs/i);
  if (ripplingMatch) {
    return {
      type: 'rippling',
      url,
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
      appliedFacets: workdayFacetsFromUrl(url),
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
      appliedFacets: workdayFacetsFromUrl(url),
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
  return jobs.map(j => {
    // Combine primary + secondary locations (multi-city roles list them as secondaryLocations)
    const locs = [j.location || ''];
    for (const s of (j.secondaryLocations || [])) {
      if (s.location) locs.push(s.location);
    }
    return {
      title: j.title || '',
      url: j.jobUrl || '',
      company: companyName,
      location: locs.filter(Boolean).join('; '),
      description: j.descriptionPlain || '',
    };
  });
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => {
    const locs = j.categories?.allLocations?.length
      ? j.categories.allLocations
      : [j.categories?.location || ''];
    return {
      title: j.text || '',
      url: j.hostedUrl || '',
      company: companyName,
      location: locs.filter(Boolean).join('; '),
      description: j.descriptionPlain || stripHtml(j.description || ''),
    };
  });
}

function parseSmartRecruiters(json, companyName) {
  const jobs = json.content || [];
  return jobs.map(j => {
    const locParts = [];
    const loc = j.location || {};
    if (loc.fullLocation) {
      locParts.push(loc.fullLocation);
    } else {
      if (loc.city) locParts.push(loc.city);
      if (loc.region) locParts.push(loc.region);
      if (loc.country) locParts.push(loc.country);
      if (loc.remote) locParts.push('Remote');
    }
    return {
      title: j.name || '',
      url: j.applyUrl || `https://jobs.smartrecruiters.com/${j.company?.identifier}/${j.id}`,
      company: companyName,
      location: locParts.filter(Boolean).join(', '),
      description: '', // detail endpoint required — fetched on-demand later
    };
  });
}

function parseBambooHR(json, companyName, publicBase) {
  const jobs = json.result || [];
  return jobs.map(j => {
    const loc = j.location || {};
    const locParts = [];
    if (loc.city) locParts.push(loc.city);
    if (loc.state) locParts.push(loc.state);
    if (j.isRemote) locParts.push('Remote');
    const jobUrl = `${publicBase.replace(/\/list$/, '')}/${j.id}`;
    return {
      title: j.jobOpeningName || '',
      url: jobUrl,
      company: companyName,
      location: locParts.filter(Boolean).join(', '),
      description: '',
    };
  });
}

function parseWorkable(json, companyName, publicBase) {
  const jobs = json.results || [];
  return jobs.map(j => {
    const locs = (j.locations?.length ? j.locations : [j.location || {}]).map(loc => {
      const parts = [];
      if (loc.city) parts.push(loc.city);
      if (loc.region) parts.push(loc.region);
      if (loc.country) parts.push(loc.country);
      return parts.filter(Boolean).join(', ');
    }).filter(Boolean);
    const workplace = j.workplace ? ` (${j.workplace})` : '';
    return {
      title: j.title || '',
      url: j.shortcode ? `${publicBase}/j/${j.shortcode}/` : '',
      company: companyName,
      location: locs.join('; ') + workplace,
      description: '',
    };
  });
}

function parseWorkableWidget(json, companyName, publicBase) {
  const jobs = json.jobs || [];
  return jobs.map(j => {
    const locs = (j.locations?.length ? j.locations : [j]).map(loc => {
      const parts = [];
      if (loc.city) parts.push(loc.city);
      if (loc.region || loc.state) parts.push(loc.region || loc.state);
      if (loc.country) parts.push(loc.country);
      return parts.filter(Boolean).join(', ');
    }).filter(Boolean);
    if (j.telecommuting) locs.push('Remote');
    return {
      title: j.title || '',
      url: j.url || j.shortlink || (j.shortcode ? `${publicBase}/j/${j.shortcode}` : ''),
      company: companyName,
      location: locs.join('; '),
      description: stripHtml(j.description || ''),
    };
  });
}

function parseNextData(html) {
  const m = String(html || '').match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  return JSON.parse(m[1]);
}

function parseRippling(html, companyName) {
  const data = parseNextData(html);
  const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
  const queryData = queries.map(q => q.state?.data).find(d => Array.isArray(d?.items));
  const items = queryData?.items || [];

  return items.map(j => ({
    title: j.name || '',
    url: j.url || '',
    company: companyName,
    location: (j.locations || []).map(l => l.name).filter(Boolean).join('; '),
    description: '',
  }));
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function htmlCellText(s) {
  return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAvature(html, companyName, publicBase) {
  const jobs = [];
  const seen = new Set();
  const articles = String(html || '').match(/<article\b[\s\S]*?<\/article>/gi) || [];

  for (const article of articles) {
    const anchors = [...article.matchAll(/<a\b([^>]*)href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const link = anchors.find(m => /\blink_result\b/i.test(m[1]))
      || anchors.find(m => /JobDetail|jobdetails|\/jobs?\//i.test(m[2]) && !/^apply$/i.test(htmlCellText(m[3])))
      || anchors.find(m => !/^apply$/i.test(htmlCellText(m[3])));
    if (!link) continue;

    const title = htmlCellText(link[3]);
    const url = new URL(decodeHtml(link[2]), publicBase).toString();
    const location = htmlCellText((article.match(/<span\b[^>]*class=["'][^"']*\blist-item-location\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    const department = htmlCellText((article.match(/<span\b[^>]*class=["'][^"']*\blist-item-department\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1]);

    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    jobs.push({
      title,
      url,
      company: companyName,
      location: [location, department].filter(Boolean).join(' | '),
      description: '',
    });
  }

  return jobs;
}

function parseJazzhr(html, companyName, publicBase) {
  const jobs = [];
  const seen = new Set();
  const rows = String(html || '').match(/<li\b[^>]*class=["'][^"']*\blist-group-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>\s*(?=<li\b[^>]*class=["'][^"']*\blist-group-item\b|<\/ul>)/gi) || [];

  for (const row of rows) {
    const link = row.match(/<a\b[^>]*href=["']([^"']*applytojob\.com\/apply\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const url = new URL(decodeHtml(link[1]), publicBase).toString();
    if (seen.has(url)) continue;

    const title = htmlCellText(link[2]);
    const location = htmlCellText((row.match(/<li\b[^>]*>\s*<i\b[^>]*fa-map-marker[^>]*><\/i>([\s\S]*?)<\/li>/i) || [])[1]);
    const department = htmlCellText((row.match(/<li\b[^>]*>\s*<i\b[^>]*fa-sitemap[^>]*><\/i>([\s\S]*?)<\/li>/i) || [])[1]);

    seen.add(url);
    jobs.push({
      title,
      url,
      company: companyName,
      location: [location, department].filter(Boolean).join(' | '),
      description: '',
    });
  }

  return jobs;
}

function parseIcims(html, companyName, publicBase) {
  const jobs = [];
  const seen = new Set();
  const cards = String(html || '').match(/<li\b[^>]*class=["'][^"']*\biCIMS_JobCardItem\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];

  for (const card of cards) {
    const link = card.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\biCIMS_Anchor\b[^"']*["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i)
      || card.match(/<a\b[^>]*class=["'][^"']*\biCIMS_Anchor\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!link) continue;

    const url = new URL(decodeHtml(link[1]), publicBase).toString();
    if (seen.has(url)) continue;

    const location = htmlCellText((card.match(/<span\b[^>]*class=["'][^"']*\bsr-only\b[^"']*["'][^>]*>\s*Location\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    seen.add(url);
    jobs.push({
      title: htmlCellText(link[2]),
      url,
      company: companyName,
      location,
      description: '',
    });
  }

  return jobs;
}

function parseSuccessFactors(html, companyName, publicBase) {
  const jobs = [];
  const seen = new Set();
  const rows = String(html || '').match(/<tr\b[^>]*class=["'][^"']*\bdata-row\b[^"']*["'][^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const link = row.match(/<a\b[^>]*class=["'][^"']*\bjobTitle-link\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const url = new URL(decodeHtml(link[1]), publicBase).toString();
    if (seen.has(url)) continue;

    const location = htmlCellText((row.match(/<td\b[^>]*class=["'][^"']*\bcolLocation\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*class=["'][^"']*\bjobLocation\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1])
      || htmlCellText((row.match(/<span\b[^>]*class=["'][^"']*\bjobLocation\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1]);

    seen.add(url);
    jobs.push({
      title: htmlCellText(link[2]),
      url,
      company: companyName,
      location,
      description: '',
    });
  }

  return jobs;
}

function parseAmazon(json, companyName, publicBase) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.job_path ? new URL(j.job_path, publicBase).toString() : '',
    company: companyName,
    location: j.normalized_location || j.location || [j.city, j.state, j.country_code].filter(Boolean).join(', '),
    description: stripHtml([j.description, j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join('\n\n')),
  }));
}

function parseOracleCe(json, companyName) {
  const jobs = [];
  const items = json.items || [];
  for (const item of items) {
    for (const j of (item.requisitionList || [])) {
      jobs.push({
        title: j.Title || '',
        url: j.Id ? `https://careers.oracle.com/en/sites/jobsearch/job/${j.Id}` : '',
        company: companyName,
        location: j.PrimaryLocation || j.PrimaryLocationCountry || '',
        description: stripHtml(j.ShortDescriptionStr || ''),
      });
    }
  }
  return jobs;
}

function parseRss(xml, companyName) {
  const jobs = [];
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const title = decodeHtml((item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || item.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const url = decodeHtml(htmlCellText((item.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]));
    const descriptionHtml = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || item.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '';
    const description = stripHtml(descriptionHtml);
    const location = htmlCellText((descriptionHtml.match(/All Available Locations:\s*<\/strong>\s*([\s\S]*?)<\/p>/i) || descriptionHtml.match(/Primary Location:\s*<\/strong>\s*([\s\S]*?)(?:<br|<\/p>)/i) || [])[1])
      || htmlCellText((title.match(/\(([^()]*,\s*(?:ON|QC|BC|AB|CA)[^()]*)\)\s*$/i) || [])[1]);

    if (!title || !url) continue;
    jobs.push({
      title,
      url,
      company: companyName,
      location,
      description,
    });
  }
  return jobs;
}

function parseNjoyn(html, companyName, publicBase) {
  if (/Radware Captcha Page|validate\.perfdrive|Please solve this CAPTCHA/i.test(html)) {
    throw new Error('Njoyn blocked request with CAPTCHA');
  }

  const jobs = [];
  const seen = new Set();
  const rows = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    if (!/Page=JobDetails/i.test(row)) continue;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 5) continue;

    const hrefMatch = cells[0].match(/href=['"]([^'"]*Page=JobDetails[^'"]*)['"]/i);
    if (!hrefMatch) continue;

    const title = htmlCellText(cells[1]);
    const city = htmlCellText(cells[3]);
    const country = htmlCellText(cells[4]);
    const url = new URL(decodeHtml(hrefMatch[1]), publicBase).toString();
    if (!title || seen.has(url)) continue;
    seen.add(url);

    jobs.push({
      title,
      url,
      company: companyName,
      location: [city, country].filter(Boolean).join(', '),
      description: '',
    });
  }
  return jobs;
}

function slugifyJobTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function phenomDetailUrl(job, publicBase) {
  const jobSeqNo = job.jobSeqNo || job.jobId || job.reqId || '';
  if (!jobSeqNo) return job.applyUrl || '';

  let base;
  try {
    base = new URL(publicBase);
  } catch {
    return job.applyUrl || '';
  }

  const segments = base.pathname.split('/').filter(Boolean);
  const localePrefix = segments.length >= 2 ? `/${segments[0]}/${segments[1]}` : '';
  return `${base.origin}${localePrefix}/job/${jobSeqNo}/${slugifyJobTitle(job.title || jobSeqNo)}`;
}

function parsePhenom(json, companyName, publicBase) {
  const jobs = json?.refineSearch?.data?.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: phenomDetailUrl(j, publicBase),
    company: companyName,
    location: j.cityStateCountry || j.location || (j.multi_location || []).filter(Boolean).join('; '),
    description: stripHtml(j.descriptionTeaser || j.ml_job_parser?.descriptionTeaser_ats || ''),
  }));
}

function adpStringField(job, code) {
  return (job?.customFieldGroup?.stringFields || [])
    .find(f => f?.nameCode?.codeValue === code)
    ?.stringValue || '';
}

function adpWfnHeaders(lang) {
  return {
    'Accept-Language': lang,
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'locale': lang,
    'x-forwarded-host': 'workforcenow.adp.com',
  };
}

function parseAdpWfn(json, company) {
  const api = company._api;
  const jobs = json?.jobRequisitions || [];

  return jobs.map(j => {
    const externalJobId = adpStringField(j, 'ExternalJobID');
    const ccId = adpStringField(j, 'CareerCenterRefId') || api.ccId;
    const locations = (j.requisitionLocations || []).map(loc =>
      loc?.nameCode?.shortName
        || [loc?.address?.cityName, loc?.address?.countrySubdivisionLevel1?.codeValue, loc?.address?.countryCode].filter(Boolean).join(', ')
    ).filter(Boolean);
    const url = externalJobId
      ? `${new URL(api.url).origin}/mascsr/default/mdf/recruitment/recruitment.html?cid=${encodeURIComponent(api.cid)}&ccId=${encodeURIComponent(ccId)}&jobId=${encodeURIComponent(externalJobId)}&source=CC2&lang=${encodeURIComponent(api.lang)}`
      : '';

    return {
      title: j.requisitionTitle || '',
      url,
      company: company.name,
      location: locations.join('; '),
      description: stripHtml(j.requisitionDescription || ''),
    };
  });
}

function parseEightfold(json, companyName, publicBase) {
  const positions = json?.data?.positions || [];
  return positions.map(p => {
    const locs = p.standardizedLocations?.length ? p.standardizedLocations : (p.locations || []);
    const path = p.positionUrl || (p.id ? `/careers/job/${p.id}` : '');
    return {
      title: p.name || '',
      url: path ? new URL(path, publicBase).toString() : '',
      company: companyName,
      location: locs.filter(Boolean).join('; '),
      description: '',
    };
  });
}

function parseJibe(json, companyName, publicBase) {
  const jobs = json.jobs || [];
  return jobs.map(j => {
    const d = j.data || j;
    const loc = d.full_location || d.short_location || [d.city, d.state, d.country].filter(Boolean).join(', ');
    const jobUrl = d.apply_url || (d.slug ? new URL(`/careers-home/jobs/${d.slug}`, publicBase).toString() : '');
    return {
      title: d.title || '',
      url: jobUrl,
      company: companyName,
      location: loc || '',
      description: d.description || '',
    };
  });
}

function parseAutomattic(html, companyName) {
  const startToken = 'const ghJobsData = ';
  const start = String(html || '').indexOf(startToken);
  if (start === -1) return [];

  const sourceMarker = String(html).indexOf('//# sourceURL=wwu-positions', start);
  if (sourceMarker === -1) return [];

  const raw = String(html)
    .slice(start + startToken.length, sourceMarker)
    .replace(/;\s*$/, '')
    .trim();

  const jobs = JSON.parse(raw);
  return jobs.map(j => {
    const title = j.title || '';
    const isNewYork = /\bnew york\b/i.test(`${title} ${j.href || ''}`);
    return {
      title,
      url: j.href || '',
      company: companyName,
      location: isNewYork ? 'New York, NY, United States' : 'Remote Canada eligible',
      description: stripHtml(j.content || ''),
    };
  });
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  ashby: parseAshby,
  lever: parseLever,
  smartrecruiters: parseSmartRecruiters,
  bamboohr: parseBambooHR,
};

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

async function fetchJsonWithHeaders(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
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

async function fetchNjoynJobs(apiUrl, company) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const body = [
    's=+EnterDate+Desc+',
    'hiddencategoryid=',
    'pn=1',
    'Inp_country=',
    'NotUsed_inp_City=',
    'searchFilled=',
    'Inp_Jobtype=',
    'inp_Jobcategory=0',
    'inp_Jobcategory2=',
    'tmpJobs=',
    'Inp_XWEB_JobListing_CustomFields=',
    `Inp_Keywords=${encodeURIComponent(company._api.keyword || '')}`,
    `inp_City=${encodeURIComponent(company._api.city || '')}`,
    'Inp_XWEB_JobListing_JobID=',
    'joblistingsearchbutton=Search',
  ].join('&');

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': new URL(apiUrl).origin,
        'Referer': apiUrl,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseNjoyn(html, company.name, apiUrl);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPhenomJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 10;
  const size = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * size;
    const body = {
      ddoKey: 'refineSearch',
      keyword: company._api.keyword || '',
      location: company._api.location || '',
      sortBy: 'Most recent',
      from,
      size,
      jobs: true,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const pageJobs = parsePhenom(json, company.name, company._api.publicBase);
      for (const job of pageJobs) {
        if (!job.url || seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }

      const total = json?.refineSearch?.totalHits;
      if (pageJobs.length === 0 || pageJobs.length < size || (Number.isFinite(total) && jobs.length >= total)) break;
    } finally {
      clearTimeout(timer);
    }
  }

  return jobs;
}

function buildAdpWfnPageUrl(company, skip, top) {
  const api = company._api;
  const url = new URL('/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions', api.url);
  url.searchParams.set('cid', api.cid);
  url.searchParams.set('timeStamp', String(Date.now()));
  url.searchParams.set('ccId', api.ccId);
  url.searchParams.set('lang', api.lang);
  url.searchParams.set('$skip', String(skip));
  url.searchParams.set('$top', String(top));
  url.searchParams.set('userQuery', api.query || '');
  return url.toString();
}

async function fetchAdpWfnJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 10;
  const top = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJsonWithHeaders(
      buildAdpWfnPageUrl(company, page * top, top),
      adpWfnHeaders(company._api.lang)
    );
    const pageJobs = parseAdpWfn(json, company);
    for (const job of pageJobs) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }

    const total = json?.meta?.totalNumber;
    if (pageJobs.length === 0 || pageJobs.length < top || (Number.isFinite(total) && jobs.length >= total)) break;
  }

  return jobs;
}

async function fetchAutomatticJobs(apiUrl, company) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseAutomattic(html, company.name);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(apiUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJazzhrJobs(apiUrl, company) {
  const html = await fetchHtml(apiUrl);
  return parseJazzhr(html, company.name, apiUrl);
}

function buildIcimsPageUrl(apiUrl, page) {
  const out = new URL(apiUrl);
  out.searchParams.set('in_iframe', '1');
  if (page > 0) {
    out.searchParams.set('pr', String(page));
  } else {
    out.searchParams.delete('pr');
  }
  return out.toString();
}

async function fetchIcimsJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await fetchHtml(buildIcimsPageUrl(apiUrl, page));
    const pageJobs = parseIcims(html, company.name, apiUrl);
    for (const job of pageJobs) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }
    if (pageJobs.length === 0) break;
  }

  return jobs;
}

function buildSuccessFactorsPageUrl(apiUrl, page, query = null) {
  const out = new URL(apiUrl);
  if (query !== null) {
    out.searchParams.set('q', query);
  }
  if (page > 0) {
    out.searchParams.set('startrow', String(page * 25));
  } else {
    out.searchParams.delete('startrow');
  }
  return out.toString();
}

async function fetchSuccessFactorsJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 20;
  const queries = company._api.queries?.length ? company._api.queries : [null];

  for (const query of queries) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const html = await fetchHtml(buildSuccessFactorsPageUrl(apiUrl, page, query));
      const pageJobs = parseSuccessFactors(html, company.name, apiUrl);
      for (const job of pageJobs) {
        if (!job.url || seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (pageJobs.length < 25) break;
    }
  }

  return jobs;
}

async function fetchWorkableWidgetJobs(apiUrl, company) {
  const json = await fetchJson(apiUrl);
  return parseWorkableWidget(json, company.name, company._api.publicBase || 'https://apply.workable.com');
}

function buildAmazonSearchUrl(apiUrl, offset) {
  const out = new URL(apiUrl);
  out.pathname = out.pathname.replace(/\/search$/, '/search.json');
  out.searchParams.set('offset', String(offset));
  out.searchParams.set('result_limit', '100');

  for (const key of ['country', 'state', 'city']) {
    const bracketKey = `${key}[]`;
    const values = out.searchParams.getAll(bracketKey);
    if (values.length > 0) {
      out.searchParams.delete(bracketKey);
      out.searchParams.set(key, values[0]);
    }
  }

  return out.toString();
}

async function fetchAmazonJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 20;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJson(buildAmazonSearchUrl(apiUrl, offset));
    const pageJobs = parseAmazon(json, company.name, company._api.publicBase || 'https://www.amazon.jobs');
    for (const job of pageJobs) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }

    const count = json.jobs?.length || 0;
    if (count === 0) break;
    offset += count;
    if (count < 100 || (Number.isFinite(json.hits) && offset >= json.hits)) break;
  }

  return jobs;
}

function buildOracleCeSearchUrl(company, offset) {
  const source = new URL(company.careers_url);
  const locationId = source.searchParams.get('locationId') || '';
  const api = new URL('/hcmRestApi/resources/latest/recruitingCEJobRequisitions', company._api.apiOrigin);
  api.searchParams.set('onlyData', 'true');
  api.searchParams.set('expand', 'all');
  api.searchParams.set('limit', '100');
  api.searchParams.set('offset', String(offset));
  const finder = [
    `siteNumber=${company._api.siteNumber}`,
    locationId ? `locationId=${locationId}` : '',
    'sortBy=POSTING_DATES_DESC',
  ].filter(Boolean).join(',');
  api.searchParams.set('finder', `findReqs;${finder}`);
  return api.toString();
}

async function fetchOracleCeJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 10;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJson(buildOracleCeSearchUrl(company, offset));
    const pageJobs = parseOracleCe(json, company.name);
    for (const job of pageJobs) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }

    if (!json.hasMore || pageJobs.length === 0) break;
    offset += pageJobs.length;
  }

  return jobs;
}

async function fetchRssJobs(apiUrl, company) {
  const xml = await fetchHtml(apiUrl);
  return parseRss(xml, company.name);
}

function buildRipplingPageUrl(apiUrl, page) {
  const out = new URL(apiUrl);
  out.searchParams.set('page', String(page));
  return out.toString();
}

async function fetchRipplingJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = buildRipplingPageUrl(apiUrl, page);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const pageJobs = parseRippling(html, company.name);
      for (const job of pageJobs) {
        if (!job.url || seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (pageJobs.length < 20) break;
    } finally {
      clearTimeout(timer);
    }
  }

  return jobs;
}

function buildAvaturePageUrl(apiUrl, offset) {
  const out = new URL(apiUrl);
  out.searchParams.set('jobRecordsPerPage', '20');
  if (offset > 0) {
    out.searchParams.set('jobOffset', String(offset));
  } else {
    out.searchParams.delete('jobOffset');
  }
  return out.toString();
}

async function fetchAvatureJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 30;

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = buildAvaturePageUrl(apiUrl, page * 20);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const pageJobs = parseAvature(html, company.name, apiUrl);
      for (const job of pageJobs) {
        if (!job.url || seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (pageJobs.length < 20) break;
    } finally {
      clearTimeout(timer);
    }
  }

  return jobs;
}

function buildEightfoldSearchUrl(apiUrl, company, start) {
  const source = new URL(company._api.sourceUrl || company.careers_url);
  const out = new URL(apiUrl);
  const sourceParams = source.searchParams;

  for (const [key, value] of sourceParams.entries()) {
    out.searchParams.append(key, value);
  }

  out.searchParams.set('domain', company._api.domain || source.hostname.replace(/^[^.]+\./, ''));
  out.searchParams.set('query', sourceParams.get('query') || sourceParams.get('keyword') || '');
  if (company._api.location || sourceParams.get('location')) {
    out.searchParams.set('location', company._api.location || sourceParams.get('location'));
  }
  out.searchParams.set('start', String(start));
  return out.toString();
}

async function fetchEightfoldJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 10;
  let start = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = buildEightfoldSearchUrl(apiUrl, company, start);
    const json = await fetchJson(pageUrl);
    const pageJobs = parseEightfold(json, company.name, new URL(company.careers_url).origin);
    for (const job of pageJobs) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }

    const positions = json?.data?.positions || [];
    if (positions.length === 0) break;

    const total = json?.metadata?.totalPositions || json?.data?.totalPositions || json?.total;
    start += positions.length;
    if (positions.length < 10 || (Number.isFinite(total) && start >= total)) break;
  }

  return jobs;
}

function buildJibePageUrl(apiUrl, page) {
  const out = new URL(apiUrl);
  out.searchParams.set('page', String(page));
  return out.toString();
}

async function fetchAllJibeJobs(apiUrl, company) {
  const jobs = [];
  const seen = new Set();
  const MAX_PAGES = 25;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await fetchJson(buildJibePageUrl(apiUrl, page));
    const pageJobs = parseJibe(json, company.name, company._api.publicBase || company.careers_url);
    for (const job of pageJobs) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }

    const count = json.jobs?.length || 0;
    const total = json.totalCount;
    if (count === 0 || (Number.isFinite(total) && jobs.length >= total)) break;
  }

  return jobs;
}

// Workday paginates via offset. Server caps limit at 20 per request.
// Cap at ~1000 jobs per company to keep scans bounded without truncating larger boards.
async function fetchAllWorkdayJobs(apiUrl, publicBase, companyName, appliedFacets = {}) {
  const jobs = [];
  const limit = 20;
  const MAX_PAGES = 50;
  // Detail endpoint lives at {cxsBase}/job/{externalPath}
  const cxsBase = apiUrl.replace(/\/jobs$/, '');
  let offset = 0;
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJsonPost(apiUrl, { appliedFacets, limit, offset, searchText: '' });
    const postings = json.jobPostings || [];
    if (total === null) total = json.total ?? postings.length;
    for (const p of postings) {
      jobs.push({
        title: p.title || '',
        url: p.externalPath ? `${publicBase}${p.externalPath}` : '',
        company: companyName,
        location: p.locationsText || '',
        _detailUrl: p.externalPath ? `${cxsBase}${p.externalPath}` : '',
      });
    }
    offset += postings.length;
    if (postings.length < limit || offset >= total) break;
  }
  return jobs;
}

// Workday multi-city jobs show "N Locations" in the listing; detail endpoint
// has the full list under additionalLocations. Also returns jobDescription (HTML).
async function fetchWorkdayDetail(detailUrl) {
  if (!detailUrl) return null;
  try {
    return await fetchJson(detailUrl);
  } catch {
    return null;
  }
}

function workdayDetailLocation(detail, fallback) {
  const info = detail?.jobPostingInfo || {};
  const locs = [info.location, ...(info.additionalLocations || [])];
  return locs.filter(Boolean).join('; ') || fallback;
}

function workdayDetailDescription(detail) {
  return stripHtml(detail?.jobPostingInfo?.jobDescription || '');
}

// Greenhouse list endpoint omits descriptions — fetch them per job on demand.
async function fetchGreenhouseDescription(jobUrl) {
  const json = await fetchGreenhouseDetail(jobUrl);
  return stripHtml(json?.content || '');
}

function greenhouseSlugFromApiUrl(apiUrl) {
  return (String(apiUrl || '').match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs/) || [])[1] || '';
}

async function fetchGreenhouseDetail(jobUrl, boardSlug = '') {
  const m = jobUrl.match(/greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/)
    || jobUrl.match(/gh_jid=(\d+)/);
  if (!m) return '';
  const slug = m.length === 3 ? m[1] : boardSlug || (jobUrl.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/) || [])[1];
  const id = m.length === 3 ? m[2] : m[1];
  if (!slug || !id) return null;
  try {
    return await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}?content=true`);
  } catch {
    return null;
  }
}

function greenhouseDetailLocation(detail, fallback) {
  const locs = [];
  if (detail?.location?.name && !/^N\/A$/i.test(detail.location.name)) locs.push(detail.location.name);
  for (const office of (detail?.offices || [])) {
    if (office?.name) locs.push(office.name);
  }
  return [...new Set(locs)].join('; ') || fallback;
}

async function fetchWorkableDescription(jobUrl) {
  const m = jobUrl.match(/apply\.workable\.com\/([^/]+)\/j\/([^/]+)/);
  if (!m) return '';
  const [, account, shortcode] = m;
  try {
    const json = await fetchJson(`https://apply.workable.com/api/v2/accounts/${account}/jobs/${shortcode}`);
    return stripHtml(json.description || '');
  } catch {
    return '';
  }
}

async function fetchRipplingDescription(jobUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(jobUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = parseNextData(await res.text());
      const description = data?.props?.pageProps?.apiData?.jobPost?.description;
      if (!description) return '';
      if (typeof description === 'string') return stripHtml(description);
      return Object.values(description).map(stripHtml).filter(Boolean).join('\n\n');
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

async function fetchAvatureDescription(jobUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(jobUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || html;
      return stripHtml(main);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

function stripHtml(s) {
  // Decode HTML entities FIRST (Greenhouse returns content with &lt;div&gt; encoded tags).
  let text = String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  // Then strip tags.
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Title filter ────────────────────────────────────────────────────

// Build a word-boundary regex for a keyword. Adds \b only on edges
// where the keyword starts/ends with an alphanumeric char, so that
// "AI" matches "AI Engineer" but NOT "Télétravail" (substring 'ai'),
// while keywords like ".NET" or "Sr " still work as expected.
function makeKeywordRegex(kw, { unordered = true } = {}) {
  const trimmed = kw.trim();
  if (unordered && /^data engineering$/i.test(trimmed)) {
    return /\bdata\s+engineering\b/i;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (unordered && words.length > 1 && words.every(w => /^[a-z0-9]+$/i.test(w))) {
    const lookaheads = words.map(w => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pluralAware = /^(engineer|scientist|researcher|developer|architect|analyst)$/i.test(w)
        ? `${escaped}s?`
        : escaped;
      return `(?=.*\\b${pluralAware}\\b)`;
    }).join('');
    return new RegExp(lookaheads, 'i');
  }

  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const start = /^[a-z0-9]/i.test(trimmed) ? '\\b' : '';
  const end = /[a-z0-9]$/i.test(trimmed) ? '\\b' : '';
  return new RegExp(`${start}${escaped}${end}`, 'i');
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(makeKeywordRegex);
  const negative = (titleFilter?.negative || []).map(makeKeywordRegex);

  const matches = (title) => {
    const titleText = String(title || '');
    const isMemberOfTechnicalStaff = /\bMember of Technical Staff\b/i.test(titleText);
    const isSeniorMemberOfTechnicalStaff =
      /^\s*Staff\s+Member of Technical Staff\b/i.test(titleText)
      ||
      /\b(?:Senior|Sr\.?|Principal|Lead|Head|Chief|Director|VP|Vice President|AVP|Staff)\s+Member of Technical Staff\b/i.test(titleText)
      || /\bMember of Technical Staff\b.*\b(?:Senior|Sr\.?|Principal|Lead|Head|Chief|Director|VP|Vice President|AVP)\b/i.test(titleText);
    if (isMemberOfTechnicalStaff) return !isSeniorMemberOfTechnicalStaff;

    const hasPositive = positive.length === 0 || positive.some(re => re.test(title));
    const hasNegative = negative.some(re => re.test(title));
    return hasPositive && !hasNegative;
  };

  return (title) => {
    if (matches(title)) return true;

    // Some boards publish combined senior/non-senior titles like
    // "Senior Data Visualization Engineer/Data Visualization Engineer".
    // Treat only full role variants independently; do not split acronyms like AI/ML.
    if (String(title || '').includes('/')) {
      const variants = String(title).split('/').map(part => part.trim()).filter(Boolean);
      const roleVariant = variants.length > 1 && variants.every(part =>
        part.length >= 10 && /\b(engineer|scientist|researcher|developer|architect|analyst)\b/i.test(part)
      );
      if (roleVariant) return variants.some(part => matches(part));
    }

    return false;
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

function writeJobsSnapshot(offers, outPath, date, stats) {
  const sorted = [...offers].sort((a, b) =>
    (a.company || '').localeCompare(b.company || '')
      || (a.title || '').localeCompare(b.title || '')
      || (a.location || '').localeCompare(b.location || '')
  );

  const rows = sorted.map((o, i) =>
    `| ${i} |  | ${date} | ${esc(o.company)} | ${esc(o.title)} | ${esc(o.location)} | ${o.url || ''} | source: ${esc(o.source)} |`
  );

  const errorLines = (stats.errors || []).length
    ? [
        '',
        '## Errors',
        '',
        '| Company | Error |',
        '|---------|-------|',
        ...(stats.errors || []).map(e => `| ${esc(e.company)} | ${esc(e.error)} |`),
        '',
      ]
    : [];

  const text = [
    '# Jobs Snapshot',
    '',
    `Generated: ${date}`,
    'Scope: ATS/direct companies from `scan.mjs` only. This snapshot ignores existing `jobs.md`, `scan-history.tsv`, and `applications.md` history, but still removes duplicates within the fresh scan.',
    '',
    '| Metric | Value |',
    '|--------|------:|',
    `| Companies scanned | ${stats.targetsCount} |`,
    `| Enabled companies skipped as non-ATS/direct | ${stats.skippedCount} |`,
    `| Total jobs fetched | ${stats.totalFound} |`,
    `| Filtered by title | ${stats.totalFiltered} |`,
    `| Filtered by location | ${stats.totalFilteredLocation} |`,
    `| Duplicate rows within snapshot | ${stats.totalDupes} |`,
    `| Current matches | ${sorted.length} |`,
    '',
    '| # | Status | Date | Company | Role | Location | URL | Notes |',
    '|---|--------|------|---------|------|----------|-----|-------|',
    ...rows,
    ...errorLines,
  ].join('\n') + '\n';

  writeFileSync(outPath, text, 'utf-8');
}

// Renumber all data rows so the `#` column is dense (0..N-1).
// Run after append or whenever user may have manually deleted rows.
function renumberJobsFile() {
  if (!existsSync(JOBS_PATH)) return;
  const lines = readFileSync(JOBS_PATH, 'utf-8').split('\n');
  let idx = 0;
  const out = lines.map(line => {
    if (!/^\|\s*\d+\s*\|/.test(line)) return line;
    const replaced = line.replace(/^\|\s*\d+\s*\|/, `| ${idx} |`);
    idx++;
    return replaced;
  });
  writeFileSync(JOBS_PATH, out.join('\n'), 'utf-8');
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
      '| # | Status | Date | Company | Role | Location | URL | Notes |',
      '|---|--------|------|---------|------|----------|-----|-------|',
      '',
    ].join('\n');
    writeFileSync(JOBS_PATH, header, 'utf-8');
  }

  // Continue the `#` numbering from the highest existing index (first cell of data rows).
  let text = readFileSync(JOBS_PATH, 'utf-8');
  let nextIdx = 0;
  for (const m of text.matchAll(/^\|\s*(\d+)\s*\|/gm)) {
    const n = parseInt(m[1], 10);
    if (n + 1 > nextIdx) nextIdx = n + 1;
  }

  const rows = offers.map((o, i) =>
    `| ${nextIdx + i} |  | ${date} | ${esc(o.company)} | ${esc(o.title)} | ${esc(o.location)} | ${o.url} | |`
  ).join('\n') + '\n';

  if (!text.endsWith('\n')) text += '\n';
  text += rows;
  writeFileSync(JOBS_PATH, text, 'utf-8');
}

// ── JD archive ──────────────────────────────────────────────────────

function loadArchivedJdUrls() {
  const urls = new Set();
  if (!existsSync(JD_ARCHIVE_PATH)) return urls;
  const text = readFileSync(JD_ARCHIVE_PATH, 'utf-8');
  for (const match of text.matchAll(/^\*\*URL:\*\*\s*(\S+)/gm)) {
    urls.add(match[1]);
  }
  return urls;
}

async function enrichDescription(offer) {
  if (offer.description) return;
  if (offer.source === 'greenhouse-api') {
    offer.description = await fetchGreenhouseDescription(offer.url);
  } else if (offer.source === 'workable-api') {
    offer.description = await fetchWorkableDescription(offer.url);
  } else if (offer.source === 'rippling-api') {
    offer.description = await fetchRipplingDescription(offer.url);
  } else if (offer.source === 'avature-api') {
    offer.description = await fetchAvatureDescription(offer.url);
  } else if (offer.source === 'workday-api' && offer._detailUrl) {
    const detail = await fetchWorkdayDetail(offer._detailUrl);
    if (detail) offer.description = workdayDetailDescription(detail);
  }
}

function renderJdBlock(offer, date) {
  const lines = [
    `## ${offer.company} · ${offer.title}`,
    '',
    `**URL:** ${offer.url}`,
    `**Location:** ${offer.location || '—'}`,
    `**Source:** ${offer.source}`,
    `**Scanned:** ${date}`,
    '',
    offer.description || '_(no description captured)_',
    '',
    '---',
    '',
  ];
  return lines.join('\n');
}

async function appendJdArchive(newOffers, date) {
  const archived = loadArchivedJdUrls();
  const toSave = newOffers.filter(o => !archived.has(o.url));
  if (toSave.length === 0) return 0;

  // Ensure archive file exists with header
  if (!existsSync(JD_ARCHIVE_PATH)) {
    const header = [
      '# Job Description Archive',
      '',
      'Append-only archive of full JDs captured during scans. Search by company or role with Ctrl+F.',
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(JD_ARCHIVE_PATH, header, 'utf-8');
  }

  // Fetch missing descriptions in parallel (limited)
  const needFetch = toSave.filter(o => !o.description);
  await parallelFetch(needFetch.map(o => () => enrichDescription(o)), 5);

  const blocks = toSave.map(o => renderJdBlock(o, date)).join('\n');
  let existing = readFileSync(JD_ARCHIVE_PATH, 'utf-8');
  if (!existing.endsWith('\n')) existing += '\n';
  writeFileSync(JD_ARCHIVE_PATH, existing + blocks, 'utf-8');
  return toSave.length;
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
  const snapshotFlag = args.indexOf('--snapshot');
  const snapshotPath = snapshotFlag !== -1
    ? (args[snapshotFlag + 1] && !args[snapshotFlag + 1].startsWith('--') ? args[snapshotFlag + 1] : 'data/jobs2.md')
    : null;

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
  if (snapshotPath) console.log(`(snapshot mode — writing all current matches to ${snapshotPath}, no history dedupe)\n`);

  // 3. Load dedup sets
  const seenUrls = snapshotPath ? new Set() : loadSeenUrls();

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
        jobs = await fetchAllWorkdayJobs(url, publicBase, company.name, company._api.appliedFacets);
      } else if (type === 'automattic') {
        jobs = await fetchAutomatticJobs(url, company);
      } else if (type === 'jibe') {
        jobs = await fetchAllJibeJobs(url, company);
      } else if (type === 'eightfold') {
        jobs = await fetchEightfoldJobs(url, company);
      } else if (type === 'njoyn') {
        jobs = await fetchNjoynJobs(url, company);
      } else if (type === 'phenom') {
        jobs = await fetchPhenomJobs(url, company);
      } else if (type === 'adp_wfn') {
        jobs = await fetchAdpWfnJobs(url, company);
      } else if (type === 'bamboohr') {
        const json = await fetchJson(url);
        jobs = parseBambooHR(json, company.name, publicBase);
      } else if (type === 'workable') {
        const json = await fetchJsonPost(url, {});
        jobs = parseWorkable(json, company.name, publicBase);
      } else if (type === 'workable_widget') {
        jobs = await fetchWorkableWidgetJobs(url, company);
      } else if (type === 'rippling') {
        jobs = await fetchRipplingJobs(url, company);
      } else if (type === 'avature') {
        jobs = await fetchAvatureJobs(url, company);
      } else if (type === 'jazzhr') {
        jobs = await fetchJazzhrJobs(url, company);
      } else if (type === 'icims') {
        jobs = await fetchIcimsJobs(url, company);
      } else if (type === 'successfactors') {
        jobs = await fetchSuccessFactorsJobs(url, company);
      } else if (type === 'amazon') {
        jobs = await fetchAmazonJobs(url, company);
      } else if (type === 'oracle_ce') {
        jobs = await fetchOracleCeJobs(url, company);
      } else if (type === 'rss') {
        jobs = await fetchRssJobs(url, company);
      } else if (type === 'smartrecruiters') {
        // Paginate — SmartRecruiters caps at 100 per page
        jobs = [];
        const MAX_PAGES = 10;
        for (let page = 0; page < MAX_PAGES; page++) {
          const pageUrl = `${url.replace(/([?&])offset=\d+/, '').replace(/\?$/, '')}${url.includes('?') ? '&' : '?'}offset=${page * 100}`;
          const json = await fetchJson(pageUrl);
          const pageJobs = parseSmartRecruiters(json, company.name);
          jobs.push(...pageJobs);
          if ((json.content?.length || 0) < 100) break;
        }
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
        // Workday "N Locations" placeholder → fetch detail to get real cities
        if (/^\d+\s+Locations?$/i.test(job.location) && job._detailUrl) {
          const detail = await fetchWorkdayDetail(job._detailUrl);
          if (detail) {
            job.location = workdayDetailLocation(detail, job.location);
            if (!job.description) job.description = workdayDetailDescription(detail);
          }
        }
        // Some Greenhouse boards (notably Stripe) put "N/A" in the list
        // endpoint but expose Canada offices on the detail endpoint.
        if (type === 'greenhouse' && (!job.location || /^N\/A$/i.test(job.location))) {
          const detail = await fetchGreenhouseDetail(job.url, greenhouseSlugFromApiUrl(url));
          if (detail) {
            job.location = greenhouseDetailLocation(detail, job.location);
            if (!job.description) job.description = stripHtml(detail.content || '');
          }
        }
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        // Mark the concrete posting URL as seen to avoid exact duplicates.
        // Do not dedupe by company+title: ATSs often reuse generic titles
        // like "AI Engineer" for distinct postings.
        seenUrls.add(job.url);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  let archivedJDs = 0;
  if (snapshotPath && !dryRun) {
    writeJobsSnapshot(newOffers, snapshotPath, date, {
      targetsCount: targets.length,
      skippedCount,
      totalFound,
      totalFiltered,
      totalFilteredLocation,
      totalDupes,
      errors,
    });
  } else if (!dryRun && newOffers.length > 0) {
    appendToJobs(newOffers, date);
    appendToScanHistory(newOffers, date);
    archivedJDs = await appendJdArchive(newOffers, date);
  }

  // Always re-number the jobs tracker so the `#` column stays dense
  // even if the user deleted rows manually between scans.
  if (!dryRun && !snapshotPath) renumberJobsFile();

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
  console.log(snapshotPath
    ? `Snapshot matches:       ${newOffers.length}`
    : `New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (snapshotPath && !dryRun) {
    console.log(`\nSnapshot saved to ${snapshotPath}`);
  } else if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${JOBS_PATH} and ${SCAN_HISTORY_PATH}`);
      if (archivedJDs > 0) {
        console.log(`JDs archived:          ${archivedJDs} → ${JD_ARCHIVE_PATH}`);
      }
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Re-usable exports so scan-playwright.mjs can share the pipeline helpers
// without triggering a full API scan on import.
export {
  loadDotenv,
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  appendToJobs,
  appendToScanHistory,
  renumberJobsFile,
  appendJdArchive,
  stripHtml,
  esc,
};
export const notifyTelegram = notifyTelegram_;

// Run main() only when executed directly (not when imported by another script).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
