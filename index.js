'use strict';

var async = require('async'),
    concat = require('concat-stream'),
    hyperquest = require('hyperquest'),
    groupsOf = require('in-groups-of');

var debug = require('diagnostics')('footage');

//
// Range cannot be larger than 365 days.
//
var RANGE = process.env.NPM_RANGE || 'last-month';

var footage = module.exports = function (user) {
  var searchUri = 'https://skimdb.npmjs.com/registry/_design/app/_view/byUser?key='

  hyperquest.get(searchUri + '%22' + user + '%22')
    .pipe(concat({ encoding: 'string' }, function (data) {
      footage.downloads(JSON.parse(data), user);
    }));
};

footage.downloads = function (pkgs, user) {
  var baseUri = 'https://api.npmjs.org/downloads/range';
  var groups = groupsOf(pkgs.rows.map(function (row) {
    return row.id;
  }).sort(), 50);

  //
  // Does a simple reduce on the download
  // keys of a single npm downloads request
  //
  function sumDownloads(names, stats) {
    names.forEach(function (name) {
      if (!stats[name]) { return; }
      stats[name].total = Object.keys(stats[name].downloads || {})
        .reduce(function (sum, key) {
          return sum + stats[name].downloads[key].downloads;
        }, 0);
    });

    return stats;
  }

  //
  // Gets the statistics for the specified
  // set of packages.
  //
  function getGroupStats(query) {
    return function (pkgs, next) {
      var uri = [baseUri, query, pkgs.join(',')].join('/');
      debug('GET ' + uri);
      hyperquest.get(uri)
        .pipe(concat({ encoding: 'string' }, function (data) {
          next(null, sumDownloads(pkgs, JSON.parse(data)));
        }));
    };
  }

  async.mapLimit(groups, 5, getGroupStats('last-month'), function (err, mapped) {
    var all = mapped.reduce(function (acc, group) {
      Object.keys(group).forEach(function (name) {
        acc[name] = group[name];
      });

      return acc;
    }, {});

    var userTotal = 0;
    Object.keys(all)
      .filter(function (name) { return !!all[name]; })
      .sort(function (lname, rname) {
        return all[lname].total - all[rname].total;
      })
      .forEach(function (name) {
        userTotal += all[name].total;
        console.log(name, all[name].total);
      });

    console.log(user, userTotal);
  });
};
