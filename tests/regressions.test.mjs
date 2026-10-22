import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crawlSite, parsePage } from '../scripts/lib/crawl.mjs';
import { analyzeCrawl } from '../scripts/lib/checks.mjs';
import { compareAudits, evidenceFindings, prioritise, validateAnalysis } from '../scripts/lib/analysis.mjs';
import { main } from '../scripts/audit.mjs';

async function serverFor(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}
test('redirects cannot fetch robots-disallowed destinations', async () => {
  let privateHits = 0;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') { res.end('User-agent: *\nDisallow: /private'); return; }
    if (req.url === '/sitemap.xml') { res.writeHead(404); res.end(); return; }
    if (req.url === '/go') { res.writeHead(302, { location: '/private' }); res.end(); return; }
    if (req.url === '/private') privateHits++;
    res.setHeader('content-type', 'text/html'); res.end('<html><title>Fixture</title><a href="/go">Go</a></html>');
  });
  try {
    const audit = await crawlSite(site.origin, { allowPrivate: true, render: 0, delayMs: 0, maxPages: 5 });
    assert.equal(privateHits, 0);
    assert.match(audit.pages.find(p => p.url.endsWith('/go')).error, /robots/);
    assert.ok(!analyzeCrawl(audit).some(f => ['fetch-failed','internal-link-broken'].includes(f.checkId)));
    assert.equal(audit.coverage.failed, 0);
  } finally { await site.close(); }
});
test('canonical HTTP headers seed target checks and base href resolves document links', async () => {
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /'); return; }
    if (req.url === '/sitemap.xml') { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') res.setHeader('link', '</preferred>; rel="canonical"');
    res.end('<html lang="en"><title>Fixture</title><h1>Fixture</h1></html>');
  });
  try {
    const audit = await crawlSite(site.origin, { allowPrivate: true, render: 0, delayMs: 0, maxPages: 5 });
    assert.equal(audit.pages[0].canonical[0], site.origin + '/preferred');
    assert.ok(audit.pages.some(p => p.url.endsWith('/preferred')));
    assert.equal(parsePage('<base href="/docs/"><a href="guide">Guide</a>', site.origin + '/').links[0].url, site.origin + '/docs/guide');
  } finally { await site.close(); }
});
test('long crawl-delay pauses rather than fetching sooner than policy permits', async () => {
  let pageHits = 0;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') { res.end('User-agent: *\nCrawl-delay: 120'); return; }
    if (req.url === '/sitemap.xml') { res.writeHead(404); res.end(); return; }
    pageHits++; res.end('<html><title>Fixture</title></html>');
  });
  try {
    const audit = await crawlSite(site.origin, { allowPrivate: true, render: 0, delayMs: 0, maxSitemaps: 0 });
    assert.equal(pageHits, 0);
    assert.equal(audit.coverage.robotsBlocked, true);
    assert.ok(audit.errors.some(e => /Crawl delay/.test(e.message)));
  } finally { await site.close(); }
});
test('search-specific X-Robots directives do not apply a Bing-only exclusion to Google', () => {
  const url = 'https://example.com/';
  const page = { url, finalUrl: url, status: 200, isHtml: true, title: 'Fixture', h1: ['Fixture'], canonical: [url], wordCount: 40, links: [], headers: { 'x-robots-tag': 'bingbot: noindex' } };
  const crawl = { target: url, pages: [page], sitemaps: [{ url: url + 'sitemap.xml', urls: [{ url }], status: 200 }] };
  assert.ok(!analyzeCrawl(crawl).some(f => f.checkId === 'sitemap-noindex'));
  page.headers['x-robots-tag'] = 'googlebot: noindex';
  assert.ok(analyzeCrawl(crawl).some(f => f.checkId === 'sitemap-noindex'));
});
test('query overlap is not fabricated by combining unrelated datasets or markets', () => {
  const audit = { pages: [], gsc: { rows: [{ query: 'coffee', page: 'https://example.com/a', impressions: 10 }] },
    imports: [{ type: 'gsc', range: { startDate: '2020-01-01' }, rows: [{ query: 'coffee', page: 'https://example.com/b', impressions: 10 }] }] };
  assert.equal(evidenceFindings(audit).length, 0);
  audit.gsc.rows.push({ query: 'coffee', page: 'https://example.com/b', impressions: 10, country: 'ARE' });
  assert.equal(evidenceFindings(audit).length, 0);
});
test('traffic evidence deduplicates identical rows and missing evidence remains unknown', () => {
  const create = () => ({ id: 'x', severity: 'medium', confidence: 'high', affectedUrls: ['https://example.com/a'] });
  const row = { query: 'coffee', page: 'https://example.com/a', clicks: 3, impressions: 20 };
  assert.equal(prioritise([create()], { gscRows: [row, { ...row }] })[0].impact.observedClicks, 3);
  const unknown = prioritise([create()])[0].impact;
  assert.equal(unknown.sourceAvailable, false);
  assert.equal(unknown.observedClicks, null);
});
test('comparison flags failed coverage and different measurement samples', () => {
  const base = { target: 'https://example.com/', findings: [], pages: [], settings: { performanceLimit: 3 }, coverage: { truncated: false, failed: 0 } };
  const changed = { ...base, settings: { performanceLimit: 0 }, coverage: { truncated: false, failed: 2 } };
  const comparison = compareAudits(base, changed);
  assert.equal(comparison.comparableCoverage, false);
  assert.equal(comparison.comparability.settings, false);
});
test('documented local analysis references resolve; scalar or invented IDs are rejected', () => {
  const action = evidence => ({ strategicActions: [{ action: 'Review coverage', reason: 'Partial evidence', evidence }] });
  assert.equal(validateAnalysis(action(['audit.json#coverage']), { runId: 'x' }).evidenceValidation.internalReferences, 1);
  assert.throws(() => validateAnalysis(action('made-up'), { runId: 'x' }), /array/);
  assert.throws(() => validateAnalysis(action(['made-up']), { runId: 'x' }), /Unresolved/);
});
test('relocated reports retain referenced local Lighthouse evidence', async () => {
  const dir = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-relocate-'));
  try {
    const source = path.join(dir, 'old'), output = path.join(dir, 'new');
    await mkdir(path.join(source, 'evidence', 'lighthouse'), { recursive: true });
    await writeFile(path.join(source, 'evidence', 'lighthouse', 'test.json'), '{"measured":true}');
    await writeFile(path.join(source, 'audit.json'), JSON.stringify({ schemaVersion: 1, runId: 'x', target: 'https://example.com/', pages: [], findings: [], performance: { results: [{ evidenceFile: 'evidence/lighthouse/test.json' }] } }));
    await main(['report', path.join(source, 'audit.json'), '--output', output]);
    assert.equal(await readFile(path.join(output, 'evidence', 'lighthouse', 'test.json'), 'utf8'), '{"measured":true}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
