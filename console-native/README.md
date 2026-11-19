# Prospero Vault native title

This directory is the console interface as a real PS5 title: `PVLT00001` runs
from the home row, draws with VideoOut, reads the DualSense, and talks to the
Prospero Vault payload for the library and actions.

It is not a payload and not a page in the browser. `eboot.bin` is a development
FSELF (`0x1D3D154F`) around a native ELF (`e_type=0xFE10`) with the
process-parameter block and a `sce_module/libc.prx` companion.

## Files

```
app.cpp                 backend client, pad handling, screens, actions
render.cpp/.hpp         tiled RGBA8 framebuffer, 5x7 text, VideoOut loop
installer/main.cpp      one-shot elfldr installer; stops a running Vault first
build.sh                compile, sign, package, build the installer
tools/bootstrap-toolchain.sh  rebuild the host tools and clean-room runtime
```

## What it needs

- A PS5 on **13.20** with `elfldr` on 9021 and ShadowMount+ running. Those are
  the only versions this was launched on.
- The backend payload from `../console` loaded on `127.0.0.1:8097` (the title
  also tries 8098). Without it the title shows `BACKEND OFFLINE`.
- The external native-app toolchain: the public payload SDK, the native CRT and
  linker script, the FSELF converter, and the generated clean-room `libc.prx`.

The toolchain is GPL-3.0 and is deliberately not vendored. The default path is
`$HOME/ps5-harness/.deps/native/drakmor-boilerplate`; override it with
`PS5_NATIVE_TOOLCHAIN`. The payload SDK defaults to
`$HOME/ps5-harness/.deps/ps5-payload-sdk`.

## Build

```bash
./console-native/tools/bootstrap-toolchain.sh   # once, if the toolchain is absent
./console-native/build.sh
```

The build needs Clang with the PS5 target (Homebrew LLVM 20 on this Mac), the
payload SDK, and zlib for the host converter. Output:

```
console-native/dist/PVLT00001/       title folder
console-native/dist/PVLT00001.tar    same folder, uncompressed
console-native/dist/install.elf      installer payload (tar embedded)
```

## Install and run

Close Prospero Vault first if it is open; the installer also stops a running
copy by title id.

```bash
nc -w 30 192.168.4.100 9021 < console-native/dist/install.elf
```

Then launch **Prospero Vault** from the app row. The installer writes
`/data/homebrew/PVLT00001` with `0777` modes, including `sce_module/libc.prx`,
so ShadowMount+ can register it without an FTP step.

The title reports from inside the running app:

```bash
curl http://192.168.4.100:8096/
# {"ok":true,"app":"prospero-vault","native":true,"frames":470,"games":21,
#  "backend":true,"selected":"ddadcba1e932662"}
```

`frames` increases while the render loop runs. That is the check that the title
is not just registered but executing.

## Controls

| Control | Action |
| --- | --- |
| D-pad up/down | move the selection |
| L1 / R1 | page by ten |
| Cross | play or install the selected title |
| Square | ask the backend to scan, then reload |
| Triangle or Options | reload the library |
| Circle | show the close hint (the PS button closes the title) |

## What is verified

- The FSELF is accepted by the loader; ShadowMount+ reports `status: 0`.
- LNC launches `PVLT00001` and keeps it as the running big app.
- The `:8096` endpoint reports an increasing frame count and 21 titles from the
  backend on 13.20.
- `dist/install.elf` stops a running build, replaces all five files, and the
  next launch is the new build.

Not verified: the on-screen layout and the controller buttons were not captured
or visually inspected. Treat those as the next hardware check. Other firmware
and loader combinations are unverified.

## Limits

- **Firmware 14.xx cannot run this or any other payload/title**; there is no
  public exploit above 13.60 as of November 2026.
- **FPKG install is still capped at kstuff 11.60.** On 13.20 the installer
  service rejects packages with `0x80BD0005`; the title can mount/scan and launch
  what the console already has, not install a debug FPKG.
- The title needs the payload for the library and actions. It draws and reads
  input without it, but shows an offline state.
- The backend tries 8097 then 8098. If the payload took another port, the title
  will not find it.

## Licence

The Vault sources in this directory are MIT, like the rest of the repository.
The built title links GPL-3.0-or-later components from the external toolchain
(`app_crt.cpp`, `app_cpp_runtime.cpp`, the generated `libc.prx`, the FSELF
converter). A distributed `eboot.bin` is therefore a combined work with those
components; comply with GPL-3.0-or-later for the binary, or replace them with
compatible implementations.
