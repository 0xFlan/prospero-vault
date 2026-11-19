/**
 * Renders the status item's menu to docs/screens/status-menu.png.
 *
 * The menu is SwiftUI (MenuPanel in tools/menubar.swift), so the app can show
 * it in a normal window with --menu-preview. This starts the built app on the
 * normal port, waits for that window, and captures exactly its rectangle.
 *
 *   bun run capture:menu
 *
 * If the bundle is missing it builds it first. If the app is already running
 * on 8090, the preview uses it instead of starting a second server.
 */
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";

const ROOT = process.cwd();
const EXEC = `${ROOT}/build/Prospero Vault.app/Contents/MacOS/ProsperoVault`;
const OUT = `${ROOT}/docs/screens/status-menu.png`;
const BOUNDS = "/tmp/pv_menu_bounds.txt";
const SHOT = "/tmp/pv_status_menu.png";
const PORT = 8090;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

if (!existsSync(EXEC)) {
  console.log("building the app first…");
  const build = Bun.spawn({ cmd: ["bash", "tools/build-app.sh"], stdout: "inherit", stderr: "inherit" });
  if ((await build.exited) !== 0) throw new Error("build failed");
}

await rm(BOUNDS, { force: true });
await rm(SHOT, { force: true });

const alreadyRunning = await healthy();
const app = Bun.spawn({
  cmd: [EXEC, "--menu-preview"],
  env: { ...process.env, PV_PORT: String(PORT), PV_MENU_BOUNDS: BOUNDS, PATH: "/usr/bin:/bin" },
  stdout: "ignore",
  stderr: "ignore",
});

let bounds = "";
for (let i = 0; i < 75; i++) {
  if (existsSync(BOUNDS)) {
    bounds = (await Bun.file(BOUNDS).text()).trim();
    if (bounds) break;
  }
  await sleep(200);
}
if (!bounds) {
  app.kill();
  throw new Error("the menu window did not report its bounds");
}

// Let the first health poll replace "Starting…" with the live status line.
for (let i = 0; i < 30; i++) {
  if (await healthy()) break;
  await sleep(200);
}
await sleep(2500);

const shot = Bun.spawnSync(["screencapture", "-x", "-R", bounds, SHOT]);
if (shot.exitCode !== 0 || !existsSync(SHOT)) {
  app.kill();
  throw new Error(`screencapture failed: ${shot.stderr.toString().trim()}`);
}
await writeFile(OUT, await Bun.file(SHOT).arrayBuffer());

// SIGTERM runs the app's own quit path; a server it started is stopped too.
app.kill();
for (let i = 0; i < 40; i++) {
  if (app.exitCode !== null) break;
  await sleep(100);
}
if (!alreadyRunning) {
  for (let i = 0; i < 40; i++) {
    if (!(await healthy())) break;
    await sleep(100);
  }
}

console.log(`saved ${OUT}`);
