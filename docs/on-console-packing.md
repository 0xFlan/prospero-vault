# Packing on the console

Vault can build a debug FPKG on the PS5 itself, with no Mac. It does that through
a separate on-console engine, **PS5 Dump Forge 0.5.6** (GPL-3.0), which runs as a
payload and listens on 8095. Vault detects it, starts the job, watches the
engine's `.part` grow, and reports when the package lands.

This is an engine integration, not a reimplementation of the PKG writer. The
Vault packer (`acpack`) is C#/.NET and cannot run in a FreeBSD payload; Dump
Forge's Rust engine already implements PFS, Kraken, CNT/FIH, PlayGo and the
install archive. Driving it keeps Vault from shipping a second, unproven writer.

## Verified on the 13.20 console

- Source: `/data/homebrew/PPSA99000` (ProsperoStore, 110 files,
  85,341,147 bytes).
- Vault `POST /api/console-pack {"id":"PPSA99000"}` started Dump Forge job 4.
- Progress came from the engine's `.part`: 8 MB written, 37 MB written, then
  `Package ready`.
- Result: `/data/prospero-vault/Games/PPSA99000-console.pkg`,
  **39,008,291 bytes**.
- The engine's own verification reported 110 files with the same paths, all
  85,341,147 source bytes matching, 106 files byte-identical to the source and
  4 container entries, and a valid FPKG (FIH, CNT, PFS, PlayGo digests).
- An earlier homebrew pack, `HARN00001`, produced a 6,899,158-byte FPKG the same
  way.

The pack is real. The install is the part that still fails.

## The interface reports the ceiling

Vault reads the console's firmware at startup through
`sceKernelGetProsperoSystemSwVersion` (with `uname` as a fallback) and reports it
in `/api/health` as `firmware`, `install` and `installReason`. On this **13.20**
console it answers `"firmware":"13.20"` and `"install":"blocked"`.

The Console screen shows that answer, and pressing Play on an uninstalled
package explains the block instead of starting an install that would spend
thirty seconds waiting for `0x80BD0005`. The pack sheet says the same thing
before it starts. The `/api/install` endpoint is still there for a console with
a custom patch that changes the answer; the UI does not promise one.

## What does not work

- **Installing on 13.20.** Both Vault's installer and Dump Forge's installer
  return `0x80BD0005` for packages built on the console, including a valid
  sample package. Public kstuff/ppr-patch FPKG install support stops at 11.60;
  the A53 PPR profile for 13.20 does not exist. On 13.20, mount a folder or image
  with ShadowMount+ instead.
- **Firmware 14.xx.** There is no public exploit above 13.60. Gezine's 14.22
  game-binary dump and the 14.10 Debug Settings demo used unreleased methods;
  neither is a jailbreak or a tool. No Vault change can install there.
- **Partial install.** The FPKG builder writes PlayGo metadata, but progressive
  installation has not been tested; install itself is blocked on 13.20.
- **DLC and updates.** The engine packs both. Vault's scan lists DLC under
  `/user/addcont` as a dump, so a DLC entry can be selected for packing. Update
  (`gp`) content is not discovered by Vault yet.
- **Full performance.** A game launched by Vault is a normal console title; the
  payload does not wrap it, cap it or draw over it. There is no app-level frame
  rate or clock switch to add. The Vault interface itself uses VideoOut, not a
  GNM shader path.

## Use it

1. Load Dump Forge 0.5.6 on the console (elfldr, port 9021):
   `nc -w 90 <console-ip> 9021 < ps5-dump-forge-0.5.6-ps5.elf`
2. Open Vault's interface (`http://<console-ip>:8097`).
3. Press a dump, then **Pack on this console**.
4. The package appears in `/data/prospero-vault/Games` as
   `<title-id>-console.pkg`.

If the engine is not loaded, Vault says so instead of starting a job that cannot
run. The endpoints are:

```
GET  /api/console-pack                 engine present? version?
POST /api/console-pack {"id": "..."}   start a job
GET  /api/console-pack/status          active/done/pct/message/output
```

## Why not embed the engine

The engine is GPL-3.0 and is not vendored here. A future version can link a
native PKG writer (or a Rust static library) into the payload so no second
payload is needed. Until then, "on-console" means Vault plus the on-console
engine; the Mac is out of the loop.

## The firmware ceiling, plainly

| Firmware | Public jailbreak | FPKG install | On-console pack | Working path |
| --- | --- | --- | --- | --- |
| ≤ 11.60 | yes | public kstuff + ppr-patch support | yes | pack, install, play (not tested here) |
| 12.00–13.60 | yes (Relapse) | no public support | yes | pack, mount, play |
| 14.00–14.22 | no | no | no | not possible |

The ≤11.60 install row is the public support level, not a test on this console;
this console is 13.20. "Beat Kraken on firmware" is not an engineering choice
inside Vault. On 14.xx there is no public kernel access to build on; the private
demos have not been released.
