/**
 * Drives every synthetic dump shape through the same API the UI uses:
 * scan → import → build, then a malformed dump and a good one after it.
 *
 * Run after `make -C console` and `./packer/build.sh`.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeDumpFixtures, type DumpFixture } from "./dump-fixtures";

const PORT = Number(process.env.PV_DUMP_PORT ?? 8301);
const ROOT = join(process.env.TMPDIR ?? "/tmp", "pv-dump-check");
const BASE = `http://127.0.0.1:${PORT}`;

let checks = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
}

const post = (path: string, payload: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

async function state(): Promise<any> {
  return (await (await fetch(`${BASE}/api/state`)).json()) as any;
}

async function game(titleId: string): Promise<any> {
  return (await state()).games.find((entry: any) => entry.titleId === titleId);
}

async function waitTerminal(titleId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await game(titleId);
    // "dumped" is the queued-but-not-started state; returning on it would read
    // the import as the build's result.
    if (entry && entry.state !== "building" && entry.state !== "installing" && entry.state !== "dumped") return entry;
    await Bun.sleep(250);
  }
  return game(titleId);
}

async function main(): Promise<void> {
  console.log("\nDump shapes through the app\n");
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, "data"), { recursive: true });

  const fixtures = await makeDumpFixtures(join(ROOT, "dumps"));
  await Bun.write(
    join(ROOT, "config.json"),
    JSON.stringify({ port: PORT, consoleHost: null, engine: "auto", enginePaths: {}, scanDirs: [] }),
  );

  const app = Bun.spawn({
    cmd: ["bun", "run", "app/server.ts"],
    env: { ...process.env, PV_PORT: String(PORT), PV_CONFIG: join(ROOT, "config.json"), PV_DATA: join(ROOT, "data") },
    stdout: "pipe",
    stderr: "pipe",
  });

  const ready = Date.now() + 15000;
  while (Date.now() < ready) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) break;
    } catch {
      /* starting */
    }
    await Bun.sleep(150);
  }

  try {
    const scanned = (await (await post("/api/scan", { dir: join(ROOT, "dumps") })).json()) as any;
    check("scan finds every valid shape", scanned.found.length >= 4, `${scanned.found.length} found`);
    const foundIds = new Set(scanned.found.map((item: any) => item.titleId));
    for (const fixture of fixtures.filter((item) => item.valid)) {
      check(`scan sees ${fixture.name}`, foundIds.has(fixture.titleId), [...foundIds].join(","));
    }
    check(
      "scan reports the folder with no metadata",
      Array.isArray(scanned.problems) &&
        scanned.problems.some((problem: any) => /PPSA09005/.test(problem.path)) &&
        scanned.problems.some((problem: any) => /PPSA09007/.test(problem.path)),
      JSON.stringify(scanned.problems ?? []).slice(0, 80),
    );

    for (const fixture of fixtures.filter((item) => item.valid)) {
      const item = scanned.found.find((entry: any) => entry.titleId === fixture.titleId);
      if (!item) {
        check(`${fixture.name}: ingest`, false, "not in scan");
        continue;
      }
      const started = Date.now();
      await post("/api/import", { items: [item] });
      const imported = await game(fixture.titleId);
      check(`${fixture.name}: ingest`, imported?.sourcePath === fixture.path, String(imported?.sourcePath));
      const build = await post("/api/build", { titleId: fixture.titleId });
      check(`${fixture.name}: build accepted for a job`, build.ok, String(build.status));
      const done = await waitTerminal(fixture.titleId, fixture.name === "large" ? 600_000 : 180_000);
      const built = done?.state === "built" && done?.simulated === false;
      check(`${fixture.name}: builds a real package`, built, `${done?.state} ${String(done?.note).slice(0, 70)}`);
      if (built) {
        const file = Bun.file(done.pkgPath);
        const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        check(`${fixture.name}: package magic`, bytes[0] === 0x7f && bytes[1] === 0x46 && bytes[2] === 0x49 && bytes[3] === 0x48, [...bytes].map((b) => b.toString(16)).join(" "));
        const floor = fixture.name === "large" ? 200 * 1024 * 1024 : 4096;
        check(`${fixture.name}: package size`, (done.pkgSize ?? 0) > floor, `${done.pkgSize} bytes`);
        check(`${fixture.name}: one package for the title`, done.pkgPath === join(ROOT, "data", "pkg", `${fixture.titleId}.pkg`), done.pkgPath);
      }
      console.log(`         (${Math.round((Date.now() - started) / 100) / 10}s)`);
    }

    const builtTitles = fixtures.filter((item) => item.valid).map((item) => `${item.titleId}.pkg`);
    const pkgFiles = await Array.fromAsync(new Bun.Glob("*.pkg").scan(join(ROOT, "data", "pkg")));
    check(
      "exactly one package per built title",
      pkgFiles.length === builtTitles.length && builtTitles.every((name) => pkgFiles.includes(name)),
      pkgFiles.join(","),
    );
    const strays = await Array.fromAsync(new Bun.Glob("**/*.{tmp,part,partial}").scan(join(ROOT, "data")));
    check("no temp files are left behind", strays.length === 0, strays.join(","));

    // Malformed metadata the packer rejects at build time.
    const bad = fixtures.find((item) => item.name === "bad-content-id")!;
    await post("/api/import", { items: [{ titleId: bad.titleId, title: "Bad", path: bad.path, kind: "Game folder", size: 0 }] });
    await post("/api/build", { titleId: bad.titleId });
    const badDone = await waitTerminal(bad.titleId, 60_000);
    check("a rejected param.json ends as an error", badDone?.state === "error", String(badDone?.state));
    check(
      "and names the field to fix",
      /content id|contentId|param/i.test(String(badDone?.note)),
      String(badDone?.note).slice(0, 90),
    );

    // Metadata but no executable: the packer would accept it, the app must not.
    const noEboot = fixtures.find((item) => item.name === "no-eboot")!;
    await post("/api/import", { items: [{ titleId: noEboot.titleId, title: "No eboot", path: noEboot.path, kind: "Game folder", size: 0 }] });
    await post("/api/build", { titleId: noEboot.titleId });
    const noEbootDone = await waitTerminal(noEboot.titleId, 60_000);
    check("a dump with no eboot is refused", noEbootDone?.state === "error", String(noEbootDone?.state));
    check("and names eboot.bin", /eboot\.bin/i.test(String(noEbootDone?.note)), String(noEbootDone?.note).slice(0, 90));

    // The queue must still take work after both failures.
    const after = fixtures.find((item) => item.name === "pkg-editor")!;
    await post("/api/build", { titleId: after.titleId });
    const again = await waitTerminal(after.titleId, 180_000);
    check("a good dump builds after the failures", again?.state === "built", `${again?.state}`);

    const final = await state();
    check(
      "nothing is left running or queued",
      !final.games.some((entry: any) => entry.state === "building" || entry.state === "installing"),
    );
  } finally {
    app.kill();
  }

  console.log(`\n${checks - failed}/${checks} checks passed`);
  if (failed) process.exit(1);
}

await main();
