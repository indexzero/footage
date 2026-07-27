#!/usr/bin/env node

import { parseArgs } from 'node:util';

import footage from '../index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' }
  }
});

const [user] = positionals;

if (!user) {
  console.error('Usage: footage <user> [-o results.jsonl]');
  process.exit(1);
}

try {
  const { complete } = await footage(user, { output: values.output });

  // Exit non-zero while packages are still pending so a shell loop can retry:
  //   until footage <user> -o results.jsonl; do sleep 30; done
  process.exitCode = complete ? 0 : 1;
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
