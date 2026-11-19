# acpack — the packer, including additional content

`acpack` turns a prepared PS5 content folder into an installable debug package.
It exists because Prospero Vault needs a packer that can build **additional
content (AC / DLC)**, not just applications.

The package format itself is not reimplemented here. `acpack` is a front end for
[LibProsperoPkg](https://github.com/SvenGDK/LibProsperoPKG), which implements the
container, the AES-XTS PFS image, metadata signing, the NAPS layout and the
install archive — including `ProsperoPackageMode.AdditionalContentData` and
`AdditionalContentNoData`. What this tool adds is the decision and the checks:

1. Read the source's own `sce_sys/param.json` and decide what it is.
2. Pick the matching package mode, refusing when metadata and mode disagree.
3. Build.
4. Validate the result against the mount path's structural gate
   (`ProsperoPkgValidator`) and confirm its classification
   (`ProsperoNpDrmContentInfo`) before calling it done.

## Why the mode matters

An application and a piece of additional content are not distinguished by a flag
someone flips at the end. The container's content type, the volume type, the
`param.json` category and the install path all have to agree. Building DLC as an
application produces a package that installs as the wrong thing, or not at all,
so `acpack` derives the mode from the content's own `applicationCategoryType`
and refuses a request that contradicts it:

| `applicationCategoryType` | Kind | Mode |
|---|---|---|
| `ac`, `addcont` | additional content | `ProsperoPackageMode.AdditionalContentData` |
| `gd`, `bd`, `gc`, `wt` | base application | `Application` |
| `gp` | update | **not handled yet** — a patch is built against a base package, and the library's mode enum has no patch mode, so an update source is refused rather than packed as an application |

`--mode ac-nodata` exists for entitlement-only AC (no payload).

Passing `--mode app` for an AC source, or `--mode ac` for an application, is
rejected before anything is built.

## Prerequisites

- .NET 10 SDK
- A LibProsperoPkg checkout (it is the package engine; it is not vendored here)
- **A host where .NET has SHA3-256** — see the platform note below
- Your own signing key material, as that library requires. Nothing in this
  repository supplies, downloads or bundles keys.

```bash
# 1. the engine (a local checkout; .deps/ is not part of this project's source)
git clone --depth 1 https://github.com/SvenGDK/LibProsperoPKG packer/.deps/LibProsperoPkg

# 2. build acpack against it — name the project file, the tree contains two
cd packer
dotnet build ProsperoAcPack.csproj -c Release \
  -p:LibProsperoPkgPath="$PWD/.deps/LibProsperoPkg/src/LibProsperoPkg/LibProsperoPkg.csproj"

# 3. the entry point
dotnet bin/Release/net10.0/acpack.dll --help
```

## Use

```bash
# what is this folder, and what would be built from it?
acpack inspect "/games/PPSA01234-dlc01"

# build it
acpack build --source "/games/PPSA01234-dlc01" --output "/games/pkg"

# force a mode only when you know better than the metadata
acpack build --source ... --output ... --mode ac-nodata
```

Progress is printed as `<n>%` lines — the shape Prospero Vault already parses —
and the last line is machine-readable:

```json
RESULT {"ok":true,"pkg":".../UP9000-PPSA00001_00-DLC0000000000001-A0100-V0100.pkg",
        "mode":"ac","contentId":"UP9000-PPSA00001_00-DLC0000000000001",
        "titleId":"PPSA00001","bytes":800141,"accepted":true,
        "classification":"drm=0x00 type=0x21 nested=True finalized=False patch=None",
        "contentIdMatches":true,"licenseFree":true,"warnings":["..."]}
```

`ok` is the acceptance check, not merely "the build returned". Read
`classification` too: `nested=True` is what the mount gate requires, and
`finalized=False` is correct for a debug (FIH) image — the inner CNT is
deliberately not flagged finalized. A non-zero exit means the package is not
something to send to a console.

## Platform note: macOS cannot run the builder

`SHA3_256.IsSupported` is `false` in .NET on macOS — there is no native provider,
and no `AppContext` switch enables one. PS5 PFS key derivation, inner-image
digests, the finalized-image digests and the FIH game digest are all SHA3-256, so
the library refuses to write a package rather than emit a wrong one:

```
SHA3-256 is required for PS5 PFS key derivation and digests but is not available on this platform/runtime.
```

`acpack inspect` works on macOS (it never hashes). `acpack build` must run on
Linux or Windows, where SHA3 is available. With a Lima VM this is the flow that
produced the package above:

```bash
# once: SDK inside the VM
limactl shell <vm> -- bash -c 'curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir "$HOME/.dotnet"'

# sources in (macOS tar adds ._ AppleDouble files; strip them)
tar czf - --exclude bin --exclude obj packer | limactl shell <vm> -- bash -c 'mkdir -p ~/pvpacker && tar xzf - -C ~/pvpacker && find ~/pvpacker -name "._*" -delete'

# build and run
limactl shell <vm> -- bash -lc 'cd ~/pvpacker/packer && ~/.dotnet/dotnet build ProsperoAcPack.csproj -c Release -p:LibProsperoPkgPath=$PWD/.deps/LibProsperoPkg/src/LibProsperoPkg/LibProsperoPkg.csproj && ~/.dotnet/dotnet bin/Release/net10.0/acpack.dll build --source ~/src --output ~/out'
```

A Lima VM does not share the Mac home by default, so either add a mount or copy
the source tree in and the `.pkg` out.

## Wiring it into Prospero Vault

No app change is needed: it runs through the existing custom-command engine, and
the console still pulls the source and pulls the package back.

In Prospero Vault → Settings → *Custom command*:

```
acpack build --source "{source}" --output "{output}"
```

On a macOS-only setup that command has to be a wrapper that runs the build in a
host with SHA3 (see above), or the Mac helper itself should run on Linux.

## Status

Verified November 2026 with .NET 10.0.404 and LibProsperoPkg `748eabf`:

- **Compiles** — `dotnet build` → 0 errors, on macOS and on Ubuntu 24.04.
- **`inspect` verified** on real folder shapes: an `ac` DLC tree is reported
  `kind: ac`, mode `ac`, with title and content id read from `param.json`; a
  `gd` game tree as `kind: app`. Incomplete trees report `missing` and exit 1.
- **`build` verified end to end on Linux** against a synthetic AC tree: wrote
  `UP9000-PPSA00001_00-DLC0000000000001-A0100-V0100.pkg` (800,141 bytes) from
  mode `ac`, with `accepted:true`, `nested=True`, `contentIdMatches:true`,
  `patch=None`. Signing keys loaded ("RSA-3072 metadata + passcode +
  mount-image"); the build is license-free by default, so no license record is
  written.
- **Not verified**: installation on a console. Nothing here has been installed
  on a PS5, and LibProsperoPkg is explicit that structural validity does not
  guarantee on-console acceptance. The real test is the user's console, a real
  DLC dump from `/user/addcont`, and `sceAppInstUtilAppInstallPkg`'s answer.
- **Not implemented**: patches (`gp`), and discovering AC/update content on the
  console (Prospero Vault only scans `/user/app` today).

## Licensing

LibProsperoPkg is GPL-3.0. It is consumed as a dependency and is not copied into
this repository; distributing `acpack` built against it carries that licence's
obligations.
