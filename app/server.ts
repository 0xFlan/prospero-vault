import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  PKG_DIR,
  ROOT,
  ensureDirs,
  isInside,
  lanAddress,
  loadConfig,
  saveConfig,
  scanDir,
  shortSize,
  configProblem,
  normaliseHost,
  ENGINE_IDS,
  type Config,
} from "./core";
import { loadLibrary, saveLibrary, touch, librarySkipped, libraryProblem, type Game } from "./library";
import {
  buildWith,
  probeEngines,
  resolveEngineFrom,
  sweepWorkbench,
  type EngineStatus,
} from "./engines";
import { install as installToConsole, probe as probeConsole, type ConsoleStatus } from "./console";
import { pullSource, PULL_ROOT } from "./pull";

const PUBLIC_DIR = join(ROOT, "public");
const VERSION = "0.10.0";

/* ------------------------------------------------------------------ *
 * In-memory state
 * ------------------------------------------------------------------ */

let config: Config;
let games: Game[] = [];

/** Latest packaging progress per title, so the console can poll it over plain HTTP. */
const buildProgress = new Map<
  string,
  { pct: number; line: string; state: string; message: string | null }
>();

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const heartbeats = new Map<ReadableStreamDefaultController<Uint8Array>, ReturnType<typeof setInterval>>();
const encoder = new TextEncoder();

function broadcast(message: unknown): void {
  const frame = encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
  for (const client of clients) {
    try {
      client.enqueue(frame);
    } catch {
      clients.delete(client);
      const timer = heartbeats.get(client);
      if (timer) clearInterval(timer);
      heartbeats.delete(client);
    }
  }
}

/** Set when the last library write failed, so the interface can say so. */
let saveProblem: string | null = null;

/**
 * Queued, not raced: two saves in flight finish in whatever order the disk
 * chooses, so an older snapshot could land last and bring back a title that
 * had just been deleted. Each queued write serialises the library as it is
 * when the write runs, and a failure is named instead of swallowed.
 */
let persistChain: Promise<void> = Promise.resolve();

function persist(): Promise<boolean> {
  persistChain = persistChain.then(async () => {
    try {
      await saveLibrary(games);
      saveProblem = null;
    } catch (error) {
      saveProblem =
        "The library could not be written to the data folder. Anything changed since the last good save will be lost when this app restarts.";
      console.error("[library] save failed:", error);
    }
  });
  return persistChain.then(() => saveProblem === null);
}

let consoleCache: { at: number; value: ConsoleStatus } | null = null;

/** `which` is a subprocess and the interface polls often, so ask at most every 5s. */
let engineCache: { at: number; list: EngineStatus[] } | null = null;

function engineList(force = false): EngineStatus[] {
  const now = Date.now();
  if (!force && engineCache && now - engineCache.at < 5000) return engineCache.list;
  const list = probeEngines(config);
  engineCache = { at: now, list };
  return list;
}

async function consoleStatus(force = false): Promise<ConsoleStatus> {
  const now = Date.now();
  if (!force && consoleCache && now - consoleCache.at < 4000) return consoleCache.value;
  const value = await probeConsole(config.consoleHost);
  consoleCache = { at: now, value };
  return value;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// `error` is what this app's own clients read; `message` is what the console UI
// reads. Sending both keeps one shape for every failure, whichever client asks.
const bad = (message: string, status = 400) => json({ error: message, message }, status);

/** A request body past this is not a title list: refuse it before reading it. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The body stopped arriving: the client stalled, so there is nothing to answer but 408. */
class BodyTimeout extends Error {}

/** A body past MAX_BODY_BYTES, whether or not it declared its length. */
class BodyTooLarge extends Error {}

/**
 * A client can declare more bytes than it sends and then go quiet. Left alone,
 * that request holds its handler (and its socket) until the runtime's idle
 * timeout, with no answer ever written. The deadline bounds it.
 */
const BODY_DEADLINE_MS = Math.max(200, Number(process.env.PV_BODY_DEADLINE_MS ?? 10_000) || 10_000);

async function body<T>(req: Request): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = req
      .text()
      .then((raw) => {
        // A chunked body has no declared length, so the up-front Content-Length
        // check cannot see it. Refuse it here rather than parse a 2 MiB title
        // list the app would never use.
        if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new BodyTooLarge("body too large");
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      })
      .catch((error) => {
        if (error instanceof BodyTooLarge) throw error;
        return null;
      });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BodyTimeout("body stopped arriving")), BODY_DEADLINE_MS);
    });
    return (await Promise.race([read, deadline])) as T | null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fields arrive from two interfaces and any client on the LAN. A value of the
 * wrong type used to reach `.trim()` or `for…of` and become a 500; every one of
 * these is a bad request, and says so.
 */
const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function findGame(titleId: string): Game | undefined {
  return games.find((g) => g.titleId === titleId);
}

/**
 * A title id becomes a file name (`<id>.pkg`) and a folder name under
 * data/pulled, and it arrives from the network. Letters, digits, dash and
 * underscore only: any separator or dot is refused, so nothing can climb out of
 * the folders this app owns.
 */
function safeId(id: string): boolean {
  return id.length > 0 && id.length <= 24 && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Route ids are percent-decoded; a malformed escape is a bad request, not a crash. */
function routeId(pathname: string, prefix: string): string {
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * Build queue — one package at a time, on purpose.
 * ------------------------------------------------------------------ */

/**
 * How long a follower waits. Overridable only so a test can reach the timeout
 * without waiting twenty minutes; the defaults are what a real transfer gets.
 */
const FOLLOW_IDLE_MS = Number(process.env.PV_FOLLOW_IDLE_MS ?? 0) || 20 * 60_000;
const FOLLOW_CAP_MS = Number(process.env.PV_FOLLOW_CAP_MS ?? 0) || 6 * 60 * 60_000;

let buildChain: Promise<void> = Promise.resolve();

/** Titles already queued but not yet marked building, so a double tap cannot queue twice. */
const pendingBuilds = new Set<string>();

/** Titles currently being copied off the console. */
const pulling = new Set<string>();

/**
 * The title whose package is on its way, if any. The console runs one install
 * job at a time, so deploys are serialised across titles as well as within one:
 * a second package sent mid-flight would be answered for the first title.
 */
let deploying: string | null = null;

/** Titles a follower is already watching, one loop per title. */
const tracking = new Set<string>();

function enqueueBuild(game: Game): void {
  pendingBuilds.add(game.titleId);
  buildChain = buildChain
    .then(() => runBuild(game))
    .catch((error) => console.error("[build]", error))
    .finally(() => pendingBuilds.delete(game.titleId));
}

async function runBuild(game: Game): Promise<void> {
  if (!game.sourcePath) {
    game.state = "error";
    game.note = "No source path recorded for this game.";
    touch(game);
    await persist();
    broadcast({ type: "state" });
    return;
  }

  const engine = resolveEngineFrom(engineList(), config);

  // A pulled source only reveals its category afterwards, so the same rule as
  // /api/build applies here — an application packer would build DLC as an app.
  if (game.category === "ac" && engine !== "command") {
    game.state = "error";
    game.note =
      "Additional content (DLC) needs an AC-capable packer. Set a custom command in Settings: " +
      'acpack build --source "{source}" --output "{output}"';
    touch(game);
    await persist();
    broadcast({ type: "state", games });
    return;
  }

  console.log(`  build   ${game.titleId} via ${engine}`);
  game.state = "building";
  buildProgress.set(game.titleId, { pct: 0, line: "queued", state: "building", message: null });
  game.engine = engine;
  game.note = null;
  // Keep the last good package until a new one exists: a failed rebuild must not
  // make an already-installable package vanish from the library.
  const previous = { pkgPath: game.pkgPath, pkgSize: game.pkgSize, simulated: game.simulated };
  game.pkgPath = null;
  game.pkgSize = 0;
  touch(game);
  await persist();
  broadcast({ type: "state", games });

  try {
    const result = await buildWith(
      engine,
      {
        titleId: game.titleId,
        title: game.title,
        sourcePath: game.sourcePath,
        category: game.category,
        outDir: PKG_DIR,
      },
      config,
      (progress) => {
        const pct = Math.round(progress.pct);
        buildProgress.set(game.titleId, { pct, line: progress.line, state: "building", message: null });
        broadcast({ type: "progress", titleId: game.titleId, pct, line: progress.line });
      },
    );

    const size = (await stat(result.pkgPath)).size;
    game.pkgPath = result.pkgPath;
    game.pkgSize = size;
    game.simulated = result.simulated;
    game.state = "built";
    game.note = result.simulated
      ? "Built with the simulated engine — this .pkg is a placeholder, not installable."
      : `Packaged with ${engine} (${shortSize(size)})`;
    console.log(`  built   ${game.titleId} ${shortSize(size)}`);
    buildProgress.set(game.titleId, {
      pct: 100,
      line: "package ready",
      state: "built",
      message: game.note,
    });
    touch(game);
  } catch (error) {
    game.state = "error";
    game.pkgPath = previous.pkgPath;
    game.pkgSize = previous.pkgSize;
    game.simulated = previous.simulated;
    game.note = error instanceof Error ? error.message : String(error);
    buildProgress.set(game.titleId, {
      pct: 100,
      line: "failed",
      state: "error",
      message: game.note,
    });
    touch(game);
    broadcast({ type: "log", titleId: game.titleId, line: game.note });
  }

  // The library write is part of the build. A full or read-only data folder
  // used to leave the app saying "packaged" with nothing on disk and only a
  // console line to show for it.
  const saved = await persist();
  if (!saved) {
    const tail = "the library could not be saved, so this will be lost when the app restarts.";
    game.note =
      game.state === "built"
        ? `The package was built, but ${tail}`
        : `${game.note ? `${game.note} ` : ""}It ${tail}`;
  }
  broadcast({ type: "state", games });
}

/**
 * Follows a pull the console started. Its worker thread does the transfer, so
 * the Mac records the real outcome instead of calling it done up front.
 */
async function trackConsolePull(game: Game): Promise<void> {
  const base = config.consoleHost?.replace(/\/$/, "");
  if (!base) return;
  // One follower per title. A second deploy used to start a second loop over
  // the same job, and the two wrote the same fields from two places.
  if (tracking.has(game.titleId)) return;
  tracking.add(game.titleId);

  try {
    await followConsolePull(game, base);
  } finally {
    tracking.delete(game.titleId);
  }
}

async function followConsolePull(game: Game, base: string): Promise<void> {

  // Two limits, because they answer different questions. A transfer of sixty
  // gigabytes can legitimately run for an hour, so a single fixed deadline
  // would report failure on a pull that was still working. Silence is the real
  // signal, and the hard cap only stops a console that keeps talking forever.
  const idleLimit = FOLLOW_IDLE_MS;
  const hardLimit = Date.now() + FOLLOW_CAP_MS;
  let lastReport = Date.now();
  let lastLine = game.note ?? "";

  while (Date.now() < hardLimit && Date.now() - lastReport < idleLimit) {
    await new Promise((resolve) => setTimeout(resolve, 2500));

    let latest:
      | { active?: boolean; done?: boolean; ok?: boolean; id?: string; line?: string; message?: string; pct?: number }
      | null = null;
    try {
      const res = await fetch(`${base}/api/convert/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) latest = (await res.json()) as typeof latest;
    } catch {
      continue; // the console may be busy; try again shortly
    }
    if (!latest || latest.id !== game.titleId) continue;

    if (latest.active) {
      const line = `${latest.line || "working"}${typeof latest.pct === "number" ? ` · ${latest.pct}%` : ""}`;
      // Any change, even a percentage, says the console is still on this job.
      if (line === lastLine) continue;
      lastReport = Date.now();
      lastLine = line;
      game.note = line;
      touch(game);
      broadcast({ type: "state", games });
      continue;
    }

    if (!latest.done) continue;

    game.state = latest.ok ? "installed" : "error";
    game.consoleLabel = latest.ok ? base : null;
    game.note = latest.ok
      ? `On the console${latest.message ? ` · ${latest.message}` : ""}`
      : latest.message || "The console could not finish the transfer.";
    touch(game);
    await persist();
    broadcast({ type: "state", games });
    return;
  }

  // The follower gave up waiting. Leaving the title at "installing" would show
  // a job that can never move again, so it becomes an error with the reason —
  // and the reason differs depending on which limit it hit.
  const capped = Date.now() >= hardLimit;
  game.state = "error";
  game.note = capped
    ? "This transfer has been running longer than this app will follow, so it stopped watching. " +
      "Check it on the console — the package on this Mac is unchanged."
    : "The console stopped reporting this transfer, so it was left unfinished there. Check it on the " +
      "console, then deploy again — the package on this Mac is unchanged.";
  touch(game);
  await persist();
  broadcast({ type: "state", games });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** The verbs each endpoint answers, so a wrong one can say which is right. */
function allowedMethods(pathname: string): string[] | null {
  if (pathname === "/api/state" || pathname === "/api/events") return ["GET"];
  if (
    pathname === "/api/scan" ||
    pathname === "/api/import" ||
    pathname === "/api/build" ||
    pathname === "/api/deploy" ||
    pathname === "/api/settings"
  )
    return ["POST"];
  if (pathname.startsWith("/api/game/")) return ["DELETE"];
  if (
    pathname.startsWith("/api/progress/") ||
    pathname.startsWith("/api/ready/") ||
    pathname.startsWith("/api/pkg/") ||
    pathname.startsWith("/api/icon/")
  )
    return ["GET"];
  return null;
}

async function serveStatic(pathname: string): Promise<Response> {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  // One segment, starting with a real character: the old class accepted "..",
  // which resolves to the parent of public/.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(join(PUBLIC_DIR, name));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "cache-control": "no-cache" } });
}

async function state(): Promise<Response> {
  const engines = engineList();
  return json({
    version: VERSION,
    games,
    engines,
    engine: resolveEngineFrom(engines, config),
    console: await consoleStatus(),
    config: {
      port: config.port,
      consoleHost: config.consoleHost,
      engine: config.engine,
      enginePaths: config.enginePaths,
      scanDirs: config.scanDirs,
    },
    lan: `http://${lanAddress()}:${config.port}`,
    pkgDir: PKG_DIR,
    // Said out loud rather than silently swallowed: a file that could not be
    // read looks exactly like the app forgetting the user's settings.
    configProblem,
    libraryProblem,
    dataProblem,
    librarySkipped,
    saveProblem,
    // A stream that was opened and never cancelled leaves a heartbeat timer
    // behind on every reconnect. Counting them makes that visible.
    streams: clients.size,
  });
}

async function handle(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;

  // A body larger than any request this app accepts is refused up front, so a
  // stray upload cannot be buffered in memory and turned into a 500.
  if (pathname.startsWith("/api/")) {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return bad("That request is larger than this app accepts.", 413);
    }
  }

  if (req.method === "GET" && pathname === "/api/state") return state();

  if (req.method === "GET" && pathname === "/api/events") {
    // One cleanup per stream, reachable from both the abort and the cancel
    // path, so a stream can never be left in either map.
    let detach: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add(controller);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "hello" })}\n\n`));
        // A comment frame every 15s. An idle event stream through a proxy, or
        // over a Wi-Fi link that dozed, is otherwise closed silently — and the
        // page then shows stale state with no sign that it stopped updating.
        const timer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(timer);
            heartbeats.delete(controller);
            clients.delete(controller);
          }
        }, 15_000);
        heartbeats.set(controller, timer);

        // A closed tab, a reload or a dropped link never cancels the stream
        // from this side. Without the request's own abort, every reconnect
        // left its heartbeat running forever — eight closed streams stayed
        // eight live ones.
        const drop = () => {
          clearInterval(timer);
          heartbeats.delete(controller);
          clients.delete(controller);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        req.signal.addEventListener("abort", drop, { once: true });
        detach = () => req.signal.removeEventListener("abort", drop);
      },
      cancel(controller) {
        clients.delete(controller);
        const timer = heartbeats.get(controller);
        if (timer) clearInterval(timer);
        heartbeats.delete(controller);
        detach?.();
        detach = null;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  if (req.method === "POST" && pathname === "/api/scan") {
    const payload = await body<{ dir?: unknown }>(req);
    const dir = asText(payload?.dir);
    if (!dir) return bad("A folder path is required");
    if (!existsSync(dir)) return bad(`Folder not found: ${dir}`, 404);
    const found = await scanDir(dir);
    const known = new Set(games.map((g) => g.titleId));
    return json({ dir, found: found.map((f) => ({ ...f, inLibrary: known.has(f.titleId) })) });
  }

  if (req.method === "POST" && pathname === "/api/import") {
    const payload = await body<{ items?: unknown }>(req);
    // `items: 5` used to reach the for…of and throw a 500.
    const items = Array.isArray(payload?.items) ? payload.items : null;
    if (!items) return bad("A list of titles is required.");
    let added = 0;
    for (const entry of items) {
      const item = asObject(entry);
      if (!item) continue;
      const titleId = asText(item.titleId);
      const sourcePath = asText(item.path);
      if (!titleId || !sourcePath || !safeId(titleId)) continue;
      if (findGame(titleId)) continue;
      games.push({
        titleId,
        title: String(item.title ?? titleId),
        sourcePath,
        sourceKind: String(item.kind ?? "Unknown"),
        sizeBytes: Number(item.size ?? 0),
        state: "dumped",
        pkgPath: null,
        pkgSize: 0,
        engine: null,
        hasIcon: Boolean(item.hasIcon),
        category: item.category ? String(item.category) : null,
        simulated: false,
        consoleLabel: null,
        note: item.retailPkg
          ? "Retail .pkg — the packers here cannot re-sign an encrypted retail package."
          : null,
        updatedAt: new Date().toISOString(),
      });
      added++;
    }
    await persist();
    broadcast({ type: "state", games });
    return json({ added, games });
  }

  if (req.method === "POST" && pathname === "/api/build") {
    const payload = await body<{ titleId?: unknown; pull?: unknown }>(req);
    const titleId = asText(payload?.titleId);
    const needsPull = payload?.pull === true;
    if (!titleId) return bad("A title id is required");
    if (!safeId(titleId)) return bad("That title id cannot be used as a file name", 400);

    let game = findGame(titleId);
    if (game && (game.state === "building" || game.state === "installing" || pendingBuilds.has(game.titleId)))
      return bad("That game is already busy", 409);
    if (game?.sourceKind === "PKG") return bad("Retail .pkg files cannot be repackaged", 422);

    // A pull can be tens of gigabytes. Refuse before it starts if nothing here
    // could turn it into a package the console would accept.
    // Additional content is not an application. An engine that ignores the
    // category would build a package the console installs as the wrong thing,
    // so say so before pulling gigabytes.
    if (game?.category === "ac" && resolveEngineFrom(engineList(), config) !== "command") {
      return bad(
        "That source is additional content (DLC). Set a custom command for the AC packer — " +
          'acpack build --source "{source}" --output "{output}" — because the application packer ' +
          "would package it as the wrong kind of content.",
        422,
      );
    }

    if (needsPull && resolveEngineFrom(engineList(), config) === "mock") {
      return bad(
        "No packer is configured on this Mac, so that dump would be copied here and then thrown away. " +
          "Set the fpkg-cli path, or a custom packer command, in Prospero Vault, then try again.",
        422,
      );
    }

    // The console can hand over a dump it holds when this Mac has no copy. That
    // is the whole point of pull: a dump that lives only on the console would
    // otherwise be a dead end, because nothing there can pack a package.
    const missing = !game || !game.sourcePath || !existsSync(game.sourcePath);
    if (missing) {
      if (!needsPull) {
        return game
          ? bad("The source folder is gone. Rescan and add the title again.", 422)
          : bad("Unknown title", 404);
      }

      // Register the title before the transfer starts. The console polls
      // /api/progress for it, and a 404 there reads as "the Mac forgot this
      // job" — so the entry has to exist for the whole pull, not after it.
      if (!game) {
        game = {
          titleId,
          title: titleId,
          sourcePath: null,
          sourceKind: "Unknown",
          sizeBytes: 0,
          state: "building",
          pkgPath: null,
          pkgSize: 0,
          engine: null,
          hasIcon: false,
          category: null,
          simulated: false,
          consoleLabel: config.consoleHost,
          note: "Pulling from the console…",
          updatedAt: new Date().toISOString(),
        };
        games.push(game);
      } else {
        game.state = "building";
        game.note = "Pulling from the console…";
        touch(game);
      }
      await persist();
      broadcast({ type: "state", games });

      // A pull can run for an hour, and the console holds this request with a
      // 20-second client timeout. Answer now and let its own progress poll
      // follow the job — blocking here reported a failure that was not one.
      const target = game;
      if (!pulling.has(titleId)) {
        pulling.add(titleId);
        void (async () => {
          try {
            const pulled = await pullSource(config.consoleHost, titleId, (pct, line) => {
              buildProgress.set(titleId, { pct, line, state: "building", message: null });
              broadcast({ type: "progress", titleId, pct, line });
            });

            if (!pulled.ok) {
              target.state = "error";
              target.note = pulled.detail;
              touch(target);
              buildProgress.set(titleId, {
                pct: 100,
                line: "pull failed",
                state: "error",
                message: pulled.detail,
              });
              await persist();
              broadcast({ type: "state", games });
              return;
            }

            target.sourcePath = pulled.path;
            target.title = pulled.title || target.title;
            target.sourceKind = pulled.kind === "image" ? "Disc image" : "Game folder";
            target.sizeBytes = pulled.bytes;
            target.hasIcon = pulled.hasIcon;
            target.category = pulled.category;
            target.state = "dumped";
            target.note = `Pulled from the console · ${pulled.files} files`;
            touch(target);
            await persist();
            broadcast({ type: "state", games });
            enqueueBuild(target);
          } catch (error) {
            target.state = "error";
            target.note = error instanceof Error ? error.message : String(error);
            touch(target);
            await persist();
            broadcast({ type: "state", games });
          } finally {
            pulling.delete(titleId);
          }
        })();
      }

      return json(
        { queued: true, titleId, pulling: true, engine: resolveEngineFrom(engineList(), config) },
        202,
      );
    }

    if (!game) return bad("Unknown title", 404);
    enqueueBuild(game);
    return json({ queued: true, titleId, engine: resolveEngineFrom(engineList(), config) });
  }

  if (req.method === "POST" && pathname === "/api/deploy") {
    const payload = await body<{ titleId?: unknown }>(req);
    const wanted = asText(payload?.titleId);
    const game = wanted ? findGame(wanted) : undefined;
    if (!game) return bad("Unknown title", 404);
    if (!game.pkgPath || !existsSync(game.pkgPath)) return bad("Build the package first", 409);
    // Two presses on one tile sent two install requests: the console ran one
    // while the second overwrote the job status, and two followers raced over
    // the same game. The second press is refused until the first is answered.
    if (deploying) {
      return bad(
        deploying === game.titleId
          ? "That package is already on its way to the console."
          : `The console is still receiving ${deploying}. Wait for that to finish, then send this one.`,
        409,
      );
    }
    deploying = game.titleId;

    try {
      game.state = "installing";
      game.note = "Asking the console to fetch the package…";
      touch(game);
      await persist();
      broadcast({ type: "state", games });

      const result = await installToConsole(config.consoleHost, {
        titleId: game.titleId,
        mac: `${lanAddress()}:${config.port}`,
      });

      game.state = result.ok ? (result.pulling ? "installing" : "installed") : "error";
      game.consoleLabel = result.label;
      game.note = result.detail;
      touch(game);
      await persist();
      broadcast({ type: "state", games });

      // Keep following the pull so the library does not claim the package
      // arrived the moment the console merely accepted the job.
      if (result.ok && result.pulling) void trackConsolePull(game);

      return json({
        ok: result.ok,
        detail: result.detail,
        simulated: result.simulated,
        pulling: result.pulling,
      });
    } finally {
      deploying = null;
    }
  }

  if (req.method === "POST" && pathname === "/api/settings") {
    const payload = asObject(await body<unknown>(req));
    if (!payload) return bad("Invalid settings payload");
    // Only fields of the right type are adopted: a number where a path belongs
    // used to be written into config.json and break the next start.
    const next: Config = { ...config };
    // A setting that will break the next request is worse than a refusal: it
    // is stored, looks saved, and fails later with an unrelated symptom.
    if (payload.port !== undefined) {
      if (typeof payload.port !== "number" || !Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) {
        return bad("The port must be a whole number from 1 to 65535.");
      }
      next.port = payload.port;
    }
    if (payload.consoleHost !== undefined) {
      const host = normaliseHost(payload.consoleHost);
      if (!host.ok) return bad(host.reason);
      next.consoleHost = host.value;
    }
    if (payload.engine !== undefined) {
      if (typeof payload.engine !== "string" || !ENGINE_IDS.includes(payload.engine as (typeof ENGINE_IDS)[number])) {
        return bad("That is not one of the packaging engines this app has.");
      }
      next.engine = payload.engine as Config["engine"];
    }
    const paths = asObject(payload.enginePaths);
    if (paths) {
      const merged = { ...config.enginePaths };
      for (const [key, value] of Object.entries(paths)) {
        if (typeof value === "string") (merged as Record<string, string>)[key] = value;
      }
      next.enginePaths = merged;
    }
    if (Array.isArray(payload.scanDirs)) {
      next.scanDirs = payload.scanDirs.filter((entry): entry is string => typeof entry === "string");
    }
    config = next;
    try {
      await saveConfig(config);
    } catch (error) {
      // A read-only data folder must not answer with an unnamed 500. The value
      // is still adopted for this run, and the answer says it did not persist.
      console.error("[settings]", error);
      broadcast({ type: "state", games });
      return bad("Those settings are in use, but could not be written to the data folder. They will be lost on restart.", 507);
    }
    consoleCache = null;
    engineCache = null;
    broadcast({ type: "state", games });
    return json({ ok: true, config });
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/game/")) {
    const titleId = routeId(pathname, "/api/game/");
    const game = titleId ? findGame(titleId) : undefined;
    if (!game) return bad("Unknown title", 404);
    // Removing a title mid-job leaves the worker writing into a folder nothing
    // points at, and the pkg it produces would never be listed again.
    if (game.state === "building" || game.state === "installing" || pendingBuilds.has(titleId) || pulling.has(titleId)) {
      return bad("That title is busy. Wait for the job to finish, then remove it.", 409);
    }

    // The artifact goes too: its name is the title id, so leaving it behind
    // fills the packages folder with files nothing can reach.
    if (game.pkgPath && isInside(game.pkgPath, PKG_DIR)) {
      await rm(game.pkgPath, { force: true }).catch(() => undefined);
    }

    // A source this app copied off the console lives in data/pulled/<id>, and
    // the removed title is the only way back to it. Without this, every
    // convert-and-remove left a whole dump — tens of gigabytes — behind.
    let removedSource = false;
    if (game.sourcePath && isInside(game.sourcePath, PULL_ROOT)) {
      await rm(join(PULL_ROOT, titleId), { recursive: true, force: true }).catch(() => undefined);
      removedSource = true;
    }

    buildProgress.delete(titleId);
    games = games.filter((g) => g.titleId !== titleId);
    await persist();
    broadcast({ type: "state", games });
    return json({ removed: titleId, removedSource });
  }

  // Polled by the console payload to draw a progress bar while it waits.
  if (req.method === "GET" && pathname.startsWith("/api/progress/")) {
    const titleId = routeId(pathname, "/api/progress/");
    const game = titleId ? findGame(titleId) : undefined;
    if (!game) return bad("Unknown title", 404);
    const latest = buildProgress.get(titleId) ?? {
      pct: 0,
      line: "not started",
      state: game.state,
      message: null as string | null,
    };
    return json({
      titleId,
      state: latest.state || game.state,
      pct: latest.pct,
      line: latest.line,
      message: latest.message ?? null,
      ready: Boolean(game.pkgPath),
    });
  }

  // Used by the console payload while it waits on a build.
  if (req.method === "GET" && pathname.startsWith("/api/ready/")) {
    const titleId = routeId(pathname, "/api/ready/");
    const game = titleId ? findGame(titleId) : undefined;
    if (!game?.pkgPath || !existsSync(game.pkgPath)) return bad("That package is not ready yet. Nothing to send until it is built.", 404);
    // simulated travels with readiness so the console can refuse a placeholder
    // instead of pulling it and calling the job a success.
    return json({ ready: true, size: game.pkgSize, simulated: Boolean(game.simulated) });
  }

  if (req.method === "GET" && pathname.startsWith("/api/pkg/")) {
    const titleId = routeId(pathname, "/api/pkg/");
    const game = titleId ? findGame(titleId) : undefined;
    // Binary answer, but the refusals are still the app's one JSON shape: a
    // console that logs the body should read a sentence, not "No package".
    if (!game?.pkgPath) return bad("That package does not exist any more. Build it again from its card.", 404);
    if (!isInside(game.pkgPath, PKG_DIR)) return bad("That package is outside this app's package folder.", 403);
    const file = Bun.file(game.pkgPath);
    if (!(await file.exists())) return bad("The package file is missing from disk. Build it again from its card.", 404);

    const size = file.size;
    const disposition = `attachment; filename="${game.titleId}.pkg"`;
    const range = req.headers.get("range");

    // A dropped Wi-Fi link must not cost the whole package: the console resumes
    // by asking for just the bytes it does not have yet.
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
      const start = match ? Number(match[1]) : Number.NaN;
      if (!match || !Number.isFinite(start) || start >= size) {
        return new Response(
          JSON.stringify({
            error: "That byte range is outside the package.",
            message: "That byte range is outside the package. Ask for the whole file.",
          }),
          {
            status: 416,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-range": `bytes */${size}`,
              "accept-ranges": "bytes",
            },
          },
        );
      }
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          "content-disposition": disposition,
        },
      });
    }

    return new Response(file, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "accept-ranges": "bytes",
        "content-disposition": disposition,
      },
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/icon/")) {
    const titleId = routeId(pathname, "/api/icon/");
    const game = titleId ? findGame(titleId) : undefined;
    if (!game?.sourcePath) return bad("That title has no icon.", 404);
    const icon = join(game.sourcePath, "sce_sys", "icon0.png");
    if (!isInside(icon, game.sourcePath)) return bad("That icon is outside the title's folder.", 403);
    const file = Bun.file(icon);
    if (!(await file.exists())) return bad("That title has no icon.", 404);
    return new Response(file, { headers: { "cache-control": "max-age=3600" } });
  }

  // Everything under /api is answered in JSON. Falling through to the static
  // files gave an unknown endpoint an HTML 404, which the interfaces cannot
  // render, and a wrong method looked like a missing page.
  if (pathname.startsWith("/api/")) {
    const allowed = allowedMethods(pathname);
    if (allowed && !allowed.includes(req.method)) {
      // A known endpoint, wrong verb: 405 with the verb that would work, so a
      // client is told what to do instead of being told the route is gone.
      const message = `${req.method} is not how ${pathname} is asked; use ${allowed.join(" or ")}.`;
      return new Response(JSON.stringify({ error: message, message }), {
        status: 405,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          allow: allowed.join(", "),
        },
      });
    }
    return bad(`No endpoint at ${pathname}`, 404);
  }

  return serveStatic(pathname);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/** Set when the data folder itself cannot be written. */
let dataProblem: string | null = null;
try {
  await ensureDirs();
} catch (error) {
  // A read-only or unwritable data folder used to end the process before it
  // could answer anything. It runs, serves the interface, and says why.
  dataProblem = `The data folder could not be written (${error instanceof Error ? error.message : String(error)}). The app is running, but nothing can be saved.`;
  console.error(`[data] ${dataProblem}`);
}
const cleaned = await sweepWorkbench(PKG_DIR).catch(() => 0);
config = await loadConfig();
games = await loadLibrary();

// A crash, a closed lid or a killed process leaves a title marked mid-build or
// mid-install with nothing running behind it. Repair that at boot, so the grid
// never shows a spinner that cannot move again.
const interrupted = games.filter((game) => game.state === "building" || game.state === "installing");
if (interrupted.length) {
  for (const game of interrupted) {
    // A rebuild clears pkgPath before the packer starts, so a crash mid-rebuild
    // came back with no package while the previous one was still on disk. Find
    // it again rather than orphaning a file the user already built.
    if (!game.pkgPath) {
      const canonical = join(PKG_DIR, `${game.titleId}.pkg`);
      if (existsSync(canonical)) {
        game.pkgPath = canonical;
        game.pkgSize = (await stat(canonical)).size;
      }
    }
    game.state = game.pkgPath && existsSync(game.pkgPath) ? "built" : "dumped";
    game.note = "Interrupted before it finished — try again.";
    touch(game);
  }
  await persist();
  console.log(
    `  repaired      ${interrupted.length} interrupted job${interrupted.length === 1 ? "" : "s"}`,
  );
}

// First run: offer the usual dump hiding places in Forge.
if (!config.scanDirs.length) {
  const home = process.env.HOME ?? "";
  if (home) {
    config.scanDirs = [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")].filter(
      (dir) => existsSync(dir),
    );
    await saveConfig(config).catch((error) => {
      dataProblem ??= `The data folder could not be written (${error instanceof Error ? error.message : String(error)}). The app is running, but nothing can be saved.`;
    });
  }
}

const port = Number(process.env.PV_PORT ?? process.env.TITAN_PORT ?? config.port) || config.port;

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      return await handle(req, url);
    } catch (error) {
      if (error instanceof BodyTimeout) {
        return bad("The body of that request stopped arriving, so it was dropped. Send it again.", 408);
      }
      if (error instanceof BodyTooLarge) {
        return bad("That request is larger than this app accepts.", 413);
      }
      console.error("[request]", url.pathname, error);
      return json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  },
});

const lan = `http://${lanAddress()}:${server.port}`;
console.log(`
  PROSPERO VAULT ${VERSION}
  ─────────────────────────────────────────
  this Mac      http://localhost:${server.port}
  on the PS5    ${lan}
  packages      ${PKG_DIR}
  library       ${games.length} title${games.length === 1 ? "" : "s"}
`);

if (cleaned) {
  console.log(`  cleaned       ${cleaned} leftover build file${cleaned === 1 ? "" : "s"}`);
}
