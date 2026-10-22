#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseTarget, projectKey, compareAudits, evidenceFindings, prioritise, validateAnalysis } from './lib/analysis.mjs';
import { findBrowser, runPerformance, performanceFindings, collectCrux } from './lib/performance.mjs';

export const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = [
  'Search Audit — local SEO, AEO and GEO audits using free tools',
  '',
  '  node scripts/audit.mjs audit <website> [options]',
  '  node scripts/audit.mjs report <audit.json> [--analysis file.json] [--pdf]',
  '  node scripts/audit.mjs auth connect --profile name --client oauth-client.json',
  '  node scripts/audit.mjs auth list | auth disconnect --profile name',
  '  node scripts/audit.mjs gsc properties --profile name',
  '  node scripts/audit.mjs doctor',
  '',
  'Audit options:',
  '  --output DIR           Report destination; default ./audit-output/<project>/<run>',
  '  --data-dir DIR         Project/connection metadata; default ./.search-audit',
  '  --max-pages N          HTTP page budget (default 200)',
  '  --delay-ms N           Delay between HTTP requests (default 150)',
  '  --timeout-ms N         HTTP timeout (default 15000)',
  '  --render N             Rendered-page sample budget (default 3)',
  '  --lighthouse N         Performance URL sample budget (default 3)',
  '  --devices LIST         mobile,desktop (default mobile)',
  '  --lighthouse-runs N    Runs per URL/device (default 1; use 3 for a median)',
  '  --no-performance      Skip Lighthouse explicitly',
  '  --browser PATH        Chrome/Chromium executable; also supports CHROME_PATH',
  '  --pdf                 Export PDF as well as HTML',
  '  --timezone ZONE       Report display timezone (default local IANA timezone)',
  '  --resume              Resume saved crawl evidence/queue for this project',
  '  --seed URL            Extra discovery seed; repeatable',
  '  --important URL       Business-important URL/prefix; repeatable',
  '  --import TYPE=FILE    gsc,backlinks,citations,logs; repeatable CSV/JSON imports',
  '  --gsc-profile NAME    Optional per-user Google account profile',
  '  --gsc-property ID     Exact accessible domain or URL-prefix property',
  '  --start YYYY-MM-DD    GSC start date (default 90 days before end)',
  '  --end YYYY-MM-DD      GSC end date (default 3 days ago)',
  '  --inspect N           URL Inspection sample budget (default 10; max 100)',
  '  --previous FILE       Compare a previous audit; otherwise project latest',
  '  --analysis FILE       Evidence-backed assistant analysis JSON',
  '  --allow-private       Explicitly allow local/private targets for owned fixtures',
  '',
  'Search Console uses your own OAuth consent and read-only access.',
  'No Google connection or paid SEO API is required for public audits.',
  'Optional CRUX_API_KEY enables direct field-data lookup. Tokens are never in reports.',
  'Each report declares scope, samples and unavailable evidence.'
].join('\n');
const options = {
  help: { type: 'boolean', short: 'h' }, output: { type: 'string' }, 'data-dir': { type: 'string' },
  'max-pages': { type: 'string' }, 'delay-ms': { type: 'string' }, 'timeout-ms': { type: 'string' },
  render: { type: 'string' }, lighthouse: { type: 'string' }, devices: { type: 'string' },
  'lighthouse-runs': { type: 'string' }, 'no-performance': { type: 'boolean' },
  timezone: { type: 'string' }, browser: { type: 'string' }, pdf: { type: 'boolean' }, resume: { type: 'boolean' },
  seed: { type: 'string', multiple: true }, important: { type: 'string', multiple: true },
  import: { type: 'string', multiple: true }, 'gsc-profile': { type: 'string' },
  'gsc-property': { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
  inspect: { type: 'string' }, previous: { type: 'string' }, analysis: { type: 'string' },
  'allow-private': { type: 'boolean' }, profile: { type: 'string' }, client: { type: 'string' },
  'no-open': { type: 'boolean' }
};
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const saveJson = async (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
function numberOption(values, key, fallback, min = 0, max = 100000) {
  const number = Number(values[key] ?? fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('--' + key + ' must be an integer from ' + min + ' to ' + max + '.');
  return number;
}
const defaultDate = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
function dates(values) {
  const endDate = values.end ?? defaultDate(3);
  const valid = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(new Date(date).getTime()) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(endDate)) throw new Error('Dates must be valid YYYY-MM-DD values.');
  const startDate = values.start ?? new Date(new Date(endDate).getTime() - 90 * 86400000).toISOString().slice(0, 10);
  if (!valid(startDate)) throw new Error('Dates must be valid YYYY-MM-DD values.');
  if (startDate > endDate) throw new Error('--start must precede --end.');
  return { startDate, endDate };
}
function sampleUrls(pages, limit, important = []) {
  const eligible = pages.filter(p => p.status === 200 && p.isHtml !== false && !p.redirects?.length && p.title !== undefined);
  const selected = [], seenTemplates = new Set();
  const add = page => { if (page && !selected.includes(page.url)) selected.push(page.url); };
  for (const prefix of important) add(eligible.find(p => p.url === prefix || p.url.startsWith(prefix)));
  add(eligible[0]);
  for (const page of eligible) {
    const template = new URL(page.url).pathname.replace(/\d+/g, ':id').split('/').slice(0, -1).join('/');
    if (!seenTemplates.has(template)) { seenTemplates.add(template); add(page); }
  }
  for (const page of eligible) add(page);
  return selected.slice(0, limit);
}
function capabilities(audit, values) {
  const imported = type => audit.imports.some(i => i.type === type && i.rows?.length);
  const rendered = Number(audit.coverage.rendered ?? 0);
  const inspectedCount = (audit.gsc.inspections ?? []).filter(i => i.status === 'observed' || i.indexStatusResult).length;
  return [
    { id: 'crawl', label: 'Technical and on-page crawl', status: audit.coverage.truncated ? 'sampled' : 'complete', detail: 'Configured discovery scope only. ' + audit.coverage.crawled + ' URLs crawled; undiscovered URLs are unknown.' },
    { id: 'render', label: 'JavaScript rendering', status: rendered ? 'sampled' : values.render ? 'unavailable' : 'not_assessed', detail: rendered + ' pages rendered. Compare response and rendered evidence only for this sample.' },
    { id: 'performance', label: 'Laboratory performance', status: audit.performance.status, detail: audit.performance.summaries.length + ' URL/device samples; ' + audit.performance.errors.length + ' failed measurements.' },
    { id: 'field', label: 'Real-user Core Web Vitals', status: audit.crux.status, detail: audit.crux.records.length ? 'CrUX page/origin coverage and period are recorded separately.' : 'No field result; laboratory data is not a substitute.' },
    { id: 'gsc', label: 'Search Console performance', status: audit.gsc.status, detail: audit.gsc.property ? 'Selected property: ' + audit.gsc.property : 'Optional per-user connection not available for this run.' },
    { id: 'indexation', label: 'Actual indexed-version status', status: inspectedCount ? 'sampled' : 'not_assessed', detail: inspectedCount + ' URL Inspection records. Public checks assess indexability only.' },
    { id: 'intent', label: 'Search intent and content strategy', status: audit.analysis ? 'sampled' : 'not_assessed', detail: audit.analysis ? 'Evidence-backed assistant review; see content actions and source references.' : 'Content overlap candidates are available. Complete the skill analysis step for reviewed intent and business recommendations.' },
    { id: 'cannibalisation', label: 'Query/page overlap', status: audit.gsc.rows?.length || imported('gsc') ? 'sampled' : 'not_assessed', detail: 'Overlap candidates require intent and historical review before consolidation; no harmful cannibalisation is assumed.' },
    { id: 'offpage', label: 'Off-page links', status: imported('backlinks') ? 'sampled' : 'not_assessed', detail: 'Imported or supplied evidence only; no complete web backlink index is available.' },
    { id: 'aeo', label: 'AI retrieval accessibility', status: 'sampled', detail: 'Public directives and content evidence; real bot admission requires verified logs. Training controls are assessed separately.' },
    { id: 'citations', label: 'Observed AI citations', status: imported('citations') ? 'sampled' : 'not_assessed', detail: 'Only supplied engine/query observations. No citation, training inclusion or ranking guarantee.' }
  ];
}

export async function runAudit(targetInput, values = {}, { log = console.log } = {}) {
  const target = normaliseTarget(targetInput);
  const timezone = values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('Use a valid IANA --timezone, such as Asia/Dubai.'); }
  const settings = {
    maxPages: numberOption(values, 'max-pages', 200, 1), delayMs: numberOption(values, 'delay-ms', 150),
    timeoutMs: numberOption(values, 'timeout-ms', 15000, 100, 120000), render: numberOption(values, 'render', 3, 0, 1000),
    performanceLimit: values['no-performance'] ? 0 : numberOption(values, 'lighthouse', 3, 0, 1000),
    performanceRuns: numberOption(values, 'lighthouse-runs', 1, 1, 5), inspections: numberOption(values, 'inspect', 10, 0, 100),
    devices: (values.devices ?? 'mobile').split(',')
  };
  if (settings.devices.some(device => !['mobile', 'desktop'].includes(device))) throw new Error('--devices accepts mobile,desktop.');
  if (values['gsc-property'] && !values['gsc-profile']) throw new Error('--gsc-property requires --gsc-profile.');
  const { startDate, endDate } = dates(values);
  const dataDir = path.resolve(values['data-dir'] ?? '.search-audit');
  const projectId = projectKey(target), projectDir = path.join(dataDir, 'projects', projectId);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.resolve(values.output ?? path.join('audit-output', projectId, runId));
  await mkdir(output, { recursive: true }); await mkdir(projectDir, { recursive: true });
  let project = { target, projectId };
  try { project = { ...project, ...await readJson(path.join(projectDir, 'project.json')) }; } catch {}
  if (project.target !== target) throw new Error('Project scope mismatch.');
  const { importDataset } = await import('./lib/imports.mjs');
  const imports = [];
  for (const spec of values.import ?? []) {
    const split = spec.indexOf('=');
    if (split <= 0) throw new Error('--import expects TYPE=FILE.');
    imports.push(await importDataset(spec.slice(split + 1), { type: spec.slice(0, split), target }));
  }
  let gsc = { status: 'not_assessed', rows: [], inspections: [], limitations: [] };
  const profile = values['gsc-profile'] ?? project.gscProfile;
  const property = values['gsc-property'] ?? project.gscProperty;
  if (profile) {
    try {
      const { collectGsc, listProperties, propertyMatchesTarget } = await import('./lib/gsc.mjs');
      let selected = property;
      if (!selected) {
        const properties = await listProperties({ profile, dataDir });
        const entries = Array.isArray(properties) ? properties : properties.siteEntry ?? properties.properties ?? [];
        const matches = entries.filter(entry => propertyMatchesTarget(entry.siteUrl ?? entry.property ?? entry, target));
        if (matches.length !== 1) throw new Error('Choose --gsc-property from accessible matching properties: ' + matches.map(entry => entry.siteUrl ?? entry.property ?? entry).join(', '));
        selected = matches[0].siteUrl ?? matches[0].property ?? matches[0];
      }
      gsc = await collectGsc({ profile, property: selected, target, startDate, endDate, dataDir,
        inspectionUrls: [], maxInspections: 0 });
      gsc.collectionStatus = gsc.status;
      gsc.status = 'sampled';
      project.gscProfile = profile; project.gscProperty = selected;
    } catch (error) { gsc = { status: 'unavailable', rows: [], inspections: [], limitations: [error.message] }; log('Search Console unavailable: ' + error.message); }
  }
  const seeds = [...(values.seed ?? []), ...(gsc.rows ?? []).map(row => row.page).filter(Boolean),
    ...imports.flatMap(dataset => (dataset.rows ?? []).map(row => dataset.type === 'gsc' ? row.page :
      dataset.type === 'backlinks' ? row.targetUrl : dataset.type === 'citations' ? row.citedUrl : dataset.type === 'logs' ? row.url : null).filter(Boolean))];
  const browserExecutable = await findBrowser(values.browser);
  const progress = event => {
    if (event.phase === 'lighthouse') log('Lighthouse: ' + event.device + ' run ' + event.run + '/' + event.runs + ' ' + event.url);
    else if (event.url) log('Crawl: ' + event.url);
  };
  log('Auditing ' + target);
  const { crawlSite } = await import('./lib/crawl.mjs');
  const crawl = await crawlSite(target, {
    maxPages: settings.maxPages, delayMs: settings.delayMs, timeoutMs: settings.timeoutMs,
    render: settings.render, seeds, allowPrivate: Boolean(values['allow-private']), onProgress: progress,
    stateFile: path.join(projectDir, 'crawl-state.json'), resume: Boolean(values.resume), browserExecutable
  });
  const urls = sampleUrls(crawl.pages, Math.max(settings.performanceLimit, settings.inspections), values.important ?? []);
  const performance = await runPerformance(urls, { limit: settings.performanceLimit, devices: settings.devices,
    runs: settings.performanceRuns, browserExecutable, evidenceDir: path.join(output, 'evidence', 'lighthouse'), onProgress: progress });
  const crux = await collectCrux(target, { apiKey: process.env.CRUX_API_KEY });
  if (gsc.status === 'sampled' && settings.inspections) {
    try {
      const inspected = await (await import('./lib/gsc.mjs')).inspectGscUrls({
        profile, property: gsc.property, target, dataDir,
        inspectionUrls: urls.slice(0, settings.inspections), maxInspections: settings.inspections
      });
      gsc.inspections = inspected.inspections;
      gsc.limitations = [...gsc.limitations.filter(item => !item.startsWith('No URL Inspection evidence collected')), ...inspected.limitations];
      gsc.coverage = { ...gsc.coverage, inspectionSample: inspected.coverage };
    } catch (error) { gsc.limitations.push('URL Inspection sample unavailable: ' + error.message); }
  }
  const audit = {
    schemaVersion: 1, ruleVersion: '1.0.0', timezone, runId, projectId, target, startedAt: crawl.startedAt,
    completedAt: new Date().toISOString(), brand: crawl.brand, coverage: { ...crawl.coverage,
      performanceTested: new Set(performance.results.map(r => r.url)).size },
    settings: { ...settings, allowPrivate: Boolean(values['allow-private']), startDate, endDate },
    pages: crawl.pages, robots: crawl.robots, sitemaps: crawl.sitemaps, errors: crawl.errors,
    performance, crux, gsc, imports, findings: [], capabilities: [],
    limitations: ['The crawl covers discovered URLs within the configured scope and budget, not every possible URL.',
      'Public technical checks cannot prove Google indexation, bot retrieval, AI citation or model training inclusion.',
      'No paid SEO database is used. Search demand and comprehensive backlink/competitor inventories are outside this dataset.']
  };
  const { analyzeCrawl } = await import('./lib/checks.mjs');
  const checked = await analyzeCrawl(crawl, { gsc, imports });
  const findingArray = Array.isArray(checked) ? checked : checked.findings ?? [];
  audit.findings = prioritise([...findingArray, ...performanceFindings(performance), ...evidenceFindings(audit)], {
    importantUrls: values.important ?? [],
    gscRows: gsc.rows?.length ? gsc.rows : (imports.find(i => i.type === 'gsc' && i.rows?.length)?.rows ?? [])
  });
  if (values.analysis) audit.analysis = validateAnalysis(await readJson(values.analysis), audit);
  audit.capabilities = capabilities(audit, { ...values, render: settings.render });
  const previousFile = values.previous ? path.resolve(values.previous) : project.latestAudit;
  if (previousFile) {
    try { audit.comparison = compareAudits(await readJson(previousFile), audit); }
    catch (error) { audit.limitations.push('Previous run comparison unavailable: ' + error.message); }
  }
  const auditFile = path.join(output, 'audit.json');
  await saveJson(auditFile, audit);
  const { writeReport } = await import('./lib/report.mjs');
  const artifacts = await writeReport(audit, output, { pdf: Boolean(values.pdf), browserExecutable });
  await saveJson(path.join(projectDir, 'project.json'), { ...project, latestAudit: auditFile, updatedAt: audit.completedAt });
  log('Report: ' + artifacts.html);
  if (artifacts.pdf) log('PDF: ' + artifacts.pdf);
  if (artifacts.pdfError) log(artifacts.pdfError);
  log('Evidence: ' + auditFile);
  log(audit.findings.length + ' grouped finding(s); ' + audit.coverage.crawled + ' URL(s) crawled.');
  return { audit, artifacts, auditFile, output };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, ...rest] = positionals;
  const dataDir = path.resolve(values['data-dir'] ?? '.search-audit');
  if (command === 'doctor') {
    const browser = await findBrowser(values.browser);
    console.log(JSON.stringify({ node: process.version, browser, skillDir, dataDir,
      searchConsole: 'Optional: auth connect --profile NAME --client FILE',
      fieldData: process.env.CRUX_API_KEY ? 'CrUX key configured' : 'Optional CRUX_API_KEY not configured' }, null, 2)); return;
  }
  if (command === 'auth') {
    const gsc = await import('./lib/gsc.mjs');
    if (rest[0] === 'connect') {
      if (!values.profile || !values.client) throw new Error('auth connect requires --profile and --client.');
      const result = await gsc.authConnect({ profile: values.profile, clientFile: path.resolve(values.client), dataDir,
        noOpen: Boolean(values['no-open']), onAuthorizationUrl: url => console.log('Sign in with your own Google account:\n' + url) });
      console.log(JSON.stringify(result, null, 2)); return;
    }
    if (rest[0] === 'list') { console.log(JSON.stringify(await gsc.authList({ dataDir }), null, 2)); return; }
    if (rest[0] === 'disconnect' && values.profile) { console.log(JSON.stringify(await gsc.authDisconnect({ profile: values.profile, dataDir }), null, 2)); return; }
    throw new Error('Use auth connect, auth list, or auth disconnect --profile NAME.');
  }
  if (command === 'gsc' && rest[0] === 'properties') {
    if (!values.profile) throw new Error('gsc properties requires --profile.');
    console.log(JSON.stringify(await (await import('./lib/gsc.mjs')).listProperties({ profile: values.profile, dataDir }), null, 2)); return;
  }
  if (command === 'report') {
    if (!rest[0]) throw new Error('report requires an audit.json path.');
    const file = path.resolve(rest[0]), audit = await readJson(file);
    if (audit.schemaVersion !== 1 || !Array.isArray(audit.findings) || !Array.isArray(audit.pages)) throw new Error('Invalid audit evidence file.');
    if (values.analysis) {
      audit.analysis = validateAnalysis(await readJson(values.analysis), audit);
      const intent = audit.capabilities?.find(c => c.id === 'intent');
      if (intent) { intent.status = 'sampled'; intent.detail = 'Evidence-backed assistant review; see content actions.'; }
    }
    if (values.timezone) { new Intl.DateTimeFormat('en', { timeZone: values.timezone }); audit.timezone = values.timezone; }
    const output = path.resolve(values.output ?? path.dirname(file));
    await mkdir(output, { recursive: true });
    if (output !== path.dirname(file)) {
      const references = [...new Set([...(audit.performance?.results ?? []).map(r => r.evidenceFile),
        ...(audit.performance?.summaries ?? []).flatMap(r => r.evidenceFiles ?? [])].filter(Boolean))];
      for (const reference of references) {
        try {
          if (!/^evidence\/lighthouse\/[a-z0-9._-]+\.json$/i.test(reference)) throw new Error('Unsupported evidence reference.');
          const original = await realpath(path.join(path.dirname(file), reference));
          const sourceRoot = await realpath(path.dirname(file));
          if (!original.startsWith(sourceRoot + path.sep)) throw new Error('Evidence escapes the source audit directory.');
          const destination = path.join(output, reference);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(original, destination);
        } catch { (audit.limitations ??= []).push('Referenced Lighthouse evidence could not be relocated: ' + reference); }
      }
    }
    if (values.analysis || values.timezone || output !== path.dirname(file)) await saveJson(path.join(output, 'audit.json'), audit);
    console.log(JSON.stringify(await (await import('./lib/report.mjs')).writeReport(audit, output, {
      pdf: Boolean(values.pdf), browserExecutable: await findBrowser(values.browser)
    }), null, 2)); return;
  }
  if (command === 'audit') {
    if (!rest[0]) throw new Error('audit requires a website URL.');
    await runAudit(rest[0], values); return;
  }
  if (/^(https?:\/\/|[a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i.test(command)) { await runAudit(command, values); return; }
  throw new Error('Unknown command: ' + command + '. Use --help.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Search Audit: ' + error.message); process.exitCode = 1; });
}
