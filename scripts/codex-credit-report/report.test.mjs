import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildReport, renderMarkdown } from './report.mjs';

const rates = JSON.parse(readFileSync(new URL('./rates.json', import.meta.url), 'utf8'));

function receipt(overrides = {}) {
  return {
    id: 'r1',
    workId: 'w1',
    worker: 'R9700A',
    model: 'local-model',
    status: 'DELIVERED',
    disposition: 'accepted',
    runtimeMs: 1000,
    usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 0 },
    ...overrides,
  };
}

function input(receipts, comparison = { model: 'gpt-6-astra', speed: 'standard' }, extra = {}) {
  return { schemaVersion: 1, comparison, receipts, ...extra };
}

const build = (receipts, comparison, extra) => buildReport(input(receipts, comparison, extra), rates);

test('reference arithmetic matches Astra and Sol6.1 standard rates', () => {
  const astraUncached = build([receipt()]);
  assert.deepEqual(astraUncached.receipts[0].estimate.knownSubtotal, {
    minCredits: '37.5', maxCredits: '37.5',
  });
  assert.equal(astraUncached.receipts[0].estimate.complete, true);

  const astraCached = build([receipt({ usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 100_000 } })]);
  assert.deepEqual(astraCached.receipts[0].estimate.knownSubtotal, {
    minCredits: '15', maxCredits: '15',
  });

  const solUncached = build([receipt()], { model: 'gpt-6.1-sol', speed: 'standard' });
  assert.deepEqual(solUncached.receipts[0].estimate.knownSubtotal, {
    minCredits: '7.5', maxCredits: '7.5',
  });
  const solCached = build([receipt({ usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 100_000 } })], { model: 'gpt-6.1-sol', speed: 'standard' });
  assert.deepEqual(solCached.receipts[0].estimate.knownSubtotal, {
    minCredits: '2.75', maxCredits: '2.75',
  });
});

test('speed multipliers are purchased-credit multipliers, with ultrafast enabled only where supported', () => {
  const fast = build([receipt()], { model: 'gpt-6-astra', speed: 'fast' });
  assert.equal(fast.comparison.multiplier, '2');
  assert.deepEqual(fast.receipts[0].estimate.knownSubtotal, { minCredits: '75', maxCredits: '75' });
  const ultrafast = build([receipt()], { model: 'gpt-6-astra', speed: 'ultrafast' });
  assert.equal(ultrafast.comparison.multiplier, '6');
  assert.deepEqual(ultrafast.receipts[0].estimate.knownSubtotal, { minCredits: '225', maxCredits: '225' });
  assert.throws(() => build([receipt()], { model: 'gpt-5.6-sol', speed: 'fast' }));
});

test('unknown cache produces a bounded range and zero input remains exact', () => {
  const unknownCache = build([receipt({ usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: null } })]);
  const estimate = unknownCache.receipts[0].estimate;
  assert.deepEqual(estimate.knownSubtotal, { minCredits: '15', maxCredits: '37.5' });
  assert.equal(estimate.complete, true);
  assert.equal(estimate.cacheUncertain, true);

  const zeroInput = build([receipt({ usage: { inputTokens: 0, outputTokens: 10_000, cachedInputTokens: null } })]);
  assert.deepEqual(zeroInput.receipts[0].estimate.knownSubtotal, { minCredits: '12.5', maxCredits: '12.5' });
  assert.equal(zeroInput.receipts[0].estimate.cacheUncertain, false);
});

test('missing input or output stays incomplete with partial known subtotal and coverage', () => {
  const report = build([
    receipt({ id: 'missing-in', workId: 'a', usage: { inputTokens: null, outputTokens: 10_000, cachedInputTokens: null } }),
    receipt({ id: 'missing-out', workId: 'b', usage: { inputTokens: 100_000, outputTokens: null, cachedInputTokens: 0 } }),
    receipt({ id: 'missing-both', workId: 'c', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null } }),
  ]);
  assert.deepEqual(report.receipts.map((item) => item.estimate.complete), [false, false, false]);
  assert.deepEqual(report.receipts.map((item) => item.estimate.missingUsage), [
    ['inputTokens'], ['outputTokens'], ['inputTokens', 'outputTokens'],
  ]);
  assert.equal(report.receipts[0].estimate.knownSubtotal.maxCredits, '12.5');
  assert.equal(report.receipts[1].estimate.knownSubtotal.maxCredits, '25');
  assert.deepEqual(report.groups.allLocalProcessing.coverage, {
    inputKnownJobs: 1, outputKnownJobs: 1, cacheKnownJobs: 1, runtimeKnownJobs: 3, totalJobs: 3,
  });
  assert.equal(report.groups.allLocalProcessing.estimate.complete, false);
});

test('reasoning tokens are validated as output subset and are never charged twice', () => {
  const withReasoning = build([receipt({ usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 0, reasoningTokens: 8_000 } })]);
  const withoutReasoning = build([receipt()]);
  assert.deepEqual(withReasoning.receipts[0].estimate, withoutReasoning.receipts[0].estimate);
  assert.throws(() => build([receipt({ usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 0, reasoningTokens: 10_001 } })]));
});

test('repair chains, useful dispositions, counts and overlapping subsets are kept distinct', () => {
  const report = build([
    receipt({ id: 'root', workId: 'w', disposition: 'discarded' }),
    receipt({ id: 'retry', workId: 'w', repairOf: 'root', disposition: 'partial', usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 } }),
    receipt({ id: 'retry2', workId: 'w', repairOf: 'retry', disposition: 'discarded', status: 'FAILED', runtimeMs: null, usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null } }),
    receipt({ id: 'pending', workId: 'pending-work', disposition: 'pending' }),
  ]);
  assert.deepEqual(report.counts, { jobs: 4, workItems: 2, accepted: 0, partial: 1, discarded: 2, pending: 1, failed: 1, repairs: 2 });
  assert.equal(report.groups.allLocalProcessing.jobs, 4);
  assert.equal(report.groups.acceptedUseful.jobs, 0);
  assert.equal(report.groups.partialUseful.jobs, 1);
  assert.equal(report.groups.discarded.jobs, 2);
  assert.equal(report.groups.pending.jobs, 1);
  assert.equal(report.groups.repairProcessing.jobs, 2);
  assert.equal(report.groups.discardedRepairOverhead.jobs, 1);
  assert.equal(report.groups.repairProcessing.inputTokensKnown, '23');
});

test('disposition, receipt identity and repair references are validated', () => {
  assert.throws(() => build([receipt(), receipt()])); // duplicate receipt ID and duplicate root
  assert.throws(() => build([receipt({ status: 'FAILED', disposition: 'accepted' })]));
  assert.throws(() => build([receipt({ status: 'FAILED', disposition: 'pending' })]));
  assert.throws(() => build([receipt({ disposition: 'accepted', status: 'FAILED' })]));
  assert.doesNotThrow(() => build([receipt({ disposition: 'pending' }), receipt({ id: 'r2', disposition: 'accepted', repairOf: 'r1' })]));
  assert.throws(() => build([receipt({ id: 'r1', workId: 'w1', disposition: 'accepted' }), receipt({ id: 'r2', workId: 'w1', repairOf: 'r1', disposition: 'partial' })]));
  assert.throws(() => build([receipt({ repairOf: 'missing' })]));
  assert.throws(() => build([receipt(), receipt({ id: 'r2', workId: 'other', repairOf: 'r1' })]));
});

test('rejects invalid token counts, cache bounds and unsupported comparison selections', () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12', NaN]) {
    assert.throws(() => build([receipt({ usage: { inputTokens: invalid, outputTokens: 0, cachedInputTokens: null } })]));
  }
  assert.throws(() => build([receipt({ usage: { inputTokens: 10, outputTokens: 0, cachedInputTokens: 11 } })]));
  assert.throws(() => build([receipt({ runtimeMs: -1 })]));
  assert.throws(() => build([receipt()], { model: 'unknown', speed: 'standard' }));
  assert.throws(() => build([receipt()], { model: 'gpt-6-astra', speed: 'warp' }));
});

test('safe integer token totals use exact arithmetic without float rounding', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const report = build([receipt({ usage: { inputTokens: max, outputTokens: 0, cachedInputTokens: 0 } })]);
  assert.equal(report.groups.allLocalProcessing.inputTokensKnown, String(max));
  assert.equal(report.receipts[0].estimate.knownSubtotal.minCredits, '2251799813685.24775');
  assert.equal(report.receipts[0].estimate.knownSubtotal.maxCredits, '2251799813685.24775');
});

test('observed credits are reported separately and labels are escaped in Markdown', () => {
  const hostile = '<img src=x onerror=alert(1)>|[click](https://evil.test)\nnext';
  const report = build([receipt({ worker: hostile, model: hostile })], undefined, {
    observedCodexCredits: { credits: 12.5, source: hostile },
  });
  assert.equal(report.receipts[0].worker, hostile);
  assert.deepEqual(report.observedCodexCredits, { credits: 12.5, source: hostile });
  const markdown = renderMarkdown(report);
  assert.equal(markdown.includes('<img'), false);
  assert.ok(markdown.includes('&#60;img')); // Inert escaped text is preserved, not removed.
  assert.equal(markdown.includes('[click]('), false);
  assert.equal(markdown.includes('https://evil.test'), false); // Prevent bare-URL autolinks too.
  assert.equal(markdown.includes('\nnext'), false);
  assert.match(markdown, /observed/i);
  assert.throws(() => build([receipt()], undefined, { observedCodexCredits: { credits: -1, source: 'manual' } }));
});

test('www and email-shaped labels cannot become GFM autolinks', () => {
  const report = build([receipt({ worker: 'www.evil.example', model: 'user@evil.example' })]);
  const markdown = renderMarkdown(report);
  assert.ok(!markdown.includes('www.evil.example'));
  assert.ok(!markdown.includes('user@evil.example'));
  assert.ok(markdown.includes('www&#46;evil&#46;example'));
  assert.ok(markdown.includes('user&#64;evil&#46;example'));
  assert.equal(report.receipts[0].worker, 'www.evil.example');
});

test('zero speed multiplier cannot hide an inverted cache rate', () => {
  const invalid = structuredClone(rates);
  invalid.standard['gpt-6-astra'].cachedInput = '251';
  invalid.purchasedCreditMultipliers.standard = '0';
  assert.throws(() => buildReport(input([]), invalid), /Cached input rate exceeds/);
  invalid.standard['gpt-6-astra'].cachedInput = '25';
  assert.equal(buildReport(input([receipt()]), invalid).receipts[0].estimate.knownSubtotal.minCredits, '0');
});
