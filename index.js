import { Impit } from 'impit';
import sjson from 'secure-json-parse';
import PQueue from 'p-queue';

import diagnostics from 'diagnostics';
const _debug = diagnostics('footage');
const debug = (...args) => _debug(`[${new Date().toISOString()}]`, ...args);

// Create impit instance for HTTP requests
const impit = new Impit({ browser: 'chrome' });

// Range cannot be larger than 365 days.
const RANGE = process.env.NPM_RANGE || 'last-month';

// Static npm mirror URLs
const URLS = {
  SEARCH: 'https://registry.npmjs.org/-/v1/search',
  DOWNLOADS: 'https://api.npmjs.org/downloads/point'
};

/**
 * { function_description }
 *
 * @param      {<type>}   user    The user
 * @return     {Promise}  { description_of_the_return_value }
 */
export default async function footage(user) {
  const results = getSearchIterator({ user });
  const pkgs = [];

  for await (const { package: pkg } of results) {
    pkgs.push(pkg);
  }

  await downloadsFor({ pkgs, user });
};

async function downloadsFor({ pkgs, user }) {
  const pretty = new Intl.NumberFormat();
  const names = pkgs.map(p => p.name).sort();

  debug('Downloads for:', names);

  const dls = [];

  // Rate limit: 1 request per 500ms (2 req/sec max)
  const queue = new PQueue({
    concurrency: 1,
    interval: 500,
    intervalCap: 1
  });

  async function fetchDownloads(name, retryCount = 0) {
    const target = `${URLS.DOWNLOADS}/${RANGE}/${name}`;

    debug(`GET ${target}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
    const response = await impit.fetch(target);
    const body = await response.text();

    // Delay after each request to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 500));

    if (response.status === 429) {
      // Exponential backoff: 10s * 2^retry, max 5 minutes
      const backoff = Math.min(10000 * Math.pow(2, retryCount), 300000);
      debug(`GET ${target} rate limited (429), waiting ${backoff / 1000}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      // Retry immediately with incremented count
      return fetchDownloads(name, retryCount + 1);
    }

    if (!response.ok) {
      debug(`GET ${target} failed with status ${response.status}`);
      return { downloads: 0, package: name };
    }

    const res = sjson.parse(body);
    debug(`GET ${target} ok`, res);
    return res;
  }

  debug(`Processing ${names.length} packages`);

  const promises = names.map(name =>
    queue.add(() => fetchDownloads(name))
      .then(res => dls.push(res))
      .catch(err => {
        debug(`Unexpected error for ${name}:`, err.message);
        dls.push({ downloads: 0, package: name });
      })
  );

  await Promise.all(promises);
  await queue.onIdle();

  const total = dls.reduce((sum, res) => {
    const { downloads, package: name } = res;
    console.log(`${name}: ${pretty.format(downloads)}`)
    return sum + downloads;
  }, 0);

  console.log(`\n-----------------------------------------
Total downloads for ${user} in ${RANGE}: ${pretty.format(total)}
-----------------------------------------`);
}

/**
 * Returns an async iterator for returning pages of npm search results.
 *
 * @return {AsyncGenerator} Async iterator for abstracting over pages
 */
async function* getSearchIterator({ user, size = 100 }) {
  const searchParams = {
    text: `maintainer:${user}`,
    from: 0,
    size
  };

  const requestLimit = 285;
  const backoff = 1000;
  let requestCount = 0;

  while (requestCount < requestLimit) {
    const url = new URL(URLS.SEARCH);
    url.searchParams.set('text', searchParams.text);
    url.searchParams.set('from', searchParams.from.toString());
    url.searchParams.set('size', searchParams.size.toString());

    debug(URLS.SEARCH, searchParams);

    const response = await impit.fetch(url.toString());
    const body = await response.text();
    // Using `secure-json-parse` to prevent prototype pollution.
    const res = sjson.parse(body);
    const items = res.objects;

    // If there are no more data, finish.
    if (!items || items.length === 0) {
      return;
    }

    // Yield each item individually
    for (const item of items) {
      yield item;
    }

    // Update the cursor by size in searchParams
    searchParams.from += size;
    requestCount++;

    // Wait before making another request to prevent API rate limiting.
    if (requestCount < requestLimit) {
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
}
