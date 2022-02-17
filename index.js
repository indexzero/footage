import got from 'got';
import Bourne from '@hapi/bourne';
import mapLimit from 'async/mapLimit.js';
import groupsOf from 'in-groups-of';

import diagnostics from 'diagnostics';
const debug = diagnostics('footage');

// Range cannot be larger than 365 days.
const RANGE = process.env.NPM_RANGE || 'last-month';

// Naive regexp for separating scoped package names
const isScoped = /^\@([^\/]+)\/([^\/]+)$/

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
  const pkgs = {
    scoped: [],
    unscoped: []
  };

  for await (const { package: pkg } of results) {
    const cohort = isScoped.test(pkg.name) ? 'scoped' : 'unscoped';
    pkgs[cohort].push(pkg);
  }

  await downloadsFor({ pkgs, user });
};


async function downloadsFor({ pkgs, user }) {
  const { scoped, unscoped } = pkgs;
  await Promise.all([
    downloadsForScoped({ pkgs: scoped, user }),
    //downloadsForUnscoped({ pkgs: unscoped, user })
  ]);

};

async function downloadsForScoped({ pkgs, user }) {
  const names = pkgs.map(p => p.name).sort();

  debug('Downloads for:', names);

  const dls = await mapLimit(names, 10, async function dlsFor(name) {
    const res = await got(`${URLS.DOWNLOADS}/${RANGE}/${name}`).json();
    console.log(res);
    return res;
  });
}

async function downloadsForUnscoped({ pkgs, user }) {
  const names = pkgs.map(p => p.name).sort();

  debug('Downloads for:', names);
  const groups = groupsOf(names, 50);



  // //
  // // Does a simple reduce on the download
  // // keys of a single npm downloads request
  // //
  // function sumDownloads(names, stats) {
  //   names.forEach(function (name) {
  //     if (!stats[name]) { return; }
  //     stats[name].total = Object.keys(stats[name].downloads || {})
  //       .reduce(function (sum, key) {
  //         return sum + stats[name].downloads[key].downloads;
  //       }, 0);
  //   });

  //   return stats;
  // }

  // //
  // // Gets the statistics for the specified
  // // set of packages.
  // //
  // function getGroupStats(query) {
  //   return function (pkgs, next) {
  //     const uri = [baseUri, query, pkgs.join(',')].join('/');
  //     debug('GET ' + uri);
  //     hyperquest.get(uri)
  //       .pipe(concat({ encoding: 'string' }, function (data) {
  //         next(null, sumDownloads(pkgs, JSON.parse(data)));
  //       }));
  //   };
  // }

  // async.mapLimit(groups, 5, getGroupStats('last-month'), function (err, mapped) {
  //   const all = mapped.reduce(function (acc, group) {
  //     Object.keys(group).forEach(function (name) {
  //       acc[name] = group[name];
  //     });

  //     return acc;
  //   }, {});

  //   const userTotal = 0;
  //   Object.keys(all)
  //     .filter(function (name) { return !!all[name]; })
  //     .sort(function (lname, rname) {
  //       return all[lname].total - all[rname].total;
  //     })
  //     .forEach(function (name) {
  //       userTotal += all[name].total;
  //       console.log(name, all[name].total);
  //     });

  //   console.log(user, userTotal);
  // });
};

/**
 * Returns a Got-based iterator for returning pages of npm search results.
 *
 * See also:
 *
 * https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback
 * https://2ality.com/2019/11/nodejs-streams-async-iteration.html#writing-to-writable-streams
 * https://github.com/sindresorhus/got/blob/main/documentation/4-pagination.md
 * https://github.com/sindresorhus/got/blob/main/source/core/options.ts#L696
 *
 * @return {Iterator} Got-based iterator for abstracting over pages
 */
function getSearchIterator({ user, size = 100 }) {
  const searchParams = {
    text: `maintainer:${user}`,
    from: 0,
    size
  };

  debug(URLS.SEARCH, searchParams);
  return got.paginate(URLS.SEARCH, {
    method: 'get',
    searchParams,
    pagination: {
      paginate: ({ response, currentItems }) => {
        // If there are no more data, finish.
        if (currentItems.length === 0) {
          return false;
        }

        // Update the cursor by size in searchParams
        searchParams.from += size;
        debug(URLS.SEARCH, searchParams);

        return { searchParams };
      },
      // Using `Bourne` to prevent prototype pollution.
      transform: response => {
        const res = Bourne.parse(response.body);
        return res.objects;
      },
      // Wait 1s before making another request to prevent API rate limiting.
      backoff: 1000,
      // It is a good practice to set an upper limit of how many requests can be made.
      // This way we can avoid infinite loops.
      requestLimit: 285,
      // In this case, we don't need to store all the items we receive.
      // They are processed immediately.
      stackAllItems: false
    }
  });
}
