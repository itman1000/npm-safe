#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const VERSION = '0.1.2';
const DEFAULT_MIN_AGE_DAYS = 7;
const MAX_REPORT_ITEMS = 20;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const OWNED_NPM_FLAGS = new Set([
  '--ignore-scripts',
  '--before',
  '--min-release-age',
  '--fund',
  '--audit',
  '--package-lock-only',
]);

const NPM_FLAGS_WITH_VALUE = new Set([
  '--tag', '--save-prefix', '--registry', '--cache', '--workspace',
  '--omit', '--include', '--before', '--min-release-age', '--ignore-scripts', '--fund', '--audit', '--userconfig',
  '--prefix', '--install-strategy', '--package-lock',
  '--color', '--loglevel', '--node-options', '--script-shell', '--nodedir',
  '--workspace', '-w', '-C',
]);

const ENV_EXACT_DENY = new Set([
  'NODE_OPTIONS',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PAT',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
]);

const ENV_SECRET_RE = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS?|ACCESS_KEY|AUTH|API_KEY|PAT)(_|$)/i;

main().catch((error) => {
  console.error(`npm-safe: ${error.message}`);
  if (process.env.NPM_SAFE_DEBUG) console.error(error.stack);
  process.exit(1);
});

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (command === 'install' || command === 'i') {
    await commandInstall(argv.slice(1));
    return;
  }

  if (command === 'ci') {
    await commandCi(argv.slice(1));
    return;
  }

  if (command === 'rebuild') {
    await commandRebuild(argv.slice(1));
    return;
  }

  if (command === 'verify') {
    await commandVerify(argv.slice(1));
    return;
  }

  throw new Error(`unknown command: ${command}\nRun: npm-safe help`);
}

function printHelp() {
  console.log(`npm-safe ${VERSION}

A small safety wrapper for npm install.

Standard use:
  npm-safe install
  npm-safe install axios
  npm-safe install -D vitest

CI:
  npm-safe ci

When a trusted package really needs its build/install script:
  npm-safe rebuild esbuild

Useful options:
  --min-age <days>   Default: ${DEFAULT_MIN_AGE_DAYS}
  --allow-new        Disable the release-age gate for this run
  --allow-git        Allow git dependencies
  --allow-host <host> Allow remote tarballs from a specific trusted host
  --allow-remote     Allow all non-registry remote tarball URLs
  --allow-file       Allow file: and local path dependencies

Advanced:
  npm-safe verify --strict
`);
}

async function commandInstall(rawArgs) {
  const parsed = parseSafetyArgs(rawArgs);
  const npmVersion = getNpmVersion();
  ensureSupportedNpm(npmVersion);

  if (hasNoLockFlag(parsed.npmArgs)) {
    throw new Error('npm-safe requires a package lock. Remove --no-package-lock / --package-lock=false.');
  }

  const registry = getNpmRegistry(parsed.env);
  const allowedSources = allowedRemoteSourcesFor(registry, parsed.policy);
  await preflightRootAndArgs(parsed.npmArgs, parsed.policy, allowedSources);

  const backups = await snapshotFiles(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);

  try {
    const candidateArgs = [
      'install',
      ...stripOwnedNpmFlags(parsed.npmArgs),
      '--package-lock-only',
      ...safetyNpmArgs(npmVersion, parsed.policy, { includeAge: true }),
    ];

    console.log('npm-safe: resolving a safe candidate lockfile...');
    await runNpm(candidateArgs, parsed.env);

    const lockPath = await findLockfile();
    if (!lockPath) {
      throw new Error('npm did not create package-lock.json or npm-shrinkwrap.json.');
    }

    await checkLockfilePolicy(lockPath, parsed.policy, registry, parsed.env, { verbose: parsed.policy.verbose });

    const installArgs = [
      'install',
      ...stripOwnedNpmFlags(parsed.npmArgs),
      ...safetyNpmArgs(npmVersion, parsed.policy, { includeAge: true }),
    ];

    console.log('npm-safe: installing with npm scripts disabled...');
    await runNpm(installArgs, parsed.env);

    await markLockfileVerified(lockPath, parsed.policy, registry);
    await printInstallScriptSummary(lockPath);
    printEnvSummary(parsed.envInfo, parsed.policy.verbose);
    console.log('npm-safe: done.');
  } catch (error) {
    await restoreFiles(backups);
    throw error;
  }
}

async function commandCi(rawArgs) {
  const parsed = parseSafetyArgs(rawArgs);
  const npmVersion = getNpmVersion();
  ensureSupportedNpm(npmVersion);

  const lockPath = await findLockfile();
  if (!lockPath) {
    throw new Error('npm-safe ci requires package-lock.json or npm-shrinkwrap.json.');
  }

  const registry = getNpmRegistry(parsed.env);
  const allowedSources = allowedRemoteSourcesFor(registry, parsed.policy);
  await preflightRootAndArgs([], parsed.policy, allowedSources);
  await checkLockfilePolicy(lockPath, parsed.policy, registry, parsed.env, { verbose: parsed.policy.verbose });

  const ciArgs = [
    'ci',
    ...stripOwnedNpmFlags(parsed.npmArgs),
    ...safetyNpmArgs(npmVersion, parsed.policy, { includeAge: false }),
  ];

  console.log('npm-safe: running npm ci with npm scripts disabled...');
  await runNpm(ciArgs, parsed.env);
  await markLockfileVerified(lockPath, parsed.policy, registry);
  await printInstallScriptSummary(lockPath);
  printEnvSummary(parsed.envInfo, parsed.policy.verbose);
  console.log('npm-safe: done.');
}

async function commandRebuild(rawArgs) {
  const parsed = parseSafetyArgs(rawArgs);
  const packages = parsed.npmArgs.filter((arg) => !arg.startsWith('-'));
  if (packages.length === 0) {
    throw new Error('usage: npm-safe rebuild <trusted-package> [more-packages...]');
  }

  console.log('npm-safe: rebuilding only the package(s) you selected. Trust them before running this.');
  await runNpm(['rebuild', ...parsed.npmArgs, '--foreground-scripts'], parsed.env);
  printEnvSummary(parsed.envInfo, parsed.policy.verbose);
}

async function commandVerify(rawArgs) {
  const parsed = parseSafetyArgs(rawArgs);
  const strict = parsed.npmArgs.includes('--strict');
  const npmArgs = parsed.npmArgs.filter((arg) => arg !== '--strict');

  if (npmArgs.length) {
    throw new Error(`unknown verify option(s): ${npmArgs.join(' ')}`);
  }

  const lockPath = await findLockfile();
  if (!lockPath) {
    throw new Error('verify requires package-lock.json or npm-shrinkwrap.json.');
  }

  const registry = getNpmRegistry(parsed.env);
  await checkLockfilePolicy(lockPath, parsed.policy, registry, parsed.env, { verbose: true, force: true });

  if (strict) {
    console.log('npm-safe: running npm audit signatures...');
    await runNpm(['audit', 'signatures'], parsed.env);
  }

  printEnvSummary(parsed.envInfo, parsed.policy.verbose);
  console.log('npm-safe: verify complete.');
}

function parseSafetyArgs(rawArgs) {
  const policy = {
    minAgeDays: DEFAULT_MIN_AGE_DAYS,
    allowNew: false,
    allowGit: false,
    allowRemote: false,
    allowHosts: new Set(),
    allowFile: false,
    sanitizeEnv: true,
    verbose: false,
  };
  const npmArgs = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === '--') {
      npmArgs.push(...rawArgs.slice(i));
      break;
    }

    if (arg === '--allow-new') {
      policy.allowNew = true;
      continue;
    }

    if (arg === '--allow-git') {
      policy.allowGit = true;
      continue;
    }

    if (arg === '--allow-remote' || arg === '--allow-tarball') {
      policy.allowRemote = true;
      continue;
    }

    if (arg === '--allow-host') {
      const value = rawArgs[++i];
      if (!value) throw new Error('--allow-host requires a host name or URL.');
      addAllowedHosts(policy, value);
      continue;
    }

    if (arg.startsWith('--allow-host=')) {
      addAllowedHosts(policy, arg.slice('--allow-host='.length));
      continue;
    }

    if (arg === '--allow-file') {
      policy.allowFile = true;
      continue;
    }

    if (arg === '--allow-exotic') {
      policy.allowGit = true;
      policy.allowRemote = true;
      policy.allowFile = true;
      continue;
    }

    if (arg === '--no-env-sanitize') {
      policy.sanitizeEnv = false;
      continue;
    }

    if (arg === '--verbose') {
      policy.verbose = true;
      continue;
    }

    if (arg === '--min-age') {
      const value = rawArgs[++i];
      if (value == null) throw new Error('--min-age requires a number of days.');
      policy.minAgeDays = parseMinAge(value);
      continue;
    }

    if (arg.startsWith('--min-age=')) {
      policy.minAgeDays = parseMinAge(arg.slice('--min-age='.length));
      continue;
    }

    npmArgs.push(arg);
  }

  if (policy.minAgeDays <= 0) policy.allowNew = true;
  const { env, info } = buildChildEnv(policy);
  return { npmArgs, policy, env, envInfo: info };
}

function addAllowedHosts(policy, value) {
  const entries = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!entries.length) throw new Error('--allow-host requires a host name or URL.');
  for (const entry of entries) {
    let hostname;
    try {
      hostname = /^https?:\/\//i.test(entry) ? new URL(entry).hostname : new URL(`https://${entry}`).hostname;
    } catch (_) {
      throw new Error(`invalid --allow-host value: ${entry}`);
    }
    hostname = hostname.replace(/^[.]+|[.]+$/g, '').toLowerCase();
    if (!hostname || hostname.includes('*') || !/^[a-z0-9.-]+$/i.test(hostname)) {
      throw new Error(`invalid --allow-host value: ${entry}`);
    }
    policy.allowHosts.add(hostname);
  }
}

function parseMinAge(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --min-age value: ${value}`);
  return n;
}

function getNpmVersion() {
  const result = spawnSync(NPM, ['--version'], { encoding: 'utf8' });
  if (result.error) throw new Error(`failed to run npm: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`failed to read npm version: ${result.stderr || result.stdout}`);
  return parseVersion(String(result.stdout).trim());
}

function parseVersion(value) {
  const m = String(value).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`cannot parse npm version: ${value}`);
  return { raw: value, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function ensureSupportedNpm(v) {
  if (v.major < 6) {
    throw new Error(`npm-safe supports npm 6 or newer. Current npm: ${v.raw}`);
  }
}

function supportsMinReleaseAge(v) {
  return v.major > 11 || (v.major === 11 && v.minor >= 10);
}

function safetyNpmArgs(npmVersion, policy, { includeAge }) {
  const args = ['--ignore-scripts', '--fund=false', '--audit=false'];

  if (includeAge && !policy.allowNew && policy.minAgeDays > 0) {
    if (supportsMinReleaseAge(npmVersion)) {
      args.push(`--min-release-age=${policy.minAgeDays}`);
    } else {
      args.push(`--before=${new Date(Date.now() - policy.minAgeDays * 86400000).toISOString()}`);
    }
  }

  return args;
}

function stripOwnedNpmFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (OWNED_NPM_FLAGS.has(key)) {
      if (eq === -1 && NPM_FLAGS_WITH_VALUE.has(key) && i + 1 < args.length) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function hasNoLockFlag(args) {
  return args.some((arg) =>
    arg === '--no-package-lock' ||
    arg === '--package-lock=false' ||
    arg === '--no-shrinkwrap'
  );
}

function buildChildEnv(policy) {
  if (!policy.sanitizeEnv) {
    return { env: { ...process.env }, info: { blocked: [] } };
  }

  const env = {};
  const blocked = [];

  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    const isDenied = ENV_EXACT_DENY.has(upper) || ENV_SECRET_RE.test(upper);
    const isUnsafeNpmConfig = upper === 'NPM_CONFIG_IGNORE_SCRIPTS' ||
      upper === 'NPM_CONFIG_SCRIPT_SHELL' ||
      upper === 'NPM_CONFIG_NODE_OPTIONS';

    if (isDenied || isUnsafeNpmConfig) {
      blocked.push(key);
      continue;
    }
    env[key] = value;
  }

  return { env, info: { blocked } };
}

function printEnvSummary(info, verbose) {
  if (!info || !info.blocked || info.blocked.length === 0) return;
  if (!verbose) {
    console.log(`npm-safe: sanitized ${info.blocked.length} sensitive environment variable(s). Use --verbose to list names.`);
    return;
  }
  console.log('npm-safe: sanitized environment variable(s):');
  for (const key of info.blocked.slice(0, MAX_REPORT_ITEMS)) console.log(`  - ${key}`);
  if (info.blocked.length > MAX_REPORT_ITEMS) console.log(`  ... and ${info.blocked.length - MAX_REPORT_ITEMS} more`);
}

async function runNpm(args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(NPM, args, { stdio: 'inherit', env, cwd: process.cwd() });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args[0]} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function captureNpm(args, env) {
  const result = spawnSync(NPM, args, { encoding: 'utf8', env, cwd: process.cwd() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim() || `npm ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function getNpmRegistry(env) {
  const envRegistry = env.NPM_CONFIG_REGISTRY || env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || process.env.npm_config_registry;
  if (envRegistry && /^https?:\/\//i.test(envRegistry)) return ensureTrailingSlash(envRegistry);

  try {
    const value = captureNpm(['config', 'get', 'registry'], env).trim();
    if (value && value !== 'undefined' && /^https?:\/\//i.test(value)) return ensureTrailingSlash(value);
  } catch (_) {
    // Fall back to the public registry below.
  }
  return 'https://registry.npmjs.org/';
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function allowedRemoteSourcesFor(registry, policy = {}) {
  const origins = new Set();
  const hosts = new Set();

  for (const url of [registry, 'https://registry.npmjs.org/']) {
    try {
      const parsed = new URL(url);
      origins.add(parsed.origin);
      hosts.add(parsed.hostname.toLowerCase());
    } catch (_) {
      // ignore invalid values
    }
  }

  for (const host of policy.allowHosts || []) {
    hosts.add(String(host).toLowerCase());
  }

  return { origins, hosts };
}

function isAllowedRemoteUrl(url, allowedSources) {
  return Boolean(
    allowedSources &&
    (
      allowedSources.origins?.has(url.origin) ||
      allowedSources.hosts?.has(url.hostname.toLowerCase())
    )
  );
}

async function preflightRootAndArgs(npmArgs, policy, allowedSources) {
  const rootIssues = await inspectPackageJsonDependencies(policy, allowedSources);
  const argIssues = inspectInstallArgs(npmArgs, policy, allowedSources);
  const issues = [...rootIssues, ...argIssues];
  if (issues.length) throw new Error(formatExoticIssues(issues));
}

async function inspectPackageJsonDependencies(policy, allowedSources) {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(packageJsonPath)) return [];
  const pkg = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8'));
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
  const issues = [];

  for (const field of fields) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const issue = classifyExotic(String(spec), allowedSources);
      if (issue && !isAllowedIssue(issue, policy)) {
        issues.push({ name, where: `package.json ${field}`, spec: String(spec), kind: issue.kind, hostname: issue.hostname });
      }
    }
  }
  return issues;
}

function inspectInstallArgs(args, policy, allowedSources) {
  const specs = extractInstallSpecs(args);
  const issues = [];
  for (const spec of specs) {
    const issue = classifyUserInstallSpec(spec, allowedSources);
    if (issue && !isAllowedIssue(issue, policy)) {
      issues.push({ name: spec, where: 'install argument', spec, kind: issue.kind, hostname: issue.hostname });
    }
  }
  return issues;
}

function extractInstallSpecs(args) {
  const specs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      specs.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg : arg.slice(0, eq);
      if (eq === -1 && NPM_FLAGS_WITH_VALUE.has(key)) i++;
      continue;
    }
    specs.push(arg);
  }
  return specs;
}

function classifyUserInstallSpec(spec, allowedSources) {
  const s = spec.trim();
  if (!s) return null;
  if (/^(git\+|git:|ssh:|github:|gitlab:|bitbucket:)/i.test(s)) return { kind: 'git' };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/.test(s)) return { kind: 'git' };
  if (/^(file:|\.\.?\/|\/|[A-Za-z]:\\)/.test(s)) return { kind: 'file' };
  if (/^https?:\/\//i.test(s)) return classifyExotic(s, allowedSources);
  return null;
}

function classifyExotic(spec, allowedSources) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (/^(git\+|git:|ssh:|github:|gitlab:|bitbucket:)/i.test(s)) return { kind: 'git' };
  if (/^(file:|link:|\.\.?\/|\/|[A-Za-z]:\\)/.test(s)) return { kind: 'file' };
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (isAllowedRemoteUrl(u, allowedSources)) return null;
      return { kind: 'remote', origin: u.origin, hostname: u.hostname.toLowerCase() };
    } catch (_) {
      return { kind: 'remote' };
    }
  }
  return null;
}

function isAllowedIssue(issueOrKind, policy) {
  const issue = typeof issueOrKind === 'string' ? { kind: issueOrKind } : issueOrKind;
  if (!issue) return false;
  if (issue.kind === 'git') return policy.allowGit;
  if (issue.kind === 'remote') return policy.allowRemote;
  if (issue.kind === 'file') return policy.allowFile;
  return false;
}

function formatExoticIssues(issues) {
  const lines = ['blocked non-registry dependency source(s):'];
  for (const issue of issues.slice(0, MAX_REPORT_ITEMS)) {
    const host = issue.hostname ? ` host=${issue.hostname}` : '';
    lines.push(`- ${issue.name} (${issue.where}): ${issue.spec} [${issue.kind}${host}]`);
  }
  if (issues.length > MAX_REPORT_ITEMS) lines.push(`... and ${issues.length - MAX_REPORT_ITEMS} more`);
  lines.push('Use --allow-host <host> for trusted private registry/CDN tarballs. Use --allow-git, --allow-remote, or --allow-file only when you trust the source.');
  return lines.join('\n');
}

async function findLockfile() {
  const shrinkwrap = path.join(process.cwd(), 'npm-shrinkwrap.json');
  if (fs.existsSync(shrinkwrap)) return shrinkwrap;
  const packageLock = path.join(process.cwd(), 'package-lock.json');
  if (fs.existsSync(packageLock)) return packageLock;
  return null;
}

async function snapshotFiles(fileNames) {
  const map = new Map();
  for (const name of fileNames) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) map.set(p, await fsp.readFile(p));
    else map.set(p, null);
  }
  return map;
}

async function restoreFiles(snapshot) {
  for (const [p, data] of snapshot.entries()) {
    if (data === null) {
      if (fs.existsSync(p)) await fsp.unlink(p).catch(() => {});
    } else {
      await fsp.writeFile(p, data);
    }
  }
}

async function checkLockfilePolicy(lockPath, policy, registry, env, opts = {}) {
  const lockText = await fsp.readFile(lockPath, 'utf8');
  const lockHash = sha256(lockText);
  const state = await loadCache();
  const verificationKey = lockVerificationKey(lockHash, policy, registry);

  if (!opts.force && state.verifiedLocks && state.verifiedLocks[verificationKey]) {
    if (opts.verbose) console.log('npm-safe: lockfile already verified for this policy.');
    return;
  }

  const lock = JSON.parse(lockText);
  const packages = collectLockPackages(lock);
  const allowedSources = allowedRemoteSourcesFor(registry, policy);

  const exoticIssues = [];
  for (const pkg of packages) {
    for (const value of [pkg.version, pkg.resolved]) {
      const issue = classifyExotic(value, allowedSources);
      if (issue && !isAllowedIssue(issue, policy)) {
        exoticIssues.push({ name: pkg.name || pkg.path || '(unknown)', where: 'package-lock', spec: String(value), kind: issue.kind, hostname: issue.hostname });
      }
    }
  }
  if (exoticIssues.length) throw new Error(formatExoticIssues(exoticIssues));

  if (!policy.allowNew && policy.minAgeDays > 0) {
    await checkReleaseAges(packages, policy, registry, env, state, opts);
  }

  if (!state.verifiedLocks) state.verifiedLocks = {};
  state.verifiedLocks[verificationKey] = {
    verifiedAt: new Date().toISOString(),
    packageCount: packages.length,
    minAgeDays: policy.minAgeDays,
  };
  await saveCache(state);
}

function collectLockPackages(lock) {
  if (lock && lock.packages && typeof lock.packages === 'object') {
    const result = [];
    for (const [packagePath, entry] of Object.entries(lock.packages)) {
      if (!packagePath || !entry || entry.link) continue;
      const name = entry.name || nameFromPackagePath(packagePath);
      if (!name || !entry.version) continue;
      result.push({
        name,
        version: entry.version,
        resolved: entry.resolved,
        hasInstallScript: Boolean(entry.hasInstallScript),
        path: packagePath,
      });
    }
    return result;
  }

  const result = [];
  function walk(deps) {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, entry] of Object.entries(deps)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.version) {
        result.push({
          name,
          version: entry.version,
          resolved: entry.resolved,
          hasInstallScript: Boolean(entry.hasInstallScript),
          path: name,
        });
      }
      walk(entry.dependencies);
    }
  }
  walk(lock.dependencies);
  return result;
}

function nameFromPackagePath(packagePath) {
  const marker = 'node_modules/';
  const idx = packagePath.lastIndexOf(marker);
  if (idx === -1) return null;
  const tail = packagePath.slice(idx + marker.length);
  const parts = tail.split('/');
  if (parts[0] && parts[0].startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] || null;
}

async function checkReleaseAges(packages, policy, registry, env, state, opts) {
  const cutoff = Date.now() - policy.minAgeDays * 86400000;
  const candidates = uniquePackagesForAgeCheck(packages);
  const failures = [];

  if (!state.packageTimes) state.packageTimes = {};

  let checked = 0;
  await mapLimit(candidates, 8, async (pkg) => {
    const cacheKey = `${new URL(registry).origin}|${pkg.name}@${pkg.version}`;
    let publishedAt = state.packageTimes[cacheKey];

    if (!publishedAt) {
      const times = await getPackageTimes(pkg.name, registry, env);
      publishedAt = times[pkg.version];
      if (publishedAt) state.packageTimes[cacheKey] = publishedAt;
    }

    checked += 1;
    if (opts.verbose && checked % 50 === 0) console.log(`npm-safe: checked release age for ${checked}/${candidates.length} packages...`);

    if (!publishedAt) {
      failures.push({ name: pkg.name, version: pkg.version, reason: 'missing publish time' });
      return;
    }

    const publishedMs = Date.parse(publishedAt);
    if (!Number.isFinite(publishedMs)) {
      failures.push({ name: pkg.name, version: pkg.version, reason: `invalid publish time: ${publishedAt}` });
      return;
    }

    if (publishedMs > cutoff) {
      const ageHours = Math.max(0, (Date.now() - publishedMs) / 3600000);
      failures.push({
        name: pkg.name,
        version: pkg.version,
        reason: `published ${ageHours.toFixed(1)} hours ago`,
      });
    }
  });

  await saveCache(state);

  if (failures.length) {
    const lines = [`blocked package version(s) newer than ${policy.minAgeDays} day(s):`];
    for (const f of failures.slice(0, MAX_REPORT_ITEMS)) lines.push(`- ${f.name}@${f.version}: ${f.reason}`);
    if (failures.length > MAX_REPORT_ITEMS) lines.push(`... and ${failures.length - MAX_REPORT_ITEMS} more`);
    lines.push('Use --allow-new only when you intentionally accept fresh releases.');
    throw new Error(lines.join('\n'));
  }
}

function uniquePackagesForAgeCheck(packages) {
  const map = new Map();
  for (const pkg of packages) {
    if (!pkg.name || !isRegistryVersion(pkg.version)) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (!map.has(key)) map.set(key, { name: pkg.name, version: pkg.version });
  }
  return [...map.values()];
}

function isRegistryVersion(version) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version));
}

async function getPackageTimes(name, registry, env) {
  try {
    const metadata = await fetchPackageMetadata(name, registry);
    if (metadata && metadata.time) return metadata.time;
  } catch (_) {
    // Fall back to npm view, which can use the user's npm auth configuration.
  }

  try {
    const out = captureNpm(['view', name, 'time', '--json'], env);
    const parsed = JSON.parse(out);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    throw new Error(`failed to read publish time for ${name}: ${error.message}`);
  }

  throw new Error(`failed to read publish time for ${name}`);
}

async function fetchPackageMetadata(name, registry) {
  const base = ensureTrailingSlash(registry);
  const escaped = name.startsWith('@') ? `${name.split('/')[0]}%2f${name.split('/')[1]}` : encodeURIComponent(name);
  const url = new URL(escaped, base).toString();
  return await getJson(url);
}

function getJson(urlString, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 20000,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(getJson(next, redirects + 1));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
}

async function printInstallScriptSummary(lockPath) {
  const lock = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
  const packages = collectLockPackages(lock).filter((pkg) => pkg.hasInstallScript);
  if (!packages.length) return;

  console.log(`npm-safe: ${packages.length} package(s) declare install/build scripts; they were not run.`);
  for (const pkg of packages.slice(0, 8)) console.log(`  - ${pkg.name}@${pkg.version}`);
  if (packages.length > 8) console.log(`  ... and ${packages.length - 8} more`);
  console.log('npm-safe: if you trust one of them, run: npm-safe rebuild <package>');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function lockVerificationKey(lockHash, policy, registry) {
  return sha256(JSON.stringify({
    lockHash,
    registryOrigin: new URL(registry).origin,
    minAgeDays: policy.allowNew ? 0 : policy.minAgeDays,
    allowGit: policy.allowGit,
    allowRemote: policy.allowRemote,
    allowHosts: Array.from(policy.allowHosts || []).sort(),
    allowFile: policy.allowFile,
  }));
}

async function markLockfileVerified(lockPath, policy, registry) {
  const lockText = await fsp.readFile(lockPath, 'utf8');
  const state = await loadCache();
  if (!state.verifiedLocks) state.verifiedLocks = {};
  state.verifiedLocks[lockVerificationKey(sha256(lockText), policy, registry)] = {
    verifiedAt: new Date().toISOString(),
    minAgeDays: policy.allowNew ? 0 : policy.minAgeDays,
  };
  await saveCache(state);
}

async function cachePath() {
  const home = os.homedir();
  const projectKey = sha256(process.cwd()).slice(0, 16);
  if (home) {
    const base = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    return path.join(base, 'npm-safe', `${projectKey}.json`);
  }
  return path.join(process.cwd(), '.npm-safe-cache.json');
}

async function loadCache() {
  try {
    const p = await cachePath();
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (_) {
    return { packageTimes: {}, verifiedLocks: {} };
  }
}

async function saveCache(state) {
  const p = await cachePath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(state, null, 2));
}
