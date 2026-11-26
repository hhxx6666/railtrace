function timeTolerance(a, b) {
  return Number.EPSILON * 4 * Math.max(Math.abs(a), Math.abs(b));
}

function crossingTime(t0, t1, v0, v1, threshold) {
  const span = v1 - v0;
  const fraction = Number.isFinite(span)
    ? (threshold - v0) / span
    : (threshold / 2 - v0 / 2) / (v1 / 2 - v0 / 2);
  return t0 + (t1 - t0) * fraction;
}

export function findEdge(timeMs, values, { edge, thresholdV, holdMs }) {
  const active = edge === 'rising' ? value => value >= thresholdV : value => value <= thresholdV;
  let started = null;
  let previousActive = active(values[0]);
  for (let i = 1; i < timeMs.length; i++) {
    const currentActive = active(values[i]);
    if (currentActive !== previousActive) {
      const crossing = crossingTime(timeMs[i - 1], timeMs[i], values[i - 1], values[i], thresholdV);
      if (currentActive) {
        started = crossing;
      } else {
        if (started !== null && crossing - started + timeTolerance(started, crossing) >= holdMs) return started;
        started = null;
      }
    }
    if (started !== null && timeMs[i] - started + timeTolerance(started, timeMs[i]) >= holdMs) return started;
    previousActive = currentActive;
  }
  return null;
}

function checkRule(rule, edges) {
  const fromMs = edges.get(rule.from);
  const toMs = edges.get(rule.to);
  const result = { ...rule, fromMs, toMs, deltaMs: null, status: 'fail' };
  if (fromMs === null || toMs === null) {
    return {
      ...result,
      reason: 'missing_edge',
      missing: [rule.from, rule.to].filter(id => edges.get(id) === null),
    };
  }

  const deltaMs = toMs - fromMs;
  const tolerance = timeTolerance(fromMs, toMs);
  if (rule.kind === 'order' && deltaMs <= tolerance) return { ...result, deltaMs, reason: 'out_of_order' };
  if (rule.kind === 'delay' && deltaMs < rule.minMs - tolerance) {
    return { ...result, deltaMs, reason: 'too_early', limitMs: fromMs + rule.minMs };
  }
  if (rule.kind === 'delay' && rule.maxMs !== undefined && deltaMs > rule.maxMs + tolerance) {
    return { ...result, deltaMs, reason: 'too_late', limitMs: fromMs + rule.maxMs };
  }
  return { ...result, deltaMs, status: 'pass', reason: null };
}

export function analyze(file, capture, config) {
  const { timeMs, voltages } = capture;
  const signals = config.signals.map((signal, index) => ({
    ...signal,
    eventMs: findEdge(timeMs, voltages[index], signal),
  }));
  const edges = new Map(signals.map(signal => [signal.id, signal.eventMs]));
  const rules = config.rules.map(rule => checkRule(rule, edges));
  const failures = rules.filter(rule => rule.status === 'fail').length;
  return { file, samples: timeMs.length, startMs: timeMs[0], endMs: timeMs.at(-1), signals, rules, failures };
}

export function formatMs(value) {
  return value === null ? '—' : `${Number(value.toPrecision(8))} ms`;
}

export function describe(rule) {
  if (rule.reason === 'missing_edge') return `No qualifying edge for ${rule.missing.join(', ')}`;
  if (rule.reason === 'out_of_order') return `${rule.to} must follow ${rule.from} (Δ ${formatMs(rule.deltaMs)})`;
  if (rule.reason === 'too_early') return `Δ ${formatMs(rule.deltaMs)} is below ${formatMs(rule.minMs)}`;
  if (rule.reason === 'too_late') return `Δ ${formatMs(rule.deltaMs)} is above ${formatMs(rule.maxMs)}`;
  return `Δ ${formatMs(rule.deltaMs)}`;
}
