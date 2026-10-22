import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill, runtimeFiles, resolveInstallTargets, resolveNpmInvocation, SOURCE_DIR } from '../scripts/install.mjs';

const execute = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(path.join(testRoot, '.tmp-install-'));
  t.after(async () => {
    const relative = path.relative(testRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && path.basename(directory).startsWith('.tmp-install-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function filesBelow(directory, prefix = '') {
  const output = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + item.name : item.name;
    if (item.isDirectory()) output.push(...await filesBelow(path.join(directory, item.name), relative));
    else output.push(relative);
  }
  return output.sort();
}
async function minimalSource(root) {
  const sourceDir = path.join(root, 'source');
  const fixtureFiles = {
    'SKILL.md': '---\nname: search-audit\ndescription: Synthetic installer fixture\n---\n',
    'README.md': '# Synthetic installer fixture\n',
    'LICENSE': 'Synthetic test license\n',
    'package.json': JSON.stringify({ name: 'search-audit-skill', version: '1.0.0', type: 'module' }),
    'package-lock.json': JSON.stringify({ name: 'search-audit-skill', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'search-audit-skill', version: '1.0.0' } } }),
    'scripts/audit.mjs': 'console.log("synthetic fixture");\n',
    'scripts/install.mjs': '// Synthetic installer fixture\n',
    'scripts/lib/runtime.mjs': 'export const fixture = true;\n',
    'references/methodology.md': '# Synthetic methodology\n',
    'agents/openai.yaml': 'interface:\n  display_name: Search Audit\n',
    'audit-output/report.json': 'PRIVATE_AUDIT_SENTINEL',
    '.search-audit/credentials/private.json': 'PRIVATE_CREDENTIAL_SENTINEL',
    'node_modules/private/index.js': 'PRIVATE_DEPENDENCY_SENTINEL',
    '.git/config': 'PRIVATE_GIT_SENTINEL',
    'tests/private.test.mjs': 'PRIVATE_TEST_SENTINEL',
    'scripts/demo.mjs': 'PRIVATE_DEMO_SENTINEL',
    'scripts/lib/private.txt': 'PRIVATE_EXTRA_SENTINEL',
    'references/.private.md': 'PRIVATE_HIDDEN_SENTINEL'
  };
  for (const [relative, content] of Object.entries(fixtureFiles)) {
    const file = path.join(sourceDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return sourceDir;
}

test('Default targets use modern Codex and Claude personal directories, independently of CODEX_HOME', () => {
  const homeDir = path.resolve(testRoot, 'synthetic-home');
  const targets = resolveInstallTargets({}, { homeDir });
  assert.deepEqual(targets.map(target => target.agent), ['codex', 'claude']);
  assert.equal(targets[0].destination, path.join(homeDir, '.agents', 'skills', 'search-audit'));
  assert.equal(targets[1].destination, path.join(homeDir, '.claude', 'skills', 'search-audit'));
  assert.throws(() => resolveInstallTargets({ agent: '../claude' }), /--agent/);
  assert.throws(() => resolveInstallTargets({ scope: '../user' }), /--scope/);
  assert.throws(() => resolveInstallTargets({ projectDir: 'project' }), /requires --scope/);
});

test('Dry run lists both project destinations and writes no files', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const projectDir = path.join(root, 'project with spaces');
  const result = await installSkill({ scope: 'project', projectDir, dryRun: true }, { sourceDir });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.agent, 'both');
  assert.equal(result.dependencies, 'npm-ci');
  assert.equal(result.targets.length, 2);
  assert.equal(await exists(projectDir), false);
});

test('Runtime allowlist excludes reports, credentials, dependencies, demos, tests, Git and hidden files', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const files = await runtimeFiles(sourceDir);
  assert.deepEqual(files, [
    'LICENSE', 'README.md', 'SKILL.md', 'agents/openai.yaml', 'package-lock.json', 'package.json',
    'references/methodology.md', 'scripts/audit.mjs', 'scripts/install.mjs', 'scripts/lib/runtime.mjs'
  ]);
  const projectDir = path.join(root, 'project');
  const result = await installSkill({ scope: 'project', projectDir, skipDeps: true }, { sourceDir });
  for (const target of result.targets) {
    assert.deepEqual(await filesBelow(target.destination), files);
    const content = (await Promise.all(files.map(file => readFile(path.join(target.destination, file), 'utf8')))).join('\n');
    assert.equal(content.includes('PRIVATE_'), false);
  }
});

test('CLI installs the actual runtime for both agents into an isolated project from any cwd', async t => {
  const root = await temporary(t);
  const projectDir = path.join(root, 'isolated project');
  const script = path.join(SOURCE_DIR, 'scripts', 'install.mjs');
  const result = await execute(process.execPath, [script, '--scope', 'project', '--project-dir', projectDir, '--skip-deps'], { cwd: root, windowsHide: true });
  assert.match(result.stdout, /"status": "installed"/);
  const allowlist = await runtimeFiles();
  for (const agentDirectory of ['.agents', '.claude']) {
    const destination = path.join(projectDir, agentDirectory, 'skills', 'search-audit');
    assert.deepEqual(await filesBelow(destination), allowlist);
    const help = await execute(process.execPath, [path.join(destination, 'scripts', 'audit.mjs'), '--help'], { cwd: root, windowsHide: true });
    assert.match(help.stdout, /local SEO/);
    assert.equal(await exists(path.join(destination, 'node_modules')), false);
    assert.equal(await exists(path.join(destination, '.search-audit')), false);
  }
});

test('Existing skills require force; force preserves a verified backup outside discovery folders', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const projectDir = path.join(root, 'project');
  const options = { scope: 'project', projectDir, agent: 'codex', skipDeps: true };
  const first = await installSkill(options, { sourceDir });
  const destination = first.targets[0].destination;
  await writeFile(path.join(destination, 'personal-note.txt'), 'retain this data');
  await assert.rejects(installSkill(options, { sourceDir }), /already exists/);
  assert.equal(await readFile(path.join(destination, 'personal-note.txt'), 'utf8'), 'retain this data');
  const second = await installSkill({ ...options, force: true }, { sourceDir });
  const backup = second.targets[0].backup;
  assert.equal(path.dirname(backup), path.join(projectDir, '.agents', 'skill-backups'));
  assert.equal(await readFile(path.join(backup, 'personal-note.txt'), 'utf8'), 'retain this data');
  assert.equal(await exists(path.join(destination, 'personal-note.txt')), false);
  assert.deepEqual(await readdir(path.join(projectDir, '.agents', 'skills')), ['search-audit']);
});

test('Force refuses an unrelated destination and does not touch its files', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const projectDir = path.join(root, 'project');
  const target = path.join(projectDir, '.agents', 'skills', 'search-audit');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'important.txt'), 'unrelated data');
  await assert.rejects(installSkill({ scope: 'project', projectDir, agent: 'codex', skipDeps: true, force: true }, { sourceDir }), /verified search-audit/);
  assert.equal(await readFile(path.join(target, 'important.txt'), 'utf8'), 'unrelated data');
});

test('Destination symlink/junction and symlinked parents are refused without touching external data', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const external = path.join(root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'important.txt'), 'external sentinel');
  const projectDir = path.join(root, 'project');
  const parent = path.join(projectDir, '.agents', 'skills');
  await mkdir(parent, { recursive: true });
  await symlink(external, path.join(parent, 'search-audit'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill({ scope: 'project', projectDir, agent: 'codex', skipDeps: true, force: true }, { sourceDir }), /symbolic-link|junction/);
  const secondProject = path.join(root, 'second-project');
  await mkdir(secondProject);
  await symlink(external, path.join(secondProject, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill({ scope: 'project', projectDir: secondProject, skipDeps: true }, { sourceDir }), /symbolic-link|junction/);
  assert.equal(await readFile(path.join(external, 'important.txt'), 'utf8'), 'external sentinel');
  assert.deepEqual(await readdir(external), ['important.txt']);
});

test('A symlinked runtime source cannot copy a file from outside the source allowlist', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const outside = path.join(root, 'outside.mjs');
  await writeFile(outside, 'SECRET_EXTERNAL_SOURCE');
  try { await symlink(outside, path.join(sourceDir, 'scripts', 'lib', 'leak.mjs'), 'file'); }
  catch (error) {
    // Windows file symlinks require Developer Mode/admin; junction checks above always exercise destination protection.
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('File symlink creation unavailable without Developer Mode'); return; }
    throw error;
  }
  await assert.rejects(runtimeFiles(sourceDir), /non-regular|symbolic-link/);
});

test('npm invocation uses Node plus npm-cli.js and fixed arguments without a shell', async t => {
  const root = await temporary(t);
  const npmCli = path.join(root, 'npm with spaces & symbols', 'npm-cli.js');
  await mkdir(path.dirname(npmCli), { recursive: true });
  await writeFile(npmCli, '// synthetic npm entry\n');
  const invocation = await resolveNpmInvocation({ env: { npm_execpath: npmCli, PATH: '' } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
});

test('Dependency installation stages both copies before publishing; failure leaves existing skills untouched', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const projectDir = path.join(root, 'project');
  const options = { scope: 'project', projectDir, skipDeps: true };
  const first = await installSkill(options, { sourceDir });
  for (const target of first.targets) await writeFile(path.join(target.destination, 'existing.txt'), 'original');
  const npmCli = path.join(root, 'npm-cli.js');
  await writeFile(npmCli, '// synthetic npm entry\n');
  let calls = 0;
  await assert.rejects(installSkill({ ...options, skipDeps: false, force: true }, {
    sourceDir, env: { npm_execpath: npmCli, PATH: '' },
    runCommand: async (command, args, options) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.equal(args[0], npmCli);
      assert.ok(path.basename(options.cwd).startsWith('.search-audit-install-'));
      assert.equal(options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
      for (const target of first.targets) assert.equal(await readFile(path.join(target.destination, 'existing.txt'), 'utf8'), 'original');
      if (calls === 2) throw new Error('synthetic offline failure');
    }
  }), /synthetic offline failure/);
  assert.equal(calls, 2);
  for (const target of first.targets) {
    assert.equal(await readFile(path.join(target.destination, 'existing.txt'), 'utf8'), 'original');
    assert.deepEqual(await readdir(target.parent), ['search-audit']);
  }
});

test('Installer cannot force-replace its own source directory', async t => {
  const root = await temporary(t);
  const fixture = await minimalSource(root);
  const projectDir = path.join(root, 'project');
  const destination = path.join(projectDir, '.agents', 'skills', 'search-audit');
  await mkdir(path.dirname(destination), { recursive: true });
  // Rename only this test's generated fixture into the fixed target location.
  const { rename } = await import('node:fs/promises');
  await rename(fixture, destination);
  await assert.rejects(installSkill({ scope: 'project', projectDir, agent: 'codex', force: true, skipDeps: true }, { sourceDir: destination }), /installer source/);
});



test('Actual npm installs a dependency-free fixture offline for both agents using a temporary cache', async t => {
  const root = await temporary(t);
  const sourceDir = await minimalSource(root);
  const packageFile = path.join(sourceDir, 'package.json');
  const data = JSON.parse(await readFile(packageFile, 'utf8'));
  data.scripts = { preinstall: 'node -e "process.exit(19)"' };
  await writeFile(packageFile, JSON.stringify(data));
  const projectDir = path.join(root, 'offline project');
  const result = await installSkill({ scope: 'project', projectDir }, {
    sourceDir,
    env: {
      ...process.env, npm_config_cache: path.join(root, 'npm-cache'),
      npm_config_offline: 'true', npm_config_update_notifier: 'false'
    }
  });
  assert.equal(result.status, 'installed');
  assert.equal(result.dependencies, 'npm-ci');
  assert.equal(result.targets.length, 2);
  for (const target of result.targets) {
    const output = await execute(process.execPath, [path.join(target.destination, 'scripts', 'audit.mjs')], { cwd: root, windowsHide: true });
    assert.match(output.stdout, /synthetic fixture/);
  }
});
