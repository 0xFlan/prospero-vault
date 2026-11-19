/**
 * End-to-end self-check. Starts the app on a spare port, builds a fake dump
 * with a real param.sfo, then walks the whole flow the UI walks:
 *
 *   scan -> import -> build (simulated engine) -> serve the package -> deploy
 *
 * Run: bun run test
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const TITLE_ID = "PSTA00001";
const TITLE = "Prospero Vault Selftest";
/** A second title the simulated engine holds mid-build, so races are guard tests. */
const HOLD_ID = "PSTA00009";
// Everything this suite writes lives under one throwaway root. The real
// library used to be the suite's library: a run killed mid-flight left its
// titles in the person's own list, and the next boot showed them as games.
const SELFTEST_ROOT = join(tmpdir(), "pv_selftest");
const DATA_ROOT = join(SELFTEST_ROOT, "data");
const FIXTURE_DIR = join(SELFTEST_ROOT, "fixtures");
const HOLD_FIXTURE = join(FIXTURE_DIR, HOLD_ID);
const FIXTURE = join(FIXTURE_DIR, TITLE_ID);

/** The folder the real app keeps for the person using it. */
const REAL_DATA = join(process.cwd(), "data");
const PKG_PATH = join(DATA_ROOT, "pkg");
const TMP_PATH = join(DATA_ROOT, "tmp");

/** Refuses to start a server whose data folder is the real one. */
function assertThrowaway(dir: string, who: string): void {
  const real = resolve(REAL_DATA);
  const target = resolve(dir);
  if (target === real || target.startsWith(real + sep)) {
    throw new Error(`${who} would write into the real data folder (${real}); it must use a throwaway one`);
  }
}

let passed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
    throw new Error(name);
  }
  passed++;
  console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`);
}

/** Minimal but real param.sfo writer, so the app's parser is genuinely tested. */
function buildSfo(entries: Record<string, string>): Uint8Array {
  const keys = Object.keys(entries).sort();
  const encoder = new TextEncoder();
  const keyBlobs = keys.map((key) => encoder.encode(`${key}\0`));
  const valueBlobs = keys.map((key) => encoder.encode(`${entries[key]}\0`));
  const pad4 = (n: number) => (n + 3) & ~3;
  const padded = valueBlobs.map((blob) => pad4(blob.length));

  const headerSize = 20;
  const entrySize = 16;
  const keyTableStart = headerSize + entrySize * keys.length;
  const keyTableSize = keyBlobs.reduce((sum, blob) => sum + blob.length, 0);
  const dataTableStart = keyTableStart + keyTableSize;
  const dataTableSize = padded.reduce((sum, size) => sum + size, 0);

  const out = new Uint8Array(dataTableStart + dataTableSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46535000, true);
  view.setUint32(4, 0x00000101, true);
  view.setUint32(8, keyTableStart, true);
  view.setUint32(12, dataTableStart, true);
  view.setUint32(16, keys.length, true);

  let keyOffset = 0;
  let dataOffset = 0;
  keys.forEach((_, index) => {
    const entry = headerSize + index * 16;
    view.setUint16(entry, keyOffset, true);
    view.setUint16(entry + 2, 0x0204, true);
    view.setUint32(entry + 4, valueBlobs[index].length, true);
    view.setUint32(entry + 8, padded[index], true);
    view.setUint32(entry + 12, dataOffset, true);
    out.set(keyBlobs[index], keyTableStart + keyOffset);
    out.set(valueBlobs[index], dataTableStart + dataOffset);
    keyOffset += keyBlobs[index].length;
    dataOffset += padded[index];
  });
  return out;
}

type State = {
  games: Array<{
    titleId: string;
    title: string;
    state: string;
    pkgPath: string | null;
    pkgSize: number;
    simulated: boolean;
  }>;
  engine: string;
  console: { mode: string };
};

const getState = async (): Promise<State> => (await fetch(`${BASE}/api/state`)).json() as Promise<State>;

async function post(path: string, payload: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function waitReady(timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready");
}

const CONFIG_PATH = join(SELFTEST_ROOT, "config.json");
const LIBRARY_PATH = join(DATA_ROOT, "library.json");

let server: ReturnType<typeof Bun.spawn>;

function startServer(): ReturnType<typeof Bun.spawn> {
  assertThrowaway(DATA_ROOT, "the self-check server");
  return Bun.spawn({
    cmd: ["bun", "run", "app/server.ts"],
    env: {
      ...process.env,
      PV_PORT: String(PORT),
      PV_CONFIG: CONFIG_PATH,
      PV_DATA: DATA_ROOT,
      // Only this title is held; every other build is as fast as before.
      PV_MOCK_HOLD_ID: HOLD_ID,
      PV_MOCK_HOLD_MS: "2500",
      // Short enough for the stalled-body check to be quick, long enough that
      // no legitimate request in this suite can reach it.
      PV_BODY_DEADLINE_MS: "1000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Boot is where an interrupted job is repaired, so the suite has to be able to run it. */
async function restartServer(): Promise<void> {
  server.kill();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(400) });
    } catch {
      break; // the port is free again
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  server = startServer();
  await waitReady();
}

async function waitForBuild(timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    const game = state.games.find((g) => g.titleId === TITLE_ID);
    if (game?.state === "built") return;
    if (game?.state === "error") throw new Error("build reported error");
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("build timed out");
}

async function main(): Promise<void> {
  console.log("\nProspero Vault self-check\n");

  // Re-runnable: the app keeps one library for the real data folder, so an
  // aborted run used to leave this title behind and the next run then imported
  // nothing — a single failure poisoned every run after it.
  await rm(SELFTEST_ROOT, { recursive: true, force: true });
  await mkdir(DATA_ROOT, { recursive: true });

  let refusedReal = false;
  try {
    assertThrowaway(REAL_DATA, "a suite with no data folder of its own");
  } catch {
    refusedReal = true;
  }
  check("a test server pointed at the real data folder is refused", refusedReal);
  check(
    "the self-check runs on a throwaway data folder",
    resolve(DATA_ROOT) !== resolve(REAL_DATA) && !resolve(DATA_ROOT).startsWith(resolve(REAL_DATA) + sep),
    DATA_ROOT,
  );

  // A dump with a genuine SFO, so discovery is exercised for real.
  await mkdir(join(FIXTURE, "sce_sys"), { recursive: true });
  await writeFile(
    join(FIXTURE, "sce_sys", "param.sfo"),
    buildSfo({
      TITLE_ID,
      TITLE,
      CATEGORY: "gd",
      APP_VER: "01.00",
      VERSION: "01.00",
      CONTENT_ID: `UP9000-${TITLE_ID}_00-SELFTEST00000001`,
    }),
  );
  await writeFile(join(FIXTURE, "eboot.bin"), "not a real eboot");

  // Its own config, so a real console address in data/config.json cannot make
  // the deploy step depend on hardware being plugged in.
  await writeFile(
    CONFIG_PATH,
    JSON.stringify({ port: PORT, consoleHost: null, engine: "auto", enginePaths: {}, scanDirs: [] }),
  );

  server = startServer();

  try {
    await waitReady();
    check("server answers /api/state", true, `port ${PORT}`);

    const initial = await getState();
    check("library loads", Array.isArray(initial.games));
    check(
      "engine resolves without any packer installed",
      initial.engine === "mock",
      `engine=${initial.engine}`,
    );

    // ---------------- the HTTP contract ----------------

    const unknown = await fetch(`${BASE}/api/does-not-exist`);
    const unknownBody = await unknown.text();
    check(
      "an unknown endpoint answers in JSON",
      unknown.status === 404 && /"error"/.test(unknownBody),
      `${unknown.status} ${unknownBody.slice(0, 40)}`,
    );

    // A wrong verb on a real endpoint used to look like a missing page. This
    // pass it answers 405 and names the verb that works, so a client is told
    // what to do. Behaviour changed on purpose; the check is stricter, not weaker.
    const wrongMethod = await fetch(`${BASE}/api/state`, { method: "POST" });
    const wrongBody = await wrongMethod.text();
    check(
      "a wrong method answers 405 with the verb that works",
      wrongMethod.status === 405 &&
        wrongMethod.headers.get("allow") === "GET" &&
        /use GET/.test(wrongBody) &&
        /"error"/.test(wrongBody),
      `${wrongMethod.status} allow=${wrongMethod.headers.get("allow")} ${wrongBody.slice(0, 60)}`,
    );
    const wrongWrite = await fetch(`${BASE}/api/build`);
    check(
      "a GET on a write endpoint is a 405 too",
      wrongWrite.status === 405 && wrongWrite.headers.get("allow") === "POST",
      `${wrongWrite.status} allow=${wrongWrite.headers.get("allow")}`,
    );

    const malformed = await fetch(`${BASE}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const malformedBody = await malformed.text();
    check(
      "a malformed body is refused with a reason",
      malformed.status === 400 && /"message"/.test(malformedBody),
      `${malformed.status} ${malformedBody.slice(0, 40)}`,
    );

    const oversized = await fetch(`${BASE}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [], pad: "x".repeat(1_200_000) }),
    });
    check("an oversized body is refused before it is read", oversized.status === 413, String(oversized.status));

    const sendRaw = (path: string, payload: string, headers: Record<string, string> = {}) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: payload,
      });

    const empty = await sendRaw("/api/build", "");
    const emptyBody = await empty.text();
    check(
      "an empty body is a JSON 400",
      empty.status === 400 && /"error"/.test(emptyBody) && /"message"/.test(emptyBody),
      `${empty.status} ${emptyBody.slice(0, 40)}`,
    );

    // A JSON body labelled as text is still JSON: being strict about the header
    // would break the console UI, which reads the payload's own answers.
    const textBody = await sendRaw("/api/settings", JSON.stringify({ scanDirs: [] }), {
      "content-type": "text/plain",
    });
    check("a body sent as text is still read", textBody.status === 200, String(textBody.status));

    const formBody = await sendRaw("/api/build", "titleId=PSTA00001", {
      "content-type": "application/x-www-form-urlencoded",
    });
    const formText = await formBody.text();
    check(
      "a form-encoded body is a JSON 400",
      formBody.status === 400 && /"error"/.test(formText),
      `${formBody.status} ${formText.slice(0, 40)}`,
    );

    // A field of the wrong type used to reach the code and become a 500.
    const badItems = await sendRaw("/api/import", JSON.stringify({ items: 5 }));
    check("a wrongly typed list is a 400, not a 500", badItems.status === 400, String(badItems.status));
    const badDir = await sendRaw("/api/scan", JSON.stringify({ dir: 5 }));
    check("a wrongly typed path is a 400, not a 500", badDir.status === 400, String(badDir.status));

    const badSettings = await sendRaw(
      "/api/settings",
      JSON.stringify({ port: "nope", engine: 5, scanDirs: "x", consoleHost: 42 }),
    );
    const afterSettings = (await (await fetch(`${BASE}/api/state`)).json()) as {
      config: { port: number; engine: string; consoleHost: string | null };
    };
    // Behaviour changed on purpose this pass: a payload with a wrongly typed
    // field is now refused whole (400) instead of having its bad half quietly
    // dropped, because a half-applied save is a settings set nobody sent.
    check(
      "badly typed settings are refused and nothing is written",
      badSettings.status === 400 && afterSettings.config.port === PORT && afterSettings.config.consoleHost === null,
      `${badSettings.status} ${afterSettings.config.port} ${afterSettings.config.engine} ${afterSettings.config.consoleHost}`,
    );

    // A declared length shorter than the body: the server reads what it was told,
    // so the JSON is cut. That must be a 400, not a hang and not a 500.
    const lying = await Promise.race([
      new Promise<string>((resolve) => {
        let buffer = "";
        Bun.connect({
          hostname: "127.0.0.1",
          port: PORT,
          socket: {
            open(socket) {
              const payload = JSON.stringify({ titleId: TITLE_ID, pad: "x".repeat(200) });
              socket.write(
                `POST /api/build HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n${payload}`,
              );
            },
            data(_socket, chunk) {
              buffer += new TextDecoder().decode(chunk);
            },
            close() {
              resolve(buffer);
            },
            error() {
              resolve(buffer);
            },
          },
        });
      }),
      Bun.sleep(4000).then(() => "timed out"),
    ]);
    check(
      "a body that lies about its length is refused, not left hanging",
      /^HTTP\/1\.1 400/.test(lying) && /"error"/.test(lying),
      lying.slice(0, 50).replace(/\s+/g, " "),
    );

    // The other direction: the client declares more than it ever sends. The
    // connection must be answered and closed, not held open indefinitely.
    const stalled = await Promise.race([
      new Promise<string>((resolve) => {
        let buffer = "";
        let live: { end: () => void } | null = null;
        Bun.connect({
          hostname: "127.0.0.1",
          port: PORT,
          socket: {
            open(socket) {
              live = socket;
              socket.write(
                `POST /api/build HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"titleId":`,
              );
            },
            data(_socket, chunk) {
              buffer += new TextDecoder().decode(chunk);
            },
            close() {
              resolve(buffer);
            },
            error() {
              resolve(buffer);
            },
          },
        });
        setTimeout(() => {
          try {
            live?.end();
          } catch {
            /* already gone */
          }
          resolve(buffer);
        }, 6000);
      }),
      Bun.sleep(9000).then(() => "timed out"),
    ]);
    check(
      "a body that never finishes is answered with 408, not held open",
      /^HTTP\/1\.1 408/.test(stalled) && /"error"/.test(stalled),
      stalled.slice(0, 60).replace(/\s+/g, " "),
    );

    // ---------------- two subscribers at once ----------------

    const first = new AbortController();
    const streamA = await fetch(`${BASE}/api/events`, { signal: first.signal });
    const streamB = await fetch(`${BASE}/api/events`);
    const readerA = streamA.body!.getReader();
    const readerB = streamB.body!.getReader();
    const decoder = new TextDecoder();
    const readWithin = async (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<string> => {
      const chunk = await Promise.race([
        reader.read().then((result) => (result.done ? "" : decoder.decode(result.value))),
        Bun.sleep(ms).then(() => ""),
      ]);
      return String(chunk);
    };
    const helloA = await readWithin(readerA, 2500);
    const helloB = await readWithin(readerB, 2500);
    check(
      "two subscribers stream at the same time",
      helloA.includes("hello") && helloB.includes("hello"),
      `${helloA.trim()} | ${helloB.trim()}`,
    );

    // One tab closes mid-stream. The other must keep working and the server must
    // not fall over writing to the one that left.
    first.abort();
    await Bun.sleep(150);
    const churn = await post("/api/import", {
      items: [{ titleId: "PSSE00001", title: "Stream Test", path: "/tmp", kind: "Game folder", size: 1 }],
    });
    check("the app keeps serving after a subscriber leaves", churn.status === 200, String(churn.status));
    const frame = await readWithin(readerB, 3000);
    check("the surviving subscriber still receives events", frame.includes("state"), frame.trim().slice(0, 60));
    await fetch(`${BASE}/api/game/PSSE00001`, { method: "DELETE" });
    readerB.cancel().catch(() => undefined);

    const scan = await post("/api/scan", { dir: FIXTURE_DIR });
    check("scan finds the dump", scan.data.found?.length === 1, `${scan.data.found?.length} found`);
    const found = scan.data.found[0];
    check("param.sfo parsed for TITLE_ID", found.titleId === TITLE_ID, found.titleId);
    check("param.sfo parsed for TITLE", found.title === TITLE, found.title);
    check("source kind recognised", found.kind === "Game folder", found.kind);

    const imported = await post("/api/import", { items: [found] });
    check("import into library", imported.data.added === 1);

    const build = await post("/api/build", { titleId: TITLE_ID });
    check("build accepted", build.status === 200, `engine=${build.data.engine}`);
    await waitForBuild();

    const built = (await getState()).games.find((g) => g.titleId === TITLE_ID);
    check("game reaches built state", built?.state === "built", built?.state);
    check("package exists on disk", Boolean(built?.pkgPath && (await stat(built.pkgPath)).size > 0));
    check("build marked simulated", built?.simulated === true);

    const pkgFiles = await readdir(PKG_PATH).catch(() => [] as string[]);
    const strays = pkgFiles.filter((name) => !name.toLowerCase().endsWith(".pkg"));
    check("packages folder holds no temporary files", strays.length === 0, strays.join(", ") || "clean");
    check("exactly one package for the title", pkgFiles.filter((n) => n === `${TITLE_ID}.pkg`).length === 1);
    const staging = await readdir(TMP_PATH).catch(() => [] as string[]);
    check("no staging folder left behind", staging.length === 0, staging.join(", ") || "clean");

    // A crash mid-rebuild leaves the library saying "building" with no package,
    // while the previous package sits on disk. Boot has to find it again instead
    // of orphaning a file the user already built.
    const saved = JSON.parse(await readFile(LIBRARY_PATH, "utf8")) as Array<Record<string, unknown>>;
    await writeFile(
      LIBRARY_PATH,
      JSON.stringify(
        saved
          .map((entry) =>
            entry.titleId === TITLE_ID ? { ...entry, state: "building", pkgPath: null, pkgSize: 0 } : entry,
          )
          .concat([
            // A copy that was in flight when the app went down: no package, no
            // job. It must not sit on screen claiming to be copying forever.
            {
              titleId: "PSTA00099",
              title: "Interrupted copy",
              sourcePath: FIXTURE,
              sourceKind: "Game folder",
              sizeBytes: 0,
              state: "building",
              pkgPath: null,
              pkgSize: 0,
              engine: null,
              hasIcon: false,
              category: null,
              simulated: false,
              consoleLabel: null,
              note: "Pulling from the console…",
              updatedAt: new Date().toISOString(),
            },
          ]),
        null,
        2,
      ),
    );
    await restartServer();
    const repaired = (await getState()).games.find((g) => g.titleId === TITLE_ID);
    check(
      "an interrupted rebuild gets its package back after a restart",
      repaired?.state === "built" && Boolean(repaired?.pkgPath),
      `${repaired?.state} ${repaired?.pkgPath ?? "no package"}`,
    );

    const interruptedCopy = (await getState()).games.find((game) => game.titleId === "PSTA00099");
    // Back to "dumped" is the designed repair (no package, but the dump is
    // still on the console). What must never survive is the in-progress claim.
    check(
      "an interrupted copy is not left claiming progress",
      interruptedCopy?.state !== "building" && /Interrupted/.test(interruptedCopy?.note ?? ""),
      `${interruptedCopy?.state} — ${interruptedCopy?.note ?? "no note"}`,
    );
    await fetch(`${BASE}/api/game/PSTA00099`, { method: "DELETE" });

    const served = await fetch(`${BASE}/api/pkg/${TITLE_ID}`);
    const whole = new Uint8Array(await served.arrayBuffer());
    check(
      "package is downloadable",
      served.ok && Number(served.headers.get("content-length")) === whole.byteLength && whole.byteLength > 0,
      `${whole.byteLength} bytes`,
    );

    // Resume: after a dropped link the console asks for the bytes it lacks.
    const resumed = await fetch(`${BASE}/api/pkg/${TITLE_ID}`, { headers: { range: "bytes=1000-2499" } });
    const tail = new Uint8Array(await resumed.arrayBuffer());
    check(
      "package resumes with a Range request",
      resumed.status === 206 && tail.byteLength === 1500,
      `${resumed.status}, ${tail.byteLength} bytes`,
    );
    check(
      "range response names the full size",
      (resumed.headers.get("content-range") ?? "").endsWith(`/${whole.byteLength}`),
      resumed.headers.get("content-range") ?? "missing",
    );
    check(
      "resumed bytes line up with the whole file",
      tail[0] === whole[1000] && tail[tail.byteLength - 1] === whole[2499],
    );

    // ---------------- delete racing a build ----------------
    // The simulated engine is held on this title, so the window is a fact of the
    // run instead of a guess about timing.
    await mkdir(join(HOLD_FIXTURE, "sce_sys"), { recursive: true });
    await writeFile(
      join(HOLD_FIXTURE, "sce_sys", "param.json"),
      JSON.stringify({ titleId: HOLD_ID, titleName: "Held Build" }),
    );
    await writeFile(join(HOLD_FIXTURE, "eboot.bin"), "x");
    const heldScan = await post("/api/scan", { dir: FIXTURE_DIR });
    const heldItem = (heldScan.data.found ?? []).find((entry: any) => entry.titleId === HOLD_ID);
    check("the held fixture is found", Boolean(heldItem), String(heldScan.data.found?.length));
    await post("/api/import", { items: [heldItem] });

    const heldBuild = post("/api/build", { titleId: HOLD_ID });
    let heldBuilding = false;
    for (let i = 0; i < 200 && !heldBuilding; i++) {
      heldBuilding = (await getState()).games.some((g) => g.titleId === HOLD_ID && g.state === "building");
      if (!heldBuilding) await Bun.sleep(20);
    }
    check("the held build is running", heldBuilding);

    const raced = await fetch(`${BASE}/api/game/${HOLD_ID}`, { method: "DELETE" });
    check("removing a title mid-build is refused", raced.status === 409, String(raced.status));

    await heldBuild;
    let heldBuilt: { state: string } | null = null;
    for (let i = 0; i < 200 && heldBuilt?.state !== "built"; i++) {
      heldBuilt = (await getState()).games.find((g) => g.titleId === HOLD_ID) ?? null;
      if (heldBuilt?.state !== "built") await Bun.sleep(50);
    }
    check("the held build still finishes", heldBuilt?.state === "built", heldBuilt?.state);

    // ---------------- one console, one package at a time ----------------
    const sending = post("/api/deploy", { titleId: TITLE_ID });
    let sendingNow = false;
    for (let i = 0; i < 200 && !sendingNow; i++) {
      sendingNow = (await getState()).games.some((g) => g.titleId === TITLE_ID && g.state === "installing");
      if (!sendingNow) await Bun.sleep(20);
    }
    const buildDuringSend = await post("/api/build", { titleId: TITLE_ID });
    check(
      "a build is refused while a package is being sent",
      sendingNow && buildDuringSend.status === 409,
      `${sendingNow} ${buildDuringSend.status}`,
    );
    await sending;

    const [sendA, sendB] = await Promise.all([
      post("/api/deploy", { titleId: TITLE_ID }),
      post("/api/deploy", { titleId: HOLD_ID }),
    ]);
    const pair = [sendA.status, sendB.status].sort((a, b) => a - b);
    check(
      "only one package goes to the console at a time",
      pair[0] === 200 && pair[1] === 409,
      pair.join(" and "),
    );

    const heldRemove = await fetch(`${BASE}/api/game/${HOLD_ID}`, { method: "DELETE" });
    check("the held title can be removed once it is idle", heldRemove.ok, String(heldRemove.status));

    // Two presses on one tile must not send the package twice, and the second
    // follower must not start a second loop over the same job.
    const [pressA, pressB] = await Promise.all([
      post("/api/deploy", { titleId: TITLE_ID }),
      post("/api/deploy", { titleId: TITLE_ID }),
    ]);
    const codes = [pressA.status, pressB.status].sort((a, b) => a - b);
    check(
      "a second deploy while one is running is refused",
      codes[0] === 200 && codes[1] === 409,
      codes.join(" and "),
    );

    const deploy = await post("/api/deploy", { titleId: TITLE_ID });
    check("deploy reports success", deploy.data.ok === true, deploy.data.detail);
    check("deploy marked simulated", deploy.data.simulated === true);

    const installed = (await getState()).games.find((g) => g.titleId === TITLE_ID);
    check("game reaches installed state", installed?.state === "installed", installed?.state);

    // Two saves at the same moment used to share one temp file: the second
    // rename failed with ENOENT, answering 500 and losing that save.
    const parallelIds = ["PSTA00011", "PSTA00012", "PSTA00013", "PSTA00014", "PSTA00015", "PSTA00016"];
    const parallel = await Promise.all(
      parallelIds.map((id) =>
        fetch(`${BASE}/api/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ titleId: id, title: id, path: FIXTURE, kind: "Game folder", size: 0 }] }),
        }).then((res) => res.status),
      ),
    );
    check("saves from parallel requests never collide", parallel.every((status) => status === 200), parallel.join(","));
    const parallelListed = (await getState()).games.filter((game) => parallelIds.includes(game.titleId)).length;
    check("every parallel save survives", parallelListed === parallelIds.length, `${parallelListed} of ${parallelIds.length}`);
    await Promise.all(parallelIds.map((id) => fetch(`${BASE}/api/game/${id}`, { method: "DELETE" })));

    /* ---------------- hostile and malformed requests ---------------- */
    // Every one of these has to come back as a named 4xx in the app's JSON
    // error shape, and the process has to keep serving afterwards.
    const probeJson = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${BASE}${path}`, init);
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: res.status, text, parsed };
    };
    const jsonPost = (path: string, body: string) =>
      probeJson(path, { method: "POST", headers: { "content-type": "application/json" }, body });

    const refused = [
      { name: "malformed json", run: () => jsonPost("/api/build", "{oops") },
      { name: "truncated json", run: () => jsonPost("/api/import", '{"items":[') },
      { name: "a JSON null body", run: () => jsonPost("/api/build", "null") },
      { name: "a JSON array where an object belongs", run: () => jsonPost("/api/settings", "[]") },
      { name: "a JSON string where an object belongs", run: () => jsonPost("/api/scan", '"scan"') },
      { name: "an unknown route", run: () => probeJson("/api/does-not-exist") },
      { name: "a wrong method on state", run: () => probeJson("/api/state", { method: "DELETE" }) },
      { name: "a traversal in a game id", run: () => probeJson("/api/game/..%2F..%2Fetc%2Fpasswd", { method: "DELETE" }) },
      { name: "a traversal in a package id", run: () => probeJson("/api/pkg/..%2Fetc%2Fpasswd") },
      { name: "a traversal in an icon id", run: () => probeJson("/api/icon/..%2F..%2Fetc%2Fpasswd") },
      { name: "a traversal in a progress id", run: () => probeJson("/api/progress/..%2Fetc") },
      { name: "a traversal in a ready id", run: () => probeJson("/api/ready/..%2Fetc") },
      { name: "a missing build id", run: () => jsonPost("/api/build", "{}") },
      { name: "a numeric deploy id", run: () => jsonPost("/api/deploy", '{"titleId":17}') },
    ];
    for (const probe of refused) {
      const answer = await probe.run();
      const named =
        answer.status >= 400 &&
        answer.status < 500 &&
        answer.parsed !== null &&
        typeof answer.parsed.error === "string" &&
        !answer.text.includes("<") &&
        !/ at .*\.ts:\d/.test(answer.text);
      check(`${probe.name} is a named 4xx`, named, `${answer.status} ${answer.text.slice(0, 60)}`);
    }

    const accepted = [
      { name: "extra fields are ignored", run: () => jsonPost("/api/scan", JSON.stringify({ dir: FIXTURE, nope: 1, deeper: { a: 1 } })) },
    ];
    for (const probe of accepted) {
      const answer = await probe.run();
      check(`${probe.name} without refusing the request`, answer.status === 200, `${answer.status} ${answer.text.slice(0, 60)}`);
    }

    // Import is deliberately lenient: an entry it cannot use is skipped, and
    // the answer says how many were added (none), rather than failing a batch.
    const nonsense = await jsonPost(
      "/api/import",
      JSON.stringify({ items: [null, 5, "x", {}, { titleId: "../x", path: "/tmp" }] }),
    );
    check(
      "an import of nonsense adds nothing and says so",
      nonsense.status === 200 && nonsense.parsed?.added === 0,
      `${nonsense.status} ${nonsense.text.slice(0, 50)}`,
    );

    const stillAlive = await probeJson("/api/state");
    check(
      "the process still serves after the hostile sequence",
      stillAlive.status === 200 && Array.isArray(stillAlive.parsed?.games),
      String(stillAlive.status),
    );

    // A body that never declares its length cannot be caught by the header
    // check; the reader has to refuse it once it sees the size.
    const chunked = await fetch(`${BASE}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ items: [], pad: "x".repeat(1_300_000) })));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    check("an oversized body without a length is refused", chunked.status === 413, String(chunked.status));

    // Traversal payloads must not create anything, anywhere.
    const escapeTargets = [
      join(DATA_ROOT, "x.pkg"),
      join(SELFTEST_ROOT, "x.pkg"),
      join(SELFTEST_ROOT, "..", "x.pkg"),
      join(DATA_ROOT, "..", "escape.pkg"),
    ];
    check(
      "no traversal payload created a package file",
      escapeTargets.every((target) => !existsSync(target)),
      escapeTargets.filter((target) => existsSync(target)).join(", "),
    );
    const escapeServe = await fetch(`${BASE}/api/pkg/..%2F..%2Fpackage.json`);
    check("a traversal package id is never served", escapeServe.status === 404, String(escapeServe.status));

    // Rapid fire at every write endpoint: nothing may 5xx, and a normal
    // request right after must still succeed.
    const fireStart = Date.now();
    const fires: Array<Promise<Response>> = [];
    const firePost = (path: string, body: string) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    for (let i = 0; i < 30; i++) {
      const round = i % 5;
      if (round === 0) fires.push(firePost("/api/import", JSON.stringify({ items: [] })));
      if (round === 1) fires.push(firePost("/api/build", JSON.stringify({ titleId: "PSTA00404" })));
      if (round === 2) fires.push(firePost("/api/deploy", JSON.stringify({ titleId: "PSTA00404" })));
      if (round === 3) fires.push(firePost("/api/settings", JSON.stringify({ scanDirs: [] })));
      if (round === 4) fires.push(fetch(`${BASE}/api/game/PSTA00404`, { method: "DELETE" }));
    }
    const fireAnswers = await Promise.all(fires);
    const fireBodies = await Promise.all(fireAnswers.map((answer) => answer.text()));
    const fiveHundreds = fireAnswers.filter((answer) => answer.status >= 500).length;
    check("thirty rapid writes produce no 5xx", fiveHundreds === 0, `${fiveHundreds} of 30`);
    check(
      "none of them leaks a stack or a placeholder",
      fireBodies.every((body) => !/undefined|\[object Object\]| at .*\.ts:\d/.test(body)),
      fireBodies.find((body) => /undefined|\[object Object\]/.test(body))?.slice(0, 60) ?? "",
    );
    const afterFire = Date.now();
    const fireState = await probeJson("/api/state");
    check(
      "a normal request works right after the burst, inside 1s",
      fireState.status === 200 && Date.now() - afterFire < 1000,
      `${fireState.status} ${Date.now() - afterFire}ms`,
    );
    const fireStateAfter = (await (await fetch(`${BASE}/api/state`)).json()) as any;
    check(
      "the burst left nothing building or installing",
      !fireStateAfter.games.some((game: any) => game.state === "building" || game.state === "installing"),
      fireStateAfter.games.map((game: any) => game.state).join(","),
    );
    check("the whole hostile sequence finishes inside 5s", Date.now() - fireStart < 5000, `${Date.now() - fireStart}ms`);

    /* ---------------- concurrent mutations ---------------- */
    const duplicateAttempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        jsonPost(
          "/api/import",
          JSON.stringify({ items: [{ titleId: "PSTA00021", title: "Duplicate", path: FIXTURE, kind: "Game folder", size: 0 }] }),
        ).then((answer) => answer.parsed?.added),
      ),
    );
    const duplicates = (await getState()).games.filter((game) => game.titleId === "PSTA00021").length;
    check("five imports of one title leave one entry", duplicates === 1, String(duplicates));
    check(
      "only one of five concurrent imports adds it",
      duplicateAttempts.filter((added) => added === 1).length === 1,
      duplicateAttempts.join(","),
    );

    // A delete racing a scan: both are answered, and neither corrupts the file.
    const raceScan = jsonPost("/api/scan", JSON.stringify({ dir: FIXTURE }));
    const raceDelete = fetch(`${BASE}/api/game/PSTA00021`, { method: "DELETE" });
    const [scanAnswer, deleteAnswer] = await Promise.all([raceScan, raceDelete]);
    check(
      "a delete during a scan is answered, not refused by corruption",
      scanAnswer.status === 200 && deleteAnswer.status === 200,
      `${scanAnswer.status}/${deleteAnswer.status}`,
    );

    /* ---------------- the build queue under load ---------------- */
    const queueIds = Array.from({ length: 8 }, (_, i) => `PSTA0003${i}`);
    await jsonPost(
      "/api/import",
      JSON.stringify({ items: queueIds.map((id) => ({ titleId: id, title: `Queued ${id}`, path: FIXTURE, kind: "Game folder", size: 0 })) }),
    );
    const queued = await Promise.all(queueIds.map((id) => jsonPost("/api/build", JSON.stringify({ titleId: id }))));
    check(
      "eight builds at once are all accepted",
      queued.every((answer) => answer.status === 200),
      queued.map((answer) => answer.status).join(","),
    );
    const again = await jsonPost("/api/build", JSON.stringify({ titleId: queueIds[7] }));
    check("a title already queued is refused, not queued twice", again.status === 409, String(again.status));

    const queueDeadline = Date.now() + 20_000;
    let allBuilt = false;
    while (Date.now() < queueDeadline) {
      const states = (await getState()).games.filter((game) => queueIds.includes(game.titleId)).map((game) => game.state);
      if (states.length === queueIds.length && states.every((state) => state === "built")) {
        allBuilt = true;
        break;
      }
      await Bun.sleep(150);
    }
    check("eight queued builds all finish, none stuck behind the queue", allBuilt, allBuilt ? "all built" : "still building");
    await Promise.all(queueIds.map((id) => fetch(`${BASE}/api/game/${id}`, { method: "DELETE" })));

    /* ---------------- settings that would break later ---------------- */
    const saveSettings = (payload: unknown) => jsonPost("/api/settings", JSON.stringify(payload));
    const beforeConfig = (await getState()).config;
    const refusedHosts = [
      "not a url",
      "http://",
      "javascript:alert(1)",
      "http://127.0.0.1:8090/api/health",
      "ftp://127.0.0.1:8090",
      "http://user:pass@127.0.0.1:8090",
      "h".repeat(400),
    ];
    for (const host of refusedHosts) {
      const answer = await saveSettings({ consoleHost: host });
      check(
        `a console address like ${JSON.stringify(host.slice(0, 26))} is refused`,
        answer.status === 400 && typeof answer.parsed?.error === "string",
        String(answer.status),
      );
    }
    const bareHost = await saveSettings({ consoleHost: "127.0.0.1:1" });
    check(
      "a bare host:port is accepted and given a scheme",
      bareHost.status === 200 && bareHost.parsed?.config?.consoleHost === "http://127.0.0.1:1",
      `${bareHost.status} ${bareHost.parsed?.config?.consoleHost}`,
    );
    check(
      "a refused address does not clear the accepted one",
      (await getState()).config.consoleHost === "http://127.0.0.1:1",
      String((await getState()).config.consoleHost),
    );
    const badPort = await saveSettings({ port: 70000 });
    check("an out-of-range port is refused", badPort.status === 400, String(badPort.status));
    const badEngine = await saveSettings({ engine: "banana" });
    check("an engine that does not exist is refused", badEngine.status === 400, String(badEngine.status));
    const partialSave = await saveSettings({ scanDirs: ["/tmp/pv-settings-a"], engine: "mock" });
    check(
      "a valid save keeps the other fields",
      partialSave.status === 200 &&
        partialSave.parsed?.config?.consoleHost === "http://127.0.0.1:1" &&
        partialSave.parsed?.config?.engine === "mock" &&
        partialSave.parsed?.config?.scanDirs?.[0] === "/tmp/pv-settings-a",
      JSON.stringify(partialSave.parsed?.config),
    );
    await restartServer();
    const reloaded = (await getState()).config;
    check(
      "a restart shows exactly the settings that were saved",
      reloaded.consoleHost === "http://127.0.0.1:1" &&
        reloaded.engine === "mock" &&
        reloaded.scanDirs?.[0] === "/tmp/pv-settings-a" &&
        reloaded.port === beforeConfig.port,
      JSON.stringify(reloaded),
    );
    const restored = await saveSettings({ consoleHost: null, engine: beforeConfig.engine, scanDirs: [], port: beforeConfig.port });
    check("the settings can be put back", restored.status === 200 && (await getState()).config.consoleHost === null, String(restored.status));

    /* ---------------- streams do not leak ---------------- */
    const opened: AbortController[] = [];
    for (let i = 0; i < 8; i++) {
      const controller = new AbortController();
      opened.push(controller);
      void fetch(`${BASE}/api/events`, { signal: controller.signal })
        .then((res) => res.body?.getReader().read())
        .catch(() => undefined);
    }
    await Bun.sleep(400);
    const liveStreams = Number((await getState() as any).streams);
    for (const controller of opened) controller.abort();
    await Bun.sleep(700);
    const closedStreams = Number((await getState() as any).streams);
    check("eight open event streams are counted", liveStreams >= 8, String(liveStreams));
    check("closed streams leave no heartbeat behind", closedStreams === 0, String(closedStreams));

    // A dashboard polls this for hours. Sixty in a row must stay fast and leave
    // nothing behind, or a long session drifts into slow and fat.
    const pollStart = Date.now();
    for (let i = 0; i < 60; i++) await fetch(`${BASE}/api/state`).then((res) => res.arrayBuffer());
    const perPoll = (Date.now() - pollStart) / 60;
    check(
      "sixty state polls stay fast and leave nothing behind",
      perPoll < 250 && Number((await getState() as any).streams) === 0,
      `${perPoll.toFixed(0)}ms each`,
    );

    const removed = await fetch(`${BASE}/api/game/${TITLE_ID}`, { method: "DELETE" });
    check("remove from library", removed.ok);

    // The package is named after the title, so leaving it behind would fill the
    // folder with files nothing lists or serves.
    const leftover = await stat(join(PKG_PATH, `${TITLE_ID}.pkg`)).catch(() => null);
    check("removing a title takes its package with it", leftover === null);

    await rm(join(PKG_PATH, `${TITLE_ID}.pkg`), { force: true });
  } finally {
    server.kill();
    await rm(SELFTEST_ROOT, { recursive: true, force: true });
  }

  /* ---------------- boot with files it cannot use ---------------- */

  const bootRoot = "/tmp/pv_boot";
  await rm(bootRoot, { recursive: true, force: true });

  const bootApp = async (
    name: string,
    configText: string,
    library: unknown[] | null,
    port: number,
    options: { libraryText?: string; beforeSpawn?: (dir: string) => Promise<void>; env?: Record<string, string> } = {},
  ) => {
    const dir = join(bootRoot, name);
    assertThrowaway(join(dir, "data"), `the ${name} boot test`);
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "config.json"), configText);
    if (library) await writeFile(join(dir, "data", "library.json"), JSON.stringify(library));
    if (options.libraryText !== undefined) await writeFile(join(dir, "data", "library.json"), options.libraryText);
    if (options.beforeSpawn) await options.beforeSpawn(dir);
    const child = Bun.spawn({
      cmd: ["bun", "run", "app/server.ts"],
      env: {
        ...process.env,
        PV_CONFIG: join(dir, "config.json"),
        PV_DATA: join(dir, "data"),
        PV_PORT: String(port),
        ...(options.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return { child, dir, state: (await res.json()) as any };
      } catch {
        /* not up yet */
      }
      await Bun.sleep(150);
    }
    child.kill();
    throw new Error(`${name} did not start`);
  };

  const corrupt = await bootApp("corrupt", '{ this is not json ', null, 8131);
  try {
    check("the app starts with an unreadable settings file", corrupt.state?.config !== undefined);
    check(
      "an unreadable settings file is named, not swallowed",
      /settings file could not be read/i.test(String(corrupt.state.configProblem)),
      String(corrupt.state.configProblem).slice(0, 60),
    );
    const kept = await readFile(join(corrupt.dir, "config.json.bad"), "utf8").catch(() => "");
    check("the unreadable file is kept rather than overwritten", kept.includes("not json"), kept.slice(0, 20));
    check(
      "defaults are used in its place",
      corrupt.state.config.consoleHost === null && corrupt.state.config.engine === "auto",
      `${corrupt.state.config.consoleHost} ${corrupt.state.config.engine}`,
    );
  } finally {
    corrupt.child.kill();
  }

  const junk = await bootApp(
    "junk",
    JSON.stringify({ port: "not-a-port", engine: 5, scanDirs: "x", consoleHost: 42, enginePaths: { command: 7 } }),
    [{ titleId: "PBOT00001" }, 7, { title: "no id" }, { titleId: "PBOT00002", state: "weird", pkgPath: 5, sizeBytes: "big" }],
    8132,
  );
  try {
    check(
      "unusable settings fields are dropped, not adopted",
      typeof junk.state.config.port === "number" &&
        junk.state.config.engine === "auto" &&
        junk.state.config.consoleHost === null &&
        Array.isArray(junk.state.config.scanDirs),
      JSON.stringify(junk.state.config).slice(0, 80),
    );
    check(
      "the fields it could not use are named",
      /could not be used/i.test(String(junk.state.configProblem)),
      String(junk.state.configProblem).slice(0, 70),
    );
    check(
      "only the readable library rows survive",
      junk.state.games.length === 2 && junk.state.librarySkipped === 2,
      `${junk.state.games.length} rows, ${junk.state.librarySkipped} skipped`,
    );
    const repaired = junk.state.games.find((game: any) => game.titleId === "PBOT00002");
    check(
      "a half-written row is given workable values",
      repaired?.state === "dumped" && repaired?.pkgPath === null && repaired?.sizeBytes === 0,
      JSON.stringify(repaired).slice(0, 90),
    );
  } finally {
    junk.child.kill();
  }

  // A damaged library with no backup used to read as "no titles" — which is
  // what a fresh app looks like, and the next save would replace the file.
  const badLibrary = await bootApp("badlib", JSON.stringify({ port: 8130, consoleHost: null, engine: "auto", enginePaths: {}, scanDirs: [] }), null, 8133, {
    libraryText: '[{"titleId":"PBOT00009"}, broken',
  });
  try {
    check(
      "a damaged library file is named, not shown as an empty app",
      /could not be read/i.test(String(badLibrary.state.libraryProblem)),
      String(badLibrary.state.libraryProblem).slice(0, 70),
    );
    const keptLibrary = await readFile(join(badLibrary.dir, "data", "library.json.bad"), "utf8").catch(() => "");
    check("the damaged library is kept aside rather than overwritten", keptLibrary.includes("broken"));
    check("the app still answers with an empty list", Array.isArray(badLibrary.state.games) && badLibrary.state.games.length === 0);
  } finally {
    badLibrary.child.kill();
  }

  // A data folder that cannot be written used to end the process at boot.
  const readOnly = await bootApp(
    "readonly",
    JSON.stringify({ port: 8130, consoleHost: null, engine: "auto", enginePaths: {}, scanDirs: [] }),
    null,
    8134,
    {
      beforeSpawn: async (dir) => {
        await chmod(join(dir, "data"), 0o555);
      },
    },
  );
  try {
    check(
      "an unwritable data folder starts and says so",
      /could not be written/i.test(String(readOnly.state.dataProblem)),
      String(readOnly.state.dataProblem).slice(0, 70),
    );
  } finally {
    readOnly.child.kill();
    await chmod(join(bootRoot, "readonly", "data"), 0o755).catch(() => undefined);
  }

  // A save that fails mid-build used to be swallowed: the app said the title
  // was packaged, nothing was on disk, and a restart forgot the build.
  const saveFail = await bootApp(
    "savefail",
    JSON.stringify({ port: 8135, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
    null,
    8135,
    {},
  );
  const saveFailHost = "http://127.0.0.1:8135";
  const saveFailPost = (path: string, payload: unknown) =>
    fetch(`${saveFailHost}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    // The main suite's cleanup removed the fixtures; this check needs a source
    // that exists, so it plants its own.
    await mkdir(join(FIXTURE, "sce_sys"), { recursive: true });
    await writeFile(join(FIXTURE, "eboot.bin"), "not a real eboot");
    const imported = await saveFailPost("/api/import", {
      items: [{ titleId: "PSTA00041", title: "Unsaved", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    check("a title can be added while the folder is writable", imported.status === 200, String(imported.status));
    // The build's own scratch and output folders stay writable: this check is
    // about the library write failing, not the packer.
    await mkdir(join(bootRoot, "savefail", "data", "tmp"), { recursive: true });
    await chmod(join(bootRoot, "savefail", "data"), 0o555);
    const build = await saveFailPost("/api/build", { titleId: "PSTA00041" });
    check("the build is accepted before the disk is tested", build.status === 200, String(build.status));
    let state: any = null;
    for (let i = 0; i < 80; i++) {
      state = await (await fetch(`${saveFailHost}/api/state`)).json();
      const running = state.games.find((game: any) => game.titleId === "PSTA00041");
      if (running && running.state !== "building") break;
      await Bun.sleep(150);
    }
    const unsaved = state.games.find((game: any) => game.titleId === "PSTA00041");
    check(
      "a build that cannot be saved says so on the title",
      unsaved?.state === "built" && /could not be saved/i.test(String(unsaved?.note)),
      `${unsaved?.state} — ${unsaved?.note ?? "no note"}`,
    );
    check(
      "a failed save is named in the state",
      /could not be written/i.test(String(state?.saveProblem)),
      String(state?.saveProblem).slice(0, 60),
    );
    await chmod(join(bootRoot, "savefail", "data"), 0o755);
    await saveFailPost("/api/import", {
      items: [{ titleId: "PSTA00042", title: "Saved Later", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    const recovered: any = await (await fetch(`${saveFailHost}/api/state`)).json();
    check("a save after the folder is writable clears the warning", !recovered.saveProblem, String(recovered.saveProblem));
  } finally {
    saveFail.child.kill();
    await chmod(join(bootRoot, "savefail", "data"), 0o755).catch(() => undefined);
  }

  // A console that is down and comes back: the app must say offline, then
  // reconnect by itself. And a library path that is not a file (a directory
  // left where the JSON should be) must be named, never truncated.
  const recovery = await bootApp(
    "recovery",
    JSON.stringify({
      port: 8137,
      consoleHost: "http://127.0.0.1:8197",
      engine: "mock",
      enginePaths: {},
      scanDirs: [],
    }),
    null,
    8137,
    {},
  );
  const recoveryHost = "http://127.0.0.1:8137";
  try {
    const down = ((await (await fetch(`${recoveryHost}/api/state`)).json()) as any).console;
    check(
      "a console that is down is reported offline, not connected",
      down.mode === "offline" && down.connected === false,
      `${down.mode} connected=${down.connected}`,
    );
    const stillDown = ((await (await fetch(`${recoveryHost}/api/state`)).json()) as any).console;
    check("the second look is honest too, not a cached success", stillDown.connected === false, String(stillDown.connected));

    // A library entry that outlives its console: the title still lists, and a
    // deploy to the dead address fails with a sentence quickly, not a hang.
    const offlinePost = (path: string, payload: unknown) =>
      fetch(`${recoveryHost}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    await offlinePost("/api/import", {
      items: [{ titleId: "PSTA00091", title: "Stale", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    await mkdir(join(bootRoot, "recovery", "data", "tmp"), { recursive: true });
    await offlinePost("/api/build", { titleId: "PSTA00091" });
    let stale: any = null;
    for (let i = 0; i < 80; i++) {
      const state = (await (await fetch(`${recoveryHost}/api/state`)).json()) as any;
      stale = state.games.find((game: any) => game.titleId === "PSTA00091");
      if (stale && stale.state !== "building") break;
      await Bun.sleep(150);
    }
    check("a title whose console is offline still lists", stale?.state === "built" && Boolean(stale?.pkgPath), `${stale?.state}`);
    const deployStart = Date.now();
    const deployAnswer = (await (await offlinePost("/api/deploy", { titleId: "PSTA00091" })).json()) as any;
    const deployMs = Date.now() - deployStart;
    check(
      "a deploy to an offline console fails with a sentence",
      deployAnswer.ok === false && typeof deployAnswer.detail === "string" && deployAnswer.detail.length > 10,
      JSON.stringify(deployAnswer).slice(0, 90),
    );
    check("an offline deploy answers inside its 1s budget", deployMs < 1000, `${deployMs}ms`);
    const afterDeploy = (await (await fetch(`${recoveryHost}/api/state`)).json()) as any;
    const staleAfter = afterDeploy.games.find((game: any) => game.titleId === "PSTA00091");
    check("the failed deploy leaves an error, not a running job", staleAfter?.state === "error", `${staleAfter?.state}`);

    const listener = Bun.serve({ port: 8197, fetch: () => Response.json({ ok: true, version: "check", free: 5 }) });
    let linked: any = null;
    for (let i = 0; i < 40; i++) {
      const state = (await (await fetch(`${recoveryHost}/api/state`)).json()) as any;
      if (state.console.connected) {
        linked = state.console;
        break;
      }
      await Bun.sleep(250);
    }
    listener.stop();
    check(
      "a console that comes back is picked up without a restart",
      linked?.mode === "payload" && linked?.connected === true && linked?.version === "check",
      linked ? `${linked.mode} v${linked.version}` : "still offline after 10s",
    );
  } finally {
    recovery.child.kill();
  }

  // The library path is a directory: boot must name it, set it aside (never
  // overwrite it), and then save normally.
  const notAFile = await bootApp(
    "notafile",
    JSON.stringify({ port: 8138, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
    null,
    8138,
    {
      beforeSpawn: async (dir) => {
        await mkdir(join(dir, "data", "library.json"), { recursive: true });
      },
    },
  );
  const notAFileHost = "http://127.0.0.1:8138";
  try {
    check(
      "a library path that is not a file is named at boot",
      /could not be read/i.test(String(notAFile.state.libraryProblem)),
      String(notAFile.state.libraryProblem).slice(0, 60),
    );
    const aside = await stat(join(bootRoot, "notafile", "data", "library.json.bad")).catch(() => null);
    check("the unreadable path was set aside, not overwritten", Boolean(aside), aside ? "kept" : "missing");
    const added = await fetch(`${notAFileHost}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ titleId: "PSTA00061", title: "Nowhere", path: FIXTURE, kind: "Game folder", size: 0 }] }),
    });
    const state = (await (await fetch(`${notAFileHost}/api/state`)).json()) as any;
    check(
      "once the path is free, a save works again",
      added.status === 200 && state.saveProblem === null,
      `${added.status} ${String(state.saveProblem)}`,
    );
  } finally {
    notAFile.child.kill();
  }

  // A write that fails after its temporary file exists: the library file is
  // immutable, so the rename is refused. Nothing may truncate the old library,
  // leave a temporary behind, or stop the app serving.
  const immutable = await bootApp(
    "immutable",
    JSON.stringify({ port: 8140, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
    null,
    8140,
    {},
  );
  const immutableHost = "http://127.0.0.1:8140";
  const immutableLibrary = join(bootRoot, "immutable", "data", "library.json");
  const immutablePost = (path: string, payload: unknown) =>
    fetch(`${immutableHost}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    await immutablePost("/api/import", {
      items: [{ titleId: "PSTA00081", title: "Kept", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    const before = await readFile(immutableLibrary, "utf8");
    Bun.spawnSync(["chflags", "uchg", immutableLibrary]);
    const refused = await immutablePost("/api/import", {
      items: [{ titleId: "PSTA00082", title: "Not Kept", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    const state = (await (await fetch(`${immutableHost}/api/state`)).json()) as any;
    const after = await readFile(immutableLibrary, "utf8");
    check(
      "a write refused after its temporary file exists is named",
      refused.status === 200 && /could not be written/i.test(String(state.saveProblem)),
      `${refused.status} ${String(state.saveProblem).slice(0, 50)}`,
    );
    check("the old library is still whole and unchanged", after === before && (() => { try { JSON.parse(after); return true; } catch { return false; } })(), `${before.length} bytes`);
    const strays = (await readdir(join(bootRoot, "immutable", "data"))).filter((name) => name.endsWith(".tmp"));
    check("no half-written temporary file is left behind", strays.length === 0, strays.join(", ") || "clean");
    check("the app still serves while its library is unwritable", ((await (await fetch(`${immutableHost}/api/state`)).json()) as any).games.length >= 1);
  } finally {
    Bun.spawnSync(["chflags", "nouchg", immutableLibrary]);
    immutable.child.kill();
  }

  // Two saves that overlap: the older one is forced to finish late. With the
  // chain the delete lands last and stays deleted; without it the older
  // snapshot brings the title back on disk.
  const race = await bootApp(
    "saveorder",
    JSON.stringify({ port: 8139, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
    null,
    8139,
    { env: { PV_SAVE_DELAY_MS: "600", PV_SAVE_DELAY_MARKER: "PSTA00071" } },
  );
  const raceHost = "http://127.0.0.1:8139";
  const racePost = (path: string, payload: unknown) =>
    fetch(`${raceHost}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    await mkdir(join(FIXTURE, "sce_sys"), { recursive: true });
    await writeFile(join(FIXTURE, "eboot.bin"), "not a real eboot");
    await racePost("/api/import", {
      items: [{ titleId: "PSTA00072", title: "Soon Gone", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    await mkdir(join(bootRoot, "saveorder", "data", "tmp"), { recursive: true });
    await racePost("/api/import", {
      items: [{ titleId: "PSTA00071", title: "Doomed", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    const build = await racePost("/api/build", { titleId: "PSTA00072" });
    check("the slow-save build starts", build.status === 200, String(build.status));
    // Wait until the build is done: its library write is now in its delay
    // window, so the delete below lands while that older snapshot is pending.
    for (let i = 0; i < 80; i++) {
      const seen = (await (await fetch(`${raceHost}/api/state`)).json()) as any;
      if (seen.games.find((game: any) => game.titleId === "PSTA00072")?.state === "built") break;
      await Bun.sleep(50);
    }
    const removed = await fetch(`${raceHost}/api/game/PSTA00071`, { method: "DELETE" });
    check("the other title is removed while the save is slow", removed.status === 200, String(removed.status));
    await Bun.sleep(1800);
    const disk = JSON.parse(await readFile(join(bootRoot, "saveorder", "data", "library.json"), "utf8")) as Array<{ titleId: string }>;
    const live = (((await (await fetch(`${raceHost}/api/state`)).json()) as any).games as Array<{ titleId: string }>).map((g) => g.titleId);
    check(
      "an older save cannot bring a deleted title back on disk",
      !disk.some((entry) => entry.titleId === "PSTA00071") && !live.includes("PSTA00071"),
      `disk=${disk.map((e) => e.titleId).join(",")} live=${live.join(",")}`,
    );
  } finally {
    race.child.kill();
  }

  /* ---------------- front 1: the queue and state machine, adversarially ---------------- */
  const machineStart = Date.now();
  const machine = await bootApp(
    "machine",
    JSON.stringify({ port: 8142, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
    null,
    8142,
    { env: { PV_MOCK_HOLD_ID: "PSTA00201", PV_MOCK_HOLD_MS: "1500" } },
  );
  const coldStartMs = Date.now() - machineStart;
  const machineHost = "http://127.0.0.1:8142";
  const machinePost = (path: string, payload: unknown, signal?: AbortSignal) =>
    fetch(`${machineHost}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  const machineState = async () => (await (await fetch(`${machineHost}/api/state`)).json()) as any;
  const waitTerminal = async (titleId: string, deadlineMs = 8000): Promise<any> => {
    const deadline = Date.now() + deadlineMs;
    let game: any = null;
    while (Date.now() < deadline) {
      game = (await machineState()).games.find((entry: any) => entry.titleId === titleId);
      if (game && game.state !== "building" && game.state !== "installing") return game;
      await Bun.sleep(120);
    }
    return game;
  };
  try {
    await mkdir(join(bootRoot, "machine", "data", "tmp"), { recursive: true });
    await mkdir(join(FIXTURE, "sce_sys"), { recursive: true });
    await writeFile(join(FIXTURE, "eboot.bin"), "not a real eboot");

    // Two deploys of the same title, at the same instant.
    await machinePost("/api/import", {
      items: [{ titleId: "PSTA00202", title: "Double Deploy", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    await machinePost("/api/build", { titleId: "PSTA00202" });
    await waitTerminal("PSTA00202");
    const [firstDeploy, secondDeploy] = await Promise.all([
      machinePost("/api/deploy", { titleId: "PSTA00202" }),
      machinePost("/api/deploy", { titleId: "PSTA00202" }),
    ]);
    const codes = [firstDeploy.status, secondDeploy.status].sort();
    check("two deploys at once: one runs, one is refused", codes.join("/") === "200/409", codes.join("/"));
    const afterDeploys = await waitTerminal("PSTA00202");
    check("the duelled deploy ends terminal, not installing", afterDeploys?.state !== "installing", `${afterDeploys?.state}`);

    // A deploy while that title is still building.
    await machinePost("/api/import", {
      items: [{ titleId: "PSTA00201", title: "Held", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    await machinePost("/api/build", { titleId: "PSTA00201" });
    await Bun.sleep(150);
    const duringBuild = await machinePost("/api/deploy", { titleId: "PSTA00201" });
    check("a deploy while the title is building is refused", duringBuild.status === 409, String(duringBuild.status));
    const heldDone = await waitTerminal("PSTA00201", 10000);
    check("the held build still finishes after the refusal", heldDone?.state === "built", `${heldDone?.state}`);

    // A deploy whose client hangs up on a console that never answers: the
    // request is abandoned, the job must still end terminal, and the server
    // must keep serving while the connect timeout runs out.
    await machinePost("/api/settings", { consoleHost: "http://10.255.255.1:8097" });
    const probeStart = Date.now();
    const probed = await fetch(`${machineHost}/api/state`);
    const probedBody = (await probed.json()) as any;
    const probeMs = Date.now() - probeStart;
    check(
      "a black-holed console is probed once and answers offline within 4.5s",
      probed.status === 200 && probedBody.console.connected === false && probeMs < 4500,
      `${probeMs}ms ${probedBody.console.mode}`,
    );
    const control = new AbortController();
    const abandoned = machinePost("/api/deploy", { titleId: "PSTA00202" }, control.signal).catch(() => null);
    await Bun.sleep(300);
    control.abort();
    await abandoned;
    const afterHangup = await waitTerminal("PSTA00202", 10000);
    check(
      "a deploy abandoned mid-flight still ends terminal",
      afterHangup?.state !== "installing" && afterHangup?.state !== "building",
      `${afterHangup?.state}`,
    );
    const stillServing = await fetch(`${machineHost}/api/state`);
    check("the server keeps serving after that hang-up", stillServing.status === 200, String(stillServing.status));
    await machinePost("/api/settings", { consoleHost: null });

    // The source folder disappears while the job is queued.
    const vanishing = join(bootRoot, "vanishing");
    await mkdir(join(vanishing, "sce_sys"), { recursive: true });
    await writeFile(join(vanishing, "eboot.bin"), "x");
    await machinePost("/api/import", {
      items: [{ titleId: "PSTA00204", title: "Vanishing", path: vanishing, kind: "Game folder", size: 0 }],
    });
    await rm(vanishing, { recursive: true, force: true });
    const goneBuild = await machinePost("/api/build", { titleId: "PSTA00204" });
    check(
      "a build whose source is gone is refused with a sentence",
      goneBuild.status === 422 || goneBuild.status === 400,
      String(goneBuild.status),
    );
    const goneBody = (await goneBuild.json()) as any;
    check(
      "that refusal names the missing source",
      typeof goneBody?.message === "string" && /gone|rescan|source/i.test(goneBody.message),
      String(goneBody?.message).slice(0, 70),
    );
    const goneState = await machineState();
    const goner = goneState.games.find((entry: any) => entry.titleId === "PSTA00204");
    check("a source that is gone leaves no running job", goner?.state !== "building", `${goner?.state}`);

    // A stale entry: package removed from disk, console offline.
    await machinePost("/api/import", {
      items: [{ titleId: "PSTA00205", title: "Lost Package", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    await machinePost("/api/build", { titleId: "PSTA00205" });
    const builtLost = await waitTerminal("PSTA00205");
    if (builtLost?.pkgPath) await rm(builtLost.pkgPath, { force: true });
    const lostDeploy = await machinePost("/api/deploy", { titleId: "PSTA00205" });
    const lostGame = await waitTerminal("PSTA00205");
    check(
      "a package missing from disk is not reported as sent",
      lostGame?.state !== "installed",
      `${lostDeploy.status} ${lostGame?.state}`,
    );

    // A burst of state requests while a build holds the queue.
    await machinePost("/api/import", {
      items: [{ titleId: "PSTA00206", title: "Busy", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    await machinePost("/api/build", { titleId: "PSTA00206" });
    await Bun.sleep(120);
    const burstStart = Date.now();
    const burst = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const started = Date.now();
        const response = await fetch(`${machineHost}/api/state`);
        await response.arrayBuffer();
        return { status: response.status, ms: Date.now() - started };
      }),
    );
    const burstMs = Date.now() - burstStart;
    const slowest = Math.max(...burst.map((entry) => entry.ms));
    check("forty state requests during a build all answer", burst.every((entry) => entry.status === 200), `${burst.filter((e) => e.status !== 200).length} failed`);
    check("none of them waits behind the build", slowest < 1500, `slowest ${slowest}ms, burst ${burstMs}ms`);

    // Seeded fuzz: random requests, a truncated body and an aborted request per
    // round. Every round has to settle terminal within its deadline.
    let seed = 20261119;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const fuzzIds = ["PSTA00211", "PSTA00212", "PSTA00213"];
    let settled = 0;
    for (let round = 0; round < 10; round++) {
      const id = fuzzIds[Math.floor(random() * fuzzIds.length)];
      const pick = Math.floor(random() * 5);
      if (pick === 0) {
        await machinePost("/api/import", {
          items: [{ titleId: id, title: `Fuzz ${id}`, path: FIXTURE, kind: "Game folder", size: 0 }],
        });
      } else if (pick === 1) {
        await machinePost("/api/build", { titleId: id }).catch(() => null);
      } else if (pick === 2) {
        await machinePost("/api/deploy", { titleId: id }).catch(() => null);
      } else if (pick === 3) {
        await fetch(`${machineHost}/api/game/${id}`, { method: "DELETE" }).catch(() => null);
      } else {
        // A truncated body, sent raw.
        await fetch(`${machineHost}/api/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"items":[{"titleId":"PSTA00211"',
        }).catch(() => null);
      }
      if (random() < 0.4) await fetch(`${machineHost}/api/state`).then((r) => r.arrayBuffer()).catch(() => null);
      const deadline = Date.now() + 6000;
      let terminal = false;
      while (Date.now() < deadline) {
        const state = await machineState();
        if (!state.games.some((game: any) => game.state === "building" || game.state === "installing")) {
          terminal = true;
          break;
        }
        await Bun.sleep(120);
      }
      if (terminal) settled++;
    }
    check("ten fuzz rounds all settle terminal, none hang", settled === 10, `${settled}/10`);

    /* ---------------- front 2: measured budgets ---------------- */
    check("cold start to a served /api/state is under 4s", coldStartMs < 4000, `${coldStartMs}ms`);
    const warmStart = Date.now();
    for (let i = 0; i < 60; i++) await fetch(`${machineHost}/api/state`).then((r) => r.arrayBuffer());
    const warmAvg = (Date.now() - warmStart) / 60;
    check("a warm /api/state averages under 60ms", warmAvg < 60, `${warmAvg.toFixed(1)}ms avg`);
  } finally {
    machine.child.kill();
  }

  // A slow packer: the request path must stay free, and killing the app mid-build
  // must leave a terminal state after restart, not a phantom job.
  const slow = await bootApp(
    "slow",
    JSON.stringify({
      port: 8143,
      consoleHost: null,
      engine: "command",
      enginePaths: { command: `sleep 20; printf '\\177' > "{pkg}"` },
      scanDirs: [],
    }),
    null,
    8143,
    {},
  );
  const slowHost = "http://127.0.0.1:8143";
  try {
    await mkdir(join(bootRoot, "slow", "data", "tmp"), { recursive: true });
    await fetch(`${slowHost}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ titleId: "PSTA00221", title: "Slow", path: FIXTURE, kind: "Game folder", size: 0 }] }),
    });
    await fetch(`${slowHost}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ titleId: "PSTA00221" }),
    });
    await Bun.sleep(300);
    const whileBuilding = Date.now();
    const answered = await fetch(`${slowHost}/api/state`);
    await answered.arrayBuffer();
    const stateWhileBuilding = Date.now() - whileBuilding;
    check("a state request returns while a slow packer runs", answered.status === 200 && stateWhileBuilding < 500, `${stateWhileBuilding}ms`);
    slow.child.kill();
    await Bun.sleep(400);
    const restarted = await bootApp(
      "slow",
      JSON.stringify({
        port: 8144,
        consoleHost: null,
        engine: "command",
        enginePaths: { command: `sleep 20; printf '\\177' > "{pkg}"` },
        scanDirs: [],
      }),
      null,
      8144,
      {},
    );
    try {
      const revived = (restarted.state.games as any[]).find((game) => game.titleId === "PSTA00221");
      check(
        "a build killed mid-flight comes back terminal, not running",
        revived?.state !== "building" && revived?.state !== "installing",
        `${revived?.state}`,
      );
      check(
        "its note says the job was interrupted",
        /interrupt/i.test(String(revived?.note)),
        String(revived?.note).slice(0, 70),
      );
    } finally {
      restarted.child.kill();
    }
  } finally {
    slow.child.kill();
  }

  // A packer command that fails: the job must end as an error with the code,
  // not sit in "building" and not leave the request open.
  const failing = await bootApp(
    "failing",
    JSON.stringify({
      port: 8141,
      consoleHost: null,
      engine: "command",
      enginePaths: { command: "exit 7" },
      scanDirs: [],
    }),
    null,
    8141,
    {},
  );
  const failingHost = "http://127.0.0.1:8141";
  const failingPost = (path: string, payload: unknown) =>
    fetch(`${failingHost}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    await mkdir(join(bootRoot, "failing", "data", "tmp"), { recursive: true });
    await failingPost("/api/import", {
      items: [{ titleId: "PSTA00095", title: "Breaks", path: FIXTURE, kind: "Game folder", size: 0 }],
    });
    const accepted = await failingPost("/api/build", { titleId: "PSTA00095" });
    check("a build with a broken packer is still accepted", accepted.status === 200, String(accepted.status));
    let state: any = null;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(`${failingHost}/api/state`)).json();
      const game = state.games.find((entry: any) => entry.titleId === "PSTA00095");
      if (game && game.state !== "building") break;
      await Bun.sleep(150);
    }
    const broken = state.games.find((entry: any) => entry.titleId === "PSTA00095");
    check("a failed packer ends the job as an error", broken?.state === "error", `${broken?.state}`);
    check(
      "the failure names the exit code",
      /\(7\)|exit 7|code 7/i.test(String(broken?.note)),
      String(broken?.note).slice(0, 90),
    );
    check("no package is left behind for a failed build", !broken?.pkgPath, String(broken?.pkgPath));
  } finally {
    failing.child.kill();
  }

  await rm(bootRoot, { recursive: true, force: true });

  console.log(`\n${passed} checks passed\n`);
}

main().catch((error) => {
  console.error(`\nself-check aborted: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
