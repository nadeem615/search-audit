import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { containsUrl } from './gsc.mjs';
import { isIP } from 'node:net';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 200000;
const ALIASES = {
  query: ['query', 'queries', 'topqueries', 'searchquery', 'keyword'],
  page: ['page', 'pages', 'toppages', 'landingpage', 'landingpageurl', 'url'],
  clicks: ['clicks', 'totalclicks'],
  impressions: ['impressions', 'totalimpressions'],
  ctr: ['ctr', 'clickthroughrate'],
  position: ['position', 'averageposition', 'avgposition'],
  date: ['date', 'day'],
  sourceUrl: ['sourceurl', 'sourcepage', 'referringpage', 'referringpageurl', 'referrer', 'linkingpage', 'from'],
  targetUrl: ['targeturl', 'targetpage', 'destinationurl', 'destination', 'to'],
  anchor: ['anchor', 'anchortext', 'linktext'],
  rel: ['rel', 'linkrel', 'linktype'],
  engine: ['engine', 'platform', 'assistant', 'model'],
  prompt: ['prompt', 'question', 'query'],
  citedUrl: ['citedurl', 'citationurl', 'targeturl', 'url', 'page'],
  observedAt: ['observedat', 'timestamp', 'date', 'checkedat'],
  response: ['response', 'answer', 'excerpt'],
  locale: ['locale', 'country', 'market'],
  citationPresent: ['citationpresent', 'cited', 'iscited'],
  status: ['status', 'statuscode', 'httpstatus', 'responsestatus'],
  userAgent: ['useragent', 'ua', 'httpuseragent'],
  ip: ['ip', 'clientip', 'remoteaddr', 'remoteaddress'],
  method: ['method', 'requestmethod']
};

function key(value) { return String(value).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function get(row, field) {
  const lookup = new Map(Object.entries(row).map(([name, value]) => [key(name), value]));
  for (const alias of ALIASES[field] || [key(field)]) if (lookup.has(alias)) return lookup.get(alias);
  return undefined;
}
function present(value) { return value !== undefined && value !== null && String(value).trim() !== ''; }
function text(value) { return present(value) ? String(value).trim() : undefined; }
function url(value) {
  if (!present(value)) return undefined;
  try {
    const parsed = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.hash = ''; return parsed.href;
  } catch { return undefined; }
}
function number(value, { percentage = false } = {}) {
  if (!present(value)) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  const trimmed = String(value).trim();
  const percent = trimmed.endsWith('%');
  if (percent && !percentage) return undefined;
  const cleaned = trimmed.replace(/,/g, '').replace(/%$/, '');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return undefined;
  const result = Number(cleaned) / (percent ? 100 : 1);
  return Number.isFinite(result) && result >= 0 && (!percentage || result <= 1) ? result : undefined;
}
function validDate(value) {
  if (!present(value)) return undefined;
  const result = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) return undefined;
  const date = new Date(result + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : undefined;
}

/** RFC 4180-style CSV/TSV parser; quoted delimiters/newlines and escaped quotes work. */
export function parseDelimited(input, { delimiter } = {}) {
  const source = String(input).replace(/^\uFEFF/, '');
  if (!delimiter) {
    let quoted = false; let commas = 0; let tabs = 0;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === '"') { if (quoted && source[index + 1] === '"') index++; else quoted = !quoted; }
      else if (!quoted && (char === '\n' || char === '\r')) break;
      else if (!quoted && char === ',') commas++;
      else if (!quoted && char === '\t') tabs++;
    }
    delimiter = tabs > commas ? '\t' : ',';
  }
  if (![',', '\t', ';'].includes(delimiter)) throw new Error('CSV delimiter must be a comma, tab, or semicolon.');
  const records = []; let record = []; let cell = ''; let quoted = false; let afterQuote = false;
  const endCell = () => { record.push(cell); cell = ''; afterQuote = false; };
  const endRecord = () => { endCell(); if (record.some(value => value !== '')) records.push(record); record = []; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (char === delimiter) endCell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[index + 1] === '\n') index++; endRecord(); }
    else if (char === '"') {
      if (cell.length || afterQuote) throw new Error('Malformed CSV: quote inside an unquoted field.');
      quoted = true;
    } else {
      if (afterQuote) {
        if (char === ' ' || char === '\t') continue;
        throw new Error('Malformed CSV: unexpected characters after a closing quote.');
      }
      cell += char;
    }
  }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted field.');
  if (cell.length || record.length || afterQuote) endRecord();
  if (!records.length) return [];
  const headers = records.shift().map(name => name.trim());
  if (headers.some(name => !name) || new Set(headers.map(key)).size !== headers.length) throw new Error('CSV must have unique, non-empty column names.');
  return records.map((values, index) => {
    if (values.length !== headers.length) throw new Error('CSV row ' + (index + 2) + ' has ' + values.length + ' columns; expected ' + headers.length + '.');
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

function normalizeType(type, rows) {
  const requested = String(type || '').toLowerCase();
  if (['gsc', 'search-console', 'searchconsole', 'queries'].includes(requested)) return 'gsc';
  if (['backlinks', 'backlink', 'links'].includes(requested)) return 'backlinks';
  if (['logs', 'log', 'server-logs'].includes(requested)) return 'logs';
  if (['citations', 'citation', 'ai', 'ai-visibility'].includes(requested)) return 'citations';
  if (requested && requested !== 'auto') throw new Error('Import type must be gsc, backlinks, citations, logs, or auto.');
  const first = rows[0] || {};
  if (present(get(first, 'status')) && present(get(first, 'page'))) return 'logs';
  if (present(get(first, 'sourceUrl')) && present(get(first, 'targetUrl'))) return 'backlinks';
  if (present(get(first, 'engine')) || present(get(first, 'citedUrl')) && present(get(first, 'prompt')) && !present(get(first, 'impressions'))) return 'citations';
  if (present(get(first, 'query')) || present(get(first, 'page')) || Array.isArray(first.keys)) return 'gsc';
  throw new Error('Cannot infer this dataset. Specify --type and provide supported column names.');
}

function normalizeGsc(row, dimensions) {
  const expanded = { ...row };
  if (Array.isArray(row.keys) && Array.isArray(dimensions)) dimensions.forEach((dimension, index) => { expanded[dimension] = row.keys[index]; });
  const result = {
    query: text(get(expanded, 'query')), page: url(get(expanded, 'page')), date: validDate(get(expanded, 'date')),
    clicks: number(get(expanded, 'clicks')), impressions: number(get(expanded, 'impressions')),
    ctr: number(get(expanded, 'ctr'), { percentage: true }), position: number(get(expanded, 'position'))
  };
  if (!result.query && !result.page) return null;
  if (present(get(expanded, 'page')) && !result.page) return null;
  if (present(get(expanded, 'date')) && !result.date) return null;
  for (const metric of ['clicks', 'impressions', 'ctr', 'position']) if (present(get(expanded, metric)) && result[metric] === undefined) return null;
  if (result.ctr === undefined && result.clicks !== undefined && result.impressions > 0) result.ctr = result.clicks / result.impressions;
  if (result.ctr > 1) return null;
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

function normalizeBacklink(row) {
  const sourceUrl = url(get(row, 'sourceUrl')); const targetUrl = url(get(row, 'targetUrl'));
  if (!sourceUrl || !targetUrl) return null;
  return { sourceUrl, targetUrl, anchor: text(get(row, 'anchor')), rel: text(get(row, 'rel')) };
}

function normalizeCitation(row) {
  const engine = text(get(row, 'engine')); const prompt = text(get(row, 'prompt'));
  const citedUrl = url(get(row, 'citedUrl')); const sourceUrl = url(get(row, 'sourceUrl'));
  const observedAt = text(get(row, 'observedAt')); const suppliedPresent = get(row, 'citationPresent');
  if (!engine || !prompt || !observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
  if (present(get(row, 'citedUrl')) && !citedUrl) return null;
  const citationPresent = present(suppliedPresent) ? /^(true|yes|1)$/i.test(String(suppliedPresent).trim()) : Boolean(citedUrl);
  if (present(suppliedPresent) && !/^(true|false|yes|no|1|0)$/i.test(String(suppliedPresent).trim())) return null;
  if (citationPresent && !citedUrl) return null;
  return {
    engine, prompt, citedUrl, sourceUrl, citationPresent,
    observedAt: new Date(observedAt).toISOString(), response: text(get(row, 'response')), locale: text(get(row, 'locale'))
  };
}

function normalizeLog(row, target) {
  const rawUrl = text(get(row, 'page'));
  let observedUrl = url(rawUrl);
  if (!observedUrl && rawUrl?.startsWith('/') && target && !target.startsWith('sc-domain:')) {
    try { observedUrl = url(new URL(rawUrl, target).href); } catch { /* Invalid relative request URL. */ }
  }
  const status = number(get(row, 'status'));
  const observedAt = text(get(row, 'observedAt'));
  if (!observedUrl || !Number.isInteger(status) || status < 100 || status > 599 ||
      !observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
  const rawIp = text(get(row, 'ip'));
  return {
    url: observedUrl, status, userAgent: text(get(row, 'userAgent')),
    ip: rawIp && isIP(rawIp) ? rawIp : undefined, method: text(get(row, 'method')),
    observedAt: new Date(observedAt).toISOString(), botVerification: 'not_verified'
  };
}
/** Import local evidence without connecting an account; no relationship is inferred across rows. */
export async function importDataset(file, options = {}) {
  const { target, maxBytes = MAX_BYTES, maxRows = MAX_ROWS } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxRows) || maxRows < 1) throw new Error('Import byte and row limits must be positive integers.');
  const probe = target?.startsWith('sc-domain:') ? 'https://' + target.slice(10) + '/' : target;
  if (target && !containsUrl(target, probe)) throw new Error('Import target must be a valid HTTP(S) URL or sc-domain property.');
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Import source must be a regular file.');
  if (info.size > maxBytes) throw new Error('Import exceeds the configured ' + maxBytes + '-byte size limit.');
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throw new Error('Import exceeds the configured byte limit.');
  const input = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let document = {}; let rawRows;
  if (extname(file).toLowerCase() === '.json' || /^[\s]*[\[{]/.test(input)) {
    try { document = JSON.parse(input); } catch { throw new Error('Import source is not valid JSON.'); }
    rawRows = Array.isArray(document) ? document : document.rows || document.data;
    if (!Array.isArray(rawRows)) throw new Error('JSON must be an array or an object containing rows: [...].');
  } else rawRows = parseDelimited(input, { delimiter: options.delimiter });
  if (rawRows.length > maxRows) throw new Error('Import exceeds the configured ' + maxRows + '-row limit. Split the dataset or increase the limit explicitly.');
  if (rawRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Each import row must be an object.');
  const type = normalizeType(options.type || document.type, rawRows);
  const dimensions = options.dimensions || document.dimensions || document.source?.dimensions;
  const rows = []; let invalidRows = 0; let excludedRows = 0; let unscopedRows = 0;
  for (const rawRow of rawRows) {
    const row = type === 'gsc' ? normalizeGsc(rawRow, dimensions) : type === 'backlinks' ? normalizeBacklink(rawRow) : type === 'logs' ? normalizeLog(rawRow, target) : normalizeCitation(rawRow);
    if (!row) { invalidRows++; continue; }
    const scopedUrl = type === 'gsc' ? row.page : type === 'backlinks' ? row.targetUrl : type === 'logs' ? row.url : row.citedUrl;
    if (target && scopedUrl && !containsUrl(target, scopedUrl)) { excludedRows++; continue; }
    if (target && !scopedUrl) unscopedRows++;
    rows.push(row);
  }
  const requestedStart = options.startDate || options.range?.startDate || document.range?.startDate;
  const requestedEnd = options.endDate || options.range?.endDate || document.range?.endDate;
  if ((requestedStart && !validDate(requestedStart)) || (requestedEnd && !validDate(requestedEnd))) throw new Error('Import range dates must use valid YYYY-MM-DD values.');
  if (requestedStart && requestedEnd && requestedStart > requestedEnd) throw new Error('Import startDate must be on or before endDate.');
  const limitations = [
    'Imported evidence is user-supplied and has not been independently revalidated.',
    'Export filters, provider omissions, and row limits can restrict coverage; this import is not a complete inventory.'
  ];
  if (invalidRows) limitations.push(invalidRows + ' malformed or incomplete rows were excluded.');
  if (excludedRows) limitations.push(excludedRows + ' rows outside the target URL scope were excluded.');
  if (unscopedRows) limitations.push(unscopedRows + ' rows have no page/citation URL, so their association with this target could not be verified.');
  if (!requestedStart || !requestedEnd) limitations.push('A complete source date range was not supplied.');
  if (type === 'gsc' && !rows.some(row => row.query && row.page)) limitations.push('No linked query/page records: cannibalization cannot be confirmed from separate query or page summaries.');
  if (type === 'gsc' && rawRows.some(row => Array.isArray(row.keys)) && !Array.isArray(dimensions)) limitations.push('API row keys without declared dimensions were not interpreted; supply dimensions to preserve query/page linkage.');
  if (type === 'citations') limitations.push('Citation observations apply only to their recorded prompts, engines, locale, and dates; absence is not proof of global AI invisibility.');
  if (type === 'logs') limitations.push('User-agent strings alone do not verify crawler identity. Imported IPs have not been checked using forward/reverse DNS or published IP ranges.');
  if (type === 'backlinks') limitations.push('Backlink imports do not establish the complete backlink profile and do not justify automated disavowal.');
  if (Array.isArray(document.limitations)) limitations.push(...document.limitations.filter(value => typeof value === 'string'));
  return {
    type, status: rows.length ? 'imported' : 'empty', target,
    source: { type: 'file-import', file: basename(file), sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: new Date().toISOString(), provider: options.provider || document.source?.provider || 'user-supplied', dimensions },
    range: { startDate: requestedStart || null, endDate: requestedEnd || null, timezone: options.timezone || document.range?.timezone || (type === 'gsc' ? 'America/Los_Angeles' : 'unspecified') },
    rows, coverage: { suppliedRows: rawRows.length, retainedRows: rows.length, invalidRows, excludedRows, unscopedRows }, limitations
  };
}
