import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyze, findEdge } from '../src/check.mjs';
import { readConfig } from '../src/config.mjs';
import { readCapture } from '../src/csv.mjs';
import { renderReport } from '../src/report.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'railtrace.mjs');
const fixture = name => readFileSync(join(root, 'examples', name), 'utf8');
const config = readConfig(fixture('sequence.json'));
const edge = (time, volts, options = {}) => findEdge(time, volts, {
  edge: 'rising', thresholdV: 1, holdMs: 0, ...options,
});

test('interpolates rising and falling crossings with uneven samples', () => {
  assert.equal(edge([-2, 0, 5], [0, 0, 2]), 2.5);
  assert.equal(edge([0, 3, 7], [2, 2, 0], { edge: 'falling' }), 5);
  assert.equal(edge([0, 1], [-Number.MAX_VALUE, Number.MAX_VALUE], { thresholdV: 0 }), 0.5);
});

test('measures hold from the crossing and ignores a short glitch', () => {
  assert.equal(edge([0, 1, 2, 3, 4, 6], [0, 2, 0, 0, 2, 2], { holdMs: 1.25 }), 3.5);
  assert.equal(edge([0, 1, 2], [0, 2, 0], { holdMs: 1 }), 0.5);
  assert.equal(edge([0, 1, 2], [0, 2, 0], { holdMs: 1.01 }), null);
  assert.equal(edge([0, 1, 2], [0, 0, 2], { holdMs: 1 }), null);
});

test('requires an observed transition when the initial sample is active', () => {
  assert.equal(edge([0, 1, 2], [2, 2, 2]), null);
  assert.equal(edge([0, 1, 2], [1, 0, 2]), 1.5);
  assert.equal(edge([0, 1, 2], [0, 1, 1]), 1);
});

test('handles metadata, units, quoted multiline columns, BOM, and time conversion', () => {
  const customized = readConfig(JSON.stringify({
    csv: { timeColumn: 'Time; usec', timeUnit: 'us', delimiter: ';', skipRows: 1, skipDataRows: 1 },
    signals: [
      { id: 'a', column: 'Rail "A"' },
      { id: 'b', column: 'B\nprobe' },
    ].map(signal => ({ ...signal, thresholdV: 1 })),
    rules: [{ id: 'order', kind: 'order', from: 'a', to: 'b' }],
  }));
  const input = '\uFEFFInstrument metadata\r\n"Time; usec";"Rail ""A""";"B\r\nprobe";other\r\nus;V;V;x\r\n-1e3;0;0;\r\n\r\n2.5E3;+2.;.5;data';
  assert.deepEqual(readCapture(input, customized), { timeMs: [-1, 2.5], voltages: [[0, 2], [0, 0.5]] });
});

test('rejects damaged rows and ambiguous or unusable columns', () => {
  const header = 'Time (ms),VIN_5V,VDD_1V8,RESET_N\n';
  assert.throws(() => readCapture(header + '0,0,0,0\n0,1,1,1', config), /line 3: time must increase/);
  assert.throws(() => readCapture(header + '0,0,0,0\n1,1,,1', config), /line 3.*VDD_1V8.*finite/);
  assert.throws(() => readCapture(header + '0,0,0,0\n1,1,1', config), /line 3: expected 4 fields/);
  assert.throws(() => readCapture(header + '0,0,0,0\n1,1,"1', config), /line 3: unclosed/);
  assert.throws(() => readCapture(header.replace('VDD_1V8', 'VIN_5V'), config), /duplicate column/);
});

test('rejects unresolved rule signals and reversed delay bounds', () => {
  const unknown = JSON.parse(fixture('sequence.json'));
  unknown.rules[0].to = 'missing';
  assert.throws(() => readConfig(JSON.stringify(unknown)), /unknown signal/);
  const reversed = JSON.parse(fixture('sequence.json'));
  reversed.rules[1].maxMs = 0.8;
  assert.throws(() => readConfig(JSON.stringify(reversed)), /maxMs.*>= 1/);
});

test('checks strict order, both inclusive delay bounds, and missing edges', () => {
  const signal = id => ({ id, thresholdV: 1, edge: 'rising', holdMs: 0 });
  const settings = {
    signals: [signal('power'), signal('reset')],
    rules: [
      { id: 'order', kind: 'order', from: 'power', to: 'reset' },
      { id: 'delay', kind: 'delay', from: 'power', to: 'reset', minMs: 1, maxMs: 2 },
    ],
  };
  const timeMs = [0, 1, 2, 3, 4];
  const check = reset => analyze('test.csv', { timeMs, voltages: [[0, 2, 2, 2, 2], reset] }, settings).rules;
  assert.equal(check([0, 2, 2, 2, 2])[0].reason, 'out_of_order');
  assert.equal(check([0, 0, 2, 2, 2])[1].status, 'pass');
  assert.equal(check([0, 0, 0, 2, 2])[1].status, 'pass');
  assert.equal(check([0, 0, 0, 0, 2])[1].reason, 'too_late');
  assert.equal(check([0, 0, 0, 0, 2])[1].limitMs, 2.5);
  assert.deepEqual(check([0, 0, 0, 0, 0])[0].missing, ['reset']);
});

test('a 100 ms gap cannot establish a 5 ms hold or an earlier qualifying edge', () => {
  const settings = {
    csv: { maxSampleGapMs: 5 },
    signals: [
      { id: 'power', thresholdV: 1, edge: 'rising', holdMs: 5 },
      { id: 'reset', thresholdV: 1, edge: 'rising', holdMs: 0 },
    ],
    rules: [{ id: 'sequence', kind: 'order', from: 'reset', to: 'power' }],
  };
  const reference = analyze('gap.csv', { timeMs: [0, 1, 101], voltages: [[0, 2, 2], [0, 2, 2]] }, settings);
  assert.equal(reference.signals[0].eventMs, null);
  assert.equal(reference.signals[1].eventMs, 0.5);
  assert.equal(reference.rules[0].status, 'insufficient_evidence');
  assert.deepEqual(reference.rules[0].gap, { startMs: 1, endMs: 101, nextSample: 2 });
  assert.equal(reference.failures, 0);
  assert.equal(reference.insufficient, 1);

  const within = analyze('limit.csv', { timeMs: [0, 1, 6, 106], voltages: [[0, 1, 2, 2], [0, 2, 2, 2]] }, settings);
  assert.equal(within.signals[0].eventMs, 1);
  assert.equal(within.rules[0].status, 'pass');

  const earlyGap = analyze('hidden.csv', { timeMs: [0, 100, 101, 105, 106], voltages: [
    [0, 0, 2, 2, 2], [0, 0, 2, 2, 2],
  ] }, settings);
  assert.equal(earlyGap.signals[0].eventMs, null);
  assert.equal(earlyGap.rules[0].reason, 'sample_gap');
  const invalid = JSON.parse(fixture('sequence.json'));
  invalid.csv.maxSampleGapMs = 0;
  assert.throws(() => readConfig(JSON.stringify(invalid)), /maxSampleGapMs.*> 0/);
});

test('serializes executable-looking labels only as report data', () => {
  const capture = readCapture(fixture('fail.csv'), config);
  const name = '</script><script>alert(1)</script>';
  const result = analyze(name, capture, config);
  const html = renderReport([{ result, capture }]);
  const data = /<script id="runs" type="application\/json">(.*?)<\/script>/s.exec(html)[1];
  assert.ok(!data.includes('<'));
  assert.equal(JSON.parse(data)[0].file, name);
});

test('CLI emits reports for failed rules, with distinct exit codes for pass and invalid input', () => {
  const temporary = join(root, '.test-output');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(join(temporary, 'run-'));
  const run = (...args) => spawnSync(process.execPath, [cli, '--config', 'examples/sequence.json', ...args], {
    cwd: root, encoding: 'utf8',
  });
  try {
    const html = join(output, 'wave.html');
    const json = join(output, 'results.json');
    const success = run('examples/pass.csv');
    assert.equal(success.status, 0, success.stderr);
    const mixed = run('--html', html, '--json', json, 'examples/pass.csv', 'examples/fail.csv');
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.match(mixed.stdout, /PASS pass.csv.*\nFAIL fail.csv/);
    const results = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(results.schemaVersion, 1);
    assert.equal(results.passed, false);
    assert.equal(results.captures[0].failures, 0);
    assert.deepEqual(results.captures[1].rules.map(rule => rule.reason), ['out_of_order', 'too_early']);
    assert.match(readFileSync(html, 'utf8'), /Timing limit/);

    const gapConfig = join(output, 'gap-config.json');
    const gapCapture = join(output, 'gap.csv');
    const settings = JSON.parse(fixture('sequence.json'));
    settings.csv.maxSampleGapMs = 5;
    settings.signals[1].holdMs = 5;
    writeFileSync(gapConfig, JSON.stringify(settings));
    writeFileSync(gapCapture, 'Time (ms),VIN_5V,VDD_1V8,RESET_N\n0,0,0,0\n1,5,1.8,0\n101,5,1.8,3.3\n');
    const gap = spawnSync(process.execPath, [cli, '--config', gapConfig, '--json', json, '--html', html, gapCapture],
      { cwd: root, encoding: 'utf8' });
    assert.equal(gap.status, 1, gap.stderr);
    assert.match(gap.stdout, /INSUFFICIENT EVIDENCE gap.csv/);
    assert.equal(JSON.parse(readFileSync(json, 'utf8')).captures[0].insufficient, 2);
    assert.match(readFileSync(html, 'utf8'), /Insufficient evidence.*sample gap 1 ms to 101 ms/);

    const invalid = join(output, 'broken.csv');
    const noReport = join(output, 'invalid.html');
    writeFileSync(invalid, 'wrong columns');
    const broken = run('--html', noReport, invalid);
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /broken.csv.*missing column/);
    assert.equal(existsSync(noReport), false);
    const conflict = run('--json', 'examples/pass.csv', 'examples/pass.csv');
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /output path must differ/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
