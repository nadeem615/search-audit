import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const SERVICE = 'search-audit-gsc-v1';
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$entropy = [Text.Encoding]::UTF8.GetBytes('search-audit-gsc-v1')
if ($payload.operation -eq 'protect') {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$payload.value)
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))
} elseif ($payload.operation -eq 'unprotect') {
  $bytes = [Convert]::FromBase64String([string]$payload.value)
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))
} else { throw 'Invalid credential operation' }
`;

export function validateProfile(profile = 'default') {
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(profile)) {
    throw new Error('Profile must use 1–64 letters, numbers, dots, underscores, or hyphens, beginning with a letter or number.');
  }
  return profile;
}

function location(profile, dataDir) {
  validateProfile(profile);
  if (!dataDir) throw new Error('A local dataDir is required for credential storage.');
  const directory = join(resolve(dataDir), 'credentials');
  const key = createHash('sha256').update(resolve(dataDir) + '\0' + profile).digest('hex');
  return { directory, key, metadata: join(directory, profile + '.json'), protectedFile: join(directory, profile + '.dpapi') };
}

function run(command, args, input = '', { timeoutMs = 15000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = ''; let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      err ? reject(err) : resolveRun(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Secure credential store timed out. Unlock your OS keychain, or use file imports.')); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', err => finish(new Error('Secure credential store unavailable (' + (err.code || 'process error') + '). Use file imports instead.')));
    child.on('close', code => {
      // Platform programs may echo a secret-bearing command: never expose stderr.
      if (code !== 0) finish(new Error('Secure credential store failed or is locked. Unlock it and retry, or use file imports.'));
      else if (error && command === '/usr/bin/security' && /error:|usage:/i.test(error)) finish(new Error('macOS Keychain rejected credential storage. Use file imports instead.'));
      else finish(null, output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function protect(value) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', DPAPI_SCRIPT], JSON.stringify({ operation: 'protect', value }));
}
async function unprotect(value) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', DPAPI_SCRIPT], JSON.stringify({ operation: 'unprotect', value }));
}
function keychainQuote(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
}
async function readMetadata(profile, dataDir) {
  const paths = location(profile, dataDir);
  try { return { paths, metadata: JSON.parse(await readFile(paths.metadata, 'utf8')) }; }
  catch (err) {
    if (err.code === 'ENOENT') return { paths, metadata: null };
    throw new Error('Credential profile metadata is unreadable. Reconnect this profile.');
  }
}

/** Tokens are protected by the current OS user, never written as plaintext JSON. */
export async function saveCredential(profile, credential, { dataDir } = {}) {
  const paths = location(profile, dataDir);
  const value = JSON.stringify(credential);
  if (value.length > 100000) throw new Error('Credential payload is unexpectedly large.');
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  let backend;
  if (process.platform === 'win32') {
    const protectedValue = await protect(value);
    const temporary = paths.protectedFile + '.' + process.pid + '.tmp';
    await writeFile(temporary, protectedValue, { mode: 0o600 });
    await rename(temporary, paths.protectedFile);
    backend = 'windows-dpapi';
  } else if (process.platform === 'darwin') {
    // Interactive input keeps the secret out of the process argument list.
    const command = 'add-generic-password -U -s ' + keychainQuote(SERVICE) + ' -a ' + keychainQuote(paths.key) + ' -w ' + keychainQuote(value) + '\n';
    await run('/usr/bin/security', ['-i'], command);
    backend = 'macos-keychain';
    const stored = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', paths.key, '-w']);
    if (stored !== value) throw new Error('macOS Keychain did not retain the credential. Use file imports instead.');
  } else if (process.platform === 'linux') {
    await run('secret-tool', ['store', '--label=Search Audit Search Console', 'service', SERVICE, 'profile', paths.key], value);
    backend = 'linux-secret-service';
  } else throw new Error('No supported secure credential backend on this OS. Use file imports instead.');
  const metadata = { version: 1, profile, backend, key: paths.key, updatedAt: new Date().toISOString() };
  await writeFile(paths.metadata, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  return { profile, backend };
}

export async function loadCredential(profile = 'default', { dataDir } = {}) {
  const { paths, metadata } = await readMetadata(profile, dataDir);
  if (!metadata) throw new Error('Search Console profile "' + profile + '" is not connected. Run auth connect, or use a file import.');
  if (metadata.key !== paths.key) throw new Error('Credential profile was moved or belongs to another data directory. Reconnect the profile.');
  let value;
  if (metadata.backend === 'windows-dpapi' && process.platform === 'win32') value = await unprotect(await readFile(paths.protectedFile, 'utf8'));
  else if (metadata.backend === 'macos-keychain' && process.platform === 'darwin') value = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', paths.key, '-w']);
  else if (metadata.backend === 'linux-secret-service' && process.platform === 'linux') value = await run('secret-tool', ['lookup', 'service', SERVICE, 'profile', paths.key]);
  else throw new Error('Credential store belongs to another operating system. Reconnect here, or use a file import.');
  try { return JSON.parse(value); } catch { throw new Error('Secure credential record is unreadable. Reconnect the profile.'); }
}

export async function deleteCredential(profile = 'default', { dataDir } = {}) {
  const { paths, metadata } = await readMetadata(profile, dataDir);
  if (!metadata) return { profile, disconnected: false };
  if (metadata.key !== paths.key) throw new Error('Credential profile metadata does not match this data directory.');
  if (metadata.backend === 'macos-keychain' && process.platform === 'darwin') await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', paths.key]);
  else if (metadata.backend === 'linux-secret-service' && process.platform === 'linux') await run('secret-tool', ['clear', 'service', SERVICE, 'profile', paths.key]);
  else if (metadata.backend === 'windows-dpapi' && process.platform === 'win32') await unlink(paths.protectedFile).catch(err => { if (err.code !== 'ENOENT') throw err; });
  else throw new Error('Disconnect this credential profile on its original operating system.');
  await unlink(paths.metadata);
  return { profile, disconnected: true };
}

export async function listCredentialProfiles({ dataDir } = {}) {
  if (!dataDir) throw new Error('A local dataDir is required.');
  const directory = join(resolve(dataDir), 'credentials');
  let files;
  try { files = await readdir(directory); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const profiles = [];
  for (const file of files.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}\.json$/.test(name))) {
    try {
      const data = JSON.parse(await readFile(join(directory, file), 'utf8'));
      if (data.profile === file.slice(0, -5) && data.version === 1) profiles.push({ profile: data.profile, backend: data.backend, updatedAt: data.updatedAt });
    } catch { /* Never expose broken metadata during enumeration. */ }
  }
  return profiles.sort((a, b) => a.profile.localeCompare(b.profile));
}
