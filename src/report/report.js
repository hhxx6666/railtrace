'use strict';

const runs = JSON.parse(document.querySelector('#runs').textContent);
const capturePicker = document.querySelector('#capture');
const chart = document.querySelector('#chart');
const ctx = chart.getContext('2d');
const rulesList = document.querySelector('#rules');
const selection = document.querySelector('#selection');
const zoomIn = document.querySelector('#zoom-in');
const zoomOut = document.querySelector('#zoom-out');
const fit = document.querySelector('#fit');
const shortNumber = value => Number(value.toPrecision(7)).toString();
const ms = value => value === null ? '—' : shortNumber(value) + ' ms';
const palette = ['#75eac2', '#88c8ff', '#f3cf83', '#c9baff', '#ff9fbc'];
const failColor = '#ff8294';
const limitColor = '#f6c56a';
const laneHeight = 77;
let run;
let selected;
let domain;
let marks = [];
let ranges = [];

function node(tag, className, value) {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = value;
  return item;
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function line(x0, y0, x1, y1, color, pattern = []) {
  ctx.strokeStyle = color;
  ctx.setLineDash(pattern);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
}

function label(value, x, y, color = '#b6d0d3', align = 'left', maxWidth = undefined) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(value, x, y, maxWidth);
}

function waveform(times, volts, locateX, locateY, left, right) {
  const first = Math.max(0, lowerBound(times, domain[0]) - 1);
  const last = Math.min(times.length - 1, lowerBound(times, domain[1]));
  let start = first;
  ctx.beginPath();
  ctx.moveTo(locateX(times[first]), locateY(volts[first]));
  while (start <= last) {
    const pixel = Math.max(left - 1, Math.min(right + 1, Math.floor(locateX(times[start]))));
    let end = start;
    let min = start;
    let max = start;
    while (end < last && Math.floor(locateX(times[end + 1])) === pixel) {
      end++;
      if (volts[end] < volts[min]) min = end;
      if (volts[end] > volts[max]) max = end;
    }
    for (const i of [start, Math.min(min, max), Math.max(min, max), end]) {
      ctx.lineTo(locateX(times[i]), locateY(volts[i]));
    }
    start = end + 1;
  }
  ctx.stroke();
}

function draw() {
  if (!run || !ctx) return;
  const width = chart.clientWidth;
  const height = 46 + run.signals.length * laneHeight;
  const dpr = window.devicePixelRatio || 1;
  chart.style.height = height + 'px';
  chart.width = width * dpr;
  chart.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Consolas, monospace';
  const left = width < 550 ? 77 : 136;
  const right = width - 16;
  const plotWidth = right - left;
  if (plotWidth <= 0) return;
  const bottom = height - 29;
  const span = domain[1] - domain[0];
  const locateX = time => left + (time - domain[0]) / span * plotWidth;
  const ticks = width < 550 ? 2 : 5;

  for (let i = 0; i <= ticks; i++) {
    const x = left + i / ticks * plotWidth;
    line(x, 16, x, bottom, '#294550');
    const alignment = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
    label(shortNumber(domain[0] + i / ticks * span), x, bottom + 17, '#b6d0d3', alignment);
  }
  label('ms', left - 10, bottom + 17, '#b6d0d3', 'right');

  run.signals.forEach((signal, i) => {
    const color = palette[i % palette.length];
    const top = 17 + i * laneHeight;
    const [min, max] = ranges[i];
    const locateY = voltage => {
      const scale = Math.max(Math.abs(max), Math.abs(min), Number.MIN_VALUE);
      const scaledRange = max / scale - min / scale;
      const fraction = scaledRange ? (voltage / scale - min / scale) / scaledRange : .5;
      return top + 58 - fraction * 46;
    };
    label(signal.id, 5, top + 24, color, 'left', left - 13);
    label(shortNumber(signal.thresholdV) + ' V', 5, top + 43, '#b6d0d3', 'left', left - 13);
    line(left, top + laneHeight, right, top + laneHeight, '#294550');

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotWidth, laneHeight);
    ctx.clip();
    const thresholdY = locateY(signal.thresholdV);
    line(left, thresholdY, right, thresholdY, '#81999e', [3, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    waveform(run.timeMs, run.voltages[i], locateX, locateY, left, right);
    if (signal.eventMs !== null) {
      const edgeX = locateX(signal.eventMs);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(edgeX, thresholdY - 5);
      ctx.lineTo(edgeX + 5, thresholdY);
      ctx.lineTo(edgeX, thresholdY + 5);
      ctx.lineTo(edgeX - 5, thresholdY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  });

  marks.forEach(mark => {
    const rawX = locateX(mark.time);
    if (rawX < left - .5 || rawX > right + .5) return;
    const x = Math.min(right - .5, Math.max(left + .5, rawX));
    ctx.lineWidth = mark.pattern.length ? 1 : 2;
    line(x, 8, x, bottom, mark.color, mark.pattern);
    ctx.lineWidth = 1;
  });
}

function setDomain(center, span) {
  const fullSpan = run.endMs - run.startMs;
  const minSpan = Math.max(fullSpan / 1e6, Math.abs(center) * Number.EPSILON * 16);
  const duration = Math.min(fullSpan, Math.max(minSpan, span));
  const start = Math.max(run.startMs, Math.min(run.endMs - duration, center - duration / 2));
  domain = duration === fullSpan ? [run.startMs, run.endMs] : [start, Math.min(run.endMs, start + duration)];
  zoomIn.disabled = duration <= minSpan;
  zoomOut.disabled = duration >= fullSpan;
  fit.disabled = zoomOut.disabled;
  draw();
}

function fitCapture() {
  const span = run.endMs - run.startMs;
  setDomain(run.startMs + span / 2, span);
}

function selectRule(index, focus) {
  selected = index;
  const rule = run.rules[selected];
  const failed = rule.status === 'fail';
  const observed = palette[0];
  marks = [
    ...(rule.fromMs === null ? [] : [{ time: rule.fromMs, color: observed, pattern: [2, 4] }]),
    ...(rule.toMs === null ? [] : [{ time: rule.toMs, color: failed ? failColor : observed, pattern: [] }]),
    ...(rule.limitMs === undefined ? [] : [{ time: rule.limitMs, color: limitColor, pattern: [5, 4] }]),
    ...(rule.missing ? [{ time: run.endMs, color: failColor, pattern: [2, 4] }] : []),
  ];
  const times = marks.filter(mark => mark.time >= run.startMs && mark.time <= run.endMs).map(mark => mark.time);
  const locations = [
    rule.from + ' ' + ms(rule.fromMs),
    rule.to + ' ' + ms(rule.toMs),
  ];
  if (rule.limitMs !== undefined) {
    const outside = rule.limitMs < run.startMs || rule.limitMs > run.endMs;
    locations.push('Limit ' + ms(rule.limitMs) + (outside ? ' (outside capture)' : ''));
  }
  if (rule.missing) locations.push('Capture end ' + ms(run.endMs));
  selection.textContent = rule.id + ' · ' + locations.join(' · ');
  for (const [i, li] of [...rulesList.children].entries()) {
    li.firstElementChild.setAttribute('aria-pressed', String(i === selected));
  }

  if (focus && times.length) {
    const start = Math.min(...times);
    const end = Math.max(...times);
    setDomain(start + (end - start) / 2, Math.max((end - start) * 1.7, (run.endMs - run.startMs) * .25));
  } else {
    fitCapture();
  }
}

function loadCapture(index) {
  run = runs[index];
  ranges = run.voltages.map((values, i) => {
    let min = run.signals[i].thresholdV;
    let max = min;
    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return [min, max];
  });
  document.querySelector('#capture-meta').textContent =
    run.signals.length + ' signals · ' + run.samples.toLocaleString('en') + ' samples · ' + ms(run.endMs - run.startMs);
  const count = document.querySelector('#rule-count');
  count.textContent = (run.rules.length - run.failures) + ' passed · ' + run.failures + ' failed';
  count.classList.toggle('has-failures', run.failures > 0);
  rulesList.replaceChildren(...run.rules.map((rule, i) => {
    const item = node('li', '', '');
    const button = node('button', 'rule', '');
    button.type = 'button';
    const description = node('span', '', '');
    description.append(node('span', 'rule-name', rule.id), node('span', 'rule-route', rule.from + ' → ' + rule.to));
    const arrow = node('span', 'arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(
      node('span', 'badge ' + rule.status, rule.status.toUpperCase()),
      description,
      node('span', 'rule-detail', rule.detail),
      arrow,
    );
    button.addEventListener('click', () => selectRule(i, true));
    item.append(button);
    return item;
  }));
  document.querySelector('#signals').replaceChildren(...run.signals.map(signal => {
    const row = document.createElement('tr');
    const values = [signal.id, signal.edge, shortNumber(signal.thresholdV) + ' V', ms(signal.holdMs), ms(signal.eventMs)];
    row.append(...values.map(value => node('td', '', value)));
    return row;
  }));
  selectRule(Math.max(0, run.rules.findIndex(rule => rule.status === 'fail')), false);
}

const failingRuns = runs.filter(candidate => candidate.failures > 0).length;
document.querySelector('#summary').textContent =
  runs.length + ' capture' + (runs.length === 1 ? '' : 's') + ' analyzed · ' + failingRuns + ' with failed rules';
runs.forEach((candidate, i) => {
  const option = node('option', '', candidate.file);
  option.value = i;
  capturePicker.append(option);
});
capturePicker.value = Math.max(0, runs.findIndex(candidate => candidate.failures > 0));
capturePicker.addEventListener('change', () => loadCapture(Number(capturePicker.value)));
const zoom = factor => {
  const span = domain[1] - domain[0];
  setDomain(domain[0] + span / 2, span * factor);
};
zoomIn.addEventListener('click', () => zoom(.5));
zoomOut.addEventListener('click', () => zoom(2));
fit.addEventListener('click', fitCapture);
loadCapture(Number(capturePicker.value));
new ResizeObserver(draw).observe(chart.parentElement);
