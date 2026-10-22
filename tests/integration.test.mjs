import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from '../scripts/audit.mjs';
import { startDemoSite } from '../scripts/demo.mjs';

test('public fixture audit creates branded evidence and action plan without Google or paid data', async () => {
  const dir = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-integration-'));
  const site = await startDemoSite();
  try {
    const result = await runAudit(site.origin + '/', {
      output: path.join(dir, 'report'), 'data-dir': path.join(dir, 'data'), 'allow-private': true,
      'no-performance': true, render: '0', 'delay-ms': '0', 'max-pages': '30'
    }, { log: () => {} });
    assert.equal(result.audit.brand.name, 'Northstar Coffee');
    assert.ok(result.audit.pages.some(page => page.url === site.origin + '/orphan'));
    assert.ok(!site.requests.includes('/private'), 'robots-disallowed page must not be fetched');
    assert.ok(result.audit.findings.some(finding => finding.affectedUrls.includes(site.origin + '/bad-canonical')));
    assert.equal(result.audit.gsc.status, 'not_assessed');
    assert.equal(result.audit.capabilities.find(c => c.id === 'indexation').status, 'not_assessed');
    assert.equal(result.audit.capabilities.find(c => c.id === 'intent').status, 'not_assessed');
    assert.match(await readFile(result.artifacts.html, 'utf8'), /Northstar Coffee/);
    assert.match(await readFile(result.artifacts.actionPlan, 'utf8'), /Acceptance criteria/);
    const evidence = JSON.parse(await readFile(result.auditFile, 'utf8'));
    assert.equal(evidence.target, site.origin + '/');
    assert.ok(evidence.findings.every(f => f.recommendation && f.acceptance.length && f.evidence.length));
  } finally { await site.close(); await rm(dir, { recursive: true, force: true }); }
});

test('projects keep different website runs and branding isolated', async () => {
  const dir = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-isolation-'));
  const sites = await Promise.all([startDemoSite(), startDemoSite({ brand: 'Cedar Tea' })]);
  try {
    const results = [];
    for (let index = 0; index < sites.length; index++) results.push(await runAudit(sites[index].origin + '/', {
      output: path.join(dir, 'report-' + index), 'data-dir': path.join(dir, 'data'), 'allow-private': true,
      'no-performance': true, render: '0', 'delay-ms': '0', 'max-pages': '3'
    }, { log: () => {} }));
    assert.notEqual(results[0].audit.projectId, results[1].audit.projectId);
    assert.equal(results[1].audit.brand.name, 'Cedar Tea');
    const secondHtml = await readFile(results[1].artifacts.html, 'utf8');
    assert.ok(!secondHtml.includes('Northstar Coffee'));
    assert.ok(!secondHtml.includes(sites[0].origin));
    assert.equal(results[1].audit.comparison, undefined);
  } finally { await Promise.all(sites.map(site => site.close())); await rm(dir, { recursive: true, force: true }); }
});
