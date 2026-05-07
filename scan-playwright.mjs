#!/usr/bin/env node

/**
 * scan-playwright.mjs — Generic Playwright scraper for companies without API.
 *
 * Strategy:
 *   1. Filter tracked_companies to those that scan.mjs cannot reach (no API).
 *   2. Open each careers_url in headless Chromium (sequentially, polite).
 *   3. Extract job signals via two passes:
 *      - JSON-LD JobPosting (schema.org) — structured, accurate.
 *      - Generic <a> heuristic — filter links whose href/text looks like a job.
 *   4. Apply same title + location filters as scan.mjs (location heuristic only).
 *   5. Dedup against scan-history.tsv + jobs.md.
 *   6. Append new offers to jobs.md, scan-history.tsv, jd-archive.md (title only).
 *   7. Optionally notify Telegram (same Bot API).
 *
 * Usage:
 *   node scan-playwright.mjs                 # scan all no-API companies
 *   node scan-playwright.mjs --dry-run       # preview, no writes
 *   node scan-playwright.mjs --company Clio  # single company
 *   node scan-playwright.mjs --notify-telegram
 *
 * Zero Claude API tokens — pure browser automation + JS.
 */

import { readFileSync, existsSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

import {
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  appendToJobs,
  appendToScanHistory,
  renumberJobsFile,
  appendJdArchive,
  notifyTelegram,
} from './scan.mjs';

const PORTALS_PATH = 'portals.yml';
const PAGE_TIMEOUT_MS = 25_000;
const SPA_SETTLE_MS = 8000;
// After initial settle, keep polling up to this long for late-loading job links.
const LATE_LOAD_POLL_MS = 8000;
const LATE_LOAD_INTERVAL_MS = 1500;
const MAX_LINKS_PER_PAGE = 300;

// URL substrings that look like a real job posting (not a category/search page)
const JOB_URL_PATTERNS = [
  /\/careers\/jobs?\//i,
  /\/careers\/positions?\//i,
  /\/careers\/roles?\//i,
  /\/careers\/openings?\//i,
  /\/jobs\/\d+/i,                           // Dayforce-style: /jobs/95405
  /\/jobs\/[^/?#]+$/i,
  /\/job\/[^/?#]+/i,
  /\/positions?\/[^/?#]+/i,
  /\/openings?\/[^/?#]+/i,
  /\/opportunities?\/[^/?#]+/i,
  /\/requisitions?\/[^/?#]+/i,
  /\/jobdetails/i,
  /\/view\/[^/?#]+\/[^/?#]+/i,              // Workable / Personio
  /\/careers\/[^/?#]+_[a-f0-9-]{8,}/i,      // Shopify-style: /careers/role-name_{uuid}
  /\/roles?\/[a-z0-9][^/?#]*\/?$/i,         // Clio-style: /roles/role-name/
  /\/jobs\/results\/[^/?#]+/i,              // Google: /jobs/results/{id}-{slug}
  /\/profile\/job_details\/\d+/i,           // Meta: /profile/job_details/{id}
  /\/job_details\/\d+/i,                    // generic Meta-like
  /\/en-ca\/details\/\d+/i,                 // Apple: /en-ca/details/{id}/{slug}
  /\/details\/\d+\/[^/?#]+/i,               // Apple variant
  /\/JobDetail/i,                           // IBM, Bloomberg
  /\/job\/[^/?#]+\/[^/?#]+\/\d+\/\d+/i,     // Intuit: /job/{city}/{slug}/{org}/{id}
  /\/global\/en\/job\/\d+\/[^/?#]+/i,       // Cisco/Splunk: /global/en/job/{id}/{slug}
  /\/sites\/jobsearch\/job\/\d+/i,           // Oracle: /sites/jobsearch/job/{id}
  /[?&]jobId=\d+/i,                         // IBM query-string IDs
  /applytojob\.com\/apply\/[^/?#]+\/[^/?#]+/i, // JazzHR: /apply/{token}/{slug}
  /apply\.workable\.com\/j\/[A-Z0-9]+/i,    // Workable: /j/{id}
  /CANDIDATEPORTAL\/jobs\/\d+/i,            // Dayforce candidate portal
  /\/careers\/job_id=[A-Z_]+-\d+-\d+/i,     // Clio: /careers/job_id=JOB_POSTING-3-{id}/
  /\/go\/[^/?#]+\/\d+/i,                    // Scotiabank: /go/{slug}/{id}/
  /\/roles?\/\d+/i,                         // Goldman Sachs: higher.gs.com/roles/{id}
  /xweb\.asp\?.*Page=JobDetails/i,           // Njoyn: xweb.asp?...Page=JobDetails&...
  /\/company\/careers\/[^/?#]+\/[^/?#]+-\d+/i, // Databricks: /company/careers/{team}/{slug-id}
];

// Patterns to explicitly reject (category pages, filters, etc.)
const REJECT_URL_PATTERNS = [
  /#/,
  /\?filter/i,
  /[?&]mode=title/i,
  /\/careers\/?$/i,
  /\/careers\/team/i,
  /\/careers\/locations?/i,
  /\/jobs\/?$/i,
  /mailto:/i,
  /tel:/i,
  /javascript:/i,
];

function detectApi(company) {
  const url = company.careers_url || '';
  if (company.scan_method && company.scan_method !== 'playwright' && company.scan_method !== 'websearch') return true;
  if (company.api && company.api.includes('greenhouse')) return true;
  if (/jobs\.ashbyhq\.com\//.test(url)) return true;
  if (/jobs\.lever\.co\//.test(url)) return true;
  if (/job-boards(?:\.eu)?\.greenhouse\.io\//.test(url)) return true;
  if (/jobs\.smartrecruiters\.com\//.test(url)) return true;
  if (/api\.smartrecruiters\.com\/v1\/companies\//.test(url)) return true;
  if (/apply\.workable\.com\/[^/?#]+/.test(url)) return true;
  if (/ats\.rippling\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?[^/?#]+\/jobs/i.test(url)) return true;
  if (/\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com/.test(url)) return true;
  if (/\/\/wd\d+\.myworkdaysite\.com\/recruiting\//.test(url)) return true;
  return false;
}

function looksLikeJobUrl(href) {
  if (!href || !/^https?:/i.test(href)) return false;
  if (REJECT_URL_PATTERNS.some(re => re.test(href))) return false;
  return JOB_URL_PATTERNS.some(re => re.test(href));
}

// Some career sites concatenate text without spaces ("AnalyticsData EngineerEntry")
// which breaks word-boundary regex matching. Normalize by inserting a space at
// camelCase/PascalCase boundaries.
function normalizeTitle(t) {
  return String(t || '')
    // Strip inline CSS / SVG junk that some sites bake into anchor text
    .replace(/\.st\d+\{[^}]*\}/g, '')
    .replace(/\{[^}]*fill:[^}]*\}/g, '')
    // Insert spaces at camelCase / PascalCase boundaries
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/\s+Locations?\s+.*$/i, '')
    .trim();
}

// Runs INSIDE the page (serialised to string). Returns array of raw signals.
/* c8 ignore next */
function pageExtractor() {
  const out = [];

  // 1. JSON-LD JobPosting (schema.org) — most reliable
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent || '{}');
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        const nodes = item['@graph'] || [item];
        for (const n of nodes) {
          if (n['@type'] === 'JobPosting' && n.title && n.url) {
            const loc = [];
            const jobLoc = n.jobLocation;
            if (Array.isArray(jobLoc)) {
              for (const j of jobLoc) loc.push(j?.address?.addressLocality || j?.address?.addressRegion || '');
            } else if (jobLoc) {
              loc.push(jobLoc?.address?.addressLocality || jobLoc?.address?.addressRegion || '');
            }
            out.push({
              source: 'json-ld',
              title: String(n.title).trim(),
              url: String(n.url).trim(),
              location: loc.filter(Boolean).join('; '),
            });
          }
        }
      }
    } catch {}
  }

  // 2. Generic <a> extraction — iterate all anchors on the page
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.href;
    let text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 4) {
      let labelNode = a.parentElement;
      for (let depth = 0; depth < 4 && labelNode && (!text || text.length < 4); depth++, labelNode = labelNode.parentElement) {
        text = (labelNode.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
    if (!href || !text || text.length < 4) continue;
    // Try to find a nearby location — walk up 3 parents and look for common patterns
    let location = '';
    let node = a.parentElement;
    for (let depth = 0; depth < 3 && node && !location; depth++, node = node.parentElement) {
      const spans = node.querySelectorAll('[class*="location" i], [data-test*="location" i], [data-qa*="location" i], [aria-label*="location" i]');
      for (const sp of spans) {
        const txt = (sp.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && txt.length < 120) { location = txt; break; }
      }
    }
    out.push({ source: 'anchor', title: text, url: href, location });
  }

  return out;
}

async function scrapeCompany(browser, company, filters) {
  const { titleFilter, locationFilter } = filters;
  const result = { company: company.name, offers: [], error: null, raw: 0 };

  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  try {
    const resp = await page.goto(company.careers_url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });
    const status = resp?.status() ?? 0;
    if (status >= 400) {
      result.error = `HTTP ${status}`;
      return result;
    }

    // Let SPAs render
    await page.waitForTimeout(SPA_SETTLE_MS);

    // Some sites (Clio, etc.) lazy-load job listings via internal widgets.
    // After the initial settle, poll for new anchors until either we see new
    // job-shaped URLs or the poll budget is exhausted.
    let signals = await page.evaluate(pageExtractor);
    let prevJobUrlCount = signals.filter(s => looksLikeJobUrl(s.url)).length;
    const pollUntil = Date.now() + LATE_LOAD_POLL_MS;
    while (Date.now() < pollUntil) {
      await page.waitForTimeout(LATE_LOAD_INTERVAL_MS);
      const next = await page.evaluate(pageExtractor);
      const nextJobUrlCount = next.filter(s => looksLikeJobUrl(s.url)).length;
      if (nextJobUrlCount > prevJobUrlCount) {
        signals = next;
        prevJobUrlCount = nextJobUrlCount;
      } else if (nextJobUrlCount > 0) {
        // Stable count > 0 → likely fully loaded
        signals = next;
        break;
      }
    }
    result.raw = signals.length;

    // Dedup within page by URL
    const seen = new Set();
    for (const s of signals) {
      if (!looksLikeJobUrl(s.url)) continue;
      if (seen.has(s.url)) continue;
      seen.add(s.url);

      const normalizedTitle = normalizeTitle(s.title);
      if (!titleFilter(normalizedTitle)) continue;
      // Most playwright_ready URLs are already pre-filtered by Canada at the URL
      // level. Some portals ignore their location query, so allow per-company
      // enforcement using nearby location text plus the full card text.
      if (company.playwright_apply_location_filter) {
        const locationProbe = [s.location, normalizedTitle].filter(Boolean).join(' ');
        if (!locationFilter(locationProbe)) continue;
      }

      result.offers.push({
        title: normalizedTitle,
        url: s.url,
        company: company.name,
        location: s.location,
        source: 'playwright',
        description: '',
      });
    }
  } catch (err) {
    result.error = err.message.split('\n')[0];
  } finally {
    await page.close();
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const shouldNotify = args.includes('--notify-telegram');
  const ci = args.indexOf('--company');
  const filterCompany = ci !== -1 ? args[ci + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const all = cfg.tracked_companies || [];
  const titleFilter = buildTitleFilter(cfg.title_filter);
  const locationFilter = buildLocationFilter(cfg.location_filter);

  const targets = all
    .filter(c => c.enabled !== false)
    .filter(c => !detectApi(c))
    .filter(c => c.careers_url)
    // Only scan companies whose careers_url has been verified as a listings page
    // (marked with `playwright_ready: true`). This avoids false positives from
    // marketing landing pages.
    .filter(c => c.playwright_ready === true || filterCompany)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

  console.log(`Playwright scan — ${targets.length} companies (no-API, weekly deep sweep)`);
  if (dryRun) console.log('(dry run — no files will be written)');

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const browser = await chromium.launch({ headless: true });
  const newOffers = [];
  const companyStats = [];

  for (const company of targets) {
    process.stdout.write(`  ${company.name.padEnd(26)} `);
    const r = await scrapeCompany(browser, company, { titleFilter, locationFilter });

    let added = 0;
    for (const offer of r.offers) {
      if (seenUrls.has(offer.url)) continue;
      const key = `${offer.company.toLowerCase()}::${offer.title.toLowerCase()}`;
      if (seenCompanyRoles.has(key)) continue;
      seenUrls.add(offer.url);
      seenCompanyRoles.add(key);
      newOffers.push(offer);
      added++;
    }

    companyStats.push({ name: company.name, raw: r.raw, added, error: r.error });
    if (r.error) console.log(`✗ ${r.error}`);
    else console.log(`${r.raw.toString().padStart(4)} links → +${added} new`);
  }

  await browser.close();

  // Write results
  const date = new Date().toISOString().slice(0, 10);
  let archivedJDs = 0;
  if (!dryRun && newOffers.length > 0) {
    appendToJobs(newOffers, date);
    appendToScanHistory(newOffers, date);
    archivedJDs = await appendJdArchive(newOffers, date);
  }
  if (!dryRun) renumberJobsFile();

  // Summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Playwright Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total raw links:       ${companyStats.reduce((s, c) => s + c.raw, 0)}`);
  console.log(`New offers added:      ${newOffers.length}`);
  const errored = companyStats.filter(c => c.error);
  if (errored.length) {
    console.log(`\nErrors (${errored.length}):`);
    for (const e of errored) console.log(`  ✗ ${e.name}: ${e.error}`);
  }
  const zero = companyStats.filter(c => !c.error && c.raw === 0);
  if (zero.length) {
    console.log(`\nNo links found (${zero.length}):`);
    for (const e of zero) console.log(`  ⚠ ${e.name}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (!dryRun) {
      console.log(`\nResults saved to data/jobs.md + data/scan-history.tsv`);
      if (archivedJDs > 0) console.log(`JDs archived: ${archivedJDs}`);
    }
  }

  // Telegram notify
  if (shouldNotify && !dryRun) {
    try {
      await notifyTelegram(newOffers, date);
    } catch (err) {
      console.error('Telegram notify failed:', err.message);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
