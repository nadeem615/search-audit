import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderReport, renderActionPlan, writeReport } from '../scripts/lib/report.mjs';

function sample(overrides = {}) {
  return {
    schemaVersion: 1, runId: 'run-42', projectId: 'example', target: 'https://example.com/', startedAt: '2026-10-21T08:00:00Z', completedAt: '2026-10-21T08:10:00Z',
    brand: { name: 'Example Studio', primaryColor: '#24604c' },
    coverage: { discovered: 30, crawled: 25, failed: 2, excluded: 3, rendered: 4, performanceTested: 2, truncated: true },
    capabilities: [{ id: 'crawl', label: 'Technical crawl', status: 'sampled', detail: '25 pages, crawl limit reached' }, { id: 'backlinks', label: 'Off-page evidence', status: 'not_assessed', detail: 'No backlink dataset' }],
    findings: [{ id: 'canonical-1', checkId: 'canonical-invalid', title: 'Canonical points to an error', category: 'indexing', severity: 'high', kind: 'issue', confidence: 'high', priority: 'p1', evidence: [{ url: 'https://example.com/product', observed: 'Canonical target returned 404', expected: '200 and indexable', source: 'HTTP crawl' }], affectedUrls: ['https://example.com/product'], recommendation: 'Change the product template to reference its valid preferred URL.', owner: 'Engineering', effort: 'small', acceptance: ['Canonical targets return HTTP 200.'], dependencies: ['Confirm preferred product URL'] }, { id: 'overlap-1', checkId: 'content-overlap', title: 'Two pages may compete for the same intent', category: 'cannibalization', severity: 'medium', kind: 'hypothesis', confidence: 'low', priority: 'p2', affectedUrls: ['https://example.com/a', 'https://example.com/b'], recommendation: 'Check query-level Search Console trends before consolidation.', evidence: [], acceptance: [], dependencies: [] }],
    pages: [{ url: 'https://example.com/product', finalUrl: 'https://example.com/product', status: 200, title: 'Product', description: 'Product description', h1: ['Product'], canonical: ['https://example.com/missing'], wordCount: 120 }],
    performance: { status: 'not_assessed', results: [], errors: [] }, gsc: { status: 'not_assessed' }, imports: [], ...overrides,
  };
}

test('report separates hypotheses and limited coverage from evidence without inventing a health score', () => {
  const html = renderReport(sample());
  assert.match(html, /Example Studio/); assert.match(html, /--brand:#24604c/); assert.match(html, /Missing data is not a pass/); assert.match(html, /crawl was truncated/); assert.match(html, /Canonical target returned 404/); assert.match(html, /data-kind="hypothesis"/); assert.match(html, /No supporting evidence was supplied/); assert.match(html, /does not prove a common root cause/); assert.doesNotMatch(html, /SEO health score|100% healthy/i); assert.match(html, /@media print/); assert.match(html, /id="finding-search"/); assert.match(html, /aria-live="polite"/); assert.doesNotMatch(html, /<script\s+src=|<link[^>]+stylesheet|https:\/\/fonts\./i);
});

test('site content cannot inject scripts, attributes, URL protocols, or CSS', () => {
  const attack = '</script><img src=x onerror="alert(1)">';
  const html = renderReport(sample({ target: 'javascript:alert(1)', brand: { name: attack, primaryColor: '#fff;}body{background:url(https://bad.example)}', logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', logoUrl: 'https://bad.example/logo.png' }, findings: [{ id: '" onmouseover="alert(1)', title: attack, category: 'x" onmouseover="alert(1)', recommendation: attack, affectedUrls: ['javascript:alert(1)'], evidence: [{ url: 'data:text/html,<script>alert(1)</script>', source: 'javascript:alert(1)', observed: attack }] }] }));
  assert.doesNotMatch(html, /<img src=x|href="javascript:|href="data:|src="data:image\/svg|src="https:\/\/bad|background:url/); assert.match(html, /&lt;\/script&gt;&lt;img/); assert.match(html, /--brand:#20564b/); assert.equal((html.match(/<script>/g) || []).length, 1); assert.equal((html.match(/<\/script>/g) || []).length, 1); assert.doesNotMatch(html, /class="brand-logo"/);
});

test('embedded raster logos are accepted and missing data remains explicit', () => {
  const html = renderReport({ brand: { name: 'A B', logoDataUrl: 'data:image/png;base64,aGVsbG8=' } });
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/); assert.match(html, /No capability ledger was supplied/); assert.match(html, /Not measured/); assert.match(html, /No page inventory was supplied/); assert.match(html, /No findings were recorded/);
});

test('exports share evidence and criteria while CSV blocks formula injection', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'search-audit-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = sample(); audit.pages[0].title = '=HYPERLINK("https://bad.example","click")'; audit.findings[0].owner = '+cmd';
  const files = await writeReport(audit, directory); assert.equal(files.html, path.join(directory, 'report.html')); assert.equal(files.pdf, undefined);
  const [html, findings, pages, plan] = await Promise.all([files.html, files.findingsCsv, files.pagesCsv, files.actionPlan].map(file => readFile(file, 'utf8')));
  for (const output of [html, findings, plan]) assert.match(output, /Canonical targets return HTTP 200/);
  assert.match(findings, /"'\+cmd"/); assert.match(pages, /"'=HYPERLINK\(""https:\/\/bad/); assert.match(findings, /Canonical target returned 404/); assert.match(plan, /P1 · canonical-1/); assert.match(plan, /report\.html#finding-1/); assert.match(plan, /rollback method/); assert.match(plan, /Search Console trends before consolidation/);
});

test('developer tickets preserve every affected URL and neutralize untrusted markup', () => {
  const urls = Array.from({ length: 45 }, (_, i) => `https://example.com/product/${i}`);
  const audit = sample({ findings: [{ id: 'one', title: '<script>bad</script> [click](javascript:bad)', severity: 'critical', affectedUrls: urls, acceptance: ['Every preferred URL is valid.'] }] });
  const html = renderReport(audit), plan = renderActionPlan(audit);
  assert.match(html, /Priority inferred from severity/); assert.match(html, /Showing 30 URLs/); assert.match(plan, /https:\/\/example.com\/product\/44/); assert.match(plan, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(plan, /<script>|\[click\]\(javascript/); assert.match(plan, /P0 · one/);
});

test('inventory previews disclose limits while CSV retains all rows', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'search-audit-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pages = Array.from({ length: 105 }, (_, i) => ({ url: `https://example.com/${i}`, status: 200, title: `Page ${i}` }));
  const files = await writeReport(sample({ pages }), directory);
  assert.match(await readFile(files.html, 'utf8'), /Showing 100 of 105 recorded pages/); assert.match(await readFile(files.pagesCsv, 'utf8'), /https:\/\/example.com\/104/);
});

test('specialist analysis and measured performance are preserved in deliverables', () => {
  const audit = sample({ analysis: { executiveSummary: 'Prioritize the service page that serves the commercial query.', businessContext: { model: 'Professional services', goals: ['Qualified leads'], markets: ['UAE'] }, contentActions: [{ url: 'https://example.com/service', action: 'Keep and expand', reason: 'Matches commercial intent', evidence: ['GSC query report'], priority: 'p1' }], strategicActions: [{ action: 'Commission a customer case study', reason: 'Missing first-hand proof' }] }, performance: { status: 'sampled', summaries: [{ url: 'https://example.com/', device: 'mobile', runs: 3, performanceScore: 68, metrics: { lcp: 3200, cls: 0.13, tbt: 330, fcp: 1800 } }] } });
  const html = renderReport(audit), plan = renderActionPlan(audit);
  for (const output of [html, plan]) { assert.match(output, /commercial query/); assert.match(output, /Keep and expand/); assert.match(output, /customer case study/); assert.match(output, /GSC query report/); }
  assert.match(html, /3,200 ms/); assert.match(html, /0.13/); assert.match(html, /Lab score/); assert.match(html, /No CrUX dataset supplied/);
});

test('CrUX preserves origin scope and imported evidence previews disclose limits', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ engine: 'Example AI', prompt: 'Coffee question ' + i, citedUrl: 'https://example.com/' + i, observedAt: '2026-10-21T10:00:00Z', citationPresent: true }));
  const audit = sample({ limitations: ['Only discovered URLs were checked.'], errors: [{ url: 'https://example.com/timeout', message: 'Request timed out' }], crux: { status: 'sampled', records: [{ granularity: 'origin', formFactor: 'PHONE', record: { key: { origin: 'https://example.com' }, collectionPeriod: { firstDate: { year: 2026, month: 9, day: 20 }, lastDate: { year: 2026, month: 10, day: 17 } }, metrics: { largest_contentful_paint: { percentiles: { p75: 2800 } }, interaction_to_next_paint: { percentiles: { p75: 230 } }, cumulative_layout_shift: { percentiles: { p75: '0.14' } } } } }] }, imports: [{ type: 'citations', source: { provider: 'User sample', file: 'citations.json' }, rows, limitations: ['Bounded observations only.'] }] });
  const html = renderReport(audit);
  assert.match(html, /Origin · PHONE/);
  assert.match(html, /2,800 ms/);
  assert.match(html, /230 ms/);
  assert.match(html, /0.14/);
  assert.match(html, /2026-09-20 to 2026-10-17/);
  assert.match(html, /cannot establish the experience of an individual page/);
  assert.match(html, /Showing 10 of 15 rows/);
  assert.match(html, /Coffee question 9/);
  assert.doesNotMatch(html, /Coffee question 14/);
  assert.match(html, /Request timed out/);
});

test('caller business priority order survives within a priority and is explained', () => {
  const audit = sample();
  audit.findings = [{ ...audit.findings[0], id: 'business-first', title: 'Z: business critical', priorityReason: 'Important service landing page', impact: { observedClicks: 124, observedImpressions: 3000, importantUrls: ['https://example.com/service'] } }, { ...audit.findings[0], id: 'less-important', title: 'A: lower business impact' }];
  const html = renderReport(audit), plan = renderActionPlan(audit);
  assert.ok(html.indexOf('Z: business critical') < html.indexOf('A: lower business impact'));
  assert.match(html, /Why this priority/);
  assert.match(html, /124 clicks/);
  assert.match(plan, /Important service landing page/);
  assert.match(html, /must not be summed into a forecast/);
});

test('unknown search data stays unknown and measured zero stays zero', () => {
  const audit = sample();
  const original = audit.findings[0];
  audit.findings = [{ ...original, priorityReason: 'Technical defect', impact: { sourceAvailable: false, observedClicks: null, observedImpressions: null, importantUrls: [] } }];
  assert.match(renderReport(audit), /Search performance was not measured for this finding/);
  assert.doesNotMatch(renderReport(audit), /Observed query\/page evidence: 0 clicks/);
  audit.findings = [{ ...original, priorityReason: 'Technical defect', impact: { sourceAvailable: true, observedClicks: 0, observedImpressions: 0, importantUrls: [] } }];
  assert.match(renderReport(audit), /Observed query\/page evidence: 0 clicks/);
});

test('report dates honor the audit timezone while GSC source dates retain their timezone', () => {
  const audit = sample({ timezone: 'Asia/Tokyo', imports: [{ type: 'gsc', range: { startDate: '2026-09-01', endDate: '2026-09-30', timezone: 'America/Los_Angeles' }, source: { provider: 'User sample' }, rows: [{ query: 'coffee', page: 'https://example.com/', date: '2026-09-30', clicks: 1, impressions: 10 }] }] });
  const html = renderReport(audit), plan = renderActionPlan(audit);
  assert.match(html, /17:10 Asia\/Tokyo/);
  assert.match(plan, /17:10 Asia\/Tokyo/);
  assert.match(html, /source date timezone: America\/Los_Angeles/);
  assert.match(html, /2026-09-30/);
  assert.equal(audit.completedAt, '2026-10-21T08:10:00Z');
});

test('inventory distinguishes an empty response shell from its rendered article', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'search-audit-rendered-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = sample({ pages: [{ url: 'https://example.com/article', status: 200, title: 'Home shell', h1: [], canonical: ['https://example.com/'], wordCount: 0,
    rendered: { title: 'Useful article', h1: ['Useful article'], canonical: ['https://example.com/article'], wordCount: 480 } }] });
  const files = await writeReport(audit, directory);
  const html = await readFile(files.html, 'utf8'), inventory = await readFile(files.pagesCsv, 'utf8');
  assert.match(html, /Response: Home shell/); assert.match(html, /Rendered: Useful article/);
  assert.match(html, /Response: 0/); assert.match(html, /Rendered: 480/);
  assert.match(inventory, /responseTitle/); assert.match(inventory, /renderedTitle/);
  assert.match(inventory, /Home shell/); assert.match(inventory, /Useful article/); assert.match(inventory, /480/);
});