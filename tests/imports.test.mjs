import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDelimited, importDataset } from '../scripts/lib/imports.mjs';

async function dataFile(t, name, content) {
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.tmp-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, name);
  await writeFile(file, content, 'utf8');
  return file;
}
const target = 'https://example.com/';

test('CSV parses BOM, escaped quotes, commas, CRLF, and embedded newlines', () => {
  const rows = parseDelimited('\uFEFFQuery,Page,Clicks\r\n"best, ""red""\nshoes",https://example.com/a,12\r\n');
  assert.deepEqual(rows, [{ Query: 'best, "red"\nshoes', Page: 'https://example.com/a', Clicks: '12' }]);
  assert.deepEqual(parseDelimited('Query\tPage\nred shoes\thttps://example.com/a\n'), [{ Query: 'red shoes', Page: 'https://example.com/a' }]);
  assert.throws(() => parseDelimited('Query,Page\n"unfinished,page'), /unterminated/);
  assert.throws(() => parseDelimited('Query,Query\na,b'), /unique/);
  assert.throws(() => parseDelimited('Query,Page\none,two,three'), /columns/);
  assert.throws(() => parseDelimited('Query,Page\n"one"x,two'), /closing quote/);
});

test('GSC CSV preserves query-page linkage and typed metrics with provenance and source date range', async t => {
  const file = await dataFile(t, 'gsc.csv', 'Query,Page,Clicks,Impressions,CTR,Position\n"red, shoes",https://example.com/a,10,"1,000",1%,3.5\nred shoes,https://example.com/b,5,100,5%,7\noutside,https://evil.test/,1,10,10%,2\n');
  const data = await importDataset(file, { type: 'gsc', target, startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows[0].query, 'red, shoes');
  assert.equal(data.rows[0].page, 'https://example.com/a');
  assert.equal(data.rows[0].impressions, 1000);
  assert.equal(data.rows[0].ctr, 0.01);
  assert.equal(data.coverage.excludedRows, 1);
  assert.equal(data.range.startDate, '2026-01-01');
  assert.match(data.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(data.source.file, 'gsc.csv');
  assert.equal(JSON.stringify(data).includes(file), false);
});

test('Page and query summary exports stay separate and do not fabricate relationships', async t => {
  const queries = await dataFile(t, 'queries.csv', 'Top queries,Clicks,Impressions,CTR,Position\nred shoes,10,100,10%,3\n');
  const data = await importDataset(queries, { type: 'gsc', target });
  assert.equal(data.rows[0].query, 'red shoes');
  assert.equal(data.rows[0].page, undefined);
  assert.match(data.limitations.join(' '), /No linked query\/page/);
  assert.equal(data.coverage.unscopedRows, 1);
  const pages = await dataFile(t, 'pages.csv', 'Top pages,Clicks,Impressions\nhttps://example.com/a,12,120\n');
  const pageData = await importDataset(pages, { type: 'gsc', target });
  assert.equal(pageData.rows[0].query, undefined);
  assert.equal(pageData.rows[0].page, 'https://example.com/a');
});

test('API JSON keys require explicit dimension names to retain linkage', async t => {
  const file = await dataFile(t, 'api.json', JSON.stringify({ dimensions: ['page', 'query'], rows: [{ keys: ['https://example.com/a', 'red shoes'], clicks: 3, impressions: 10 }] }));
  const data = await importDataset(file, { type: 'gsc', target });
  assert.equal(data.rows[0].query, 'red shoes');
  assert.equal(data.rows[0].page, 'https://example.com/a');
  const missing = await dataFile(t, 'unknown-keys.json', JSON.stringify({ rows: [{ keys: ['red shoes', 'https://example.com/a'], clicks: 3 }] }));
  const unknown = await importDataset(missing, { type: 'gsc', target });
  assert.equal(unknown.rows.length, 0);
  assert.match(unknown.limitations.join(' '), /without declared dimensions/);
});

test('Malformed metrics, invalid dates, and unsafe URLs are excluded without inventing zeros', async t => {
  const file = await dataFile(t, 'gsc.json', JSON.stringify([
    { query: 'valid', page: target + 'a', impressions: 10 },
    { query: 'negative', page: target + 'b', clicks: -1 },
    { query: 'ctr', page: target + 'c', ctr: '105%' },
    { query: 'date', page: target + 'd', date: '2026-02-30' },
    { query: 'url', page: 'javascript:alert(1)', clicks: 2 }
  ]));
  const data = await importDataset(file, { type: 'gsc', target });
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].clicks, undefined);
  assert.equal(data.coverage.invalidRows, 4);
  await assert.rejects(importDataset(file, { type: 'gsc', target, startDate: '2026-02-30' }), /valid YYYY/);
  await assert.rejects(importDataset(file, { type: 'gsc', target, startDate: '2026-03-01', endDate: '2026-01-01' }), /on or before/);
});

test('Backlinks allow external referring pages but require in-scope destinations', async t => {
  const file = await dataFile(t, 'backlinks.csv', 'Source URL,Target URL,Anchor Text,Rel\nhttps://publisher.test/article,https://example.com/a,"a, link",nofollow\nhttps://publisher.test/article,https://notexample.com/a,b,follow\n');
  const data = await importDataset(file, { type: 'backlinks', target: 'sc-domain:example.com' });
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].sourceUrl, 'https://publisher.test/article');
  assert.equal(data.rows[0].anchor, 'a, link');
  assert.equal(data.coverage.excludedRows, 1);
  assert.match(data.limitations.join(' '), /complete backlink profile/);
});

test('Citation observations require engine, prompt, and observation date; negative observations remain explicit', async t => {
  const file = await dataFile(t, 'citations.json', JSON.stringify([
    { engine: 'example-engine', prompt: 'Who sells red shoes?', citedUrl: target + 'a', observedAt: '2026-01-02T12:00:00Z', locale: 'en-AE' },
    { engine: 'example-engine', prompt: 'Who sells blue shoes?', citationPresent: false, observedAt: '2026-01-02T12:00:00Z' },
    { engine: 'example-engine', prompt: 'Unrecorded date', citedUrl: target + 'b' },
    { engine: 'example-engine', prompt: 'Claimed citation without URL', citationPresent: true, observedAt: '2026-01-02' }
  ]));
  const data = await importDataset(file, { type: 'citations', target });
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows[0].citationPresent, true);
  assert.equal(data.rows[1].citationPresent, false);
  assert.equal(data.rows[1].citedUrl, undefined);
  assert.equal(data.coverage.invalidRows, 2);
  assert.match(data.limitations.join(' '), /recorded prompts/);
});

test('Logs import scopes absolute and relative URLs and never verifies bots from user-agent', async t => {
  const file = await dataFile(t, 'logs.csv', 'URL,Status,User Agent,IP,Observed At\n/a,404,Googlebot,192.0.2.1,2026-01-02T12:00:00Z\nhttps://evil.test/a,200,ExampleBot,192.0.2.2,2026-01-02T12:00:00Z\n/b,700,Unknown,192.0.2.3,2026-01-02T12:00:00Z\n');
  const data = await importDataset(file, { type: 'logs', target });
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].url, target + 'a');
  assert.equal(data.rows[0].status, 404);
  assert.equal(data.rows[0].userAgent, 'Googlebot');
  assert.equal(data.rows[0].botVerification, 'not_verified');
  assert.equal(data.coverage.excludedRows, 1);
  assert.equal(data.coverage.invalidRows, 1);
  assert.match(data.limitations.join(' '), /User-agent strings alone/);
});

test('Imports enforce bounded size/rows and strict JSON shapes', async t => {
  const file = await dataFile(t, 'bounded.json', JSON.stringify([{ query: 'a' }, { query: 'b' }]));
  await assert.rejects(importDataset(file, { type: 'gsc', maxBytes: 1 }), /byte/);
  await assert.rejects(importDataset(file, { type: 'gsc', maxRows: 1 }), /row limit/);
  const broken = await dataFile(t, 'broken.json', '{no}');
  await assert.rejects(importDataset(broken, { type: 'gsc' }), /not valid JSON/);
  const primitive = await dataFile(t, 'primitive.json', '[1]');
  await assert.rejects(importDataset(primitive, { type: 'gsc' }), /must be an object/);
});
