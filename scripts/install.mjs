#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, realpath, readdir, readFile, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const SOURCE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = 'search-audit';
const STAGE_PREFIX = '.search-audit-install-';
const BACKUP_PREFIX = 'search-audit-';

const HELP = [
  'Install Search Audit for Codex and/or Claude Code.',
  '',
  '  node scripts/install.mjs [options]',
  '',
  '  --agent codex|claude|both    Default: both',
  '  --scope user|project        Default: user',
  '  --project-dir PATH          Project root; default current directory for project scope',
  '  --dry-run                   Show the allowlist and destinations without writing or downloading',
  '  --force                     Replace a verified existing search-audit skill; retain its backup',
  '  --skip-deps                 Copy runtime files without running npm ci',
  '  --help                      Show this help',
  '',
  'User: ~/.agents/skills/search-audit and ~/.claude/skills/search-audit.',
  'Project: <project>/.agents/skills/search-audit and <project>/.claude/skills/search-audit.',
  'The current documented Codex location is .agents/skills; CODEX_HOME does not redirect it.',
  'Source files are resolved from this installer, not the current working directory.',
  'No audit data, credentials, node_modules, demo scripts, tests, or Git history are copied.',
  'Dependencies use npm ci --omit=dev --ignore-scripts --no-audit --no-fund.',
  'Chrome/Chromium remains optional; installing this skill does not download a browser.'
].join('\n');

function inside(parent, child, { allowEqual = false } = {}) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (allowEqual && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function maybeStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Reject junctions/symlinks in every existing destination component. */
export async function assertNoSymlinkPath(file) {
  const resolved = path.resolve(file);
  const root = path.parse(resolved).root;
  let cursor = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const info = await maybeStat(cursor);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error('Refusing a symbolic-link or junction path: ' + cursor);
  }
  return resolved;
}

export function resolveInstallTargets({ agent = 'both', scope = 'user', projectDir } = {}, { homeDir = os.homedir(), cwd = process.cwd() } = {}) {
  if (!['codex', 'claude', 'both'].includes(agent)) throw new Error('--agent must be codex, claude, or both.');
  if (!['user', 'project'].includes(scope)) throw new Error('--scope must be user or project.');
  if (projectDir !== undefined && scope !== 'project') throw new Error('--project-dir requires --scope project.');
  const root = path.resolve(scope === 'user' ? homeDir : projectDir || cwd);
  const agents = agent === 'both' ? ['codex', 'claude'] : [agent];
  return agents.map(selected => {
    const parent = path.join(root, selected === 'codex' ? '.agents' : '.claude', 'skills');
    const destination = path.join(parent, NAME);
    if (!inside(root, destination) || path.basename(destination) !== NAME) throw new Error('Invalid skill destination.');
    return { agent: selected, scope, root, parent, destination };
  });
}

async function requireRegularFile(file) {
  await assertNoSymlinkPath(file);
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('Runtime source must be a regular file: ' + file);
}

/** Deliberate flat allowlist: no recursive source-directory copying. */
export async function runtimeFiles(sourceDir = SOURCE_DIR) {
  const root = path.resolve(sourceDir);
  await assertNoSymlinkPath(root);
  const files = ['SKILL.md', 'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'scripts/audit.mjs', 'scripts/install.mjs', 'agents/openai.yaml'];
  for (const [directory, extension] of [['scripts/lib', '.mjs'], ['references', '.md']]) {
    await assertNoSymlinkPath(path.join(root, directory));
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (!entry.name.endsWith(extension) || entry.name.startsWith('.')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Refusing non-regular runtime source: ' + path.join(directory, entry.name));
      files.push(directory + '/' + entry.name);
    }
  }
  for (const relative of files) {
    const file = path.resolve(root, relative);
    if (!inside(root, file)) throw new Error('Runtime allowlist escaped its source directory.');
    await requireRegularFile(file);
  }
  return [...new Set(files)].sort();
}

async function verifyExistingSkill(destination, packageName) {
  const skillFile = path.join(destination, 'SKILL.md');
  const packageFile = path.join(destination, 'package.json');
  try { await requireRegularFile(skillFile); await requireRegularFile(packageFile); }
  catch { throw new Error('--force only replaces a verified search-audit skill with SKILL.md and package.json: ' + destination); }
  const skill = (await readFile(skillFile, 'utf8')).replace(/^\uFEFF/, '');
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  if (!/^name:\s*['"]?search-audit['"]?\s*$/m.test(frontmatter)) throw new Error('--force only replaces a verified search-audit skill: ' + destination);
  let existing;
  try { existing = JSON.parse((await readFile(packageFile, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new Error('Existing skill package.json is invalid; refusing --force.'); }
  if (![packageName, 'search-audit-skill'].includes(existing.name)) throw new Error('Existing package identity differs; refusing --force: ' + destination);
}

async function preflightTarget(target, { force, sourceDir, packageName }) {
  await assertNoSymlinkPath(target.destination);
  const source = await realpath(sourceDir);
  const destination = path.resolve(target.destination);
  if (path.relative(destination, source) === '' || inside(destination, source)) throw new Error('Refusing to replace the installer source or one of its ancestors.');
  const parentInfo = await maybeStat(target.root);
  if (parentInfo && !parentInfo.isDirectory()) throw new Error('Installation root must be a directory: ' + target.root);
  const current = await maybeStat(destination);
  if (!current) return false;
  if (!current.isDirectory()) throw new Error('Destination exists and is not a directory: ' + destination);
  if (!force) throw new Error('Destination already exists. Use --force to replace a verified skill: ' + destination);
  await verifyExistingSkill(destination, packageName);
  return true;
}

async function usableFile(file) {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

/** Execute npm's JS entry with Node; never pass npm.cmd through a shell. */
export async function resolveNpmInvocation({ env = process.env, nodeExecutable = process.execPath, platform = process.platform } = {}) {
  const candidates = [];
  if (env.npm_execpath && /(?:^|[\\/])npm-cli\.js$/i.test(env.npm_execpath)) candidates.push(env.npm_execpath);
  candidates.push(path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const pathValue = env.PATH || env.Path || env.path || '';
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const launcher = path.join(directory, platform === 'win32' ? 'npm.cmd' : 'npm');
    try {
      const actual = await realpath(launcher);
      if (actual.endsWith('npm-cli.js')) candidates.push(actual);
    } catch { /* Continue through PATH and known npm layouts. */ }
    candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    if (await usableFile(candidate)) return { command: nodeExecutable, args: [path.resolve(candidate), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'] };
  }
  throw new Error('npm was not found alongside Node or on PATH. Install Node with npm, or rerun --skip-deps and run npm ci --omit=dev in each installed skill directory.');
}

function runProcess(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', error => reject(new Error('Cannot start npm: ' + error.message)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('npm ci failed (exit ' + code + '). Check Node version, connectivity, and the lockfile. No staged installation was published.')));
  });
}

async function removeStage(stage, parent) {
  // Only generated staging folders within the verified parent can be recursively removed.
  const resolved = path.resolve(stage);
  if (!inside(parent, resolved) || path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith(STAGE_PREFIX)) throw new Error('Refusing unsafe staging cleanup.');
  await assertNoSymlinkPath(resolved);
  const info = await maybeStat(resolved);
  if (info && !info.isDirectory()) throw new Error('Staging path is no longer a directory.');
  if (info) await rm(resolved, { recursive: true, force: true });
}

export async function installSkill(options = {}, context = {}) {
  const nodeParts = process.versions.node.split('.').map(Number);
  if (nodeParts[0] < 22 || nodeParts[0] === 22 && nodeParts[1] < 19) throw new Error('Search Audit requires Node >=22.19.0.');
  const sourceDir = path.resolve(context.sourceDir || SOURCE_DIR);
  const files = await runtimeFiles(sourceDir);
  const packageData = JSON.parse((await readFile(path.join(sourceDir, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const targets = resolveInstallTargets(options, context);
  const force = Boolean(options.force);
  for (const target of targets) target.replacesExisting = await preflightTarget(target, { force, sourceDir, packageName: packageData.name });
  const plan = { sourceDir, agent: options.agent || 'both', scope: options.scope || 'user', dryRun: Boolean(options.dryRun), dependencies: options.skipDeps ? 'skipped' : 'npm-ci', files, targets: targets.map(target => ({ ...target })) };
  if (options.dryRun) return { ...plan, status: 'dry-run' };
  const log = context.log || (() => {});
  const stages = [];
  const journal = [];
  try {
    const invocation = options.skipDeps ? null : await resolveNpmInvocation(context);
    // Stage every requested agent before replacing any installed skill.
    for (const target of targets) {
      await assertNoSymlinkPath(target.parent);
      await mkdir(target.parent, { recursive: true });
      await assertNoSymlinkPath(target.parent);
      const stageParent = path.join(path.dirname(target.parent), 'skill-install-staging');
      await assertNoSymlinkPath(stageParent);
      await mkdir(stageParent, { recursive: true });
      await assertNoSymlinkPath(stageParent);
      const stage = path.join(stageParent, STAGE_PREFIX + randomUUID());
      await mkdir(stage, { recursive: false, mode: 0o700 });
      stages.push({ stage, stageParent, target });
      for (const relative of files) {
        const destination = path.resolve(stage, relative);
        if (!inside(stage, destination)) throw new Error('Runtime file escaped the staging directory.');
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(sourceDir, relative), destination, constants.COPYFILE_EXCL);
      }
      if (invocation) {
        log('Installing runtime dependencies for ' + target.agent + '...');
        const runner = context.runCommand || runProcess;
        await runner(invocation.command, invocation.args, { cwd: stage, env: { ...(context.env || process.env), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
      }
    }
    for (const { stage, target } of stages) {
      const exists = await preflightTarget(target, { force, sourceDir, packageName: packageData.name });
      const entry = { stage, target, backup: null, published: false };
      journal.push(entry);
      if (exists) {
        const backupParent = path.join(path.dirname(target.parent), 'skill-backups');
        await assertNoSymlinkPath(backupParent);
        await mkdir(backupParent, { recursive: true });
        await assertNoSymlinkPath(backupParent);
        entry.backup = path.join(backupParent, BACKUP_PREFIX + randomUUID());
        await rename(target.destination, entry.backup);
      }
      await rename(stage, target.destination);
      entry.published = true;
      target.backup = entry.backup;
      log('Installed ' + target.agent + ': ' + target.destination);
      if (entry.backup) log('Previous installation retained at: ' + entry.backup);
    }
    return { ...plan, status: 'installed', targets: targets.map(target => ({ ...target })) };
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...journal].reverse()) {
      try {
        await assertNoSymlinkPath(entry.target.destination);
        if (entry.published) await rename(entry.target.destination, entry.stage);
        if (entry.backup) await rename(entry.backup, entry.target.destination);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    for (const { stage, stageParent } of stages) {
      try { await removeStage(stage, stageParent); } catch (cleanupError) { rollbackErrors.push(cleanupError.message); }
    }
    if (rollbackErrors.length) error.message += ' Manual recovery may be needed: ' + rollbackErrors.join('; ');
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs({ args, strict: true, allowPositionals: false, options: {
    agent: { type: 'string', default: 'both' }, scope: { type: 'string', default: 'user' },
    'project-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' },
    'skip-deps': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  const values = parsed.values;
  if (values.help) { console.log(HELP); return; }
  const result = await installSkill({
    agent: values.agent, scope: values.scope, projectDir: values['project-dir'],
    dryRun: values['dry-run'], force: values.force, skipDeps: values['skip-deps']
  }, { log: console.log });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'installed') {
    console.log('Restart or reload the agent to discover search-audit. Codex: $search-audit; Claude Code: /search-audit.');
    console.log('Run node \"<installed-skill>/scripts/audit.mjs\" doctor. Use local Chrome, or optionally run npx playwright install chromium from an installed skill directory.');
    if (values['skip-deps']) console.log('Dependencies were skipped. Run npm ci --omit=dev in each installed skill directory before auditing.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Search Audit installer: ' + error.message); process.exitCode = 1; });
}
