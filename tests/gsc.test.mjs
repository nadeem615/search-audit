import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { containsUrl, propertyMatchesTarget, buildTargetFilter, createAuthorizationSession, authConnect, collectGsc, inspectGscUrls, listProperties, authDisconnect, GSC_SCOPE } from '../scripts/lib/gsc.mjs';
import { validateProfile, saveCredential, loadCredential, deleteCredential, listCredentialProfiles } from '../scripts/lib/credentials.mjs';

const target = 'https://www.example.com/shop/';
const credential = () => ({ clientId: 'fixture.apps.googleusercontent.com', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000, scope: GSC_SCOPE });
function memoryStore(value = credential()) {
  return {
    value, saved: [],
    async load() { return this.value; },
    async save(profile, next) { this.saved.push({ profile, value: next }); this.value = next; return { backend: 'test-memory' }; },
    async remove(profile) { this.value = null; return { profile, disconnected: true }; },
    async list() { return [{ profile: 'fixture', backend: 'test-memory' }]; }
  };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fixture(t) {
  const directory = await mkdtemp(join(process.cwd(), 'tests', '.tmp-gsc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Domain property membership respects hostname boundaries, protocols, and child domains', () => {
  assert.equal(containsUrl('sc-domain:example.com', target), true);
  assert.equal(containsUrl('sc-domain:example.com', 'http://a.b.example.com/'), true);
  assert.equal(containsUrl('sc-domain:example.com', 'https://example.com.evil.test/'), false);
  assert.equal(containsUrl('sc-domain:example.com', 'https://notexample.com/'), false);
  assert.equal(containsUrl('sc-domain:shop.example.com', 'https://example.com/'), false);
  assert.equal(containsUrl('sc-domain:example.com', 'https://example.com@evil.test/'), false);
  assert.equal(containsUrl('sc-domain:example.com/path', target), false);
  assert.equal(containsUrl('sc-domain:bücher.example', 'https://xn--bcher-kva.example/'), true);
});

test('URL-prefix matching retains scheme, host, port, path, and case semantics', () => {
  assert.equal(propertyMatchesTarget('https://www.example.com/', target), true);
  assert.equal(containsUrl(target, target + 'item?color=red'), true);
  assert.equal(containsUrl(target, 'http://www.example.com/shop/item'), false);
  assert.equal(containsUrl(target, 'https://example.com/shop/item'), false);
  assert.equal(containsUrl(target, 'https://www.example.com:8443/shop/item'), false);
  assert.equal(containsUrl(target, 'https://www.example.com/Shop/item'), false);
  assert.equal(containsUrl(target, 'https://www.example.com/shopping/item'), false);
  assert.equal(containsUrl(target, 'javascript:alert(1)'), false);
  assert.equal(containsUrl('https://www.example.com/?x=1', target), false);
  assert.equal(new RegExp(buildTargetFilter(target)).test(target + 'item'), true);
  assert.equal(new RegExp(buildTargetFilter(target)).test('https://wwwXexample.com/shop/item'), false);
});

test('OAuth loopback rejects forged state and unrelated paths before accepting valid callback', async () => {
  const session = await createAuthorizationSession({ timeoutMs: 3000 });
  try {
    assert.equal((await fetch(session.redirectUri + '?state=forged&code=bad')).status, 400);
    assert.equal((await fetch(session.redirectUri + '?state=' + encodeURIComponent('é'.repeat(session.state.length)) + '&code=bad')).status, 400);
    assert.equal((await fetch(new URL('/unrelated', session.redirectUri))).status, 404);
    const params = new URLSearchParams({ state: session.state, code: 'accepted-code' });
    assert.equal((await fetch(session.redirectUri + '?' + params)).status, 200);
    assert.equal(await session.result, 'accepted-code');
    assert.equal(session.challenge, createHash('sha256').update(session.verifier).digest('base64url'));
  } finally { session.cancel(); }
});

test('OAuth denial and timeout fail clearly without retaining a listener', async () => {
  const denied = await createAuthorizationSession({ timeoutMs: 3000 });
  const expected = assert.rejects(denied.result, /declined/);
  await fetch(denied.redirectUri + '?' + new URLSearchParams({ state: denied.state, error: 'access_denied' }));
  await expected;
  const timed = await createAuthorizationSession({ timeoutMs: 20 });
  await assert.rejects(timed.result, /timed out/);
});

test('Desktop OAuth uses readonly scope, PKCE, per-profile storage, and no real browser or Google calls', async t => {
  const directory = await fixture(t);
  const clientFile = join(directory, 'client.json');
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'synthetic-public-client-secret' } }));
  const store = memoryStore(); let authorize;
  const result = await authConnect({
    profile: 'client-b', clientFile, dataDir: directory, noOpen: true, credentialStore: store,
    onAuthorizationUrl: value => {
      authorize = new URL(value);
      setImmediate(async () => {
        const callback = new URL(authorize.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', authorize.searchParams.get('state'));
        callback.searchParams.set('code', 'synthetic-code');
        await fetch(callback);
      });
    },
    fetchImpl: async (endpoint, request) => {
      assert.equal(endpoint, 'https://oauth2.googleapis.com/token');
      assert.equal(request.body.get('code'), 'synthetic-code');
      assert.equal(request.body.get('grant_type'), 'authorization_code');
      assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
      return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: GSC_SCOPE });
    }
  });
  assert.equal(authorize.searchParams.get('scope'), GSC_SCOPE);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(result.profile, 'client-b');
  assert.equal(store.saved[0].profile, 'client-b');
  assert.equal(result.scope, GSC_SCOPE);
  assert.equal(JSON.stringify(result).includes('synthetic-refresh'), false);
});

test('OAuth rejects web clients and substituted token endpoints before creating authorization', async t => {
  const directory = await fixture(t);
  const clientFile = join(directory, 'client.json');
  await writeFile(clientFile, JSON.stringify({ web: { client_id: 'fixture.apps.googleusercontent.com' } }));
  await assert.rejects(authConnect({ clientFile, dataDir: directory }), /Desktop/);
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', token_uri: 'https://evil.test/token' } }));
  await assert.rejects(authConnect({ clientFile, dataDir: directory }), /unexpected endpoints/);
});

test('GSC retains linked dimensions, filters broad properties to target, bounds rows and inspections', async () => {
  const requests = []; const store = memoryStore();
  const result = await collectGsc({
    profile: 'client-b', property: 'sc-domain:example.com', target, startDate: '2026-01-01', endDate: '2026-01-31',
    maxRows: 2, maxInspections: 1, inspectionUrls: [target + 'a', target + 'b', 'https://evil.test/'],
    credentialStore: store,
    fetchImpl: async (endpoint, request) => {
      requests.push({ endpoint, body: request.body && JSON.parse(request.body) });
      assert.equal(request.headers.Authorization, 'Bearer synthetic-access');
      if (endpoint.endsWith('/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
      if (endpoint.includes('searchAnalytics')) return json({ rows: [
        { keys: ['red shoes', target + 'a'], clicks: 5, impressions: 100, ctr: 0.05, position: 3 },
        { keys: ['outside', 'https://www.example.com/news/'], clicks: 3, impressions: 10, ctr: 0.3, position: 2 }
      ] });
      return json({ inspectionResult: { indexStatusResult: { verdict: 'PASS', googleCanonical: target + 'a' } } });
    }
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].query, 'red shoes');
  assert.equal(result.rows[0].page, target + 'a');
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.discardedRows, 1);
  assert.equal(result.inspections.length, 1);
  assert.equal(result.inspections[0].indexStatusResult.verdict, 'PASS');
  const search = requests.find(item => item.endpoint.includes('searchAnalytics'));
  assert.deepEqual(search.body.dimensions, ['query', 'page']);
  assert.equal(search.body.dimensionFilterGroups[0].filters[0].operator, 'includingRegex');
  assert.equal(new RegExp(search.body.dimensionFilterGroups[0].filters[0].expression).test(target + 'a'), true);
});

test('GSC validates property access, range, and scoped targets before querying private data', async () => {
  const base = { property: 'sc-domain:example.com', target, startDate: '2026-01-01', endDate: '2026-01-31', credentialStore: memoryStore() };
  await assert.rejects(collectGsc({ ...base, target: 'https://evil.test/' }), /does not contain/);
  await assert.rejects(collectGsc({ ...base, startDate: '2026-02-30' }), /valid/);
  await assert.rejects(collectGsc({ ...base, endDate: '2025-01-01' }), /on or before/);
  await assert.rejects(collectGsc({ ...base, fetchImpl: async () => json({ siteEntry: [{ siteUrl: 'sc-domain:another.test', permissionLevel: 'siteOwner' }] }) }), /cannot access/);
});

test('Expired per-profile credentials are refreshed and a permission failure is not treated as pass', async () => {
  const store = memoryStore({ ...credential(), expiresAt: 0 }); let calls = 0;
  const properties = await listProperties({
    profile: 'client-b', credentialStore: store,
    fetchImpl: async (endpoint, request) => {
      calls++;
      if (endpoint.endsWith('/token')) {
        assert.equal(request.body.get('refresh_token'), 'synthetic-refresh');
        return json({ access_token: 'synthetic-new', expires_in: 3600 });
      }
      assert.equal(request.headers.Authorization, 'Bearer synthetic-new');
      return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:unverified.test', permissionLevel: 'siteUnverifiedUser' }] });
    }
  });
  assert.equal(calls, 2);
  assert.equal(store.saved[0].profile, 'client-b');
  assert.equal(properties.length, 1);
  await assert.rejects(listProperties({ credentialStore: memoryStore(), fetchImpl: async () => json({ error: 'forbidden' }, 403) }), /HTTP 403/);
});

test('Disconnect deletes local profile even when revocation is offline', async () => {
  const store = memoryStore();
  const result = await authDisconnect({ profile: 'fixture', credentialStore: store, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.disconnected, true);
  assert.equal(store.value, null);
  assert.match(result.limitations[0], /revocation was not confirmed/);
});

test('Credential profile identifiers cannot escape their local directory', () => {
  assert.throws(() => validateProfile('../other'), /Profile/);
  assert.throws(() => validateProfile('a/b'), /Profile/);
  assert.throws(() => validateProfile(''), /Profile/);
  assert.equal(validateProfile('client-b_2026.1'), 'client-b_2026.1');
});

test('Windows DPAPI stores only ciphertext and isolates synthetic local profiles', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const value = { accessToken: 'SYNTHETIC_TEST_SECRET_NOT_A_REAL_TOKEN', refreshToken: 'synthetic' };
  await saveCredential('alpha', value, { dataDir: directory });
  await saveCredential('beta', { ...value, refreshToken: 'different-synthetic' }, { dataDir: directory });
  assert.deepEqual(await loadCredential('alpha', { dataDir: directory }), value);
  assert.equal((await loadCredential('beta', { dataDir: directory })).refreshToken, 'different-synthetic');
  for (const file of await readdir(join(directory, 'credentials'))) {
    assert.equal((await readFile(join(directory, 'credentials', file), 'utf8')).includes(value.accessToken), false);
  }
  assert.equal((await listCredentialProfiles({ dataDir: directory })).length, 2);
  await deleteCredential('alpha', { dataDir: directory });
  assert.equal((await listCredentialProfiles({ dataDir: directory })).length, 1);
  await assert.rejects(loadCredential('alpha', { dataDir: directory }), /not connected/);
});



test('Separate URL Inspection revalidates property access and never refetches Search Analytics', async () => {
  const endpoints = [];
  const result = await inspectGscUrls({
    profile: 'client-b', property: 'sc-domain:example.com', target,
    inspectionUrls: [target + 'a', target + 'a', 'https://evil.test/', target + 'b'], maxInspections: 1,
    credentialStore: memoryStore(),
    fetchImpl: async (endpoint, request) => {
      endpoints.push(endpoint);
      if (endpoint.endsWith('/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
      assert.equal(endpoint, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
      assert.equal(JSON.parse(request.body).inspectionUrl, target + 'a');
      return json({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
    }
  });
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints.filter(endpoint => endpoint.endsWith('/sites')).length, 1);
  assert.equal(result.inspections.length, 1);
  assert.equal(result.coverage.requestedUrls, 3);
  assert.equal(result.coverage.excludedUrls, 1);
  assert.equal(result.coverage.truncated, true);
  await assert.rejects(inspectGscUrls({ property: 'sc-domain:example.com', target: 'https://evil.test/', credentialStore: memoryStore() }), /does not contain/);
  await assert.rejects(inspectGscUrls({
    property: 'sc-domain:example.com', target, credentialStore: memoryStore(),
    fetchImpl: async () => json({ siteEntry: [] })
  }), /cannot access/);
});

test('Pre-crawl collection can seed query/page URLs with no inspection calls or duplicate property reads', async () => {
  const endpoints = [];
  const result = await collectGsc({
    property: 'sc-domain:example.com', target, startDate: '2026-01-01', endDate: '2026-01-31',
    maxInspections: 0, inspectionUrls: [target + 'known'], credentialStore: memoryStore(),
    fetchImpl: async endpoint => {
      endpoints.push(endpoint);
      if (endpoint.endsWith('/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
      assert.match(endpoint, /searchAnalytics/);
      return json({ rows: [{ keys: ['orphan query', target + 'orphan'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] });
    }
  });
  assert.equal(result.rows[0].page, target + 'orphan');
  assert.equal(result.inspections.length, 0);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints.filter(endpoint => endpoint.endsWith('/sites')).length, 1);
});
