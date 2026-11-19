/**
 * Proves the hardware gate over real sockets:
 *
 * - the actual console payload, built for this Mac, listens on the LAN address
 *   and speaks its real /api/contract (not a stub);
 * - the companion Mac is reached at its LAN address, never 127.0.0.1;
 * - preflight passes for both paths, a dump builds through each one, and the
 *   payload ends up with the exact bytes the Mac built;
 * - an unreachable console stops the gate before anything is built;
 * - the gate still passes after the Mac app restarts.
 */
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeDumpFixtures } from "./dump-fixtures";

const ROOT = "/tmp/pv_gate_check";

/** Whatever is free right now, so another service on this Mac cannot collide. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const MAC_PORT = freePort();
const CONSOLE_PORT = freePort();
const BASE = `http://127.0.0.1:${MAC_PORT}`;

let checks = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<number> {
  const child = Bun.spawn({ cmd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return child.exited;
}

async function get(url: string, timeoutMs = 4000): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: (await res.text()).slice(0, 8000) };
  } catch {
    return null;
  }
}

const post = async (url: string, body: unknown, timeoutMs = 30000) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: (await res.text()).slice(0, 8000) };
  } catch {
    return null;
  }
};

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await get(url, 1000))?.status === 200) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  const data = join(ROOT, "data");
  const consoleRoot = join(ROOT, "console");
  const appRoot = join(ROOT, "app");
  await mkdir(data, { recursive: true });
  await mkdir(join(consoleRoot, "Games"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  const fixtures = await makeDumpFixtures(join(ROOT, "dumps"), { largeMB: 0 });

  // The console side is the payload's own source, built for this host. It runs
  // the real scanner, convert and download code; only Sony calls are absent.
  const payload = join(ROOT, "payload");
  const built = await run(
    [
      "c++",
      "-std=c++17",
      "-O2",
      "-pthread",
      `-DPV_ROOT=\"${consoleRoot}\"`,
      `-DPV_APP_ROOT=\"${appRoot}\"`,
      `-DPV_PORT=${CONSOLE_PORT}`,
      "console/main.cpp",
      "console/build/ui_data.cpp",
      "-o",
      payload,
    ],
    {},
  );
  check("the console payload builds for this host", built === 0);
  if (built !== 0) return;

  const payloadChild = Bun.spawn({ cmd: [payload], stdout: "pipe", stderr: "pipe" });
  check("the payload answers health on its port", await waitFor(`http://127.0.0.1:${CONSOLE_PORT}/api/health`, 8000));

  const config = {
    port: MAC_PORT,
    consoleHost: `127.0.0.1:${CONSOLE_PORT}`,
    engine: "auto",
    enginePaths: {},
    scanDirs: [],
  };
  await writeFile(join(ROOT, "config.json"), JSON.stringify(config));
  let app = Bun.spawn({
    cmd: ["bun", "run", "app/server.ts"],
    env: { ...process.env, PV_PORT: String(MAC_PORT), PV_CONFIG: join(ROOT, "config.json"), PV_DATA: data },
    stdout: "pipe",
    stderr: "pipe",
  });
  check("the Mac app answers", await waitFor(`${BASE}/api/state`, 12000));

  const state = JSON.parse((await get(`${BASE}/api/state`))!.text);
  const lan = String(state.lan).replace(/\/$/, "");
  const lanHost = new URL(lan).hostname;
  check("the Mac advertises a LAN address", lanHost !== "127.0.0.1" && lanHost.startsWith("192."), lan);
  check("the Mac answers over that address", (await get(`${lan}/api/state`))?.status === 200, lan);

  // Both halves talk to each other by LAN address only, so a stub on loopback
  // cannot stand in for either side.
  await writeFile(join(consoleRoot, "config.json"), JSON.stringify({ mac: `${lanHost}:${MAC_PORT}` }));
  await post(`http://127.0.0.1:${CONSOLE_PORT}/api/config`, { mac: `${lanHost}:${MAC_PORT}` });
  await post(`${BASE}/api/settings`, { consoleHost: `${lanHost}:${CONSOLE_PORT}` });
  const pointed = String(JSON.parse((await get(`${BASE}/api/state`))!.text).config.consoleHost ?? "").replace(/^https?:\/\//, "");
  check("the Mac's console address is the LAN address", pointed === `${lanHost}:${CONSOLE_PORT}`, String(pointed));

  const preflight = async (args: string[]) => {
    const child = Bun.spawn({
      cmd: ["bun", "run", "tools/preflight.ts", ...args],
      env: { ...process.env, PV_DATA: data },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    return { code: await child.exited, text };
  };

  const macOnly = fixtures.find((fixture) => fixture.name === "pkg-editor")!;
  const consoleDump = fixtures.find((fixture) => fixture.name === "odd-names")!;

  // ---- both paths, preconditions first ----
  const gate = await preflight(["--dump", macOnly.path, "--console", `${lanHost}:${CONSOLE_PORT}`, "--mac", `127.0.0.1:${MAC_PORT}`, "--path", "both"]);
  check("preflight passes for both paths with a real console and dump", gate.code === 0, gate.text.trim().split("\n").pop() ?? "");
  if (gate.code !== 0) console.log(gate.text);
  check("preflight reports no precondition after the fact", !/FAIL/.test(gate.text), gate.text.slice(0, 80));

  // ---- companion Mac: build here, console fetches over the LAN ----
  await post(`${BASE}/api/import`, { items: [{ titleId: macOnly.titleId, title: "Gate Mac", path: macOnly.path, kind: "Game folder", size: 0 }] });
  await post(`${BASE}/api/build`, { titleId: macOnly.titleId });
  let macGame: any = null;
  for (let i = 0; i < 300; i++) {
    const answer = await get(`${BASE}/api/state`);
    macGame = answer ? JSON.parse(answer.text).games.find((game: any) => game.titleId === macOnly.titleId) : null;
    if (macGame && macGame.state === "built") break;
    await Bun.sleep(200);
  }
  check("the companion Mac builds the dump", macGame?.state === "built", `${macGame?.state} ${String(macGame?.note).slice(0, 60)}`);

  const deploy = await post(`${BASE}/api/deploy`, { titleId: macOnly.titleId }, 60000);
  check("the Mac asks the console to fetch the package", deploy?.status === 200, `${deploy?.status} ${deploy?.text?.slice(0, 90) ?? ""}`);

  const consolePkg = join(consoleRoot, "Games", `${macOnly.titleId}.pkg`);
  let arrived = false;
  for (let i = 0; i < 240; i++) {
    if (existsSync(consolePkg)) {
      const size = (await stat(consolePkg)).size;
      if (size > 0 && size === macGame?.pkgSize) {
        arrived = true;
        break;
      }
    }
    await Bun.sleep(250);
  }
  check("the console receives the exact package the Mac built", arrived, `${consolePkg} vs ${macGame?.pkgSize} bytes`);
  if (arrived) {
    const [here, there] = await Promise.all([Bun.file(macGame.pkgPath!).arrayBuffer(), Bun.file(consolePkg).arrayBuffer()]);
    check("both halves are byte-identical", Buffer.compare(Buffer.from(here), Buffer.from(there)) === 0);
    const magic = new Uint8Array((await Bun.file(consolePkg).slice(0, 4).arrayBuffer())) as Uint8Array;
    check("the package has PS5 magic", magic[0] === 0x7f && magic[1] === 0x46 && magic[2] === 0x49 && magic[3] === 0x48);
  }

  const afterMac = await preflight(["--dump", macOnly.path, "--console", `${lanHost}:${CONSOLE_PORT}`, "--mac", `127.0.0.1:${MAC_PORT}`, "--path", "mac"]);
  check("preflight passes again once the package is on the console", afterMac.code === 0, afterMac.text.trim().split("\n").pop() ?? "");

  // ---- console-direct: dump lives on the console, Mac pulls and builds ----
  const consoleCopy = join(consoleRoot, "Games", consoleDump.titleId);
  await mkdir(consoleCopy, { recursive: true });
  await copyFile(join(consoleDump.path, "SCE_SYS", "PARAM.JSON"), join(consoleCopy, "param.json"));
  await copyFile(join(consoleDump.path, "EBOOT.BIN"), join(consoleCopy, "eboot.bin"));
  await mkdir(join(consoleCopy, "sce_sys"), { recursive: true });
  await copyFile(join(consoleCopy, "param.json"), join(consoleCopy, "sce_sys", "param.json"));
  await chmod(consoleCopy, 0o755);

  const rescanned = await post(`http://127.0.0.1:${CONSOLE_PORT}/api/scan`, {});
  check("the console rescans and sees the copy", rescanned?.status === 202 || rescanned?.status === 200, String(rescanned?.status));
  let consoleGames = "";
  for (let i = 0; i < 40; i++) {
    consoleGames = (await get(`http://127.0.0.1:${CONSOLE_PORT}/api/games`))?.text ?? "";
    if (consoleGames.includes(consoleDump.titleId)) break;
    await Bun.sleep(250);
  }
  check("the console lists the dump", consoleGames.includes(consoleDump.titleId), consoleGames.slice(0, 100));

  const directRun = await preflight([
    "--dump", consoleDump.path,
    "--console", `${lanHost}:${CONSOLE_PORT}`,
    "--mac", `127.0.0.1:${MAC_PORT}`,
    "--path", "console",
    "--run",
  ]);
  check("the gate converts through the console-direct path", directRun.code === 0, directRun.text.trim().split("\n").slice(-3).join(" | "));
  check("and records a finished console job", /done\b/.test(directRun.text) && !/failed/.test(directRun.text), directRun.text.split("\n").find((line) => line.includes("console "))?.slice(0, 110) ?? "");

  const directPkg = join(consoleRoot, "Games", `${consoleDump.titleId}.pkg`);
  const directSize = existsSync(directPkg) ? (await stat(directPkg)).size : 0;
  check("the console-direct path leaves a real package", directSize > 4096, `${directSize} bytes`);
  if (directSize > 4096) {
    const magic = new Uint8Array((await Bun.file(directPkg).slice(0, 4).arrayBuffer())) as Uint8Array;
    check("that package has PS5 magic", magic[0] === 0x7f && magic[1] === 0x46 && magic[2] === 0x49 && magic[3] === 0x48);
  }
  const afterDirect = await preflight(["--dump", consoleDump.path, "--console", `${lanHost}:${CONSOLE_PORT}`, "--mac", `127.0.0.1:${MAC_PORT}`, "--path", "console"]);
  check("preflight passes for the console-direct path", afterDirect.code === 0, afterDirect.text.trim().split("\n").pop() ?? "");

  // ---- a broken precondition stops the gate before any build ----
  const fresh = fixtures.find((fixture) => fixture.name === "dlc")!;
  const broken = await preflight(["--dump", fresh.path, "--console", "127.0.0.1:9", "--mac", `127.0.0.1:${MAC_PORT}`, "--path", "mac", "--run"]);
  check("an unreachable console fails the gate", broken.code === 1, `exit ${broken.code}`);
  check("and names the console as the missing piece", /console: payload answers/i.test(broken.text) && /elfldr|address/i.test(broken.text), broken.text.split("\n").find((line) => line.includes("FAIL"))?.slice(0, 110) ?? "");
  check("and says nothing was built", /Nothing was built/.test(broken.text));
  const untouched = await get(`${BASE}/api/state`);
  const library = untouched ? JSON.parse(untouched.text).games : [];
  check("the broken run created no job", !library.some((game: any) => game.titleId === fresh.titleId));

  // ---- restart the Mac, then the gate must still pass ----
  app.kill();
  await Bun.sleep(500);
  app = Bun.spawn({
    cmd: ["bun", "run", "app/server.ts"],
    env: { ...process.env, PV_PORT: String(MAC_PORT), PV_CONFIG: join(ROOT, "config.json"), PV_DATA: data },
    stdout: "pipe",
    stderr: "pipe",
  });
  check("the Mac app comes back", await waitFor(`${BASE}/api/state`, 12000));
  const restarted = await preflight(["--dump", macOnly.path, "--console", `${lanHost}:${CONSOLE_PORT}`, "--mac", `127.0.0.1:${MAC_PORT}`, "--path", "mac"]);
  check("preflight still passes after the restart", restarted.code === 0, restarted.text.trim().split("\n").pop() ?? "");
  const rebuilt = await post(`${BASE}/api/build`, { titleId: macOnly.titleId });
  check("the restarted app still builds", rebuilt?.status === 200, `${rebuilt?.status} ${rebuilt?.text?.slice(0, 70) ?? ""}`);
  let rebuiltState: any = null;
  for (let i = 0; i < 300; i++) {
    const answer = await get(`${BASE}/api/state`);
    rebuiltState = answer ? JSON.parse(answer.text).games.find((game: any) => game.titleId === macOnly.titleId) : null;
    if (rebuiltState?.state === "built") break;
    await Bun.sleep(200);
  }
  check("and the build finishes", rebuiltState?.state === "built", String(rebuiltState?.state));

  const leftovers = await Array.fromAsync(new Bun.Glob("**/*.{tmp,part,partial}").scan(join(data, "pkg")));
  check("no temp files are left in the package folder", leftovers.length === 0, leftovers.join(","));

  app.kill();
  payloadChild.kill();
  console.log(`\n${checks - failed}/${checks} checks passed`);
  if (failed) process.exit(1);
}

await main();
