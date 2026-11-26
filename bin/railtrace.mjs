#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { analyze, describe } from '../src/check.mjs';
import { readConfig } from '../src/config.mjs';
import { readCapture } from '../src/csv.mjs';
import { renderReport } from '../src/report.mjs';

const help = `RailTrace — power sequencing regression tests

Usage: railtrace --config rules.json [--html report.html] [--json report.json] <capture.csv> [...]

Exit codes: 0 all rules passed, 1 timing check failed, 2 input or execution error.
Use -- before positional filenames that start with a dash.`;

function parseArgs(args) {
  const options = {};
  const inputs = [];
  const flags = new Map([['--config', 'config'], ['--html', 'html'], ['--json', 'json']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      inputs.push(...args.slice(i + 1));
      break;
    }
    if (flags.has(arg)) {
      const key = flags.get(arg);
      if (options[key]) throw new Error(`${arg} can only be specified once`);
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a file path`);
      options[key] = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option "${arg}"`);
    } else {
      inputs.push(arg);
    }
  }
  if (!options.config || !inputs.length) throw new Error('provide --config and at least one CSV path');
  return { ...options, inputs };
}

function readInput(path, parse) {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

function fileIdentity(path) {
  let physical;
  try {
    physical = realpathSync.native(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    physical = join(realpathSync.native(dirname(resolve(path))), basename(path));
  }
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function save(path, content) {
  const temporary = join(dirname(resolve(path)), `.railtrace-${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(help);
    return 0;
  }
  const options = parseArgs(args);
  const config = readInput(options.config, readConfig);
  const runs = options.inputs.map(path => {
    const capture = readInput(path, source => readCapture(source, config));
    return { result: analyze(basename(path), capture, config), capture: options.html ? capture : null };
  });

  const usedPaths = new Set([options.config, ...options.inputs].map(fileIdentity));
  for (const destination of [options.html, options.json].filter(Boolean)) {
    const identity = fileIdentity(destination);
    if (usedPaths.has(identity)) throw new Error(`output path must differ from the inputs and other output: ${destination}`);
    usedPaths.add(identity);
  }
  const captures = runs.map(run => run.result);
  const passed = captures.every(capture => capture.failures === 0);
  if (options.html) save(options.html, renderReport(runs));
  if (options.json) save(options.json, JSON.stringify({ schemaVersion: 1, passed, captures }, null, 2) + '\n');

  for (const capture of captures) {
    console.log(`${capture.failures ? 'FAIL' : 'PASS'} ${capture.file} · ${capture.rules.length - capture.failures}/${capture.rules.length} rules passed`);
    for (const rule of capture.rules) {
      if (rule.status === 'fail') console.log(`  ${rule.id}: ${describe(rule)}`);
    }
  }
  return passed ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`railtrace: ${error.message}`);
  process.exitCode = 2;
}
