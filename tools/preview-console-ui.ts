/**
 * Preview the console UI on this Mac.
 *
 * The real UI lives in console/ui/index.html and is embedded into the ELF. This
 * runner serves that exact file with the same API the payload exposes, so the
 * screen can be checked without a console. /api/convert proxies to the
 * Prospero Vault app on :8090, so the whole convert flow is real — including
 * the background job and its pollable progress.
 *
 *   bun run preview
 */

import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSfo, readSfo } from "./sfo";

const PORT = Number(process.env.PV_PREVIEW_PORT ?? process.env.TITAN_PREVIEW_PORT ?? 8094);
const VERSION = "0.11.0";
const DEMO = process.env.PV_DEMO ?? join(process.cwd(), "data", "demo");
const APP = process.env.PV_APP_URL ?? "http://127.0.0.1:8090";
/** Test-only: make the payload slow, or make it fail with a body. */
let slowMs = Number(process.env.PV_PREVIEW_DELAY_MS ?? 0) || 0;
let failGames = process.env.PV_PREVIEW_FAIL === "1";
const TITLE_ID = /^[A-Z]{4}\d{5}$/;

type Entry = {
  id: string;
  name: string;
  kind: "dump" | "pkg" | "image";
  platform: string;
  size: number;
  icon: boolean;
  installed: boolean;
  native: boolean;
  path: string;
};

type Job = {
  active: boolean;
  done: boolean;
  ok: boolean;
  kind: "convert" | "install";
  id: string;
  pct: number;
  line: string;
  message: string;
};

let mac = "";
/** Where the tile is: 0 unknown, 1 registered, 2 written but not registered, 3 removed. */
let homeAppState = 0;
let cancelled = false;
let job: Job = { active: false, done: false, ok: false, kind: "convert", id: "", pct: 0, line: "", message: "" };

// The demo ships one installed package and one that still needs installing, so
// both states of the Play button can be seen without a console.
const installedOverride = new Set<string>();

const DEMOS: Array<{ id: string; title: string }> = [
  { id: "PTST00001", title: "Sample Dump" },
  { id: "PTST00002", title: "Arc Runner" },
  { id: "PTST00003", title: "Night Shift" },
];

async function ensureDemo(): Promise<void> {
  for (const [index, demo] of DEMOS.entries()) {
    const folder = join(DEMO, demo.id);
    await mkdir(join(folder, "sce_sys"), { recursive: true });
    if (index === 0) {
      // A PS5 dump carries param.json; the rest keep an SFO, as PS4 dumps do,
      // so both metadata paths are exercised here.
      await writeFile(
        join(folder, "sce_sys", "param.json"),
        JSON.stringify({ titleId: demo.id, titleName: demo.title, contentId: `UP9000-${demo.id}_00-SAMPLE0000000001` }),
      );
    } else {
      await writeFile(
        join(folder, "sce_sys", "param.sfo"),
        buildSfo({
          TITLE_ID: demo.id,
          TITLE: demo.title,
          CATEGORY: "gd",
          APP_VER: "01.00",
          VERSION: "01.00",
          CONTENT_ID: `UP9000-${demo.id}_00-SAMPLE0000000001`,
        }),
      );
    }
    await writeFile(join(folder, "eboot.bin"), "placeholder");
  }

  // One package, so the Packages view and the PKG tile have something real.
  const packaged = join(DEMO, "PTST00004.pkg");
  if (!existsSync(packaged)) await writeFile(packaged, Buffer.alloc(1_400_000, 7));

  // And one mounted image format, which the payload lists but cannot read into.
  const image = join(DEMO, "PTST00005.exfat");
  if (!existsSync(image)) await writeFile(image, Buffer.alloc(2_400_000, 3));

  // A second package, so one tile shows Installed and the other Needs install.
  const installedPkg = join(DEMO, "PTST00006.pkg");
  if (!existsSync(installedPkg)) await writeFile(installedPkg, Buffer.alloc(900_000, 5));
}

const IMAGE_SUFFIXES = [".exfat", ".ffpkg", ".ffpfs", ".ffpfsc"];

async function scan(): Promise<Entry[]> {
  const found: Entry[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;

      if (info.isDirectory()) {
        if (TITLE_ID.test(name)) {
          const json = join(full, "sce_sys", "param.json");
          const sfo = join(full, "sce_sys", "param.sfo");
          if (existsSync(json)) {
            const meta = JSON.parse(await readFile(json, "utf8")) as { titleId?: string; titleName?: string };
            found.push({
              id: meta.titleId || name,
              name: meta.titleName || name,
              kind: "dump",
              platform: "PS5",
              size: 0,
              icon: false, // the demo folders have no icon0.png
              installed: false,
              native: false, // a dump has to be packaged before it is a title
              path: full,
            });
            continue;
          }
          try {
            const meta = readSfo(new Uint8Array(await readFile(sfo)));
            found.push({
              id: meta.TITLE_ID || name,
              name: meta.TITLE || name,
              kind: "dump",
              platform: "PS4",
              size: 0,
              icon: false,
              installed: false,
              native: false,
              path: full,
            });
            continue;
          } catch {
            /* not a dump folder */
          }
        }
        await walk(full, depth + 1);
      } else if (name.toLowerCase().endsWith(".pkg")) {
        found.push({
          id: name.slice(0, -4),
          name,
          kind: "pkg",
          platform: "PS5",
          size: info.size,
          icon: false,
          installed: name.slice(0, -4) === "PTST00006" || installedOverride.has(name.slice(0, -4)),
          native: true, // installed and mounted by the console itself
          path: full,
        });
      } else if (IMAGE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) {
        found.push({
          id: name.slice(0, name.lastIndexOf(".")),
          name,
          kind: "image",
          platform: "PS5",
          size: info.size,
          icon: false,
          installed: false,
          native: true, // this Mac pretends a mount payload is running
          path: full,
        });
      }
    }
  };

  await walk(DEMO, 0);
  return found;
}

const html = await readFile(join(process.cwd(), "console", "ui", "index.html"));
await ensureDemo();

// Clear interrupted downloads from an earlier run, as the payload does at boot.
for (const name of await readdir(DEMO).catch(() => [] as string[])) {
  if (name.endsWith(".part")) await rm(join(DEMO, name), { force: true });
}

function set(line: string, pct: number): void {
  job.line = line;
  job.pct = pct;
}

function finish(ok: boolean, message: string): void {
  job.active = false;
  job.done = true;
  job.ok = ok;
  job.message = message;
  job.line = ok ? "done" : "failed";
  if (ok) job.pct = 100;
}

/**
 * Mirrors the payload's install job closely enough to exercise the real UI
 * path: 202 at once, progress afterwards, and the installed flag at the end.
 */
function startInstall(id: string): void {
  job = {
    active: true,
    done: false,
    ok: false,
    kind: "install",
    id,
    pct: 8,
    line: "installing on this console",
    message: "",
  };
  let pct = 8;
  const timer = setInterval(() => {
    pct += 18;
    if (pct >= 100) {
      clearInterval(timer);
      installedOverride.add(id);
      finish(true, "Installed. It can be started from Play now.");
      return;
    }
    set("installing on this console", pct);
  }, 400);
}

async function runJob(id: string): Promise<void> {
  if (!mac) {
    finish(false, "Set your Mac's address first, in Settings.");
    return;
  }

  try {
    // The Mac builds from its own library, so the title has to be known there
    // first. In the preview both halves share one filesystem, so we can hand
    // over the path directly.
    const entries = await scan();
    const entry = entries.find((item) => item.id === id);
    if (entry) {
      await fetch(`${APP}/api/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              titleId: entry.id,
              title: entry.name,
              path: entry.path,
              kind: entry.kind === "dump" ? "Game folder" : entry.kind === "image" ? "Disc image" : "PKG",
              size: entry.size,
              hasIcon: entry.icon,
            },
          ],
        }),
      }).catch(() => null);
    }

    // Same order as the payload: a package the Mac already holds is not packed twice.
    const packed = await fetch(`${APP}/api/ready/${id}`).catch(() => null);
    if (packed?.ok) {
      set("package ready on your Mac", 96);
    } else {
      set("asking your Mac to pack", 3);
      const build = await fetch(`${APP}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ titleId: id }),
      });
      if (!build.ok) {
        const text = await build.text();
        finish(false, `The Mac refused the job: ${text.slice(0, 120)}`);
        return;
      }
    }

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (cancelled) {
        finish(false, "Cancelled");
        return;
      }
      const progress = await fetch(`${APP}/api/progress/${id}`).catch(() => null);
      if (progress?.ok) {
        const state = (await progress.json()) as { pct?: number; line?: string };
        set(state.line || "packing", Math.max(3, Math.min(95, state.pct ?? 3)));
      }

      const ready = await fetch(`${APP}/api/ready/${id}`).catch(() => null);
      if (ready?.ok) {
        set("receiving package", 96);
        const pkg = await fetch(`${APP}/api/pkg/${id}`);
        const bytes = new Uint8Array(await pkg.arrayBuffer());
        // Same contract as the payload: write a .part, rename once complete.
        const final = join(DEMO, `${id}.pkg`);
        const partial = `${final}.part`;
        try {
          await writeFile(partial, bytes);
          await rename(partial, final);
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
        finish(true, `Package received (${bytes.byteLength} bytes)`);
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    finish(false, "Still packing on your Mac. Check the app there, then rescan.");
  } catch (error) {
    finish(false, `Cannot reach the Mac app on :8090 (${(error as Error).message})`);
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html") {
      // no-store: the payload sends the same, and it keeps edits visible here.
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if ((req.method === "GET" && pathname === "/api/games") || (req.method === "POST" && pathname === "/api/scan")) {
      if (slowMs > 0) await Bun.sleep(slowMs);
      if (failGames) {
        // The shape every failure uses: both keys, so either client renders it.
        return Response.json(
          { error: "The library could not be read", message: "The library could not be read" },
          { status: 500 },
        );
      }
      const games = await scan();
      // The payload's tag contract, mirrored here so the 304 path is exercised
      // on this Mac and not only on a console.
      const body = JSON.stringify({ mac, scanning: false, playing: false, games });
      const tag = `"pv-${Bun.hash(body).toString(16)}"`;
      const headers = { "cache-control": "no-store", etag: tag };
      if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers });
      return new Response(body, { status: 200, headers: { ...headers, "content-type": "application/json" } });
    }

    // Test-only: turns a healthy payload slow, or into one that answers with a
    // server error body, so both degradations can be driven deliberately.
    if (req.method === "POST" && pathname === "/api/preview/flaky") {
      const body = (await req.json().catch(() => ({}))) as { fail?: boolean; delayMs?: number };
      if (typeof body.fail === "boolean") failGames = body.fail;
      if (typeof body.delayMs === "number") slowMs = Math.max(0, body.delayMs);
      return Response.json({ ok: true, fail: failGames, delayMs: slowMs });
    }

    if (pathname === "/api/health") {
      let free = 0;
      try {
        const info = await statfs(DEMO);
        free = Number(info.bfree) * Number(info.bsize);
      } catch {
        /* report unknown */
      }
      return Response.json({
        ok: true,
        version: VERSION,
        build: "preview",
        // The console this preview stands in for: public install support stops
        // at 11.60, so the interface must say so instead of starting a job.
        firmware: "13.20",
        install: "blocked",
        installReason:
          "Public kstuff/ppr-patch support for debug-package installs stops at 11.60. On 13.20 the " +
          "console's installer returns 0x80BD0005, so mount the dump or image instead.",
        free,
        homeApp: homeAppState === 1,
        homeAppState,
      });
    }

    if (req.method === "POST" && pathname === "/api/home-app") {
      // On the console ShadowMountPlus is asked whether it holds the title; here
      // there is no payload to ask, so this stands in for a confirmed answer.
      homeAppState = 1;
      return Response.json({
        ok: true,
        state: 1,
        message:
          "Prospero Vault is registered with ShadowMountPlus and is in the app row. Its tile opens this " +
          "interface full screen.",
      });
    }

    if (req.method === "POST" && pathname === "/api/home-app/remove") {
      homeAppState = 3;
      return Response.json({
        ok: true,
        state: 3,
        message:
          "Removed from the home screen. This window keeps running until you close it, and the app will " +
          "not put itself back.",
      });
    }

    if (req.method === "POST" && pathname === "/api/config") {
      const body = (await req.json().catch(() => null)) as { mac?: unknown } | null;
      // `{mac: 5}` used to reach .trim() and answer a 500 HTML stack page.
      if (!body || typeof body.mac !== "string") {
        return Response.json(
          { ok: false, message: "The console address must be a string, for example http://192.168.1.9:8090" },
          { status: 400 },
        );
      }
      mac = body.mac.trim();
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && pathname === "/api/convert") {
      const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
      // Anything used to be queued, including a malformed body or a title that
      // does not exist: a job that could never succeed took the one job slot
      // and the screen showed "working" for it.
      if (!body || typeof body.id !== "string" || !body.id) {
        return Response.json({ ok: false, message: "A title id is required" }, { status: 400 });
      }
      const id = body.id;
      if (job.active) {
        return Response.json({ ok: false, message: "A package is already being processed" }, { status: 409 });
      }
      const entries = await scan();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return Response.json({ ok: false, message: "Unknown title" }, { status: 404 });
      if (entry.kind === "pkg") {
        return Response.json(
          { ok: false, message: "That title is already a package. Convert its dump on the Mac side, or play the package." },
          { status: 400 },
        );
      }
      cancelled = false;
      job = { active: true, done: false, ok: false, kind: "convert", id, pct: 1, line: "starting", message: "" };
      void runJob(id);
      return Response.json({ ok: true, queued: true }, { status: 202 });
    }

    if (req.method === "POST" && pathname === "/api/convert/cancel") {
      if (!job.active) return Response.json({ ok: false, message: "Nothing is running" }, { status: 409 });
      cancelled = true;
      return Response.json({ ok: true, cancelling: true }, { status: 202 });
    }

    if (req.method === "GET" && (pathname === "/api/convert/status" || pathname === "/api/task")) {
      return Response.json(job);
    }

    if (req.method === "POST" && pathname === "/api/install") {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const id = String(body.id ?? "");
      const entries = await scan();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return Response.json({ ok: false, message: "Unknown title" }, { status: 404 });
      if (entry.kind !== "pkg") {
        return Response.json(
          { ok: false, message: "Only a package is installed. A disc image is mounted when it is played." },
          { status: 409 },
        );
      }
      if (entry.installed) {
        return Response.json({ ok: false, message: "That title is already installed on this console." }, { status: 409 });
      }
      if (job.active) {
        return Response.json(
          { ok: false, message: "This console is already installing or converting something." },
          { status: 409 },
        );
      }
      startInstall(id);
      return Response.json({ ok: true, installing: true }, { status: 202 });
    }

    if (req.method === "POST" && pathname === "/api/play") {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const entries = await scan();
      const entry = entries.find((item) => item.id === String(body.id ?? ""));
      if (!entry) return Response.json({ ok: false, message: "Unknown title" }, { status: 404 });
      if (entry.kind === "dump") {
        return Response.json(
          { ok: false, message: "That is still a dump. Convert it to an FPKG first — an unregistered folder cannot be started as a title." },
          { status: 409 },
        );
      }
      // Same one-tap contract as the payload: install first, then start.
      if (entry.kind === "pkg" && !entry.installed) {
        if (job.active) {
          return Response.json(
            { ok: false, message: "This console is already installing or converting something." },
            { status: 409 },
          );
        }
        startInstall(entry.id);
        return Response.json(
          {
            ok: true,
            installing: true,
            message: "Installing on this console. It starts as soon as the console reports it ready.",
          },
          { status: 202 },
        );
      }
      // The payload can launch; this Mac preview cannot, and says so.
      return Response.json(
        { ok: false, message: "Play is built for the console: this preview cannot start a title." },
        { status: 501 },
      );
    }

    if (pathname.startsWith("/api/icon/")) {
      return Response.json({ ok: false, message: "That title has no icon." }, { status: 404 });
    }

    // The interface parses JSON from every /api call; a plain-text page would
    // show up as an unexplained failure.
    if (pathname.startsWith("/api/")) {
      return Response.json({ ok: false, message: `No endpoint at ${pathname}` }, { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  console UI preview  http://localhost:${PORT}\n  demo games          ${DEMO}\n  converts via        ${APP}\n`);
