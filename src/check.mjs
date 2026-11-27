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

export function findEdge(timeMs, values, { edge, thresholdV, holdMs }, evidenceEnd = timeMs.length) {
  const active = edge === 'rising' ? value => value >= thresholdV : value => value <= thresholdV;
  let started = null;
  let previousActive = active(values[0]);
  for (let i = 1; i < evidenceEnd; i++) {
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
  const from = edges.get(rule.from);
  const to = edges.get(rule.to);
  const fromMs = from.eventMs;
  const toMs = to.eventMs;
  const result = { ...rule, fromMs, toMs, deltaMs: null, status: 'fail' };
  if (from.evidenceGap || to.evidenceGap) {
    return {
      ...result,
      status: 'insufficient_evidence',
      reason: 'sample_gap',
      gap: from.evidenceGap ?? to.evidenceGap,
      unconfirmed: [from, to].filter(signal => signal.evidenceGap).map(signal => signal.id),
    };
  }
  if (fromMs === null || toMs === null) {
    return {
      ...result,
      reason: 'missing_edge',
      missing: [from, to].filter(signal => signal.eventMs === null).map(signal => signal.id),
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
  const maxSampleGapMs = config.csv?.maxSampleGapMs;
  const sampleGaps = [];
  if (maxSampleGapMs !== undefined) {
    for (let i = 1; i < timeMs.length; i++) {
      const startMs = timeMs[i - 1];
      const endMs = timeMs[i];
      if (endMs - startMs > maxSampleGapMs + timeTolerance(startMs, endMs)) {
        sampleGaps.push({ startMs, endMs, nextSample: i });
      }
    }
  }
  // A gap can hide an earlier qualifying edge, even with equal values at its endpoints.
  const firstGap = sampleGaps[0];
  const signals = config.signals.map((signal, index) => {
    const eventMs = findEdge(timeMs, voltages[index], signal, firstGap?.nextSample);
    return { ...signal, eventMs, ...(eventMs === null && firstGap ? { evidenceGap: firstGap } : {}) };
  });
  const edges = new Map(signals.map(signal => [signal.id, signal]));
  const rules = config.rules.map(rule => checkRule(rule, edges));
  const failures = rules.filter(rule => rule.status === 'fail').length;
  const insufficient = rules.filter(rule => rule.status === 'insufficient_evidence').length;
  return { file, samples: timeMs.length, startMs: timeMs[0], endMs: timeMs.at(-1), maxSampleGapMs,
    sampleGaps, signals, rules, failures, insufficient };
}

export function formatMs(value) {
  return value === null ? '—' : `${Number(value.toPrecision(8))} ms`;
}

export function describe(rule) {
  if (rule.reason === 'sample_gap') {
    return `Insufficient evidence for ${rule.unconfirmed.join(', ')}: sample gap ${formatMs(rule.gap.startMs)} to ${formatMs(rule.gap.endMs)}`;
  }
  if (rule.reason === 'missing_edge') return `No qualifying edge for ${rule.missing.join(', ')}`;
  if (rule.reason === 'out_of_order') return `${rule.to} must follow ${rule.from} (Δ ${formatMs(rule.deltaMs)})`;
  if (rule.reason === 'too_early') return `Δ ${formatMs(rule.deltaMs)} is below ${formatMs(rule.minMs)}`;
  if (rule.reason === 'too_late') return `Δ ${formatMs(rule.deltaMs)} is above ${formatMs(rule.maxMs)}`;
  return `Δ ${formatMs(rule.deltaMs)}`;
}
