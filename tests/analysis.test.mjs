import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTarget, projectKey, compareAudits, evidenceFindings, prioritise, validateAnalysis } from '../scripts/lib/analysis.mjs';
import { summariseLighthouse, performanceFindings, collectCrux } from '../scripts/lib/performance.mjs';

test('project identity preserves protocol and path boundaries; embedded credentials rejected', () => {
  assert.equal(normaliseTarget('example.com/docs#x'), 'https://example.com/docs');
  assert.notEqual(projectKey('https://example.com/'), projectKey('https://example.com/shop/'));
  assert.throws(() => normaliseTarget('https://user:password@example.com'));
  assert.throws(() => normaliseTarget('file:///etc/passwd'));
});
test('a disappeared finding remains not observed when crawl coverage differs', () => {
  const previous = { target: 'https://example.com/', runId: 'a', coverage: { truncated: true }, findings: [{ id: 'x', checkId: 'x', title: 'X', category: 'technical', affectedUrls: ['https://example.com/a'] }] };
  const result = compareAudits(previous, { ...previous, runId: 'b', findings: [] });
  assert.equal(result.changes[0].state, 'not_observed');
  assert.equal(result.comparableCoverage, false);
});
test('query overlap is a hypothesis and unlinked summaries cannot establish it', () => {
  const audit = { pages: [], imports: [], gsc: { rows: [
    { query: 'coffee', page: 'https://example.com/a', impressions: 20 },
    { query: 'coffee', page: 'https://example.com/b', impressions: 10 },
    { query: 'other', impressions: 100 },
    { page: 'https://example.com/c', impressions: 100 }
  ] } };
  const findings = evidenceFindings(audit);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'hypothesis');
  assert.equal(findings[0].affectedUrls.length, 2);
  assert.match(findings[0].recommendation, /Multiple results can be healthy/);
});
test('business priority uses explicit importance and observed data without inventing uplift', () => {
  const findings = [{ id: 'x', severity: 'medium', confidence: 'high', affectedUrls: ['https://example.com/shop/a'], evidence: [] }];
  const [finding] = prioritise(findings, { importantUrls: ['https://example.com/shop'], gscRows: [{ page: 'https://example.com/shop/a', clicks: 4, impressions: 20 }] });
  assert.equal(finding.priority, 'p1');
  assert.equal(finding.impact.observedClicks, 4);
  assert.equal(finding.impact.importantUrls.length, 1);
});
test('semantic actions require evidence and the report only accepts defined narrative fields', () => {
  assert.throws(() => validateAnalysis({ contentActions: [{ action: 'Merge', reason: 'similar' }] }, { runId: 'x' }), /evidence/);
  assert.deepEqual(validateAnalysis({ executiveSummary: 'Specific', token: 'discard' }, { runId: 'x' }), { executiveSummary: 'Specific', evidenceValidation: { internalReferences: 0, externalReferences: [] }, runId: 'x' });
});
test('Lighthouse lab diagnostics do not mislabel TBT as measured INP', () => {
  const sample = summariseLighthouse({ requestedUrl: 'https://example.com/', categories: { performance: { score: 0.8 } },
    audits: { 'largest-contentful-paint': { numericValue: 3000, score: 0.5 }, 'total-blocking-time': { numericValue: 300, score: 0.5 } } });
  assert.equal(sample.metrics.tbt, 300);
  assert.equal(sample.metrics.inp, undefined);
  const findings = performanceFindings({ summaries: [{ url: sample.url, device: 'mobile', runs: 3, metrics: sample.metrics }] });
  assert.equal(findings.length, 2);
  assert.match(findings.find(f => f.checkId === 'lab-tbt').recommendation, /not a measurement of field INP/);
});
test('Lighthouse audits with non-array detail items are summarised without failing', () => {
  const sample = summariseLighthouse({ requestedUrl: 'https://example.com/', categories: { performance: { score: 0.5 } },
    audits: { 'insight': { title: 'Insight', score: 0, scoreDisplayMode: 'metricSavings', details: { type: 'list', items: { sections: [] } } } } });
  assert.deepEqual(sample.diagnostics[0].items, []);
});
test('CrUX absence stays unknown, and origin fallback is disclosed', async () => {
  assert.equal((await collectCrux('https://example.com/')).status, 'not_assessed');
  const calls = [];
  const result = await collectCrux('https://example.com/a', { apiKey: 'synthetic', fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return body.url ? { status: 404, ok: false } : { status: 200, ok: true, json: async () => ({ record: { key: { origin: body.origin }, metrics: {} } }) };
  } });
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].granularity, 'origin');
  assert.equal(calls[1].origin, 'https://example.com');
  assert.ok(!JSON.stringify(result).includes('synthetic'));
});
