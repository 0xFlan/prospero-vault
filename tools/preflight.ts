/**
 * One command that reports every precondition for both test paths before
 * anything is built:
 *
 *   bun run preflight --dump <folder> [--console host:port] [--mac host:port]
 *   bun run preflight --dump <folder> --path mac --run
 *
 * Exit codes: 0 every precondition passed, 1 something failed, 2 bad usage.
 * With --run it also carries the dump through to a package: import, build, and
 * (for --path mac) send it to the console. The outcome is written to
 * data/last-gate.json in the Mac app's data folder.
 */
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type Check = { path: "both" | "console" | "mac"; name: string; ok: boolean; detail: string };

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : null;
};
const MAC = (flag("--mac") ?? "127.0.0.1:8090").replace(/^https?:\/\//, "").replace(/\/$/, "");
const RUN = args.includes("--run");
const PATH = (flag("--path") ?? "both") as "both" | "console" | "mac";
const dumpArg = flag("--dump");

const checks: Check[] = [];
const add = (path: Check["path"], name: string, ok: boolean, detail: string) => checks.push({ path, name, ok, detail });
const later = (path: Check["path"], name: string, detail: string) => add(path, name, false, detail);

async function get(url: string, timeoutMs = 4000): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: (await res.text()).slice(0, 4000) };
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown, timeoutMs = 120000): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: (await res.text()).slice(0, 4000) };
  } catch {
    return null;
  }
}

const titled = (url: string, id: string) => `${url.replace(/\/$/, "")}/api/ready/${encodeURIComponent(id)}`;

async function main(): Promise<void> {
  if (!dumpArg) {
    console.error("usage: bun run preflight --dump <folder> [--console host:port] [--mac host:port] [--path console|mac|both] [--run]");
    process.exit(2);
  }
  const dump = resolve(dumpArg);

  // ---- companion Mac ----
  const stateAnswer = await get(`http://${MAC}/api/state`);
  let state: any = null;
  if (stateAnswer?.status === 200) {
    try {
      state = JSON.parse(stateAnswer.text);
    } catch {
      state = null;
    }
  }
  add("both", "companion Mac: app answers /api/state", Boolean(state), state ? `http://${MAC}` : `no answer from http://${MAC} — start it with "bun run dev"`);

  const engine = state?.engine as string | undefined;
  add(
    "both",
    "companion Mac: a real packer is available",
    engine === "command",
    engine === "command"
      ? "bundled packer (or a configured command)"
      : `engine is "${engine ?? "unknown"}" — run ./packer/build.sh, or set a packer command in Settings`,
  );

  const lan = typeof state?.lan === "string" && state.lan.startsWith("http") ? state.lan.replace(/\/$/, "") : null;
  const lanHost = lan ? new URL(lan).hostname : "";
  const loopback = /^(127\.|localhost$|::1$|169\.254\.)/.test(lanHost);
  add(
    "both",
    "companion Mac: advertises a LAN address (not loopback)",
    Boolean(lan) && !loopback,
    lan ?? "the app did not report a LAN address — connect this Mac to the same network as the console",
  );
  if (lan && !loopback) {
    const viaLan = await get(`${lan}/api/state`);
    add("both", "companion Mac: answers over that LAN address", viaLan?.status === 200, `${lan}/api/state → ${viaLan?.status ?? "no answer"}`);
  } else {
    later("both", "companion Mac: answers over that LAN address", "no usable LAN address to try");
  }

  // ---- the dump ----
  let dumpProblem: string | null = null;
  let titleId: string | null = null;
  let category: string | null = null;
  if (!existsSync(dump)) {
    dumpProblem = `${dump} does not exist`;
  } else if (!statSync(dump).isDirectory()) {
    dumpProblem = `${dump} is not a folder — pass the dump folder itself`;
  } else {
    try {
      const entries = await readdir(dump, { withFileTypes: true });
      const meta = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "sce_sys");
      if (!meta) dumpProblem = `${dump} has no sce_sys folder`;
      else {
        const inside = (await readdir(join(dump, meta.name), { withFileTypes: true })).map((entry) => entry.name);
        const found = (name: string) => inside.find((entry) => entry.toLowerCase() === name);
        if (!found("param.json") && !found("param.sfo")) dumpProblem = `${join(dump, meta.name)} has neither param.json nor param.sfo`;
        try {
          const raw = found("param.json") ? await readFile(join(dump, meta.name, found("param.json")!), "utf8") : "{}";
          const parsed = JSON.parse(raw) as any;
          titleId = typeof parsed.titleId === "string" ? parsed.titleId : null;
          category = typeof parsed.applicationCategoryType === "string" ? parsed.applicationCategoryType.toLowerCase() : null;
        } catch {
          dumpProblem = "param.json is not readable JSON — the packer will refuse it";
        }
        const eboot = entries.some((entry) => entry.name.toLowerCase() === "eboot.bin");
        if (!dumpProblem && category !== "ac" && !eboot) dumpProblem = `${dump} has no eboot.bin`;
      }
    } catch (error) {
      dumpProblem = `${dump} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  add("both", "dump: readable folder with metadata and eboot", dumpProblem === null, dumpProblem ?? dump);
  if (!titleId) later("both", "dump: declares a title id", "param.json has no titleId — the packer cannot name the package");

  // ---- console ----
  const consoleHost = (flag("--console") ?? state?.config?.consoleHost ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  let health: any = null;
  let free = 0;
  if (!consoleHost) {
    later("console", "console: address configured", 'no address — pass --console 192.168.x.y:8097, or set it in the Mac app Settings');
    later("console", "console: payload answers /api/health", "skipped: no console address");
    later("console", "console: enough free space", "skipped: no console address");
  } else {
    add("console", "console: address configured", true, consoleHost);
    const answer = await get(`http://${consoleHost}/api/health`);
    if (answer?.status === 200) {
      try {
        health = JSON.parse(answer.text);
      } catch {
        health = null;
      }
    }
    add(
      "console",
      "console: payload answers /api/health",
      Boolean(health),
      health
        ? `payload ${health.version ?? "?"} at http://${consoleHost}`
        : `no answer from http://${consoleHost}/api/health — load console/build/prospero-vault.elf with elfldr, then check the address`,
    );
    free = typeof health?.free === "number" ? health.free : 0;
    if (!health) later("console", "console: enough free space", "skipped: console not reachable");
    else if (category === "ac") add("console", "console: enough free space", true, "additional content is small");
    else add("console", "console: enough free space", free > 2 * 1024 ** 3, `${(free / 1024 ** 3).toFixed(1)} GB free (a package needs its own size plus headroom)`);
  }

  // ---- path-specific requirements ----
  const games: any[] = Array.isArray(state?.games) ? state.games : [];
  if (!consoleHost || !health) {
    later("console", "console-direct: console lists this dump", "skipped: console not reachable");
  } else {
    // The console's own scan, not the Mac's library: this line is about what
    // the console can start a Convert for.
    let consoleGames: any[] = [];
    const consoleState = await get(`http://${consoleHost}/api/games`, 5000);
    try {
      consoleGames = consoleState ? JSON.parse(consoleState.text).games ?? [] : [];
    } catch {
      consoleGames = [];
    }
    const listed = consoleGames.some((game: any) => game.id === titleId);
    // Only a console-direct run needs the dump in the console's own scan. With
    // --path mac the Mac can hold it, and the console learns the title from the
    // package it fetches, so this is reported rather than required.
    add(
      "console",
      "console-direct: console lists this dump",
      listed || PATH !== "console",
      listed
        ? `${titleId} is in the console's scan`
        : PATH === "console"
          ? `console does not list ${titleId} — copy the dump to /data/prospero-vault/Games and rescan there, or use --path mac`
          : `not required for --path ${PATH}; the Mac will send the package`,
    );
  }

  // ---- report ----
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} preconditions passed`);
  if (failed.length) {
    console.log("Nothing was built: fix the FAIL lines above, then run this again.");
  }

  let outcome: any = null;
  if (RUN && failed.length === 0 && titleId) {
    const macAddress = lan ? lan.replace(/^https?:\/\//, "") : null;
    if (PATH === "console" && consoleHost) {
      // Console-direct is started from the console's own Convert screen. The
      // gate takes that exact step for the person, over the console's API.
      console.log(`\nAsking the console to convert ${titleId}…`);
      const startedJob = await post(`http://${consoleHost}/api/convert`, { id: titleId, mac: macAddress }, 15000);
      let status: any = null;
      for (let i = 0; i < 900; i++) {
        const answer = await get(`http://${consoleHost}/api/convert/status`, 3000);
        status = answer ? JSON.parse(answer.text) : null;
        if (status?.done) break;
        await Bun.sleep(500);
      }
      console.log(`  console ${startedJob?.status ?? "no answer"}; ${status?.ok ? "done" : "failed"} — ${status?.message ?? "no status"}`);
      outcome = { titleId, path: "console", started: startedJob?.status ?? null, done: status?.done === true, ok: status?.ok === true, message: status?.message ?? null };
    } else {
      // The same endpoints the UI calls, in the same order.
      console.log(`\nBuilding ${titleId} on the companion Mac…`);
      const items = [{ titleId, title: titleId, path: dump, kind: "Game folder", size: 0 }];
      const imported = await post(`http://${MAC}/api/import`, { items });
      const built = await post(`http://${MAC}/api/build`, { titleId });
      let game: any = null;
      for (let i = 0; i < 600; i++) {
        const answer = await get(`http://${MAC}/api/state`, 2000);
        try {
          game = answer ? JSON.parse(answer.text).games.find((entry: any) => entry.titleId === titleId) : null;
        } catch {
          game = null;
        }
        if (game && game.state !== "building" && game.state !== "dumped") break;
        await Bun.sleep(200);
      }
      console.log(`  import ${imported?.status ?? "no answer"}; build ${built?.status ?? "no answer"}; state ${game?.state ?? "unknown"}${game?.note ? ` — ${game.note}` : ""}`);

      if (PATH !== "console" && game?.state === "built") {
        const sent = await post(`http://${MAC}/api/deploy`, { titleId });
        console.log(`  deploy ${sent?.status ?? "no answer"} ${sent?.text?.slice(0, 200) ?? ""}`);
        outcome = { titleId, path: "mac", state: game.state, deployed: sent?.status === 200 };
      } else {
        outcome = { titleId, path: "mac", state: game?.state ?? null, deployed: false };
      }
    }
  }

  const record = { at: new Date().toISOString(), path: PATH, dump, consoleHost, mac: MAC, checks, outcome };
  try {
    const dataDir = process.env.PV_DATA ?? join(process.cwd(), "data");
    await writeFile(join(dataDir, "last-gate.json"), JSON.stringify(record, null, 2));
  } catch {
    /* the report is the point; recording is best effort */
  }
  process.exit(failed.length ? 1 : 0);
}

await main();
