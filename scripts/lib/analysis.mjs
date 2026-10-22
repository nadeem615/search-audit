import { createHash } from 'node:crypto';

const unique = values => [...new Set(values.filter(Boolean))];
export function normaliseTarget(value) {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) website URL without embedded credentials.');
  url.hash = '';
  return url.href;
}
export function projectKey(target) {
  const url = new URL(target);
  return url.hostname.replace(/[^a-z0-9.-]/gi, '-') + '-' + createHash('sha256').update(target).digest('hex').slice(0, 12);
}
export function compareAudits(previous, current) {
  if (normaliseTarget(previous.target) !== normaliseTarget(current.target)) throw new Error('Comparison requires the same website scope.');
  const key = finding => [finding.checkId ?? finding.id, finding.title, finding.category].join('|');
  const old = new Map(previous.findings.map(f => [key(f), f]));
  const now = new Map(current.findings.map(f => [key(f), f]));
  const changes = [];
  for (const [id, finding] of now) {
    const prior = old.get(id);
    const addedUrls = finding.affectedUrls.filter(url => !prior?.affectedUrls?.includes(url));
    const removedUrls = (prior?.affectedUrls ?? []).filter(url => !finding.affectedUrls.includes(url));
    changes.push({ id: finding.id, checkId: finding.checkId, title: finding.title,
      state: !prior ? 'new' : addedUrls.length || removedUrls.length || finding.severity !== prior.severity ? 'changed' : 'unchanged',
      affectedBefore: prior?.affectedUrls?.length ?? 0, affectedAfter: finding.affectedUrls.length, addedUrls, removedUrls });
  }
  for (const [id, finding] of old) if (!now.has(id)) changes.push({ id: finding.id, checkId: finding.checkId, title: finding.title,
    state: 'not_observed', affectedBefore: finding.affectedUrls.length, affectedAfter: 0, addedUrls: [], removedUrls: finding.affectedUrls,
    detail: 'Not observed in the new run. Confirm comparable coverage before calling this resolved.' });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const measuredSettings = audit => Object.fromEntries(['render', 'performanceLimit', 'performanceRuns', 'devices'].map(key => [key, audit.settings?.[key]]));
  const pageSet = audit => unique((audit.pages ?? []).map(page => page.url)).sort();
  const performanceSet = audit => unique((audit.performance?.results ?? []).map(row => row.url + '|' + row.device)).sort();
  const comparability = {
    coverage: !previous.coverage?.truncated && !current.coverage?.truncated && !(previous.coverage?.failed ?? 0) && !(current.coverage?.failed ?? 0) && same(pageSet(previous), pageSet(current)),
    settings: same(measuredSettings(previous), measuredSettings(current)),
    rules: previous.ruleVersion === current.ruleVersion,
    performanceSamples: same(performanceSet(previous), performanceSet(current)),
    evidencePeriods: same(previous.gsc?.range, current.gsc?.range)
  };
  return { previousRunId: previous.runId, currentRunId: current.runId,
    comparableCoverage: Object.values(comparability).every(Boolean), comparability,
    counts: Object.fromEntries(['new', 'changed', 'unchanged', 'not_observed'].map(state => [state, changes.filter(c => c.state === state).length])),
    changes, limitations: ['A finding disappearing from a partial crawl does not prove resolution. Search and business outcomes are measured separately.'] };
}
function groupFinding(checkId, title, overrides = {}) {
  return { id: checkId, checkId, title, category: 'content', severity: 'medium', kind: 'hypothesis', confidence: 'medium',
    affectedUrls: [], evidence: [], recommendation: '', owner: 'SEO and content', effort: 'medium', priority: 'p2',
    dependencies: [], acceptance: [], ...overrides };
}
export function evidenceFindings(audit) {
  const findings = [];
  const datasets = [
    { source: 'Search Console live query/page evidence', range: audit.gsc?.range, rows: audit.gsc?.rows ?? [] },
    ...(audit.imports ?? []).filter(i => i.type === 'gsc').map(i => ({
      source: 'Imported Search Console dataset: ' + (i.source?.filename ?? i.provenance?.filename ?? i.source?.file ?? 'supplied file'),
      range: i.range, rows: i.rows ?? []
    }))
  ];
  const overlaps = groupFinding('query-page-overlap', 'Queries appear across multiple landing pages', {
    recommendation: 'Review the overlapping pages against the same query intent, country, device and date range. Check landing-page switching and outcomes before choosing differentiation, internal linking or consolidation. Multiple results can be healthy.',
    acceptance: ['Document the intended landing page and purpose of each overlapping URL.', 'Validate the chosen action with matched query/page history; do not merge pages from overlap alone.'],
    dependencies: ['Intent review and query-to-page time-series evidence.']
  });
  for (const dataset of datasets) {
    const queries = new Map();
    for (const row of dataset.rows) {
      if (!row.query || !row.page || !(Number(row.impressions) > 0)) continue;
      const dimensions = [row.query, row.country ?? '', row.device ?? ''].join('|');
      const group = queries.get(dimensions) ?? [];
      group.push(row); queries.set(dimensions, group);
    }
    for (const rows of queries.values()) {
      const pages = unique(rows.map(r => r.page));
      if (pages.length < 2) continue;
      overlaps.affectedUrls.push(...pages);
      overlaps.evidence.push({ url: pages[0], source: dataset.source, observed: rows[0].query + ': ' + pages.join(', '),
        expected: 'An intentional relationship between query intent and landing pages.',
        detail: 'Dataset period: ' + JSON.stringify(dataset.range ?? 'not supplied') + '. Candidate overlap only; different datasets/markets are not merged to establish overlap.' });
    }
  }
  if (overlaps.evidence.length) { overlaps.affectedUrls = unique(overlaps.affectedUrls); findings.push(overlaps); }
  const mismatch = groupFinding('google-canonical-mismatch', 'Google-selected canonical differs from the declared canonical', {
    category: 'indexing', kind: 'issue', confidence: 'high', severity: 'high', priority: 'p1', owner: 'SEO and web engineering',
    recommendation: 'Review the inspected URL and Google-selected target against the intended canonical convention. Align redirects, internal links, sitemaps and equivalent content where appropriate; preserve intentional alternatives.',
    acceptance: ['Verify the intended live canonical and related signals.', 'After recrawling, inspect selected canonicals again. Google selection is not guaranteed.']
  });
  for (const inspection of audit.gsc?.inspections ?? []) {
    const item = inspection.inspectionResult ?? inspection.result?.inspectionResult ?? inspection.result ?? inspection;
    const status = item.indexStatusResult;
    if (status?.googleCanonical && status?.userCanonical && status.googleCanonical !== status.userCanonical) {
      const url = inspection.url ?? inspection.inspectionUrl ?? status.userCanonical;
      mismatch.affectedUrls.push(url);
      mismatch.evidence.push({ url, source: 'Search Console URL Inspection indexed version', observed: 'Google: ' + status.googleCanonical,
        expected: 'Declared: ' + status.userCanonical, detail: 'Indexed-version observation, last crawled ' + (status.lastCrawlTime ?? 'unknown') + '. A different selection may be intentional.' });
    }
  }
  if (mismatch.evidence.length) { mismatch.affectedUrls = unique(mismatch.affectedUrls); findings.push(mismatch); }
  const broken = groupFinding('backlink-destination-broken', 'Imported backlinks point to broken audited destinations', {
    category: 'off-page', kind: 'issue', confidence: 'high', severity: 'high', priority: 'p1',
    recommendation: 'Check whether each linked destination has a relevant replacement. Restore the resource or create a justified redirect; otherwise request a source correction. Avoid unrelated bulk redirects.',
    acceptance: ['Confirm each affected destination resolves to useful, relevant content with the intended status.', 'Verify imported backlink sources individually before outreach.']
  });
  const pageByUrl = new Map(audit.pages.map(p => [p.url, p]));
  for (const row of (audit.imports ?? []).filter(i => i.type === 'backlinks').flatMap(i => i.rows ?? [])) {
    const target = row.target ?? row.targetUrl ?? row.target_url ?? row.destination ?? row.page;
    const page = pageByUrl.get(target);
    if (!page || page.status < 400) continue;
    broken.affectedUrls.push(target);
    broken.evidence.push({ url: target, source: 'Imported backlink sample + current HTTP crawl', observed: 'HTTP ' + page.status,
      expected: 'A useful linked destination or justified replacement.', detail: 'Source: ' + (row.source ?? row.sourceUrl ?? row.source_url ?? 'not supplied') });
  }
  if (broken.evidence.length) { broken.affectedUrls = unique(broken.affectedUrls); findings.push(broken); }
  return findings;
}
export function prioritise(findings, { importantUrls = [], gscRows = [] } = {}) {
  const traffic = new Map();
  const observedRows = new Set();
  for (const row of gscRows) if (row.page) {
    const rowKey = JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
    if (observedRows.has(rowKey)) continue;
    observedRows.add(rowKey);
    const item = traffic.get(row.page) ?? { clicks: 0, impressions: 0 };
    item.clicks += Number(row.clicks) || 0; item.impressions += Number(row.impressions) || 0; traffic.set(row.page, item);
  }
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  for (const finding of findings) {
    finding.affectedUrls = unique(finding.affectedUrls ?? []);
    finding.evidence ??= [];
    finding.acceptance ??= [];
    finding.dependencies ??= [];
    finding.priority ??= ({ critical: 'p0', high: 'p1', medium: 'p2', low: 'p3', info: 'p3' })[finding.severity] ?? 'p2';
    const important = finding.affectedUrls.filter(url => importantUrls.some(prefix => url === prefix || url.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')));
    const observed = finding.affectedUrls.filter(url => traffic.has(url));
    finding.impact = { importantUrls: important, sourceAvailable: observed.length > 0,
      observedClicks: !observed.length ? null : observed.reduce((sum, url) => sum + (traffic.get(url)?.clicks ?? 0), 0),
      observedImpressions: !observed.length ? null : observed.reduce((sum, url) => sum + (traffic.get(url)?.impressions ?? 0), 0),
      detail: 'Observed query/page rows only; incomplete datasets and overlapping findings must not be summed into revenue forecasts.' };
    finding.priorityReason = 'Severity ' + finding.severity + ', ' + finding.affectedUrls.length + ' affected audited URL(s), confidence ' + finding.confidence +
      (important.length ? ', includes ' + important.length + ' user-designated important URL(s).' : '.');
    if (important.length && finding.priority === 'p2' && finding.confidence === 'high') finding.priority = 'p1';
  }
  return findings.sort((a, b) => (order[a.priority] - order[b.priority]) || (b.impact.observedClicks - a.impact.observedClicks) || b.affectedUrls.length - a.affectedUrls.length);
}
export function validateAnalysis(value, audit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Analysis must be a JSON object.');
  const allowed = ['executiveSummary', 'businessContext', 'contentActions', 'strategicActions', 'evidenceLimitations'];
  const result = Object.fromEntries(allowed.filter(key => key in value).map(key => [key, value[key]]));
  if (result.executiveSummary !== undefined && typeof result.executiveSummary !== 'string') throw new Error('executiveSummary must be text.');
  const known = new Set((audit.findings ?? []).flatMap(f => [f.id, f.checkId]).filter(Boolean));
  const pageUrls = new Set((audit.pages ?? []).flatMap(p => [p.url, p.finalUrl]).filter(Boolean));
  const externalReferences = new Set();
  let internalReferences = 0;
  for (const field of ['contentActions', 'strategicActions']) {
    if (result[field] !== undefined && !Array.isArray(result[field])) throw new Error(field + ' must be an array.');
    for (const action of result[field] ?? []) {
      if (!action || typeof action !== 'object' || !action.action || !action.reason) throw new Error(field + ' entries require action and reason.');
      if (!Array.isArray(action.evidence) || !action.evidence.length || action.evidence.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error(field + ' entries require an array of evidence references (URLs, finding IDs or source records).');
      for (const ref of action.evidence) {
        if (known.has(ref) || pageUrls.has(ref) || /^audit\.json#(?:coverage|pages|findings|robots|sitemaps|performance|gsc|imports|capabilities)/.test(ref)) { internalReferences++; continue; }
        try {
          const source = new URL(ref);
          if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) throw new Error();
          externalReferences.add(source.href);
        } catch { throw new Error('Unresolved analysis evidence reference: ' + ref); }
      }
    }
  }
  if (result.evidenceLimitations !== undefined && (!Array.isArray(result.evidenceLimitations) || result.evidenceLimitations.some(item => typeof item !== 'string'))) throw new Error('evidenceLimitations must be an array of text.');
  result.evidenceValidation = { internalReferences, externalReferences: [...externalReferences] };
  if (externalReferences.size) result.evidenceLimitations = [...(result.evidenceLimitations ?? []), 'External source URLs are recorded for review; their contents are not independently verified by the CLI.'];
  result.runId = audit.runId;
  return result;
}
