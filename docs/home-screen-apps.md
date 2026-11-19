# How the stores get a tile on the home screen

The question was how ProsperoStore, Pegasus DL+, Playden and the rest have real
apps in the PS5's app row. The answer is the same for every one of them, and it
is smaller than expected: **none of them ships an FPKG, and none of them is
signed.** They are folders on the console that a payload called
**ShadowMountPlus** registers with the shell.

Prospero Vault now ships one of these folders too. `console-native/` builds
`PVLT00001` as a native title with its own VideoOut interface; the payload is the
backend, not the window. The rest of this page records the mechanism, the route
that was taken, and the fallback that remains.

## What each project actually ships

| Project | Artifact | How the tile exists | UI is drawn by |
|---|---|---|---|
| ProsperoStore (`PPSA99000`) | `PPSA99000.zip` → folder | ShadowMountPlus scan of `/data/homebrew` | native C++ (VideoOut), own store UI |
| Pegasus DL+ (`PPSA99998`) | `PPSA99998.ffpfsc` (one file) | same, via the image container | native |
| Playden (`FAKE77031`) | folder | same, plus **one generated folder per Steam game** | native, Godot/OpenGL (`ps5-opengl`, `ps5-homebrew-ui`) |
| RecompStore (`PPSA92000`) | `PPSA92000.zip` | same; an installer ELF unpacks it | native |
| ProsperoWeb (`PRWB00001`) | `PRWB00001.zip` | same | WebKit relinked as a title |
| ps5-homebrew-starter / boilerplate | `dist/<TITLE_ID>.zip` | same | native C++20 skeleton |
| Sonic Loader (`PSPS69691`) | a real `.pkg` | Sony's installer, so no payload needed | the console's browser |
| Prospero Vault (current) | `console-native/dist/install.elf` writes the folder | ShadowMountPlus scan of `/data/homebrew` | native C++ (VideoOut), payload backend on `:8097` |

## The mechanism, exactly

A title is a directory named after its title ID:

```
/data/homebrew/PVLT00001/
  eboot.bin              the program: a PS5 native ELF
  sce_sys/param.json     title id and displayed name
  sce_sys/icon0.png      512x512 PNG — the tile art
  sce_sys/pic0.dds       optional, 3840x2160 BC7 DDS — background while selected
  sce_sys/pic1.dds       optional, 3840x2160 BC7 DDS — background while launching
  sce_module/libc.prx    the runtime companion the native layout expects
```

ShadowMountPlus scans `/data/homebrew`, `/data/etaHEN/games`, `/mnt/ext0..1`,
`/mnt/usb0..7` (and `.../homebrew` under each) every ~15 s and registers any
folder holding `eboot.bin` (or `eboot2.bin`) **and** `sce_sys/param.json`. The
shell then shows it in the app row with its icon, and starts it like a game. No
FPKG, no `param.sfo`, no `prospero-pub-cmd`, no debug mode, no Sony signature.

Details that decide whether it works:

- **Title ID** must be four uppercase letters plus five digits. Any prefix
  except `PPSA`, `CUSA` and `NPXS` is treated as homebrew — `PRWB`, `FAKE`,
  `PSPS` and `LAPY` are all in use. Pick one and keep it stable, because the
  tile, the saves and the updates are keyed by it.
- **`param.json` is parsed by string search, not a JSON parser.** It reads
  `titleId` (falling back to `title_id`) and `titleName`, preferring the
  `"en-US"` object when present. File limit 1 MiB, name limit 256 chars.
- **`icon0.png` must be 512x512.** It is the only art most projects ship.
- **Permissions must be 777.** A folder copied by an ordinary FTP client lands
  as 755/644 and the console answers `CE-107750-0` ("Can't start the game or
  app"). `ftpsrv` uploads correctly; the boilerplate's ZIP stores every entry
  as 0777 and its deploy target publishes `eboot.bin` last.
- **The scan is deferred while any app or game is running** (`scan_deferred:
  game_active`). That is why Playden says a new game's tile appears *when
  Playden quits*, and why an installer has to ask for a rescan.
- **Category is set in `param.json`**: `applicationCategoryType 0` with
  `contentBadgeType 1` is the Games shelf; the boilerplate's
  `APP_CATEGORY=media` puts it in Media instead.

### The one-file variant

Pegasus ships `PPSA99998.ffpfsc` — a PFS container holding that same folder.
ShadowMountPlus mounts it (experimental) and registers what is inside, with the
scan root `/mnt/shadowmnt/pfsc`. It is a distribution convenience, not a
different mechanism: one file is easier to copy than 2,700. ProsperoStore lists
these images in its catalog but cannot install them.

### If you want a real PKG instead

Sonic Loader's tile is a genuine `.pkg` built with Sony's `prospero-pub-cmd`
from the leaked SDK, run under Wine on Linux — its sources are in `pkg-source/`
(`.gp5`, `param.json`, `param.sfo`, `build_sfo.py`). That path needs the leaked
tool and a debug-mode console. This repository already carries the other half of
it: `packer/.deps/LibProsperoPkg` has `ProsperoHomebrewPackager`, which
fake-signs a homebrew module and builds an installable debug fPKG with the
license-free mount path. **Neither removes the hard part below**, because both
still want a native `eboot.bin` as input.

## The Vault title, in this repository

`PVLT00001` is a native title now:

```
/data/homebrew/PVLT00001/
  eboot.bin              development FSELF (magic 0x1D3D154F) around a native ELF
                         with e_type=0xFE10 and the process-parameter block
  sce_module/libc.prx    generated clean-room runtime, 1,284,674 bytes,
                         SHA-256 e6ff45d1...ba0036
  sce_sys/param.json     titleId PVLT00001, game category
  sce_sys/icon0.png      512x512
  assets/build.txt       which build is on the console
```

`console-native/build.sh` compiles the app with the public payload SDK's Clang
target, links it with the native-app CRT and `ps5-pie.ld` (process parameters,
RELRO anchored to `.data.rel.ro`, every `PT_LOAD` congruent modulo `0x4000`),
converts it with the `ps5-native-tool` FSELF writer, and packages the folder.
`dist/install.elf` is a one-shot `elfldr` payload: it stops a running Vault,
writes all five files with `0777`, and leaves the tile ready.

The earlier failure is understood. A probe built from the payload ELF without
the native layout died with `0x80AA001A`
(`SCE_SYSCORE_ERROR_ABORT_WHEN_CREATING_NEW_PROCESS`). That code is also what a
mismatched `PT_LOAD` produces: the file offset and virtual address must agree
modulo `0x4000`, and RELRO must be anchored to the first section of the region
(`.data.rel.ro`), not to the GOT. With that fixed and the runtime companion in
place, ShadowMount+ registers the folder and LNC launches the title.

What was verified on **13.20**: the installer wrote the folder, ShadowMount+
reported `status: 0`, LNC held `PVLT00001` as the running big app, and the
in-title status endpoint on `:8096` reported an increasing frame count with 21
titles from the backend. The screen layout and controller mapping were not
captured; that is the remaining visual check.

## The hard part is not the tile

`eboot.bin` has to be a **native PS5 application**, and a payload ELF is not
one. ProsperoWeb records the incompatibility precisely: a native title's eboot
is a signed development FSELF (`magic 0x1D3D154F`) wrapping an ELF with
`e_type=0xFE10`, it loads `sce_module/libc.prx`, and it resolves `.sprx`
imports through NID metadata — while a payload ELF is self-relocating and
resolves them through the payload SDK's own `rtld` at runtime. Renaming the
existing `prospero-vault.elf` and copying a `param.json` next to it produces a
tile that crashes on launch. `console/Makefile` builds exactly that payload ELF
(`-Wl,--no-pie`, `PV_HAVE_SONY=1`), so it cannot be reused as-is.

So the tile is cheap and the renderer is the work. Three ways, in the order the
scene actually uses them:

1. **Draw the UI natively in C++** — the boilerplate's CPU VideoOut skeleton
   (verified on firmware 6.02 and 12.70), or SDL2/OpenGL as Playden does with
   `ps5-opengl` and `ps5-homebrew-ui`. Every store in the table above, except
   ProsperoWeb, took this route. Controller input, focus and the console look
   are then ours to reproduce, which is also what the UI work so far has been.
2. **Relink a browser as the title** — ProsperoWeb's route, and the only way to
   keep an HTML UI. Its own document lists 23 console runs, an IPC stall between
   the sandboxed UI and its payload children, and "not verified on hardware" for
   WebKit and SDL under the title's memory limits. It needs both a native eboot
   *and* the payload ELF in the same folder.
3. **Ship a PKG that opens the web page** — Sonic Loader's trick. The tile is
   real, but the UI is still the console's browser in a bare window, and the
   build needs `prospero-pub-cmd` plus a debug console.

For Prospero Vault, route 1 is the one that produced a genuine app-row tile with
the interface inside it (`console-native/`). Route 3 keeps the HTML as-is but
still looks like a browser window. Route 2 is the most expensive and, on the
evidence available, has not been shown to work.

**Build host.** Upstream describes the native toolchain
(`ps5-native-app-boilerplate`, Clang + lld + make + python3) as Linux/WSL-only.
The two host programs and the deterministic runtime emitter are portable C++20,
so this repository's title also builds on macOS with Homebrew LLVM and the
payload SDK already used for the payload. The toolchain is not vendored (it is
GPL-3.0); `console-native/tools/bootstrap-toolchain.sh` reconstructs it and
checks the runtime against its pinned SHA-256.

## What this repository does now

The native title is the primary path. The payload still contains the older
web-app shell fallback, but it now refuses to overwrite a native `eboot.bin` or
delete the native folder: on a native install, `POST /api/home-app` returns the
"left alone" message and `POST /api/home-app/remove` refuses. The fallback is
for consoles that have not staged `console-native/dist/install.elf`.

That fallback works because a *folder* registered by ShadowMountPlus needs no
signing — the Sonic Loader PKG exists only to ship the same folder through Sony's
installer, which does need one.

```
/data/homebrew/PVLT00001/
  eboot.bin              copied from /system_ex/app/NPXS40106/eboot.bin
  sce_sys/param.json     titleId PVLT00001, deeplinkUri http://127.0.0.1:<port>/
  sce_sys/icon0.png      512x512, drawn by console/tools/icon.py and embedded
```

- **Why the shell eboot (fallback only).** A payload ELF is not a title, so the
  fallback folder carries the console's web-app shell, which opens the address
  in `deeplinkUri` — the same pairing the Homebrew Launcher and Sonic Loader use.
  The native title replaces this with its own `eboot.bin`.
- **`deeplinkUri` is the load-bearing field.** Without it the shell has nothing
  to open and the tile does nothing. It points at `127.0.0.1` because the tile is
  only meaningful on the console itself.
- **The icon is generated, not a placeholder.** `tools/icon.py` draws the same
  vault-door mark the interface uses in its heading, in the app's palette, and
  `tools/embed.py` puts the PNG into the ELF. One file to copy to the console.
- **Permissions are set on write**, so the `CE-107750-0` trap that catches FTP
  users cannot happen here.
- **The scan is requested, not waited for**: `POST /api/v1/scan` asks
  ShadowMountPlus for its next pass instead of leaving the tile to appear up to
  fifteen seconds later.
- **The folder is excluded from the library scan**, so the app does not list
  itself as a dump.
- **A written folder is not a tile, and is not reported as one.** Registration is
  confirmed by asking ShadowMountPlus per title, `POST /api/v1/games/info` with
  `{"title_id":"PVLT00001"}` — a `200` whose envelope reports `status: 0` is a
  tile, a `404` is not, and a connection failure is "nothing is listening". The library
  list (`/api/v1/games`) is deliberately *not* used for this: its answer is far
  larger than the 16 KiB one HTTP reply here holds, and a title near the end of a
  truncated list would read as "not registered".
- **Removal has to work while the app is running**, and ShadowMountPlus refuses
  to uninstall the live title — which this is. So the order is: delete
  `/data/homebrew/PVLT00001`, then `POST /api/v1/games/uninstall`, then
  `/api/v1/scan`. A registration whose source has gone is dropped by that scan.
  A marker file (`/data/prospero-vault/home-app-off`) stops the next start from
  re-creating it; pressing Add again clears the marker.

A game installed by this app gets its own tile the console's way:
`sceAppInstUtilAppInstallPkg` registers the title with the shell, which puts it in
Games like any other installed title. Both tiles — the app's and each game's —
come from the console's own registration path.

## Sources

- `drakmor/ShadowMountPlus` — scan paths, homebrew ID rules, `param.json`
  registration, `CE-107750-0`; issue #166 for `scan_deferred: game_active`.
- `blackbearreloaded/ProsperoStore` — install steps, permissions, install
  locations, `.ffpfsc` limitation.
- `blackbearreloaded/ps5-native-app-boilerplate` — title layout, `make init`,
  presentation assets (512 icon, 3840x2160 BC7 DDS, ATRAC9), Linux/WSL list.
- `kvaps/ProsperoWeb` `docs/native-title.md` — payload ELF vs native eboot,
  FSELF constants, launch chain, console-run log.
- `pegasus-ps5/pegasus-dl` — `.ffpfsc` release artifact.
- `leolobato/playden-ps5` — one folder and icon per game, tile appears after the
  app quits, `CE-107750-0` on a lost execute bit.
- `aloksaurabh/sonicloader` — real PKG tile, `pkg-source/`, `prospero-pub-cmd`.
- `MiladRTX/ps5-homebrew-starter` `docs/05-first-app.md` — the shortest correct
  description of the folder and the scan.
