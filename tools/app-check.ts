/**
 * Boots the built "Prospero Vault.app" with no Bun and no dotnet on PATH,
 * proves the server and UI answer, proves the CSRF guard, proves loopback mode
 * refuses off-host clients, and builds a real package through it.
 *
 *   bun run check:app
 *
 * The bundle is built first if it is missing. The menu bar item itself needs a
 * human (or Accessibility permission) to click; this covers the runtime.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeDumpFixtures } from "./dump-fixtures";

const ROOT = "/tmp/pv_app_check";
const BUNDLE = join(process.cwd(), "build", "Prospero Vault.app");
const EXEC = join(BUNDLE, "Contents", "MacOS", "ProsperoVault");

let checks = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function waitFor(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return res.status;
    } catch {
      /* starting */
    }
    await Bun.sleep(200);
  }
  return 0;
}

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, text: (await res.text()).slice(0, 2000) };
};

async function launch(port: number, home: string, bind?: string) {
  const env: Record<string, string> = {
    HOME: home,
    PATH: "/usr/bin:/bin", // no bun, no dotnet: the bundle must carry everything
    PV_PORT: String(port),
  };
  if (bind) env.PV_BIND = bind;
  return Bun.spawn({ cmd: [EXEC], env, stdout: "pipe", stderr: "pipe" });
}

async function main(): Promise<void> {
  if (!existsSync(EXEC)) {
    console.log("building the app bundle first…");
    const build = Bun.spawn({ cmd: ["bash", "tools/build-app.sh"], stdout: "inherit", stderr: "inherit" });
    if ((await build.exited) !== 0) {
      check("the app bundle builds", false);
      process.exit(1);
    }
  }

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const home = join(ROOT, "home");
  await mkdir(home, { recursive: true });
  const fixtures = await makeDumpFixtures(join(ROOT, "dumps"), { largeMB: 0 });
  const retail = fixtures.find((fixture) => fixture.name === "retail")!;

  const port = freePort();
  const app = await launch(port, home);
  const base = `http://127.0.0.1:${port}`;
  check("the packaged app starts with no Bun or dotnet on PATH", (await waitFor(`${base}/api/state`, 20000)) === 200);
  const state = (await (await fetch(`${base}/api/state`)).json()) as any;
  check("it serves on its port", state.version !== undefined, String(state.version));
  check("the packaged app finds its own packer", state.engine === "command", String(state.engine));
  check("the console UI is served too", (await waitFor(`${base}/`, 5000)) === 200);
  check("it reports the all-interfaces default explicitly", state.bind === "all" && state.listen === "0.0.0.0", `${state.bind}/${state.listen}`);

  const evil = await post(`${base}/api/import`, { items: [] }, { origin: "http://evil.example" });
  check("a cross-origin mutation is rejected", evil.status === 403, String(evil.status));
  const same = await post(`${base}/api/import`, { items: [] }, { origin: base });
  check("a same-origin mutation succeeds", same.status === 200, String(same.status));
  const native = await post(`${base}/api/import`, { items: [] });
  check("a native client with no Origin succeeds", native.status === 200, String(native.status));

  const imported = await post(
    `${base}/api/import`,
    { items: [{ titleId: retail.titleId, title: "Retail", path: retail.path, kind: "Game folder", size: 0 }] },
    { origin: base },
  );
  check("the packaged app imports a dump", imported.status === 200, String(imported.status));
  const built = await post(`${base}/api/build`, { titleId: retail.titleId }, { origin: base });
  check("the packaged app accepts a build", built.status === 200, `${built.status}`);
  let game: any = null;
  for (let i = 0; i < 300; i++) {
    const answer = await fetch(`${base}/api/state`);
    game = ((await answer.json()) as any).games.find((entry: any) => entry.titleId === retail.titleId);
    if (game && game.state !== "building" && game.state !== "dumped") break;
    await Bun.sleep(200);
  }
  check("and builds a real package with the bundled packer", game?.state === "built" && game?.simulated === false, `${game?.state} ${String(game?.note).slice(0, 60)}`);
  if (game?.pkgPath && existsSync(game.pkgPath)) {
    const size = (await stat(game.pkgPath)).size;
    const magic = new Uint8Array(await Bun.file(game.pkgPath).slice(0, 4).arrayBuffer());
    check(
      "the package is real (\x7FFIH magic, non-trivial size)",
      size > 4096 && magic[0] === 0x7f && magic[1] === 0x46 && magic[2] === 0x49 && magic[3] === 0x48,
      `${size} bytes`,
    );
  } else {
    check("the package is real", false, "no package path");
  }

  app.kill();

  const loopPort = freePort();
  const loop = await launch(loopPort, home, "loopback");
  const loopBase = `http://127.0.0.1:${loopPort}`;
  check("loopback mode starts", (await waitFor(`${loopBase}/api/state`, 20000)) === 200);
  const loopState = (await (await fetch(`${loopBase}/api/state`)).json()) as any;
  check("loopback is reported", loopState.bind === "loopback" && loopState.listen === "127.0.0.1", `${loopState.bind}/${loopState.listen}`);
  check("the LAN URL is the loopback one", String(loopState.lan).includes("127.0.0.1"), String(loopState.lan));
  const lanHost = Bun.spawnSync(["ipconfig", "getifaddr", "en0"]).stdout.toString().trim() || "192.168.4.26";
  let refused = true;
  try {
    refused = !(await fetch(`http://${lanHost}:${loopPort}/api/state`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    refused = true;
  }
  check("an off-host address is refused", refused, `${lanHost}:${loopPort}`);
  loop.kill();

  console.log(`\n${checks - failed}/${checks} checks passed`);
  if (failed) process.exit(1);
}

await main();
