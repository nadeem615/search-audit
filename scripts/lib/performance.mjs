import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function findBrowser(preferred) {
  const candidates = [preferred, process.env.CHROME_PATH,
    process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.platform === 'win32' && 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  try { candidates.push((await import('playwright')).chromium.executablePath()); } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

const median = values => {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};

export function summariseLighthouse(lhr, { url, device, run, evidenceFile } = {}) {
  const metrics = {};
  for (const [label, id] of Object.entries({
    lcp: 'largest-contentful-paint', cls: 'cumulative-layout-shift',
    tbt: 'total-blocking-time', fcp: 'first-contentful-paint', speedIndex: 'speed-index'
  })) metrics[label] = lhr.audits?.[id]?.numericValue ?? null;
  const diagnostics = Object.entries(lhr.audits ?? {})
    .filter(([, audit]) => audit.score !== null && audit.score < 1 &&
      !['notApplicable', 'manual', 'informative', 'error'].includes(audit.scoreDisplayMode))
    .map(([id, audit]) => ({
      id, title: audit.title, description: audit.description,
      displayValue: audit.displayValue, score: audit.score,
      estimatedSavingsMs: audit.details?.overallSavingsMs ?? null,
      estimatedSavingsBytes: audit.details?.overallSavingsBytes ?? null,
      items: (audit.details?.items ?? []).slice(0, 5).map(item => ({
        url: item.url, wastedMs: item.wastedMs, wastedBytes: item.wastedBytes,
        node: item.node?.snippet, label: item.label
      }))
    }));
  return {
    url: url ?? lhr.requestedUrl, finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    device, run, measuredAt: lhr.fetchTime, lighthouseVersion: lhr.lighthouseVersion,
    metrics, scores: Object.fromEntries(Object.entries(lhr.categories ?? {}).map(([key, c]) => [key, c.score === null ? null : Math.round(c.score * 100)])),
    diagnostics, evidenceFile, environment: lhr.environment,
    warnings: lhr.runWarnings ?? [], runtimeError: lhr.runtimeError ?? null
  };
}

export function performanceFindings(performance) {
  const findings = [];
  const grouped = new Map();
  for (const summary of performance.summaries ?? []) {
    const checks = [
      ['lab-lcp', 'Slow largest contentful paint in laboratory tests', summary.metrics?.lcp, 2500, 'ms', 'Inspect the LCP element and critical request chain. Fix the measured server, image, font or render-blocking cause; repeat the same lab test.'],
      ['lab-cls', 'Layout instability in laboratory tests', summary.metrics?.cls, 0.1, '', 'Reserve space for media and embeds and stabilise font loading and injected content; confirm with a browser trace.'],
      ['lab-tbt', 'Main-thread blocking in laboratory tests', summary.metrics?.tbt, 200, 'ms', 'Use the attached Lighthouse diagnostics to reduce expensive JavaScript and long main-thread tasks. TBT is a lab diagnostic, not a measurement of field INP.']
    ];
    for (const [id, title, value, threshold, unit, recommendation] of checks) {
      if (!Number.isFinite(value) || value <= threshold) continue;
      const group = grouped.get(id) ?? {
        id, checkId: id, title, category: 'performance', severity: 'medium',
        kind: 'issue', confidence: 'high', affectedUrls: [], evidence: [],
        recommendation, owner: 'Web engineering', effort: 'medium', priority: 'p2',
        dependencies: ['Reproduce under the recorded device, browser and throttling conditions.'],
        acceptance: ['Repeat the same measurement configuration and verify the affected metric improves without regressions.', 'Evaluate real-user field evidence separately when available.']
      };
      group.affectedUrls.push(summary.url);
      group.evidence.push({ url: summary.url, source: 'Local Lighthouse', observed: summary.device + ' median ' + value + unit, expected: 'Diagnostic target at or below ' + threshold + unit, detail: 'Based on ' + summary.runs + ' completed run(s); field Core Web Vitals are assessed separately.' });
      grouped.set(id, group);
    }
  }
  for (const finding of grouped.values()) {
    finding.affectedUrls = [...new Set(finding.affectedUrls)];
    findings.push(finding);
  }
  return findings;
}

export async function runPerformance(urls, { limit = 3, devices = ['mobile'], runs = 1, browserExecutable, evidenceDir, onProgress = () => {} } = {}) {
  const result = { status: 'not_assessed', results: [], summaries: [], errors: [], limitations: [
    'Laboratory measurements describe this machine and recorded simulation settings; they do not establish field Core Web Vitals.',
    'Only the selected URL sample is performance-tested. TBT is not field INP.'
  ] };
  if (!limit) return result;
  const executable = await findBrowser(browserExecutable);
  if (!executable) return { ...result, status: 'unavailable', errors: ['Chrome/Chromium not found. Install Chrome or set CHROME_PATH.'] };
  let lighthouse, chromeLauncher, desktopConfig;
  try { lighthouse = (await import('lighthouse')).default; chromeLauncher = await import('chrome-launcher'); desktopConfig = (await import('lighthouse/core/config/desktop-config.js')).default; }
  catch { return { ...result, status: 'unavailable', errors: ['Dependencies missing. Run npm ci in the skill directory.'] }; }
  const selected = [...new Set(urls)].slice(0, limit);
  for (const url of selected) {
    for (const device of devices) {
      const completed = [];
      for (let run = 1; run <= runs; run++) {
        let chrome;
        try {
          onProgress({ phase: 'lighthouse', url, device, run, runs });
          chrome = await chromeLauncher.launch({ chromePath: executable, chromeFlags: ['--headless', '--disable-gpu', '--no-first-run'], handleSIGINT: false });
          const flags = { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'], maxWaitForLoad: 45000 };
          const desktop = device === 'desktop' ? desktopConfig : undefined;
          const output = await lighthouse(url, flags, desktop);
          if (!output?.lhr || output.lhr.runtimeError) throw new Error(output?.lhr?.runtimeError?.message ?? 'Lighthouse did not return a result.');
          let evidenceFile;
          if (evidenceDir) {
            await mkdir(evidenceDir, { recursive: true });
            const name = createHash('sha256').update(url).digest('hex').slice(0, 12) + '-' + device + '-' + run + '.json';
            await writeFile(path.join(evidenceDir, name), JSON.stringify(output.lhr, null, 2));
            evidenceFile = 'evidence/lighthouse/' + name;
          }
          const summary = summariseLighthouse(output.lhr, { url, device, run, evidenceFile });
          result.results.push(summary); completed.push(summary);
        } catch (error) { result.errors.push({ url, device, run, message: error.message }); }
        finally { if (chrome) { try { await chrome.kill(); } catch {} } }
      }
      if (completed.length) {
        result.summaries.push({
          url, device, runs: completed.length,
          metrics: Object.fromEntries(['lcp', 'cls', 'tbt', 'fcp', 'speedIndex'].map(key => [key, median(completed.map(r => r.metrics[key]))])),
          performanceScore: median(completed.map(r => r.scores.performance)),
          evidenceFiles: completed.map(r => r.evidenceFile).filter(Boolean)
        });
      }
    }
  }
  result.status = result.results.length ? 'sampled' : 'unavailable';
  return result;
}

export async function collectCrux(target, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) return { status: 'not_assessed', records: [], limitations: ['Set CRUX_API_KEY to enable optional real-user field data. No field result is treated as a pass.'] };
  const records = [], errors = [];
  for (const formFactor of ['PHONE', 'DESKTOP']) {
    for (const granularity of ['url', 'origin']) {
      try {
        const response = await fetchImpl('https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=' + encodeURIComponent(apiKey), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [granularity]: granularity === 'url' ? target : new URL(target).origin, formFactor,
            metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'] }),
          signal: AbortSignal.timeout(20000)
        });
        if (response.status === 404) continue;
        if (!response.ok) { errors.push(formFactor + ': CrUX HTTP ' + response.status); break; }
        const body = await response.json();
        records.push({ granularity, formFactor, record: body.record, urlNormalizationDetails: body.urlNormalizationDetails });
        break;
      } catch { errors.push(formFactor + ': CrUX request failed. Check connectivity and API configuration.'); break; }
    }
  }
  return { status: records.length ? 'sampled' : 'unavailable', records, errors, limitations: [
    'CrUX coverage is limited to eligible pages/origins with sufficient samples.',
    'Origin-level fallback aggregates the origin and does not establish the experience of the audited page or subsection.'
  ] };
}
