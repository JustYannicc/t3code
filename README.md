# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

## Yannic's patched desktop build

`yannic/patched` is a personal macOS build for Signalbox issue #779. It keeps
upstream's `~/.t3` data directory. Never run it alongside the stock app against
the same data. Keep the stock app and back up the data before switching.

Merge order for the 2026-10-17 build:

1. Start at upstream `pingdotgg/t3code` main, `130f4a2457172eb62bfd53ae9f5fa16cae8be5d5`.
2. Merge `JustYannicc/t3code:fix/history-compaction-worker`, `77efd635d4`, with
   `--no-ff`. This is the upstream equivalent of Signalbox #783: discovery reads
   use the reader worker and compaction yields between bounded work slices.
3. Merge upstream PR #20809, `b8a4ef698ea793504692be43358b22b7db51f6c8`, with
   `--no-ff`. It includes `32b15c5c150c`, `677991191ad6`, and `b8a4ef698ea7`.
4. Cherry-pick the reviewed follow-up from Signalbox #781, `e101c52f4535`,
   retaining its source attribution. It keeps the old Stop target disabled and
   offers Resume separately because the upstream one-second guard was insufficient.
   The upstream port removes its Signalbox-only `sendLock` reference.

Candidate PRs #19917, #20064, and #20203 are not included. Signalbox #779 had
not marked them adopted when this build was assembled. No other candidate PRs
from that issue are included.

Build with the upstream packaging script and
`--build-version 0.1.1-preview.20261017.1`. The preview version is a build-time
flag: upstream deliberately omits its update feed, so this app cannot update
to stock releases. Do not add an update feed or change user settings.

For later builds, merge a pinned new `upstream/main` into this branch, then
merge newly adopted PR heads with `--no-ff`. Never rebase published history.
Recheck existing fixes for overlap, update this merge list and the preview
version, and repeat fixture checks before packaging.

```sh
cp .env.example .env
taskpolicy -b nice -n 19 pnpm install --frozen-lockfile
RUSTUP_TOOLCHAIN=stable PATH="$PWD/node_modules/.bin:$PATH" \
  taskpolicy -b nice -n 19 node scripts/build-desktop-artifact.ts \
  --platform mac --target dmg --arch arm64 \
  --build-version 0.1.1-preview.20261017.1 \
  --output-dir "$HOME/Applications-patched" --verbose
```

The public `.env.example` preserves T3 Connect configuration. No signing keys
are required. Keep the built app outside this clone, and remove the clone's
`node_modules` after verification. See `~/Documents/signalbox-design/patched-t3code.md`
for the artifact location, checks, switching, and rollback instructions.
