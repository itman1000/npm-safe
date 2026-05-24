# @itman1000/npm-safe

`npm-safe` is a small safety wrapper for `npm install`. It supports npm 6 and newer.

## Standard version

Install once:

```bash
npm install -g @itman1000/npm-safe --ignore-scripts
```

Then use `npm-safe install` instead of `npm install`:

```bash
npm-safe install
npm-safe install axios
npm-safe install -D vitest
```

What it does by default:

- blocks package versions published less than 7 days ago
- runs npm with install scripts disabled
- blocks git, non-registry tarball, and local `file:` dependencies
- lightly removes sensitive environment variables before starting npm

## Why npm-safe?

`pnpm` is a strong option if your project can migrate. `npm-safe` is for projects that want safer installs while keeping npm, `package-lock.json`, and npm 6+ compatibility.

| Capability | `npm install` | `pnpm install` with recent/configured protections | `npm-safe install` |
| --- | --- | --- | --- |
| Works with existing `package-lock.json` | Yes | No, uses `pnpm-lock.yaml` | Yes |
| Blocks dependency install scripts by default | No | Yes, with build approval/protection settings | Yes |
| Avoids very new package versions | Manual config in newer npm | Built-in/configurable in recent pnpm | Yes, 7 days by default, including npm 6 |
| Blocks git, remote tarball, and `file:` dependencies | Manual config in newer npm | Strong controls in recent pnpm | Yes, by default |
| Removes token-like environment variables before install | No | No | Yes, lightweight filtering |
| Main tradeoff | Fast and familiar, fewer guardrails | Strong, but requires pnpm migration | Slightly slower than npm, no migration |

When a trusted package needs a build script, run only that package manually:

```bash
npm-safe rebuild esbuild
```

For CI, exceptions, strict verification, and private registry notes, read [ADVANCED.md](./ADVANCED.md).
