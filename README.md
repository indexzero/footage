# footage

[![Version npm](https://img.shields.io/npm/v/footage.svg?style=flat-square)](https://www.npmjs.com/package/footage)[![npm Downloads](https://img.shields.io/npm/dm/footage.svg?style=flat-square)](https://www.npmjs.com/package/footage)[![Dependencies](https://img.shields.io/david/indexzero/footage.svg?style=flat-square)](https://david-dm.org/indexzero/footage)

Get your Open Source game footage up to speed. Just a random project to answer a question I had when visiting http://npm-stats.com one night:

> Which of the modules I've written gets the most downloads?

## Usage

```
npm i -g footage
footage <user>
```

### Resumable runs

npm's download-counts API rate-limits bursts, so a large account may not finish
in a single pass. Pass `-o` to stream results to an append-only JSONL file;
re-running resumes from it and only fetches packages not yet recorded.

```
footage <user> -o results.jsonl
```

`footage` exits non-zero while packages are still pending, so you can just loop
until it completes:

```
until footage <user> -o results.jsonl; do sleep 30; done
```

Each line in the file is one package's result:

```json
{"ts":"2026-07-26T06:56:30.916Z","user":"substack","range":"last-month","name":"cabal-headless","downloads":51}
```

Set the range with `NPM_RANGE` (default `last-month`). Records are keyed by
user + range, so changing the range starts a fresh tally in the same file.

## Further reading

* npm Registry [API](https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md)
* npm Registry [download-counts API](https://github.com/npm/registry/blob/master/docs/download-counts.md)

##### LICENSE: MIT
##### AUTHOR: [Charlie Robbins](https://github.com/indexzero)
