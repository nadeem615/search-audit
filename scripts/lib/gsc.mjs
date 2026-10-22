import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { saveCredential, loadCredential, deleteCredential, listCredentialProfiles, validateProfile } from './credentials.mjs';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const DEFAULT_LIMITS = [
  'Search Analytics exposes top rows, omits anonymized queries, and does not guarantee a complete query/page dataset.',
  'Dates use Search Console Pacific time (America/Los_Angeles), not the audit machine time zone.',
  'URL Inspection reports Google’s indexed version; it is not a live indexing test or an indexing request.'
];

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('An HTTP(S) URL without embedded credentials is required.');
  return url;
}

/** Whether a Search Console Domain or URL-prefix property contains a URL. */
export function containsUrl(property, value) {
  try {
    const url = httpUrl(value);
    if (typeof property !== 'string') return false;
    if (property.startsWith('sc-domain:')) {
      const raw = property.slice(10);
      if (!raw || /[/?#:@\s]/.test(raw)) return false;
      const domain = new URL('https://' + raw).hostname.toLowerCase().replace(/\.$/, '');
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      return host === domain || host.endsWith('.' + domain);
    }
    const prefix = httpUrl(property);
    if (prefix.search || prefix.hash || prefix.origin !== url.origin) return false;
    return url.pathname.startsWith(prefix.pathname);
  } catch { return false; }
}

export function propertyMatchesTarget(property, target) { return containsUrl(property, target); }

function sameState(actual, expected) {
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual); const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Standalone loopback session exported for security and timeout tests. */
export async function createAuthorizationSession({ timeoutMs = 180000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('OAuth timeout must be between 1 and 600000 ms.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let resolveCode; let rejectCode; let timer; let settled = false;
  const result = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  result.catch(() => {});
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' || !req.url || req.url.length > 16384) { res.writeHead(400); res.end('Invalid request.'); return; }
    if (settled) { res.writeHead(409); res.end('Authorization already completed.'); return; }
    const expectedHost = '127.0.0.1:' + server.address().port;
    if (req.headers.host !== expectedHost) { res.writeHead(400); res.end('Invalid host.'); return; }
    const callback = new URL(req.url, 'http://' + expectedHost);
    if (callback.pathname !== '/oauth/callback') { res.writeHead(404); res.end('Not found.'); return; }
    if (callback.searchParams.getAll('state').length !== 1 || !sameState(callback.searchParams.get('state'), state)) {
      res.writeHead(400); res.end('Invalid OAuth state. Return to the audit command.'); return;
    }
    if (settled) { res.writeHead(409); res.end('Authorization already completed.'); return; }
    const code = callback.searchParams.get('code');
    if (callback.searchParams.has('error')) {
      res.writeHead(400); res.end('Authorization was declined. Return to the audit command.');
      finish(new Error('Google authorization was declined. The public audit and file imports remain available.'));
    } else if (!code || callback.searchParams.getAll('code').length !== 1) {
      res.writeHead(400); res.end('Missing authorization code.');
    } else {
      res.end('Search Audit authorization received. You can close this tab and return to the audit command.');
      finish(null, code);
    }
  });
  const finish = (error, code) => {
    if (settled) return;
    settled = true; clearTimeout(timer); server.close();
    error ? rejectCode(error) : resolveCode(code);
  };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.on('error', err => finish(new Error('OAuth loopback listener failed: ' + err.code)));
  timer = setTimeout(() => finish(new Error('Google authorization timed out. Retry auth connect, or use a file import.')), timeoutMs);
  return { state, verifier, challenge, result, redirectUri: 'http://127.0.0.1:' + server.address().port + '/oauth/callback', cancel: () => finish(new Error('Google authorization cancelled.')) };
}

function openBrowser(url) {
  const commands = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['/usr/bin/open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(commands[0], commands[1], { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Browser did not open.')));
  });
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000) });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Google returned a non-JSON response (HTTP ' + response.status + ').'); }
  if (!response.ok) {
    const error = new Error('Google request failed (HTTP ' + response.status + '). Check account permissions, API enablement, quotas, and authorization.');
    error.status = response.status; throw error;
  }
  return payload;
}
function storeAdapter(options) { return options.credentialStore || { save: saveCredential, load: loadCredential, remove: deleteCredential, list: listCredentialProfiles }; }

export async function authConnect(options = {}) {
  const { profile = 'default', clientFile, dataDir, noOpen = false, timeoutMs = 180000, fetchImpl = globalThis.fetch } = options;
  validateProfile(profile);
  if (!clientFile) throw new Error('Provide a Google Desktop app OAuth client JSON file with --client.');
  if (!dataDir) throw new Error('A local dataDir is required.');
  let parsed;
  try { parsed = JSON.parse((await readFile(clientFile, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new Error('OAuth client file must be readable JSON.'); }
  const client = parsed.installed;
  if (!client || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com')) throw new Error('Use a Google OAuth client of type Desktop app (the JSON must contain installed.client_id).');
  if ((client.auth_uri && client.auth_uri !== AUTHORIZE_URL && client.auth_uri !== 'https://accounts.google.com/o/oauth2/auth') || (client.token_uri && client.token_uri !== TOKEN_URL)) throw new Error('OAuth client contains unexpected endpoints. Download the client JSON directly from Google Cloud.');
  const session = await createAuthorizationSession({ timeoutMs });
  const authorize = new URL(AUTHORIZE_URL);
  for (const [key, value] of Object.entries({
    client_id: client.client_id, redirect_uri: session.redirectUri, response_type: 'code', scope: GSC_SCOPE, access_type: 'offline', prompt: 'consent select_account',
    state: session.state, code_challenge: session.challenge, code_challenge_method: 'S256'
  })) authorize.searchParams.set(key, value);
  try {
    const notify = options.onAuthorizationUrl || (url => process.stderr.write('Open this URL to connect your own Google account:\n' + url + '\n'));
    notify(authorize.href);
    if (!noOpen) await openBrowser(authorize.href).catch(() => { process.stderr.write('Automatic browser opening failed. Open the authorization URL manually.\n'); });
    const code = await session.result;
    const body = new URLSearchParams({ client_id: client.client_id, code, code_verifier: session.verifier, redirect_uri: session.redirectUri, grant_type: 'authorization_code' });
    if (client.client_secret) body.set('client_secret', client.client_secret);
    const tokens = await fetchJson(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!tokens.access_token || !tokens.refresh_token) throw new Error('Google did not issue offline credentials. Reconnect with consent, or use a file import.');
    if (tokens.scope && !tokens.scope.split(' ').includes(GSC_SCOPE)) throw new Error('Read-only Search Console access was not granted.');
    const credential = {
      clientId: client.client_id, clientSecret: client.client_secret || undefined, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, scope: GSC_SCOPE
    };
    const stored = await storeAdapter(options).save(profile, credential, { dataDir });
    return { status: 'connected', profile, backend: stored.backend, scope: GSC_SCOPE, limitations: ['Select an accessible property for each audit; profiles do not grant access to arbitrary websites.'] };
  } finally { session.cancel(); }
}

export async function authList(options = {}) { return { profiles: await storeAdapter(options).list({ dataDir: options.dataDir }) }; }

export async function authDisconnect(options = {}) {
  const { profile = 'default', dataDir, fetchImpl = globalThis.fetch } = options;
  validateProfile(profile);
  const store = storeAdapter(options); const limitations = [];
  let credential;
  try { credential = await store.load(profile, { dataDir }); } catch { /* Local removal can proceed while offline/locked. */ }
  if (credential) {
    try {
      const response = await fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credential.refreshToken || credential.accessToken }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) limitations.push('Google token revocation was not confirmed; remove the app in Google Account permissions if needed.');
    } catch { limitations.push('Offline: Google token revocation was not confirmed; remove the app in Google Account permissions if needed.'); }
  }
  return { ...await store.remove(profile, { dataDir }), limitations };
}

async function authorizedRequest(options, url, request = {}) {
  const { profile = 'default', dataDir, fetchImpl = globalThis.fetch } = options;
  const store = storeAdapter(options);
  let credential = await store.load(profile, { dataDir });
  if (credential.scope !== GSC_SCOPE) throw new Error('Profile scope is invalid. Reconnect with read-only Search Console authorization.');
  const refresh = async () => {
    const body = new URLSearchParams({ client_id: credential.clientId, refresh_token: credential.refreshToken, grant_type: 'refresh_token' });
    if (credential.clientSecret) body.set('client_secret', credential.clientSecret);
    const tokens = await fetchJson(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!tokens.access_token) throw new Error('Google refresh response contains no access token. Reconnect the profile.');
    credential = { ...credential, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || credential.refreshToken, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
    await store.save(profile, credential, { dataDir });
  };
  if (!credential.accessToken || credential.expiresAt < Date.now() + 60000) await refresh();
  const send = () => fetchJson(fetchImpl, url, { ...request, headers: { ...request.headers, Authorization: 'Bearer ' + credential.accessToken } });
  try { return await send(); } catch (err) { if (err.status !== 401) throw err; await refresh(); return send(); }
}

export async function listProperties(options = {}) {
  validateProfile(options.profile || 'default');
  const response = await authorizedRequest(options, SITES_URL);
  return (response.siteEntry || []).filter(site => site.permissionLevel !== 'siteUnverifiedUser').map(site => ({ property: site.siteUrl, siteUrl: site.siteUrl, permissionLevel: site.permissionLevel }));
}

function validateDate(value, label) {
  const date = new Date(value + 'T00:00:00Z');
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(label + ' must be a valid YYYY-MM-DD date.');
}

export function buildTargetFilter(target) {
  const url = httpUrl(target); url.search = ''; url.hash = '';
  return '^' + url.href.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

async function validatePropertyAccess(options) {
  const { property, target } = options;
  if (!propertyMatchesTarget(property, target)) throw new Error('Selected Search Console property does not contain the audit target.');
  const properties = await listProperties(options);
  if (!properties.some(item => item.property === property)) throw new Error('This profile cannot access the selected property. Select a property from auth properties.');
}

function validateInspectionOptions(options) {
  const { inspectionUrls = [], maxInspections = 20 } = options;
  if (!Array.isArray(inspectionUrls)) throw new Error('inspectionUrls must be an array of URLs.');
  if (!Number.isInteger(maxInspections) || maxInspections < 0 || maxInspections > 2000) throw new Error('maxInspections must be an integer between 0 and 2000.');
}

/** Private: caller must have validated this account's access during the same operation. */
async function inspectValidatedUrls(options) {
  const { property, target, inspectionUrls = [], maxInspections = 20 } = options;
  const limitations = [DEFAULT_LIMITS[2]];
  const inspections = [];
  const candidates = [...new Set(inspectionUrls)];
  const eligible = candidates.filter(url => containsUrl(property, url) && containsUrl(target, url));
  const excludedUrls = candidates.length - eligible.length;
  for (const url of eligible.slice(0, maxInspections)) {
    try {
      const response = await authorizedRequest(options, INSPECT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inspectionUrl: url, siteUrl: property, languageCode: 'en-US' }) });
      inspections.push({ url, status: 'observed', observedAt: new Date().toISOString(), ...response.inspectionResult });
    } catch (err) { inspections.push({ url, status: 'unavailable', error: err.message }); }
  }
  if (excludedUrls) limitations.push(excludedUrls + ' inspection candidates outside the audit/property scope were excluded.');
  if (eligible.length > maxInspections) limitations.push('URL Inspection used a bounded sample; uninspected URLs have unknown index status.');
  if (!inspections.length) limitations.push('No URL Inspection evidence collected; indexation status is not assessed.');
  if (inspections.length && inspections.every(item => item.status !== 'observed')) limitations.push('URL Inspection requests failed; indexation status is not assessed.');
  return {
    inspections, limitations,
    coverage: {
      requestedUrls: candidates.length, eligibleUrls: eligible.length, excludedUrls,
      attemptedUrls: inspections.length, inspectedUrls: inspections.filter(item => item.status === 'observed').length,
      truncated: eligible.length > maxInspections
    }
  };
}

/** Collect indexed-version evidence after crawling without refetching Search Analytics. */
export async function inspectGscUrls(options = {}) {
  const { profile = 'default', property, target } = options;
  validateInspectionOptions(options);
  await validatePropertyAccess(options);
  return { status: 'collected', profile, property, target, ...await inspectValidatedUrls(options) };
}

export async function collectGsc(options = {}) {
  const { profile = 'default', property, target, startDate, endDate, maxRows = 50000 } = options;
  validateDate(startDate, 'startDate'); validateDate(endDate, 'endDate');
  if (startDate > endDate) throw new Error('startDate must be on or before endDate.');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000000) throw new Error('maxRows must be an integer between 1 and 1000000.');
  validateInspectionOptions(options);
  await validatePropertyAccess(options);
  const limitations = [...DEFAULT_LIMITS]; const rows = [];
  let returnedRows = 0; let discardedRows = 0; let truncated = false;
  const endpoint = SITES_URL + '/' + encodeURIComponent(property) + '/searchAnalytics/query';
  for (let startRow = 0; startRow < maxRows;) {
    const rowLimit = Math.min(25000, maxRows - startRow);
    const payload = {
      startDate, endDate, dimensions: ['query', 'page'], type: 'web', dataState: 'final', aggregationType: 'auto', rowLimit, startRow,
      dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'includingRegex', expression: buildTargetFilter(target) }] }]
    };
    const response = await authorizedRequest(options, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const batch = response.rows || []; returnedRows += batch.length;
    for (const item of batch) {
      const [query, page] = item.keys || [];
      if (typeof query !== 'string' || !containsUrl(target, page)) { discardedRows++; continue; }
      rows.push({ query, page, clicks: item.clicks, impressions: item.impressions, ctr: item.ctr, position: item.position });
    }
    startRow += batch.length;
    if (batch.length < rowLimit) break;
    if (startRow >= maxRows) truncated = true;
  }
  if (truncated) limitations.push('Collection reached its configured row cap; additional rows may exist.');
  if (discardedRows) limitations.push(discardedRows + ' response rows were outside the target scope or lacked linked query/page dimensions and were excluded.');
  const inspection = await inspectValidatedUrls(options);
  return {
    status: 'collected', type: 'gsc', profile, property, target,
    source: { type: 'google-search-console-api', collectedAt: new Date().toISOString(), dimensions: ['query', 'page'], searchType: 'web', dataState: 'final' },
    range: { startDate, endDate, timezone: 'America/Los_Angeles' }, rows, inspections: inspection.inspections,
    coverage: { returnedRows, retainedRows: rows.length, discardedRows, rowCap: maxRows, truncated, inspectedUrls: inspection.coverage.inspectedUrls },
    limitations: [...new Set([...limitations, ...inspection.limitations])]
  };
}
