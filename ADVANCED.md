# @itman1000/npm-safe Advanced version

This guide explains optional controls and operational details for people who need more than the Standard version.

The Standard version is intentionally short: install `@itman1000/npm-safe`, then use `npm-safe install` instead of `npm install`.

## Design goal

`npm-safe` is not a full malware scanner. Its job is narrower:

> Reduce the risk that `npm install` immediately runs compromised dependency code and exposes local credentials.

The default policy keeps the common command simple while blocking high-value install-time attack paths.

## Default policy

```json
{
  "minAgeDays": 7,
  "ignoreScripts": true,
  "blockGitDependencies": true,
  "blockNonRegistryRemoteTarballs": true,
  "blockFileDependencies": true,
  "sanitizeEnvironment": "simple",
  "strictTarballVerification": false
}
```

## Installation

`npm-safe` supports npm 6 and newer. npm 5 and earlier are not supported.

Install `@itman1000/npm-safe` once:

```bash
npm install -g @itman1000/npm-safe --ignore-scripts
```

Then use it in a project directory:

```bash
npm-safe install
npm-safe install axios
npm-safe install -D vitest
```

## Commands

### Install

```bash
npm-safe install
npm-safe install axios
npm-safe install -D vitest
```

`npm-safe install` first asks npm to resolve a candidate lockfile with scripts disabled. It checks the lockfile policy before doing the actual install. npm install scripts are disabled in both steps.

### CI

```bash
npm-safe ci
```

`ci` requires `package-lock.json` or `npm-shrinkwrap.json`. It checks the lockfile before running `npm ci --ignore-scripts`.

### Rebuild trusted packages

```bash
npm-safe rebuild esbuild
npm-safe rebuild sharp
npm-safe rebuild playwright
```

This is the intended escape hatch for packages that legitimately need build/install scripts. Use it only for packages you trust.

### Strict verification

```bash
npm-safe verify --strict
```

This checks the lockfile policy and then runs:

```bash
npm audit signatures
```

This requires an npm version that supports registry signature verification.

## Release-age gate

Default policy:

```text
Do not install package versions published less than 7 days ago.
```

Override the cooldown period:

```bash
npm-safe install --min-age=1
npm-safe install --min-age=14
```

Disable the gate for a single run:

```bash
npm-safe install @your-org/security-fix --allow-new
```

Implementation detail:

- npm 11.10+ uses `--min-release-age=<days>`
- npm 6 through 10 use `--before=<now - days>`
- npm 5 and earlier are rejected before install
- `npm-safe ci` also checks publish times inside the lockfile

npm 5.7+ could support some of these behaviors in theory, but npm-safe intentionally does not support it because it would add more install-behavior compatibility checks and user-facing exceptions.

## Non-registry dependency sources

Blocked by default:

```text
git+https://...
github:user/repo
https://example.com/pkg.tgz
file:../local-package
../local-package
```

Allow only when the source is intentional and trusted:

```bash
npm-safe install --allow-git
npm-safe install --allow-host cdn.company.example
npm-safe install --allow-remote
npm-safe install --allow-file
npm-safe install --allow-exotic
```

`--allow-host <host>` allows remote tarballs from one trusted host only. Prefer this for private registry CDNs.

`--allow-remote` allows remote tarball URLs from any host. Use it only when `--allow-host` is not enough.

`--allow-exotic` is shorthand for `--allow-git`, `--allow-remote`, and `--allow-file`.

## Environment handling

`npm-safe` tries not to pass common credential-related environment variables to the npm process.

This is a supplemental defense. The main defense is still that dependency install scripts are not run.

Normally, you do not need to think about this behavior. Review this section only if you use a private registry, a proxy, or special CI environment settings.

For example, variables with names like these are removed before npm is started:

```text
*_TOKEN
*_SECRET
*_PASSWORD
*_PRIVATE_KEY
*_CREDENTIAL
*_ACCESS_KEY
*_API_KEY
SSH_AUTH_SOCK
GIT_ASKPASS
SSH_ASKPASS
GIT_SSH_COMMAND
NODE_OPTIONS
```

This list is illustrative, not a guarantee that every possible secret name is recognized.

By default, `npm-safe` prints only the number of removed variables:

```text
npm-safe: sanitized 3 sensitive environment variable(s)
```

With `--verbose`, it prints the removed variable names. It never prints their values.

```bash
npm-safe install --verbose
```

Example:

```text
npm-safe: sanitized environment variable(s):
  - GITHUB_TOKEN
  - NPM_TOKEN
  - SSH_AUTH_SOCK
```

Do not use `--verbose` in CI logs if variable names themselves reveal internal system details.

Disable environment sanitization for one run:

```bash
npm-safe install --no-env-sanitize
```

Use this only in controlled environments.

## Private registries

A registry is the server npm asks for package metadata. The public default is:

```text
https://registry.npmjs.org/
```

Companies and teams may use private registries such as GitHub Packages, GitLab Package Registry, Artifactory, Nexus Repository, Verdaccio, or an internal npm-compatible registry.

A tarball is the `.tgz` file that contains the package contents. npm installation roughly works like this:

```text
1. Ask the registry for package metadata.
2. Read the tarball URL from that metadata.
3. Download the .tgz tarball.
4. Extract it into node_modules.
```

`npm-safe` allows tarballs from the active registry host and the public npm registry host. It blocks unrelated remote tarball URLs by default.

In private registry setups, the registry host and tarball host may be different. For example:

```text
registry:
  https://npm.company.example/

tarball:
  https://cdn.company.example/packages/foo-1.0.0.tgz
```

If the tarball host is a trusted company registry or CDN, allow only that host:

```bash
npm-safe install --allow-host cdn.company.example
```

`--allow-host` accepts a hostname or URL. Only the hostname is used.

```bash
npm-safe install --allow-host https://cdn.company.example/packages/
```

Avoid `--allow-remote` unless you really need to allow arbitrary remote tarball URLs for that run.

Recommended private registry practices:

- Use read-only tokens for install.
- Do not use publish tokens during install.
- Scope tokens to the specific registry host in `.npmrc`.
- Prefer `npm-safe ci` in CI.

## Cache

`npm-safe` caches publish times and verified lockfile hashes under the user cache directory:

```text
~/.cache/npm-safe/
```

This avoids repeatedly asking the registry for the same package publish times.

## Limitations

`npm-safe` reduces install-time risk. It does not prove that a package is safe.

It does not fully protect against:

- malicious runtime code imported by your application
- a compromised package version that is older than the cooldown period
- a compromised package already pinned in a lockfile and allowed by policy
- users manually running malicious scripts
- credentials that already leaked before using `npm-safe`

## Recommended CI example

```yaml
name: dependency-install
on: [push, pull_request]

jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g @itman1000/npm-safe --ignore-scripts
      - run: npm-safe ci
      - run: npm-safe verify --strict
```
