/**
 * Checks the parts of the pipeline the other two suites cannot reach: how a
 * real packer's exit code and output are judged, and what the Mac does while a
 * pull is still running.
 *
 * tools/selftest.ts drives the HTTP API with the simulated engine, and
 * tools/payload-check.sh drives the payload. Neither touches these paths, and
 * these are the ones that fail silently — a build that never finishes, or a
 * package built from a truncated copy.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWith } from "../app/engines";
import type { Config } from "../app/core";

const WORK = "/tmp/pv_pipeline_check";
const CONSOLE_PORT = 8199;
const APP_PORT = 8191;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Starts another copy of the app against its own data folder and waits for it. */
async function startApp(
  dir: string,
  config: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ host: string; stop: () => void }> {
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const port = Number(config.port);
  const host = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "app", "server.ts")], {
    cwd: dir,
    // The suite's own folder, never the real one: a killed run must not leave
    // its titles in the person's library.
    env: { ...process.env, PV_CONFIG: configPath, PV_DATA: join(dir, "data"), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${host}/api/state`)).ok) return { host, stop: () => proc.kill() };
    } catch {
      /* still starting */
    }
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`the app did not start on ${port}`);
}

const base: Config = { port: 0, consoleHost: null, engine: "command", enginePaths: {}, scanDirs: [] };
const input = {
  titleId: "PPSA00001",
  title: "pipeline",
  sourcePath: "/tmp",
  outDir: join(WORK, "out"),
  category: null,
};

/* ---------------- how a packer's result is judged ---------------- */

await rm(WORK, { recursive: true, force: true });
await mkdir(input.outDir, { recursive: true });

try {
  const good = await buildWith(
    "command",
    input,
    {
      ...base,
      enginePaths: {
        command: `printf '\\177' > "{pkg}"; head -c 512 /dev/zero >> "{pkg}"; echo '10%'; echo '90%'`,
      },
    },
    () => {},
  );
  check("a finished packer is detected and its package accepted", existsSync(good.pkgPath) && !good.simulated);
} catch (error) {
  check("a finished packer is detected and its package accepted", false, (error as Error).message);
}

const failing = { ...input, titleId: "PPSA00002" };

let exitMessage = "";
try {
  await buildWith("command", failing, { ...base, enginePaths: { command: "exit 3" } }, () => {});
} catch (error) {
  exitMessage = (error as Error).message;
}
check("a non-zero exit is reported with its code", exitMessage.includes("(3)"), exitMessage);

let magicMessage = "";
try {
  await buildWith(
    "command",
    failing,
    { ...base, enginePaths: { command: `printf 'not a package' > "{pkg}"` } },
    () => {},
  );
} catch (error) {
  magicMessage = (error as Error).message;
}
check("output without a PS5 container header is rejected", magicMessage.includes("0x7F"), magicMessage);

check(
  "a rejected build leaves nothing in the packages folder",
  !existsSync(join(input.outDir, `${failing.titleId}.pkg`)),
);

/* ---------------- what a pull does while it runs ---------------- */

const paramJson = JSON.stringify({
  titleId: "PPSA07777",
  titleName: "Pulled Title",
  applicationCategoryType: "gd",
});
const files: Record<string, string> = { "sce_sys/param.json": paramJson, "data.bin": "x".repeat(2048) };
const sizes = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, Buffer.byteLength(value)]));
const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);

const console_ = Bun.serve({
  port: CONSOLE_PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/source/PPSA07777") {
      return Response.json({ id: "PPSA07777", kind: "dump", size: total });
    }
    if (pathname === "/api/tree/PPSA07777") {
      await Bun.sleep(400);
      return Response.json({
        id: "PPSA07777",
        files: Object.entries(sizes).map(([p, s]) => ({ p, s })),
        bytes: total,
        truncated: false,
      });
    }
    if (pathname.startsWith("/api/dump/PPSA07777/")) {
      const rel = decodeURIComponent(pathname.slice("/api/dump/PPSA07777/".length));
      const body = files[rel];
      if (!body) return new Response("no", { status: 404 });
      await Bun.sleep(700);
      return new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
    }
    return new Response("no", { status: 404 });
  },
});

const appDir = join(WORK, "app");
await mkdir(appDir, { recursive: true });
const configPath = join(appDir, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    port: APP_PORT,
    consoleHost: `http://127.0.0.1:${CONSOLE_PORT}`,
    engine: "command",
    enginePaths: { command: `printf '\\177' > "{pkg}"; head -c 64 /dev/zero >> "{pkg}"` },
    scanDirs: [],
  }),
);

const server = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "app", "server.ts")], {
  cwd: appDir,
  env: { ...process.env, PV_CONFIG: configPath, PV_DATA: join(appDir, "data"), PV_PORT: String(APP_PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

const host = `http://127.0.0.1:${APP_PORT}`;
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    up = (await fetch(`${host}/api/state`)).ok;
  } catch {
    /* still starting */
  }
  if (!up) await Bun.sleep(250);
}
check("the app starts against an isolated data folder", up);

if (up) {
  const started = Date.now();
  const build = await fetch(`${host}/api/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA07777", pull: true }),
  });
  const elapsed = Date.now() - started;
  check("a pull answers at once instead of holding the request", build.status === 202 && elapsed < 1500, `${build.status} after ${elapsed}ms`);

  const progress = await fetch(`${host}/api/progress/PPSA07777`);
  check("progress stays answerable while the pull runs", progress.status === 200, String(progress.status));

  let game: { sourcePath: string | null; pkgPath: string | null; state: string } | null = null;
  for (let i = 0; i < 60 && !game?.pkgPath; i++) {
    await Bun.sleep(250);
    const state = (await (await fetch(`${host}/api/state`)).json()) as {
      games: Array<{ titleId: string; sourcePath: string | null; pkgPath: string | null; state: string }>;
    };
    game = state.games.find((entry) => entry.titleId === "PPSA07777") ?? null;
  }
  check("the pulled source is recorded on disk", Boolean(game?.sourcePath));
  check("the pull is followed by a build", Boolean(game?.pkgPath), game?.state);

  // The copy the app made is the app's data, and the title is the only way back
  // to it: leaving it behind meant every convert-and-remove buried a whole dump.
  const pulledDir = join(appDir, "data", "pulled", "PPSA07777");
  check("the pulled dump is on disk before removal", existsSync(pulledDir));
  const removed = await fetch(`${host}/api/game/PPSA07777`, { method: "DELETE" });
  check("removing a pulled title is accepted", removed.status === 200, String(removed.status));
  check("removing a pulled title deletes the copy it made", !existsSync(pulledDir));
}

server.kill();
console_.stop();

/* ---------------- the queue survives a failure, and a stuck job gives up ---------------- */

const QUEUE_PORT = 8192;
const QUEUE_CONSOLE = 8198;
const queueAppDir = join(WORK, "queue");
const goodSource = join(WORK, "src", "good");
const badSource = join(WORK, "src", "fail-me");
await mkdir(join(goodSource, "sce_sys"), { recursive: true });
await mkdir(join(badSource, "sce_sys"), { recursive: true });
await writeFile(
  join(goodSource, "sce_sys", "param.json"),
  JSON.stringify({ titleId: "PPSA08881", titleName: "Good One" }),
);
await writeFile(
  join(badSource, "sce_sys", "param.json"),
  JSON.stringify({ titleId: "PPSA08882", titleName: "Fails" }),
);

// A console that accepts a package and then never reports the transfer again.
const queueConsole = Bun.serve({
  port: QUEUE_CONSOLE,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/health") return Response.json({ version: "pipeline" });
    if (pathname === "/api/convert") return Response.json({ ok: true, message: "fetching" }, { status: 202 });
    if (pathname === "/api/convert/status") {
      return Response.json({ id: "PPSA08881", active: false, done: false, ok: false, line: "", message: "", pct: 0 });
    }
    return new Response("no", { status: 404 });
  },
});

let queueApp: Awaited<ReturnType<typeof startApp>> | null = null;
try {
  queueApp = await startApp(
    queueAppDir,
    {
      port: QUEUE_PORT,
      consoleHost: `http://127.0.0.1:${QUEUE_CONSOLE}`,
      engine: "command",
      // One source path makes the packer fail: that is the queue's worst case.
      enginePaths: {
        command: `case "{source}" in *fail*) exit 7;; esac; printf '\\177' > "{pkg}"; head -c 64 /dev/zero >> "{pkg}"`,
      },
      scanDirs: [],
    },
    // Test-only: make the follower's idle limit reachable in seconds.
    { PV_FOLLOW_IDLE_MS: "1200" },
  );

  const imported = await fetch(`${queueApp.host}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { titleId: "PPSA08881", title: "Good One", path: goodSource, kind: "Game folder", size: 0 },
        { titleId: "PPSA08882", title: "Fails", path: badSource, kind: "Game folder", size: 0 },
      ],
    }),
  });
  check("two titles are in the library", imported.status === 200, String(imported.status));

  const queuedBad = await fetch(`${queueApp.host}/api/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA08882" }),
  });
  const queuedGood = await fetch(`${queueApp.host}/api/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA08881" }),
  });
  check(
    "both builds are accepted while one is already queued",
    queuedBad.status === 200 && queuedGood.status === 200,
    `${queuedBad.status} ${queuedGood.status}`,
  );

  const states = new Map<string, { state: string; pkgPath: string | null; note: string | null }>();
  for (let i = 0; i < 100; i++) {
    const state = (await (await fetch(`${queueApp.host}/api/state`)).json()) as {
      games: Array<{ titleId: string; state: string; pkgPath: string | null; note: string | null }>;
    };
    for (const game of state.games) states.set(game.titleId, game);
    if (states.get("PPSA08882")?.state === "error" && states.get("PPSA08881")?.state === "built") break;
    await Bun.sleep(200);
  }
  check("a failed build is reported as failed", states.get("PPSA08882")?.state === "error", states.get("PPSA08882")?.state);
  check(
    "the queue drains past a failure and builds the next title",
    states.get("PPSA08881")?.state === "built",
    states.get("PPSA08881")?.state,
  );

  // The console accepted it and then went quiet: the follower's limit has to end
  // the job in a state the interface can show, not leave it at "installing".
  const sent = await fetch(`${queueApp.host}/api/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA08881" }),
  });
  const sentBody = (await sent.json()) as { pulling?: boolean; ok?: boolean; detail?: string };
  check("the console accepts the package", sentBody.ok === true && sentBody.pulling === true, sentBody.detail);

  let tracked: { state: string; note: string | null } | null = null;
  const followDeadline = Date.now() + 12000;
  while (Date.now() < followDeadline) {
    const state = (await (await fetch(`${queueApp.host}/api/state`)).json()) as {
      games: Array<{ titleId: string; state: string; note: string | null }>;
    };
    tracked = state.games.find((game) => game.titleId === "PPSA08881") ?? null;
    if (tracked?.state === "error" || tracked?.state === "installed") break;
    await Bun.sleep(150);
  }
  check("a transfer that stops reporting fails instead of hanging", tracked?.state === "error", tracked?.state);
  check(
    "the failure says the console stopped reporting",
    /stopped reporting/i.test(tracked?.note ?? ""),
    String(tracked?.note).slice(0, 90),
  );
} catch (error) {
  check("the queue and follower checks ran", false, (error as Error).message);
} finally {
  queueApp?.stop();
  queueConsole.stop();
}

/* ---------------- a transfer that goes quiet mid-file ---------------- */

const STALL_PORT = 8193;
const STALL_CONSOLE = 8197;
const stallConsole = Bun.serve({
  port: STALL_CONSOLE,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/source/PPSA09991") {
      return Response.json({ id: "PPSA09991", kind: "image", file: "disc.exfat", size: 4096 });
    }
    if (pathname === "/api/source-file/PPSA09991") {
      // Headers, a few bytes, then nothing: exactly what a powered-off console
      // looks like from here.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
          },
        }),
        { headers: { "content-length": "4096" } },
      );
    }
    return new Response("no", { status: 404 });
  },
});

let stallApp: Awaited<ReturnType<typeof startApp>> | null = null;
try {
  stallApp = await startApp(
    join(WORK, "stall"),
    {
      port: STALL_PORT,
      consoleHost: `http://127.0.0.1:${STALL_CONSOLE}`,
      engine: "command",
      enginePaths: { command: `printf '\\177' > "{pkg}"` },
      scanDirs: [],
    },
    { PV_STALL_MS: "800" },
  );

  const pull = await fetch(`${stallApp.host}/api/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA09991", pull: true }),
  });
  check("the pull is accepted", pull.status === 202, String(pull.status));

  let stalled: { state: string; note: string | null } | null = null;
  const stallDeadline = Date.now() + 20000;
  while (Date.now() < stallDeadline) {
    const state = (await (await fetch(`${stallApp.host}/api/state`)).json()) as {
      games: Array<{ titleId: string; state: string; note: string | null }>;
    };
    stalled = state.games.find((game) => game.titleId === "PPSA09991") ?? null;
    if (stalled?.state === "error") break;
    await Bun.sleep(250);
  }
  check("a transfer that goes quiet is given up on", stalled?.state === "error", stalled?.state);
  check(
    "the failure names the silence, not a generic error",
    /stopped sending data/i.test(stalled?.note ?? ""),
    String(stalled?.note).slice(0, 90),
  );
} catch (error) {
  check("the stall checks ran", false, (error as Error).message);
} finally {
  stallApp?.stop();
  stallConsole.stop();
}

/* ---------------- a job that never finishes: the cap has to end it ---------------- */

const CAP_PORT = 8194;
const CAP_CONSOLE = 8196;
const capConsole = Bun.serve({
  port: CAP_CONSOLE,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/health") return Response.json({ version: "pipeline" });
    if (pathname === "/api/convert") return Response.json({ ok: true }, { status: 202 });
    if (pathname === "/api/convert/status") {
      // Always busy and always moving: the idle limit can never fire, so only
      // the cap can end this job.
      return Response.json({
        id: "PPSA07777",
        active: true,
        done: false,
        ok: false,
        line: `step ${Date.now()}`,
        message: "",
        pct: 40,
      });
    }
    return new Response("no", { status: 404 });
  },
});

let capApp: Awaited<ReturnType<typeof startApp>> | null = null;
try {
  const capSource = join(WORK, "src", "cap");
  await mkdir(join(capSource, "sce_sys"), { recursive: true });
  await writeFile(
    join(capSource, "sce_sys", "param.json"),
    JSON.stringify({ titleId: "PPSA07777", titleName: "Cap Test" }),
  );

  capApp = await startApp(
    join(WORK, "cap"),
    {
      port: CAP_PORT,
      consoleHost: `http://127.0.0.1:${CAP_CONSOLE}`,
      engine: "command",
      enginePaths: { command: `printf '\\177' > "{pkg}"; head -c 64 /dev/zero >> "{pkg}"` },
      scanDirs: [],
    },
    // The cap in seconds, the idle limit out of the way.
    { PV_FOLLOW_CAP_MS: "1500", PV_FOLLOW_IDLE_MS: "600000" },
  );

  await fetch(`${capApp.host}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ titleId: "PPSA07777", title: "Cap Test", path: capSource, kind: "Game folder", size: 0 }],
    }),
  });
  await fetch(`${capApp.host}/api/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA07777" }),
  });

  let ready = false;
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    const state = (await (await fetch(`${capApp.host}/api/state`)).json()) as {
      games: Array<{ titleId: string; state: string }>;
    };
    ready = state.games.some((game) => game.titleId === "PPSA07777" && game.state === "built");
    if (ready) break;
    await Bun.sleep(200);
  }
  check("the cap title has a package", ready);

  await fetch(`${capApp.host}/api/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ titleId: "PPSA07777" }),
  });

  let capped: { state: string; note: string | null } | null = null;
  const capDeadline2 = Date.now() + 15000;
  while (Date.now() < capDeadline2) {
    const state = (await (await fetch(`${capApp.host}/api/state`)).json()) as {
      games: Array<{ titleId: string; state: string; note: string | null }>;
    };
    capped = state.games.find((game) => game.titleId === "PPSA07777") ?? null;
    if (capped?.state === "error") break;
    await Bun.sleep(200);
  }
  check(
    "a job past the follower's cap is ended, not left installing",
    capped?.state === "error",
    capped?.state,
  );
  check(
    "the message names the cap rather than silence",
    /longer than this app will follow/i.test(capped?.note ?? ""),
    String(capped?.note).slice(0, 90),
  );
} catch (error) {
  check("the cap checks ran", false, (error as Error).message);
} finally {
  capApp?.stop();
  capConsole.stop();
}

/* ---------------- a console that answers badly ---------------- */
// Everything here is what a proxy, a half-updated payload, or a link that dies
// mid-answer looks like from this side. None of it may reach the interface as
// raw markup or a JavaScript parser message.
const BAD_CONSOLE_PORT = 8202;
const BAD_APP_PORT = 8203;
let badMode: "html" | "hang" = "html";

const badConsole = Bun.serve({
  port: BAD_CONSOLE_PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/health") return Response.json({ version: "hostile" });
    if (pathname === "/api/convert") {
      if (badMode === "hang") {
        await Bun.sleep(20_000);
        return new Response("late", { status: 500 });
      }
      return new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    }
    if (pathname.startsWith("/api/source/")) {
      return new Response("this is not json", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname.startsWith("/api/tree/")) {
      return new Response('{"files":[{"p":"sce_sys/param.json"', { status: 200 });
    }
    return new Response("no", { status: 404 });
  },
});

const hostileRoot = join(WORK, "hostile");
const hostileSource = join(hostileRoot, "src", "PBAD00001");
await mkdir(join(hostileSource, "sce_sys"), { recursive: true });
await writeFile(
  join(hostileSource, "sce_sys", "param.json"),
  JSON.stringify({ titleId: "PBAD00001", titleName: "Hostile Console" }),
);

let badApp: Awaited<ReturnType<typeof startApp>> | null = null;
try {
  badApp = await startApp(
    join(WORK, "badapp"),
    {
      port: BAD_APP_PORT,
      consoleHost: `http://127.0.0.1:${BAD_CONSOLE_PORT}`,
      // Not the simulated engine: a pull is only allowed when something here
      // could actually package what arrives.
      engine: "command",
      enginePaths: { command: `printf '\\177' > "{pkg}"; head -c 64 /dev/zero >> "{pkg}"` },
      scanDirs: [],
    },
    // Short enough to keep the suite quick; the shipped default is 8s.
    { PV_CONSOLE_TIMEOUT_MS: "900" },
  );

  const post = (path: string, payload: unknown) =>
    fetch(`${badApp!.host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const stateGames = async () =>
    ((await (await fetch(`${badApp!.host}/api/state`)).json()) as {
      games: Array<{ titleId: string; state: string; note: string | null }>;
    }).games;

  await post("/api/import", {
    items: [{ titleId: "PBAD00001", title: "Hostile Console", path: hostileSource, kind: "Game folder", size: 0 }],
  });
  await post("/api/build", { titleId: "PBAD00001" });
  let built = false;
  const builtDeadline = Date.now() + 20000;
  while (Date.now() < builtDeadline) {
    built = (await stateGames()).some((game) => game.titleId === "PBAD00001" && game.state === "built");
    if (built) break;
    await Bun.sleep(200);
  }
  check("the hostile-console title has a package", built);

  const deployed = (await (await post("/api/deploy", { titleId: "PBAD00001" })).json()) as {
    ok: boolean;
    detail: string;
  };
  check(
    "a console's error page is not repeated as the reason",
    !/[<>]/.test(deployed.detail),
    deployed.detail.slice(0, 90),
  );
  check(
    "the reason names the console's own answer",
    /HTTP 500/.test(deployed.detail),
    deployed.detail.slice(0, 90),
  );

  // A pull whose source answer is not JSON at all: the console is reachable,
  // so "could not reach" would be a lie, and a parser message is not a reason.
  const missingSource = join(hostileRoot, "gone", "PBAD00002");
  await post("/api/import", {
    items: [{ titleId: "PBAD00002", title: "Gone Source", path: missingSource, kind: "Game folder", size: 0 }],
  });
  await post("/api/build", { titleId: "PBAD00002", pull: true });
  let pulled: { state: string; note: string | null } | undefined;
  const pullDeadline = Date.now() + 15000;
  while (Date.now() < pullDeadline) {
    pulled = (await stateGames()).find((game) => game.titleId === "PBAD00002");
    if (pulled?.state === "error") break;
    await Bun.sleep(200);
  }
  check(
    "an unreadable source answer is named, not decoded",
    /not readable JSON/i.test(pulled?.note ?? ""),
    String(pulled?.note).slice(0, 90),
  );

  // A console that accepts the connection and never answers must come back as
  // an answer well inside the interface's own deadline.
  badMode = "hang";
  const hangStart = Date.now();
  const hangResponse = await post("/api/deploy", { titleId: "PBAD00001" });
  const hung = (await hangResponse.json()) as { ok: boolean; detail?: string };
  const hangTook = Date.now() - hangStart;
  check("a console that never answers comes back as an answer", hangTook < 6000, `${hangTook}ms`);
  check(
    "that answer says the console was too slow",
    /did not answer within/i.test(hung.detail ?? ""),
    `${hangResponse.status} ${JSON.stringify(hung).slice(0, 90)}`,
  );
} catch (error) {
  check("the hostile-console checks ran", false, (error as Error).message);
} finally {
  badApp?.stop();
  badConsole.stop();
}

/* ---------------- a probe that blinks ---------------- */
// A console that drops one connection and then answers is a blink, not an
// outage. The first attempt at the health check used to decide the whole pill.
const BLINK_PORT = 8204;
const BLINK_APP_PORT = 8205;
let blinkMode: "dropAll" | "dropOne" | "badHealth" | "hang" = "dropAll";
let blinkDropped = 0;
let blinkConnections = 0;

const blinkConsole = Bun.listen({
  hostname: "127.0.0.1",
  port: BLINK_PORT,
  socket: {
    data(socket, chunk) {
      blinkConnections++;
      const request = new TextDecoder().decode(chunk);
      if (!request.includes("/api/health")) {
        socket.end();
        return;
      }
      if (blinkMode === "hang") {
        // Accepted and never answered: a console that is switched off looks
        // like this from the far side of a black-holed address.
        return;
      }
      if (blinkMode === "dropAll") {
        socket.end();
        return;
      }
      if (blinkMode === "dropOne" && blinkDropped === 0) {
        blinkDropped++;
        socket.end();
        return;
      }
      const body = blinkMode === "badHealth" ? "oops, not json" : JSON.stringify({ version: "blink", free: 4096 });
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      );
      socket.end();
    },
  },
});

let blinkApp: Awaited<ReturnType<typeof startApp>> | null = null;
try {
  blinkApp = await startApp(join(WORK, "blinkapp"), {
    port: BLINK_APP_PORT,
    consoleHost: `http://127.0.0.1:${BLINK_PORT}`,
    engine: "mock",
    enginePaths: {},
    scanDirs: [],
  });

  const consoleState = async () => {
    // Clearing the settings drops the 4s console cache, so the next state asks.
    await fetch(`${blinkApp!.host}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const state = (await (await fetch(`${blinkApp!.host}/api/state`)).json()) as {
      console: { connected: boolean; detail: string };
    };
    return state.console;
  };

  blinkMode = "dropOne";
  blinkDropped = 0;
  const blinked = await consoleState();
  check("a dropped connection is retried before calling the console offline", blinked.connected === true, blinked.detail);

  // A console that is down must not turn the interface's own polling into a
  // probe storm: the 4s cache means one question, not one per request.
  blinkMode = "dropAll";
  await fetch(`${blinkApp.host}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  blinkConnections = 0;
  let stateCalls = 0;
  const burstUntil = Date.now() + 1500;
  while (Date.now() < burstUntil) {
    await fetch(`${blinkApp.host}/api/state`);
    stateCalls++;
  }
  check(
    "a dead console is asked once, not once per request",
    blinkConnections <= 4,
    `${blinkConnections} connections for ${stateCalls} state calls`,
  );

  blinkMode = "hang";
  const hangProbeStart = Date.now();
  await consoleState();
  const hangProbeTook = Date.now() - hangProbeStart;
  check(
    "a silent console is not asked twice in one probe",
    hangProbeTook < 5500,
    `${hangProbeTook}ms`,
  );

  blinkMode = "badHealth";
  const unreadableHealth = await consoleState();
  check(
    "an unreadable health answer is named, not decoded",
    /could not read/i.test(unreadableHealth.detail) && !/Unexpected|JSON/i.test(unreadableHealth.detail),
    unreadableHealth.detail.slice(0, 80),
  );
} catch (error) {
  check("the blinking-console checks ran", false, (error as Error).message);
} finally {
  blinkApp?.stop();
  blinkConsole.stop(true);
}

/* ---------------- a pull that survives a bad link ---------------- */
// A raw listener, so the bytes and the failures are exact: dropped mid-body,
// stalled after a few bytes, a range answered short, a range ignored entirely.
// Every scenario has to end with a file identical to the console's copy.
const RESUME_CONSOLE = 8206;
const RESUME_APP = 8207;
const RESUME_SIZE = 256 * 1024;
const remote = Buffer.alloc(RESUME_SIZE);
for (let i = 0; i < RESUME_SIZE; i++) remote[i] = (i * 31 + 7) & 0xff;

type Fault = "drop" | "stall" | "short" | "long";
let faults: Fault[] = [];
let faultIndex = 0;
const pendingRequests = new Map<unknown, string>();

const resumeConsole = Bun.listen({
  hostname: "127.0.0.1",
  port: RESUME_CONSOLE,
  socket: {
    data(socket, chunk) {
      const seen = (pendingRequests.get(socket) ?? "") + new TextDecoder().decode(chunk);
      if (!seen.includes("\r\n\r\n")) {
        pendingRequests.set(socket, seen);
        return;
      }
      pendingRequests.delete(socket);
      const path = seen.split("\r\n")[0].split(" ")[1] ?? "";

      if (path.startsWith("/api/source/")) {
        const body = JSON.stringify({ kind: "image", file: "disc.bin", size: RESUME_SIZE });
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        );
        socket.end();
        return;
      }
      if (!path.startsWith("/api/source-file/")) {
        socket.end();
        return;
      }

      const range = /range: bytes=(\d+)-/i.exec(seen);
      const start = range ? Number(range[1]) : 0;
      const slice = remote.subarray(Math.min(start, RESUME_SIZE));
      const fault = faults[faultIndex++] ?? null;

      if (fault === "long") {
        // Ignores the range and sends everything, as some servers do.
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${RESUME_SIZE}\r\nConnection: close\r\n\r\n`);
        socket.write(remote);
        socket.end();
        return;
      }

      const answer = fault === "short" ? slice.subarray(0, Math.max(1, slice.length - 1024)) : slice;
      const head =
        `HTTP/1.1 ${start > 0 ? "206 Partial Content" : "200 OK"}\r\n` +
        `Content-Range: bytes ${start}-${start + answer.length - 1}/${RESUME_SIZE}\r\n` +
        `Content-Length: ${answer.length}\r\nConnection: close\r\n\r\n`;
      socket.write(head);

      if (fault === "drop") {
        socket.write(answer.subarray(0, Math.floor(answer.length / 2)));
        socket.end();
        return;
      }
      if (fault === "stall") {
        // Half the answer, then silence: the watchdog has to end this attempt.
        socket.write(answer.subarray(0, Math.floor(answer.length / 2)));
        return;
      }
      socket.write(answer);
      socket.end();
    },
  },
});

const resumeAppDir = join(WORK, "resumeapp");
let resumeApp: Awaited<ReturnType<typeof startApp>> | null = null;
try {
  resumeApp = await startApp(
    resumeAppDir,
    {
      port: RESUME_APP,
      consoleHost: `http://127.0.0.1:${RESUME_CONSOLE}`,
      engine: "command",
      enginePaths: { command: `printf '\\177' > "{pkg}"; head -c 64 /dev/zero >> "{pkg}"` },
      scanDirs: [],
    },
    // A short stall watchdog: the stall scenario must not take 90 seconds.
    { PV_STALL_MS: "400" },
  );

  const post = (path: string, payload: unknown) =>
    fetch(`${resumeApp!.host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const pullScenario = async (
    id: string,
    list: Fault[],
    prepare?: (dir: string) => Promise<void>,
  ): Promise<{ note: string; identical: boolean; size: number }> => {
    faults = list;
    faultIndex = 0;
    const dir = join(resumeAppDir, "data", "pulled", id);
    await rm(dir, { recursive: true, force: true });
    if (prepare) {
      await mkdir(dir, { recursive: true });
      await prepare(dir);
    }
    await post("/api/import", {
      items: [{ titleId: id, title: id, path: join(WORK, "gone", id), kind: "Game folder", size: 0 }],
    });
    await post("/api/build", { titleId: id, pull: true });

    let game: { state: string; note: string | null } | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = (await (await fetch(`${resumeApp!.host}/api/state`)).json()) as {
        games: Array<{ titleId: string; state: string; note: string | null }>;
      };
      game = state.games.find((entry) => entry.titleId === id);
      // "built" means the pull completed and the packer ran on it.
      if (game?.state === "built" || game?.state === "error") break;
      await Bun.sleep(200);
    }

    const file = join(dir, "disc.bin");
    const bytes = await readFile(file).catch(() => null);
    return {
      note: `${game?.state} ${game?.note ?? ""}`,
      identical: Boolean(bytes) && Buffer.compare(bytes as Buffer, remote) === 0,
      size: bytes?.length ?? 0,
    };
  };

  const dropped = await pullScenario("PRES00001", ["drop"]);
  check("a pull dropped mid-body resumes and finishes", dropped.identical, dropped.note.slice(0, 80));

  const twice = await pullScenario("PRES00002", ["drop", "drop"]);
  check("two drops in one pull still finish identically", twice.identical, twice.note.slice(0, 80));

  const stalled = await pullScenario("PRES00003", ["stall"]);
  check("a pull that stalls then recovers finishes identically", stalled.identical, stalled.note.slice(0, 80));

  const short = await pullScenario("PRES00004", ["short"]);
  check("a range answered short is resumed, not accepted", short.identical, short.note.slice(0, 80));

  const long = await pullScenario("PRES00005", ["drop", "long"]);
  check("a server that ignores the range rewrites the file cleanly", long.identical, long.note.slice(0, 80));

  const truncated = await pullScenario("PRES00006", [], async (dir) => {
    await writeFile(join(dir, "disc.bin"), remote.subarray(0, 1000));
  });
  check("a truncated local partial is completed exactly", truncated.identical, truncated.note.slice(0, 80));

  const oversized = await pullScenario("PRES00007", [], async (dir) => {
    const junk = Buffer.alloc(RESUME_SIZE + 5000, 9);
    await writeFile(join(dir, "disc.bin"), junk);
  });
  check("a local partial larger than the remote starts over", oversized.identical, oversized.note.slice(0, 80));
} catch (error) {
  check("the resume checks ran", false, (error as Error).message);
} finally {
  resumeApp?.stop();
  resumeConsole.stop(true);
}

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
