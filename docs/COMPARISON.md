# How Prospero Vault compares

Two tools solve the same first problem — get a game onto a jailbroken PS5 and
give it a tile on the home screen — from opposite directions.

* **Prospero Vault** turns a dump into a real debug FPKG on a Mac, installs it
  through the console's own installer, and then launches the installed title.
* **Kraken Mount** (quer3q, GPL-3.0, v0.3.0) never installs: it mounts a debug
  FPKG or a game folder from wherever it lives (internal SSD, M.2, USB) and
  registers a tile that launches from the source, with a per-game cache on the
  internal SSD.

Both are legitimate answers. The difference is what you pay and what you get.

| | Prospero Vault | Kraken Mount v0.3.0 |
| --- | --- | --- |
| Where the game runs from | Installed into the console's own storage through Sony's installer | Mounted from its source (internal, M.2, USB) |
| Disk cost | One copy of the package | Cache only; the source stays where it is |
| Formats | Game folders, `.exfat`, `.ffpfsc`, `.ffpfs`, `.ffpkg`, `.gp5`, debug `.pkg`, existing installed apps | Debug FPKG, plain folder, zstd folder, LZ4 folder |
| Building a package | Yes — fpkg-cli, orbis-pub-cmd, LibProsperoPkg, or a custom command, with AC/DLC packing | No — it mounts what already exists; sparse-extent PKGs must be repacked (`--kraken stored`) |
| A dump that lives only on the console | Pulled to the Mac with a resumable, byte-verified transfer, then built | Mounted directly, no copy |
| Scanning | Paths you choose, plus what the console reports from `/data`, `/user/data` and USB | Fixed roots, zero config: `/data/homebrew`, `/data/etaHEN/games`, drive roots, USB |
| Interface | Native PS5 title drawn with VideoOut and the DualSense, plus a desktop app for the library | Web UI on the console |
| DLC and PlayGo | Packed by `acpack` when you build | Bundled `dlc_emu` and `pgo_stub`, added automatically |
| Saves and trophies | Untouched — the installed title uses the console's own modules | v0.3.0 stopped shadowing `libSceSaveData` after saves went missing (#64, #68) |
| Failure reporting | Every failure carries a sentence and a name; simulated builds are labelled and refused by the console | Log lines and a title that does not appear |
| Requirements | kstuff + elfldr, the native-app toolchain to build the title, a Mac with a packer | kstuff, ShadowMount+ stopped |
| Console firmware | Payload runs on 13.20 (tested); 14.xx has no public exploit | Same exploit ceiling applies |
| FPKG install/launch | Public kstuff ceiling is 11.60; 13.20 rejects with `0x80BD0005` | Mounts without installing, so it is the working route above 11.60 |

Both tools need a jailbroken console first. As of November 2026 public chains
stop at **13.60**; 14.00/14.10 are private and 14.20+ has no public jailbreak. No
application-level change can lift that ceiling. FPKG support is narrower still:
public kstuff installs and launches debug packages only through **11.60**.

## Where Kraken Mount is ahead, honestly

* **No copy, no wait.** A 60 GB game launches from the drive it already sits on.
  Installing the same game costs 60 GB of console storage and the time to write it.
* **Zero-configuration discovery.** It knows the usual roots. Ours asks you to
  point at a folder the first time.
* **Compressed folders.** zstd and LZ4 folder dumps are read directly; we only
  take them uncompressed.
* **DLC and PlayGo emulators bundled.** We can pack AC/DLC from a Mac, but the
  console side does not ship emulators.

## Where Prospero Vault is ahead

* **It can make the package at all.** A dump is not playable as-is; something has
  to build it. Kraken Mount mounts a debug FPKG and refuses the third-party
  layouts it cannot read.
* **It installs and launches through Sony's own paths**, then keeps the result in
  a library with state, notes and a package on disk you can copy anywhere.
* **Transfers that survive a real Wi-Fi link.** Range resume with a stall
  watchdog, byte-identical verification and a bounded retry budget (see
  `README.md`, "A dump that lives only on the console").
* **Failures you can read.** A build that produced a placeholder says so and the
  console refuses to install it. A save that could not be written says so on the
  title and in a pill. Nothing is reported as progress after it stopped.
* **The interface is a real home-row title** — VideoOut, frame loop, DualSense
  input — instead of a web page styled like a dashboard. The payload is its
  backend, not its window.

## What we are closing next

1. **Packing on the console itself** — this is the big one. The current packer
   is C#/.NET and cannot run in a FreeBSD payload; the enabling work is a native
   port of the PKG/PFS writer, not a setting. Until that exists, Convert needs
   the Mac.
2. **Zero-config discovery on the Mac** — offer `~/Downloads`, `~/Desktop` and
   mounted volumes as one-tap scan roots, so the first run asks for less.
3. **Compressed folder dumps** (zstd, LZ4) on the pull path, so a packed dump on
   the console can be pulled and repacked instead of refused.

Mounting without installing stays out of scope on purpose: it is a different
product with a different trade-off, and doing both badly would be worse than
doing one of them well.

*This comparison reflects Kraken Mount v0.3.0 (18 November 2026). If it moves,
this page should move with it.*
