# dsh-wechat-share

Forward WeChat chat records into DSH sessions. A Windows share target captures the merged-forward ZIP from WeChat's "转发 → 其他应用" menu, a DSH plugin watches the local inbox, and a GUI overlay lets you pick the destination workspace + session. The ZIP arrives in that session as a file-attachment user message — the agent unpacks it and reads the chat log (text + images) directly.

## What it does

- **WeChat side**: a registered MSIX share target named **DSH Harness** appears in WeChat PC's "其他应用" share list (no 微信/WeChat substring in the display name — WeChat filters those out).
- **Capture**: the stub (C#/.NET 8, WinRT activation) validates the payload (ZIP only), normalizes media entry extensions by magic bytes (WeChat routinely ships PNG/HEIC bytes named `.jpg`), and atomically commits the batch to `%APPDATA%\dsh-desktop\harness\wxshare\inbox\Ready\<batchId>\` (manifest + files).
- **DSH side** (this plugin): an inbox watcher (fs.watch + 2s polling fallback, startup sweep for batches dropped while DSH was closed), three web routes (`/wxshare/api/state|deliver|dismiss`), and a `shell.overlay` client: a full-screen picker with the batch summary, a workspace→session two-level list (real session titles from the projection cache, blank sessions hidden, most-recent-first), and 投递/忽略 actions.
- **Delivery**: each ZIP is streamed (64KB chunks) through the host `fileUploads` service and submitted as one queued prompt — a text part (「微信聊天记录转发（来自微信，N 个文件，共 X MB）。请解压并阅读：」) plus file parts. Any failure preserves the batch in Ready for retry (batch-preserving error contract).
- **Lifecycle**: delivered/dismissed batches move to `inbox\Done\<yyyyMMdd>\` with an `outcome.json`; TTL pruning (Ready 30d, Done 7d).

## Requirements

- Windows 10/11 with **Developer Mode** enabled (the share target is registered via the unsigned dev-mode path on this project's build machines; a signed production package needs the AXCD digest formula — see `packaging/` notes)
- DSH Desktop with the web profile (the plugin installs into the profile's bundle set)
- WeChat PC (the share source)

## Install

```powershell
# from this repo root
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun   # preview
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Execute  # install
```

The installer: (1) builds + registers the share target MSIX, (2) copies the plugin into a hash-pinned generation dir, (3) registers it in the profile's three-layer registry (desired.json + generation.json + pnpm via `dsh plugin install`), (4) verifies resolution. Uninstall: `scripts\uninstall.ps1 -Execute` (exact reverse, including share-target removal).

Restart DSH Desktop after installing. In WeChat: select messages → 合并转发 → 其他应用 → **DSH Harness** → pick a session in the overlay → 投递.

## Usage notes

- If DSH is closed when you forward, the batch queues silently in the inbox; the next DSH start sweeps it and the overlay appears (nothing is lost).
- Forwarding something that is not a ZIP is rejected on the WeChat side with a Chinese message; nothing reaches the inbox.
- The overlay lists sessions with their real titles; sessions that never had a conversation are hidden (same rule as the DSH sidebar).

## Repository layout

| Path | Responsibility |
|---|---|
| `index.js`, `client.js`, `lib/`, `locale/` | the DSH plugin (host routes + overlay client) |
| `package.json` (`dsh.bundle`) + `cordis.patch.yml` | bundle manifest (installable via `dsh plugin add`) |
| `stub/` | C#/.NET 8 Windows share target (WinRT activation → validate → normalize → atomic commit) + xunit tests |
| `packaging/` | MSIX manifest, build/register scripts, signing toolchain (dev-mode path) |
| `scripts/` | install.ps1 / uninstall.ps1 (three-layer registration, dry-run capable) |
| `test/` | plugin tests (node:test, 22 cases) |
| `docs/` | e2e report, host-open probe (wake OS boundary), Context7 quality check |
| `assets/` | storefront icon + screenshots (declared in `screenshots.json`) |

## Development

```bash
node --test test/                     # plugin tests (any Node ≥ 20; repo pins vendor Node 24)
dotnet test stub/tests/               # stub tests (.NET 8, Windows)
pwsh scripts/install.ps1 -DryRun      # installer preflight
```

Design decisions and production evidence (including the mediumIL wake boundary and the WeChat placeholder write-denial) are in `docs/`.
