import { readFileSync } from 'node:fs';
import { describe } from './check.mjs';

const asset = name => readFileSync(new URL(`./report/${name}`, import.meta.url), 'utf8');

export function renderReport(runs) {
  const payload = runs.map(({ result, capture }) => ({
    ...result,
    rules: result.rules.map(rule => ({ ...rule, detail: describe(rule) })),
    ...capture,
  }));
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  return asset('index.html').replace(
    /<!-- (STYLE|DATA|SCRIPT) -->/g,
    (_, slot) => ({
      STYLE: () => `<style>${asset('report.css')}</style>`,
      DATA: () => `<script id="runs" type="application/json">${safeJson}</script>`,
      SCRIPT: () => `<script>${asset('report.js')}</script>`,
    })[slot](),
  );
}
