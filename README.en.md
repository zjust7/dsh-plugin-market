# dsh-plugin-market

A plugin market inside DeepSeek Harness. Search the DSH ecosystem and see each plugin's independent review verdict, audit tier, capability list and scanner red lines **before** you press install — and get stopped when an independent reviewer judged it harmful.

It does not host plugins, does not rank its own favourites to the top, and does not report "could not read" as "nothing wrong here".

[中文](README.md) | **English**

---

## Contents

- [The problem it solves](#the-problem-it-solves)
- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Where installed packages live](#where-installed-packages-live)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Data sources and freshness](#data-sources-and-freshness)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

---

## The problem it solves

The DSH ecosystem has thousands of community plugins but nowhere that answers the three practical questions:

1. **Is this plugin any good?** Stars show that people saw it, not that it works.
2. **Where does the thing I'm installing come from?** A package name and a repository are often two different things.
3. **What if it breaks?** You find out it is incompatible after installing, and removing it means editing config by hand.

This plugin puts all three in one window: **catalog + independent reviews + a reversible install**.

## Features

### 6,000+ plugins in one window

Three sources, one dialog:

| Tab | Contents |
|---|---|
| Curated catalog | 6,000+ community plugins with category, description, author, stars, downloads, plus the `dsh-trust-check` capability list and red lines |
| GitHub search | Repositories outside the catalog, clearly marked unscanned |
| Installed | Every bundle in the current profile, grouped by whether it is actually running; enable, update or remove |

Filter by category, sort by stars / downloads / name / updated, and page through — all in one list.

### Independent reviews before install

Integrates verdicts from [DSH Plugin Review](https://review.lingshulab.com). Each plugin shows **one verdict and one audit tier**:

| Verdict | Meaning |
|---|---|
| Helpful | Installing it measurably got the task done |
| Harmful | Installing it made things worse |
| No difference | No measurable difference in the tested scope |
| Inconclusive | Not enough data |
| Not testable | The environment or task did not apply |

Tiers are self-test / quick test / standard review / deep audit. A report whose title states no tier is shown as "not stated" rather than guessed.

### A harmful verdict stops you

A red badge in a list arrives too late: by the time it is visible, the reader has already decided. So the confirmation bar **expands that report** — reviewer, date, link — and requires an explicit "I read it" tick before the install button unlocks.

**It never blocks the install.** The decision stays with the reader; the gate only makes sure they saw why.

### Know where it comes from

Every detail drawer carries a provenance table:

| Field | Why it matters |
|---|---|
| Installs from | The exact spec handed to the package manager — the most load-bearing line |
| Repository / publisher | Clickable |
| Channel | npm registry or Git repository; the two have completely different update semantics |
| Repository updated / review record updated | Whether the report predates the code you are about to run |
| Star data from / download data from | How fresh the catalog numbers are |
| Listed via | Curated catalog, or discovered through GitHub search |

### Installs have progress, failures speak plainly

Installing is not a spinner:

- A phase bar: preparing → checking → installing → applying → done
- Live package-manager output
- Elapsed time, cancellable at any point
- Failures translated into one plain sentence plus a next step, with the raw output folded behind "show details"

### Also

- **Version history**: latest plus up to 30 earlier versions, the installed one marked, any installable version one click away
- **Screenshot gallery**: shown at the top of the drawer when the plugin publishes screenshots
- **Ask the author**: jumps to GitHub Issues or Discussions, only when the repository actually enables them
- **Favourites and notes**: stored locally, never uploaded
- **中 / EN**: catalog blurbs come from the author's own bilingual text, not machine translation

## Install

### From GitHub (recommended)

```bash
dsh plugin add github:zjust7/dsh-plugin-market
```

A **Market** button appears beside Settings in the sidebar.

> This package is **not published to npm** (`private: true`), so the bare-name form
> `dsh plugin add dsh-plugin-market` will not resolve. Use the `github:` prefix.

### From a local checkout

```bash
dsh plugin add /path/to/dsh-plugin-market
```

### With an AI agent

Hand the agent this together with the repository URL:

```text
Install the plugin market in this DSH profile:
1. Run `dsh plugin list` to confirm the current profile
2. Run `dsh plugin add github:zjust7/dsh-plugin-market`
3. Confirm the output shows it as enabled
4. Restart DSH and look for the "Market" button in the sidebar
If it fails, keep the full output before reporting. Do not retry silently
with a different command.
```

## Usage

1. Click **Market** in the sidebar (close with ✕, Escape, or a click outside)
2. Search the curated catalog by name, description or capability
3. Click any row for the detail drawer
4. Check provenance, reviews and version, then press **Install** → confirmation bar → done

Packages that need build scripts are never silently approved; they surface as one more authorisation click.

## Where installed packages live

Packages installed from the market go through the profile's own package manager and land in:

```
<profile>/node_modules/<package>/
```

They are also recorded in that profile's `package.json` and `dsh.profile.bundles`. They do not land in this repository.

## Configuration

All fields are optional; defaults are in `cordis.patch.yml`.

| Field | Default | Meaning |
|---|---|---|
| `catalogTimeoutMs` | `45000` | Per-request timeout while building the catalog (2000–180000 ms) |
| `searchTimeoutMs` | `15000` | Timeout for GitHub / npm requests (2000–180000 ms) |
| `reviewSnapshotUrl` | built-in | Review snapshot address; point it at your own mirror |

## Security model

- **No agent tool is registered.** Installs only happen from a click; no model turn can import code.
- The window talks to the Host over authenticated exact routes, sharing the same browser session check as the rest of the Web API.
- Installs go through the profile's own `pluginManager`; a failed or cancelled install restores `package.json` and the lockfile.
- Packages needing build scripts are never silently approved.
- Only public third-party data is read: nothing is written, submitted, or authenticated to anyone else's account.

## Data sources and freshness

| Data | Source | Refresh |
|---|---|---|
| Plugin catalog | `awesome-dsh-plugin.com/plugins.json` | Rebuilt upstream daily |
| Live stars | `api.github.com` batch search | Once per visible page, cached 10 minutes |
| Version history | npm registry / GitHub Release | On demand, cached 30 minutes |
| Review verdicts | A published snapshot file | Daily, with a packaged copy as fallback |

**Three honesty rules**, enforced by implementation and tests:

1. A value that could not be read is `null` and renders as `—`, never `0`
2. A report with no stated tier shows "not stated" — it is not guessed
3. "Security swept" only means the tier was a deep audit or a security-focused quick test; a capability verdict is not a security endorsement

## Development

```bash
node smoke-host.mjs     # quick smoke test
node verify-host.mjs    # full contract suite (needs network)

DSH_MARKET_OFFLINE=1 node verify-host.mjs   # skip network sections
```

The Host half is `index.js`; the browser half is `client.js`, a plain module loaded through `window.__ModuleLoader__` with no build step. The contract between them is documented in [`docs/API.md`](docs/API.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/API.md](docs/API.md) | Host ↔ browser contract, with the reasoning behind each field |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version, and why |
| [docs/DESIGN-0.09.md](docs/DESIGN-0.09.md) | Design decisions from one UI review |
| [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) | Pre-release checklist |

## License

MIT
