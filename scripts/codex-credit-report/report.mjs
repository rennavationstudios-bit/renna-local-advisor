const own = (o, k) => Object.hasOwn(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireObject(v, label) { if (!object(v)) throw new Error(label + ' must be an object'); }
function label(v, name) { if (typeof v !== 'string' || !v.trim()) throw new Error(name + ' must be a nonempty string'); return v; }
function count(v, name) {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(name + ' must be a nonnegative safe integer or null');
  return v;
}
function decimal(v, name) {
  if (typeof v !== 'string' || !/^\d+(?:\.\d+)?$/.test(v) || v.length > 100) throw new Error(name + ' must be a nonnegative decimal string');
  const [whole, fraction = ''] = v.split('.');
  return { n: BigInt(whole + fraction), scale: fraction.length };
}
function format(n, scale) {
  if (!scale) return n.toString();
  const s = n.toString().padStart(scale + 1, '0');
  return (s.slice(0, -scale) + '.' + s.slice(-scale)).replace(/\.?0+$/, '');
}
function selectRates(rates, comparison) {
  requireObject(rates, 'rates'); requireObject(comparison, 'comparison');
  if (rates.schemaVersion !== 1 || rates.basis !== 'codex_credits' || rates.unit !== 'credits_per_million_tokens') throw new Error('Unsupported rate card');
  for (const field of ['verifiedOn', 'source', 'speedSource']) label(rates[field], 'rates.' + field);
  requireObject(rates.standard, 'rates.standard'); requireObject(rates.purchasedCreditMultipliers, 'rate multipliers');
  const model = label(comparison.model, 'comparison.model'), speed = label(comparison.speed, 'comparison.speed');
  if (!own(rates.standard, model)) throw new Error('Unsupported comparison model');
  const row = rates.standard[model]; requireObject(row, 'selected rates');
  if (!Array.isArray(row.supportedSpeeds) || !row.supportedSpeeds.includes(speed) || !own(rates.purchasedCreditMultipliers, speed)) throw new Error('Unsupported model/speed combination');
  const values = ['input', 'cachedInput', 'output'].map(k => decimal(row[k], 'rate ' + k));
  const multiplier = decimal(rates.purchasedCreditMultipliers[speed], 'speed multiplier');
  const scale = Math.max(...values.map(v => v.scale));
  const base = values.map(v => v.n * 10n ** BigInt(scale - v.scale));
  if (base[1] > base[0]) throw new Error('Cached input rate exceeds input rate');
  const [input, cached, output] = base.map(v => v * multiplier.n);
  return { input, cached, output, scale: scale + multiplier.scale + 6, model, speed, multiplier: format(multiplier.n, multiplier.scale) };
}
function normalizeReceipts(receipts) {
  if (!Array.isArray(receipts)) throw new Error('receipts must be an array');
  const ids = new Map(), roots = new Set(), useful = new Set();
  return receipts.map((raw, index) => {
    requireObject(raw, 'receipt ' + index);
    const r = {};
    for (const key of ['id', 'workId', 'worker', 'model']) r[key] = label(raw[key], 'receipt.' + key);
    if (ids.has(r.id)) throw new Error('Duplicate receipt ID: ' + r.id);
    if (!['DELIVERED', 'FAILED'].includes(raw.status)) throw new Error('Invalid receipt status');
    if (!['accepted', 'partial', 'discarded', 'pending'].includes(raw.disposition)) throw new Error('Invalid disposition');
    r.status = raw.status; r.disposition = raw.disposition;
    if (r.status === 'FAILED' && r.disposition !== 'discarded') throw new Error('Failed receipt must be discarded');
    if (raw.repairOf !== undefined) {
      r.repairOf = label(raw.repairOf, 'repairOf');
      const prior = ids.get(r.repairOf);
      if (!prior || prior.workId !== r.workId) throw new Error('Repair must reference an earlier receipt in the same work item');
    } else {
      if (roots.has(r.workId)) throw new Error('Multiple original receipts for work item');
      roots.add(r.workId);
    }
    if (['accepted', 'partial'].includes(r.disposition)) {
      if (r.status !== 'DELIVERED' || useful.has(r.workId)) throw new Error('Inconsistent useful-work acceptance');
      useful.add(r.workId);
    }
    r.runtimeMs = count(raw.runtimeMs, 'runtimeMs');
    requireObject(raw.usage, 'receipt.usage'); r.usage = {};
    for (const k of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']) r.usage[k] = count(raw.usage[k], k);
    const u = r.usage;
    if (u.cachedInputTokens !== null && (u.inputTokens === null || u.cachedInputTokens > u.inputTokens)) throw new Error('Cached count requires sufficient known total input');
    if (u.reasoningTokens !== null && u.outputTokens !== null && u.reasoningTokens > u.outputTokens) throw new Error('Reasoning tokens exceed output');
    if (raw.effort !== undefined) r.effort = label(raw.effort, 'effort');
    ids.set(r.id, r); return r;
  });
}
function price(r, rate) {
  const u = r.usage; let min = 0n, max = 0n;
  const missingUsage = ['inputTokens', 'outputTokens'].filter(k => u[k] === null);
  if (u.inputTokens !== null) {
    const input = BigInt(u.inputTokens);
    if (u.cachedInputTokens === null) { min += input * rate.cached; max += input * rate.input; }
    else { const cached = BigInt(u.cachedInputTokens), cost = cached * rate.cached + (input - cached) * rate.input; min += cost; max += cost; }
  }
  if (u.outputTokens !== null) { const cost = BigInt(u.outputTokens) * rate.output; min += cost; max += cost; }
  return { min, max, missingUsage, cacheUncertain: u.inputTokens !== null && u.inputTokens > 0 && u.cachedInputTokens === null };
}
function estimate(p, rate) {
  return { knownSubtotal: { minCredits: format(p.min, rate.scale), maxCredits: format(p.max, rate.scale) }, complete: p.missingUsage.length === 0, cacheUncertain: p.cacheUncertain, missingUsage: p.missingUsage };
}
function group(rows, rate) {
  const coverage = { inputKnownJobs: 0, outputKnownJobs: 0, cacheKnownJobs: 0, runtimeKnownJobs: 0, totalJobs: rows.length };
  const totals = { inputTokensKnown: 0n, outputTokensKnown: 0n, cachedInputTokensKnown: 0n, runtimeMsKnown: 0n };
  let min = 0n, max = 0n, cacheUncertain = false; const missing = new Set();
  for (const r of rows) {
    for (const [field, sum, cov] of [['inputTokens', 'inputTokensKnown', 'inputKnownJobs'], ['outputTokens', 'outputTokensKnown', 'outputKnownJobs'], ['cachedInputTokens', 'cachedInputTokensKnown', 'cacheKnownJobs']]) {
      if (r.usage[field] !== null) { totals[sum] += BigInt(r.usage[field]); coverage[cov]++; }
    }
    if (r.runtimeMs !== null) { totals.runtimeMsKnown += BigInt(r.runtimeMs); coverage.runtimeKnownJobs++; }
    const p = price(r, rate); min += p.min; max += p.max; cacheUncertain ||= p.cacheUncertain;
    for (const k of p.missingUsage) missing.add(k);
  }
  return { jobs: rows.length, ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])), coverage, estimate: estimate({ min, max, cacheUncertain, missingUsage: [...missing].sort() }, rate) };
}
export function buildReport(input, rates) {
  requireObject(input, 'input'); if (input.schemaVersion !== 1) throw new Error('Unsupported input schema');
  const rate = selectRates(rates, input.comparison), receipts = normalizeReceipts(input.receipts);
  let observedCodexCredits = null;
  if (input.observedCodexCredits !== undefined) {
    const value = input.observedCodexCredits; requireObject(value, 'observedCodexCredits');
    if (typeof value.credits !== 'number' || !Number.isFinite(value.credits) || value.credits < 0) throw new Error('Invalid observed Codex credits');
    observedCodexCredits = { credits: value.credits, source: label(value.source, 'observed credits source') };
  }
  const counts = { jobs: receipts.length, workItems: new Set(receipts.map(r => r.workId)).size, accepted: 0, partial: 0, discarded: 0, pending: 0, failed: 0, repairs: 0 };
  for (const r of receipts) { counts[r.disposition]++; if (r.status === 'FAILED') counts.failed++; if (r.repairOf !== undefined) counts.repairs++; }
  const by = disposition => receipts.filter(r => r.disposition === disposition);
  const repairs = receipts.filter(r => r.repairOf !== undefined);
  return {
    schemaVersion: 1, basis: 'codex_credits',
    rateCard: { verifiedOn: rates.verifiedOn, source: rates.source, speedSource: rates.speedSource },
    comparison: { model: rate.model, speed: rate.speed, multiplier: rate.multiplier },
    receipts: receipts.map(r => ({ ...r, estimate: estimate(price(r, rate), rate) })), counts,
    groups: {
      allLocalProcessing: group(receipts, rate), acceptedUseful: group(by('accepted'), rate), partialUseful: group(by('partial'), rate),
      discarded: group(by('discarded'), rate), pending: group(by('pending'), rate), repairProcessing: group(repairs, rate),
      discardedRepairOverhead: group(repairs.filter(r => r.disposition === 'discarded'), rate)
    }, observedCodexCredits,
    limitations: [
      'Same-token Codex-credit repricing is an estimate; local tokenization and reasoning differ from the comparison model. It is not measured savings or avoided spend.',
      'Coverage includes only supplied records. Missing usage means a known subtotal, never a whole-task total. Unknown cache is a range, not an assumed exact amount.',
      'Repair processing and discarded repair overhead overlap the main groups; never add those subsets to totals. Runtime is summed attempt duration, not wall-clock elapsed time.',
      'DELIVERED is not acceptance. Accepted and partial dispositions are supplied primary decisions, not independently verified by this helper.',
      'No conversion to included weekly allowance, dollars, or actual avoided spend. No API context surcharge, cache-write charge, or effort multiplier.',
      'Observed Codex credits, if supplied, are a separate user-provided observation, never inferred from balance changes or subtracted to claim savings.'
    ]
  };
}
// Encode Markdown/HTML control characters, including newlines and link syntax.
const escape = value => String(value).replace(/[&<>"'`\[\]()|#*_!\\:=.@\x00-\x1f\x7f]/g, c => '&#' + c.charCodeAt(0) + ';');
function amount(e) {
  const { minCredits: min, maxCredits: max } = e.knownSubtotal;
  return (min === max ? min : min + '–' + max) + ' credits; ' + (e.complete ? 'complete supplied usage' : 'partial known subtotal') + (e.cacheUncertain ? '; cache uncertain' : '');
}
export function renderMarkdown(report) {
  const c = report.counts;
  const lines = ['# Codex-credit closing report', '',
    `Same-token estimate: ${escape(report.comparison.model)} / ${escape(report.comparison.speed)} (purchased-credit multiplier ${escape(report.comparison.multiplier)}).`,
    `Rate snapshot: ${escape(report.rateCard.verifiedOn)}. Source: ${escape(report.rateCard.source)}. Speed source: ${escape(report.rateCard.speedSource)}.`, '',
    `${c.jobs} attempts across ${c.workItems} work items: ${c.accepted} accepted, ${c.partial} partial, ${c.discarded} discarded, ${c.pending} pending; ${c.failed} failed and ${c.repairs} repair attempts.`, '',
    '| Processing group | Jobs | Credit equivalent / coverage | Known input / output tokens | Known runtime (ms) |',
    '| --- | ---: | --- | --- | ---: |'];
  for (const [name, g] of Object.entries(report.groups)) lines.push(`| ${escape(name)} | ${g.jobs} | ${escape(amount(g.estimate))} | ${g.inputTokensKnown} / ${g.outputTokensKnown} | ${g.runtimeMsKnown} |`);
  const g = report.groups.allLocalProcessing, cov = g.coverage;
  lines.push('', `Local coverage: input ${cov.inputKnownJobs}/${cov.totalJobs}, output ${cov.outputKnownJobs}/${cov.totalJobs}, cache ${cov.cacheKnownJobs}/${cov.totalJobs}, runtime ${cov.runtimeKnownJobs}/${cov.totalJobs} attempts known. Known cached-input tokens: ${g.cachedInputTokensKnown}.`, '',
    '| Receipt | Work / repair reference | Worker / model | Disposition | Credit equivalent |', '| --- | --- | --- | --- | --- |');
  for (const r of report.receipts) lines.push(`| ${escape(r.id)} | ${escape(r.workId)}${r.repairOf !== undefined ? ' / repairs ' + escape(r.repairOf) : ''} | ${escape(r.worker)} / ${escape(r.model)} | ${escape(r.disposition)} | ${escape(amount(r.estimate))} |`);
  lines.push('', report.observedCodexCredits ? `Separately supplied observed Codex credits: ${report.observedCodexCredits.credits}; source: ${escape(report.observedCodexCredits.source)}.` : 'Observed Codex credit usage: not supplied.', '', 'Limitations:', '');
  for (const text of report.limitations) lines.push('- ' + escape(text));
  return lines.join('\n') + '\n';
}
