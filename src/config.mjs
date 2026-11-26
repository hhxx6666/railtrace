const timeFactors = new Map([['s', 1000], ['ms', 1], ['us', 0.001], ['ns', 0.000001]]);
const delimiters = new Set([',', ';', '\t']);

function object(value, fields, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`Unknown field ${path}.${key}`);
  }
  return value;
}

function name(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a nonempty string`);
  return value.trim();
}

function number(value, path, minimum = -Infinity) {
  if (!Number.isFinite(value) || value < minimum) {
    const range = minimum === -Infinity ? '' : ` >= ${minimum}`;
    throw new Error(`${path} must be a finite number${range}`);
  }
  return value;
}

function count(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a nonnegative integer`);
  return value;
}

function list(value, path) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must be a nonempty array`);
  return value;
}

export function readConfig(source) {
  const config = object(JSON.parse(source.replace(/^\uFEFF/, '')), ['csv', 'signals', 'rules'], 'config');
  const csv = object(config.csv, ['timeColumn', 'timeUnit', 'delimiter', 'skipRows', 'skipDataRows'], 'csv');
  const { timeUnit, delimiter = ',', skipRows = 0, skipDataRows = 0 } = csv;
  if (!timeFactors.has(timeUnit)) throw new Error('csv.timeUnit must be s, ms, us, or ns');
  if (!delimiters.has(delimiter)) throw new Error('csv.delimiter must be a comma, semicolon, or tab');

  const signalIds = new Set();
  const signals = list(config.signals, 'signals').map((item, i) => {
    const path = `signals[${i}]`;
    const { id, column, edge = 'rising', thresholdV, holdMs = 0 } =
      object(item, ['id', 'column', 'edge', 'thresholdV', 'holdMs'], path);
    const signalId = name(id, `${path}.id`);
    if (signalIds.has(signalId)) throw new Error(`Duplicate signal id "${signalId}"`);
    signalIds.add(signalId);
    if (edge !== 'rising' && edge !== 'falling') throw new Error(`${path}.edge must be rising or falling`);
    return {
      id: signalId,
      column: name(column, `${path}.column`),
      edge,
      thresholdV: number(thresholdV, `${path}.thresholdV`),
      holdMs: number(holdMs, `${path}.holdMs`, 0),
    };
  });

  const ruleIds = new Set();
  const rules = list(config.rules, 'rules').map((item, i) => {
    const path = `rules[${i}]`;
    const { id, kind, from, to, minMs, maxMs } =
      object(item, ['id', 'kind', 'from', 'to', 'minMs', 'maxMs'], path);
    const rule = { id: name(id, `${path}.id`), kind, from: name(from, `${path}.from`), to: name(to, `${path}.to`) };
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate rule id "${rule.id}"`);
    ruleIds.add(rule.id);
    for (const endpoint of [rule.from, rule.to]) {
      if (!signalIds.has(endpoint)) throw new Error(`${path} references unknown signal "${endpoint}"`);
    }
    if (rule.from === rule.to) throw new Error(`${path} requires two different signals`);
    if (kind === 'order' && minMs === undefined && maxMs === undefined) return rule;
    if (kind !== 'delay') throw new Error(`${path} must be an order rule or a delay rule. Bounds belong to delay rules`);
    rule.minMs = number(minMs, `${path}.minMs`, 0);
    if (maxMs !== undefined) rule.maxMs = number(maxMs, `${path}.maxMs`, rule.minMs);
    return rule;
  });

  return {
    csv: {
      timeColumn: name(csv.timeColumn, 'csv.timeColumn'),
      timeFactor: timeFactors.get(timeUnit),
      delimiter,
      skipRows: count(skipRows, 'csv.skipRows'),
      skipDataRows: count(skipDataRows, 'csv.skipDataRows'),
    },
    signals,
    rules,
  };
}
