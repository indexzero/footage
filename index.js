import { appendFile, readFile } from 'node:fs/promises';

import { Impit } from 'impit';
import Bourne from '@hapi/bourne';
import mapLimit from 'async/mapLimit.js';

import diagnostics from 'diagnostics';
const debug = diagnostics('footage');

// Range cannot be larger than 365 days.
const RANGE = process.env.NPM_RANGE || 'last-month';

// Static npm mirror URLs
const URLS = {
  SEARCH: 'https://registry.npmjs.org/-/v1/search',
  DOWNLOADS: 'https://api.npmjs.org/downloads/point'
};

// Shared impit client. Impersonates a real browser so the npm registry's
// Cloudflare layer doesn't reject us with an `error code: 1015` rate limit.
const impit = new Impit({ browser: 'chrome' });

// Wait 1s between requests to prevent API rate limiting.
const BACKOFF = 1000;

// Statuses got retried automatically. impit's fetch does neither retries nor
// throwing on non-2xx, so we restore both below. npm's Cloudflare layer
// throttles bursts aggressively, so we retry generously with exponential
// backoff (capped) to ride out a rate-limit window.
const RETRY_STATUS = new Set([408, 413, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 6;
const MAX_BACKOFF = 20000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Computes how long to wait before the next retry. Honors a `Retry-After`
 * header (in seconds) when the server sends a useful value, otherwise falls
 * back to exponential backoff capped at MAX_BACKOFF.
 */
function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF);
  }

  return Math.min(BACKOFF * 2 ** attempt, MAX_BACKOFF);
}

/**
 * Performs a GET request via impit, restoring the two `got` behaviors that the
 * fetch-compatible API drops: retrying transient failures with backoff, and
 * throwing on non-2xx responses (fetch resolves them instead).
 *
 * @param  {string}  target  The URL to fetch.
 * @return {Promise<ImpitResponse>}  The successful (2xx) response.
 */
async function request(target) {
  for (let attempt = 0; ; attempt++) {
    const response = await impit.fetch(target);

    if (response.ok) {
      return response;
    }

    if (RETRY_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      const delay = retryDelay(response, attempt);
      debug(`GET ${target} -> ${response.status}, retrying in ${delay}ms`);
      await wait(delay);
      continue;
    }

    const error = new Error(`GET ${target} failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
}

/**
 * Tallies npm download counts for every package a user maintains.
 *
 * When `output` is given, results are streamed to an append-only JSONL file and
 * a re-run resumes from it — fetching only packages not yet recorded. This lets
 * a rate-limited run be retried in a loop until it completes.
 *
 * @param   {string}  user             npm maintainer to tally downloads for.
 * @param   {object}  [options]
 * @param   {string}  [options.output] Path to an append-only JSONL results file.
 * @return  {Promise<{ complete: boolean, total: number, missing: string[] }>}
 */
export default async function footage(user, { output } = {}) {
  const results = getSearchIterator({ user });
  const pkgs = [];

  for await (const { package: pkg } of results) {
    pkgs.push(pkg);
  }

  return downloadsFor({ pkgs, user, output });
};

async function downloadsFor({ pkgs, user, output }) {
  const pretty = new Intl.NumberFormat();
  const names = pkgs.map(p => p.name).sort();

  // Resume from anything already recorded for this user + range, then only
  // fetch the packages we're still missing.
  const recorded = await loadRecorded(output, { user, range: RANGE });
  const append = output ? createAppender(output) : null;
  const pending = names.filter(name => !recorded.has(name));

  debug(`Downloads for ${names.length} packages (${pending.length} pending)`);

  await mapLimit(pending, DOWNLOAD_CONCURRENCY, async function dlsFor(name) {
    const target = `${URLS.DOWNLOADS}/${RANGE}/${name}`;

    try {
      debug(`GET ${target}`);
      const { downloads } = await request(target).then(response => response.json());
      const record = { ts: new Date().toISOString(), user, range: RANGE, name, downloads };
      if (append) await append(record);
      recorded.set(name, record);
      debug(`GET ${target} ok`, downloads);
    } catch (err) {
      // Transient failures (rate limits, 5xx) are left pending so a re-run
      // retries them. Permanent ones (e.g. 404) are recorded as resolved so we
      // don't retry them forever and can still reach completion.
      if (err.status && !RETRY_STATUS.has(err.status)) {
        const record = { ts: new Date().toISOString(), user, range: RANGE, name, downloads: 0, error: `HTTP ${err.status}` };
        if (append) await append(record);
        recorded.set(name, record);
      }
      debug(`GET ${target} failed: ${err.message}`);
    }
  });

  // Report from everything recorded so far, in stable (sorted) order.
  let total = 0;
  for (const name of names) {
    const record = recorded.get(name);
    if (!record) continue;
    console.log(`${name}: ${pretty.format(record.downloads)}`);
    total += record.downloads;
  }

  const missing = names.filter(name => !recorded.has(name));
  const complete = missing.length === 0;

  console.log(`\n-----------------------------------------
Total downloads for ${user} in ${RANGE}: ${pretty.format(total)}
-----------------------------------------`);

  if (!complete) {
    console.error(`Incomplete: ${missing.length} of ${names.length} packages still pending (likely rate-limited). Re-run to resume.`);
  }

  return { complete, total, missing };
}

/**
 * Loads previously recorded results from an append-only JSONL file so a re-run
 * can resume where a rate-limited run left off. Only records matching the
 * current `user` and `range` are reused.
 *
 * @return {Promise<Map<string, object>>} package name -> recorded result
 */
async function loadRecorded(output, { user, range }) {
  const recorded = new Map();
  if (!output) return recorded;

  let content;
  try {
    content = await readFile(output, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return recorded; // nothing recorded yet
    throw err;
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let record;
    try {
      // Using `Bourne` to prevent prototype pollution.
      record = Bourne.parse(line);
    } catch {
      continue; // skip a partial/corrupt trailing line
    }

    if (record.name && record.user === user && record.range === range) {
      recorded.set(record.name, record);
    }
  }

  return recorded;
}

/**
 * Creates a function that appends JSONL records to `output`. Writes are
 * serialized through a promise chain so concurrent download workers can't
 * interleave partial lines.
 */
function createAppender(output) {
  let chain = Promise.resolve();
  return record => {
    chain = chain.then(() => appendFile(output, `${JSON.stringify(record)}\n`));
    return chain;
  };
}

// An upper limit of how many requests can be made. This way we can avoid
// infinite loops.
const REQUEST_LIMIT = 285;

// How many download-count requests to run at once. Kept modest because npm's
// downloads endpoint throttles bursts (an over-eager count trips a 429).
const DOWNLOAD_CONCURRENCY = 5;

/**
 * Returns an async iterator over pages of npm search results.
 *
 * impit exposes a `fetch`-compatible API with no built-in pagination helper
 * (as `got.paginate` provided), so we walk the cursor by hand: each page bumps
 * `from` by `size` until an empty page is returned or the request limit is hit.
 *
 * See also:
 *
 * https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback
 * https://2ality.com/2019/11/nodejs-streams-async-iteration.html#writing-to-writable-streams
 *
 * @return {AsyncIterator} iterator over individual search result items
 */
async function* getSearchIterator({ user, size = 100 }) {
  const searchParams = {
    text: `maintainer:${user}`,
    from: 0,
    size
  };

  for (let requests = 0; requests < REQUEST_LIMIT; requests++) {
    const url = new URL(URLS.SEARCH);
    url.search = new URLSearchParams(searchParams).toString();

    debug(URLS.SEARCH, searchParams);
    const response = await request(url.toString());
    // Using `Bourne` to prevent prototype pollution.
    const { objects: currentItems } = Bourne.parse(await response.text());

    // If there are no more data, finish.
    if (currentItems.length === 0) {
      return;
    }

    yield* currentItems;

    // Update the cursor by size in searchParams.
    searchParams.from += size;

    // Wait before making another request to prevent API rate limiting.
    await wait(BACKOFF);
  }
}
