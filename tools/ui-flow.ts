/**
 * Drives the real console UI through a failure and a dismissal, in a browser.
 *
 * The payload suite and the Mac suites cover their own halves; neither can see
 * what the screen does. This starts the preview on its own port with no Mac
 * configured — so a conversion is guaranteed to fail — loads the page in
 * headless Chrome and presses the same things a player presses.
 *
 * What it guards:
 *   - a run that fails shows the reason, not a spinner that never moves
 *   - the reason is still there six seconds later, until it is dismissed
 *     (it used to vanish on its own after three)
 *   - Close really closes, and the page keeps polling afterwards
 *   - nothing is logged to the console as an error while this happens
 *
 *   bun run tools/ui-flow.ts
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PREVIEW_PORT = 8095;
const CDP_PORT = 9223;
const CHROME =
  process.env.PV_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = "/tmp/pv_ui_flow_profile";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`);
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reach(url: string, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

await rm(PROFILE, { recursive: true, force: true });

// Its own preview, with no Mac address set, so the conversion below cannot
// succeed for an environmental reason.
let preview = Bun.spawn([process.execPath, "run", "tools/preview-console-ui.ts"], {
  env: { ...process.env, PV_PREVIEW_PORT: String(PREVIEW_PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

const chrome = Bun.spawn(
  [
    CHROME,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--window-size=420,900",
    "about:blank",
  ],
  { stdout: "pipe", stderr: "pipe" },
);

const cleanup = () => {
  try {
    chrome.kill();
  } catch {
    /* already gone */
  }
  try {
    preview.kill();
  } catch {
    /* already gone */
  }
};

try {
  const previewUp = await reach(`http://127.0.0.1:${PREVIEW_PORT}/`);
  check("the console UI is being served", previewUp, `port ${PREVIEW_PORT}`);
  const cdpUp = await reach(`http://127.0.0.1:${CDP_PORT}/json/version`);
  check("a browser is available to drive it", cdpUp, `port ${CDP_PORT}`);
  if (!previewUp || !cdpUp) throw new Error("nothing to drive");

  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not attach to the page"));
  });

  let next = 0;
  const pending = new Map<number, (value: any) => void>();
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
      return;
    }
    // Anything the page reports as an error counts: a rejected promise here is
    // a flow that silently did nothing.
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      errors.push(String(detail?.exception?.description ?? detail?.text ?? "exception"));
    }
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      errors.push(String(message.params.entry.text));
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      errors.push(
        (message.params.args ?? [])
          .map((arg: any) => String(arg.value ?? arg.description ?? ""))
          .join(" "),
      );
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PREVIEW_PORT}/` });

  const evaluate = async (expression: string): Promise<any> => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result?.result?.value;
  };

  /** A second page, with its own CDP session, so two interfaces can act at once. */
  async function openPage(url: string, initScript?: string) {
    const created = (await send("Target.createTarget", { url: initScript ? "about:blank" : url })) as {
      targetId: string;
    };
    const list = (await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    ).json()) as Array<{ id: string; type: string; webSocketDebuggerUrl: string }>;
    const target = list.find((entry) => entry.id === created.targetId);
    if (!target) throw new Error("the second page did not open");

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("could not attach to the second page"));
    });
    let sequence = 0;
    const waiting = new Map<number, (value: any) => void>();
    const pageErrors: string[] = [];
    /** Events this page answers itself — request interception has to run on this
     *  session, not the first tab's, or it intercepts the wrong tab. */
    const hooks = new Map<string, (params: any) => void>();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && waiting.has(message.id)) {
        waiting.get(message.id)?.(message.result);
        waiting.delete(message.id);
        return;
      }
      const hook = message.method ? hooks.get(message.method) : undefined;
      if (hook) hook(message.params);
      if (message.method === "Runtime.exceptionThrown") {
        pageErrors.push(String(message.params?.exceptionDetails?.exception?.description ?? "exception"));
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        pageErrors.push("console.error");
      }
    };
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        const id = ++sequence;
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    await call("Runtime.enable");
    await call("Page.enable");
    if (initScript) {
      await call("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
      await call("Page.navigate", { url });
    }
    const run = async (expression: string): Promise<any> => {
      const answer = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (answer?.exceptionDetails) {
        throw new Error(String(answer.exceptionDetails.exception?.description ?? "page script failed"));
      }
      return answer?.result?.value;
    };
    return { run, errors: pageErrors, close: () => socket.close(), call, hooks };
  }

  // The page is a real one: wait for it to draw the library.
  let tiles = 0;
  const tileDeadline = Date.now() + 15000;
  while (Date.now() < tileDeadline) {
    tiles = Number(await evaluate(`document.querySelectorAll(".tile[data-id]").length`));
    if (tiles > 0) break;
    await sleep(250);
  }
  check("the library draws its tiles", tiles > 0, `${tiles} tiles`);

  // Press a dump: that is the conversion flow.
  await evaluate(`document.querySelector('[data-id="PTST00003"]').click()`);
  const asked = await evaluate(
    `(document.getElementById("scrim").textContent || "").includes("Convert to FPKG")`,
  );
  check("pressing a dump asks before packing", asked === true);

  await evaluate(
    `[...document.querySelectorAll('#scrim [data-action]')].find((b) => b.dataset.action === "confirmYes").click()`,
  );

  // The failure has to arrive, and it has to say why.
  let text = "";
  const failDeadline = Date.now() + 12000;
  while (Date.now() < failDeadline) {
    text = String(await evaluate(`document.getElementById("scrim").textContent || ""`));
    if (text.includes("Conversion stopped")) break;
    await sleep(250);
  }
  check("a failed conversion says so", text.includes("Conversion stopped"), text.trim().slice(0, 80));
  check(
    "the failure carries a reason",
    /Mac|address|Settings|reach/i.test(text),
    text.replace(/\s+/g, " ").slice(0, 120),
  );

  // This is the regression: the panel used to close itself 3.2 seconds later,
  // taking the only explanation with it.
  await sleep(6000);
  const stillThere = String(await evaluate(`document.getElementById("scrim").hidden === false`));
  const afterWait = String(await evaluate(`document.getElementById("scrim").textContent || ""`));
  check("the reason stays until it is dismissed", stillThere === "true" && afterWait.includes("Conversion stopped"), afterWait.replace(/\s+/g, " ").slice(0, 60));

  await evaluate(
    `[...document.querySelectorAll('#scrim [data-action]')].find((b) => b.dataset.action === "close").click()`,
  );
  const closed = await evaluate(`document.getElementById("scrim").hidden === true`);
  check("Close dismisses it", closed === true);

  // And the page is still alive afterwards: a fresh press has to answer again.
  await evaluate(`document.querySelector('[data-id="PTST00003"]').click()`);
  const reopened = await evaluate(
    `(document.getElementById("scrim").textContent || "").includes("Convert to FPKG")`,
  );
  check("the interface still responds after a failure", reopened === true);

  // The tile that never finished packing must not claim it did.
  const stillDump = await evaluate(
    `Boolean(document.querySelector('[data-id="PTST00003"]').textContent.includes("PS4"))`,
  );
  check("a failed conversion leaves the tile as it was", stillDump === true);

  check("no error or unhandled rejection reached the console", errors.length === 0, errors.slice(0, 2).join(" | "));

  // ---------------- the payload is gone ----------------
  preview.kill();
  await sleep(900);
  await evaluate(`document.querySelector('[data-id="PTST00003"]').click()`);
  await evaluate(
    `[...document.querySelectorAll('#scrim [data-action]')].find((b) => b.dataset.action === "confirmYes").click()`,
  );
  let absentToast = "";
  const absentDeadline = Date.now() + 12000;
  while (Date.now() < absentDeadline) {
    absentToast = String(
      await evaluate(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`),
    );
    if (/not answering|Cannot reach/i.test(absentToast)) break;
    await sleep(250);
  }
  check(
    "a dead payload is reported in plain words",
    /not answering/i.test(absentToast) && !/Failed to fetch/i.test(absentToast),
    absentToast.slice(0, 80),
  );

  // ---------------- the console survives the payload restarting ----------------
  preview.kill();
  await sleep(1200);
  preview = Bun.spawn([process.execPath, "run", "tools/preview-console-ui.ts"], {
    env: { ...process.env, PV_PREVIEW_PORT: String(PREVIEW_PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await reach(`http://127.0.0.1:${PREVIEW_PORT}/`, 15000);
  let recovered = 0;
  const recoveryDeadline = Date.now() + 20000;
  while (Date.now() < recoveryDeadline) {
    recovered = Number(await evaluate(`document.querySelectorAll(".tile[data-id]").length`));
    if (recovered > 0) break;
    await sleep(500);
  }
  check("the console UI recovers after the payload restarts", recovered > 0, `${recovered} tiles`);

  // ---------------- the views the earlier checks never open ----------------
  for (const [view, heading] of [
    ["packages", "Packages on this console"],
    ["console", "This PlayStation 5"],
    ["settings", "Settings"],
  ] as const) {
    const rendered = String(
      await evaluate(`(() => {
        const item = document.querySelector('.nav .item[data-view="${view}"]');
        if (!item) return "no nav item";
        item.click();
        const head = document.getElementById("heading").textContent;
        const text = document.getElementById("scroll").textContent.trim();
        if (head !== ${JSON.stringify(heading)}) return "heading: " + head;
        if (text.length < 20) return "empty: " + head;
        return "ok";
      })()`),
    );
    check(`the ${view} view renders`, rendered === "ok", rendered.slice(0, 70));
  }
  await evaluate(`document.querySelector('.nav .item[data-view="library"]').click()`);

  // ---------------- a payload that is slow, and one that answers with an error ----------------
  const flaky = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${PREVIEW_PORT}/api/preview/flaky`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Let any earlier toast clear first, so anything seen below is this phase's.
  const clearBy = Date.now() + 6000;
  while (Date.now() < clearBy) {
    const shown = await evaluate(`document.getElementById("toast").hidden`);
    if (shown) break;
    await sleep(200);
  }

  await flaky({ delayMs: 1500 });
  const slowDeadline = Date.now() + 16000;
  let slowTiles = 0;
  let slowToast = "";
  while (Date.now() < slowDeadline) {
    slowTiles = Number(await evaluate(`document.querySelectorAll(".tile[data-id]").length`));
    const said = String(
      await evaluate(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`),
    );
    if (said) slowToast = said;
    // One full slow poll cycle has to have gone by without an error.
    if (slowTiles > 0 && Date.now() > slowDeadline - 9000) break;
    await sleep(400);
  }
  check("a slow payload still paints the list", slowTiles > 0, `${slowTiles} tiles`);
  // Any message at all means a 1.5 s answer was treated as a failure.
  check("a slow payload raises no error", slowToast === "", slowToast.slice(0, 60));

  await flaky({ delayMs: 0, fail: true });
  let errorToast = "";
  const errorDeadline = Date.now() + 22000;
  while (Date.now() < errorDeadline) {
    errorToast = String(
      await evaluate(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`),
    );
    if (errorToast.trim().length > 0) break;
    await sleep(300);
  }
  check(
    "a payload answering with an error says so in its own words",
    /could not be read/i.test(errorToast),
    errorToast.slice(0, 70),
  );
  const keptTiles = Number(await evaluate(`document.querySelectorAll(".tile[data-id]").length`));
  check("an erroring payload keeps the last list on screen", keptTiles > 0, `${keptTiles} tiles`);
  await flaky({ fail: false });

  // ---------------- the desktop app's own interface ----------------
  const APP_PORT = 8096;
  const appRoot = "/tmp/pv_ui_app";
  await rm(appRoot, { recursive: true, force: true });
  const dumpDir = join(appRoot, "dump", "PSTA01111");
  await mkdir(join(dumpDir, "sce_sys"), { recursive: true });
  await writeFile(
    join(dumpDir, "sce_sys", "param.json"),
    JSON.stringify({ titleId: "PSTA01111", titleName: "Dashboard Dump" }),
  );
  await writeFile(join(dumpDir, "eboot.bin"), "x");
  await mkdir(join(appRoot, "data"), { recursive: true });
  await writeFile(
    join(appRoot, "config.json"),
    JSON.stringify({ port: APP_PORT, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
  );

  const app = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "app", "server.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PV_CONFIG: join(appRoot, "config.json"),
      PV_PORT: String(APP_PORT),
      PV_DATA: join(appRoot, "data"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const errorsBeforeDashboard = errors.length;

  try {
    check("the desktop app answers", await reach(`http://127.0.0.1:${APP_PORT}/api/state`, 15000));
    await send("Page.navigate", { url: `http://127.0.0.1:${APP_PORT}/` });
    await sleep(800);

    // Scan a folder the way the interface does, then add what it found.
    await evaluate(`document.querySelector('.nav[data-view="forge"]').click()`);
    await evaluate(
      `(() => { const input = document.querySelector("#scanDir"); input.value = ${JSON.stringify(
        join(appRoot, "dump"),
      )}; input.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#scanBtn").click(); return true; })()`,
    );
    let found = 0;
    const foundDeadline = Date.now() + 10000;
    while (Date.now() < foundDeadline) {
      found = Number(await evaluate(`document.querySelectorAll("[data-add]").length`));
      if (found > 0) break;
      await sleep(250);
    }
    check("a scan from the interface finds the dump", found > 0, `${found} found`);

    await evaluate(`document.querySelector('[data-add="PSTA01111"]').click()`);
    await evaluate(`document.querySelector('.nav[data-view="library"]').click()`);
    let inLibrary = false;
    const libraryDeadline = Date.now() + 10000;
    while (Date.now() < libraryDeadline) {
      inLibrary = Boolean(
        await evaluate(`document.querySelectorAll('.tile[data-title="PSTA01111"]').length > 0`),
      );
      if (inLibrary) break;
      await sleep(250);
    }
    check("the added title appears as a tile", inLibrary === true);

    await evaluate(`document.querySelector('.tile[data-title="PSTA01111"]').click()`);
    check(
      "pressing a tile opens its panel",
      (await evaluate(`document.getElementById("drawer").hidden === false`)) === true,
    );

    await evaluate(`document.querySelector('[data-action="build"]').click()`);
    let built = false;
    const buildDeadline = Date.now() + 30000;
    while (Date.now() < buildDeadline) {
      const state = (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/state`)).json()) as {
        games: Array<{ titleId: string; state: string }>;
      };
      built = state.games.some((game) => game.titleId === "PSTA01111" && game.state === "built");
      if (built) break;
      await sleep(300);
    }
    check("a build from the interface produces a package", built === true);

    await evaluate(`document.querySelector('[data-action="remove"]').click()`);
    let gone = false;
    const goneDeadline = Date.now() + 10000;
    while (Date.now() < goneDeadline) {
      gone = (await evaluate(`document.querySelectorAll('.tile[data-title="PSTA01111"]').length === 0`)) === true;
      if (gone) break;
      await sleep(250);
    }
    check("removing from the interface clears the tile", gone === true);

    check(
      "the desktop interface logs no errors either",
      errors.length === errorsBeforeDashboard,
      errors.slice(errorsBeforeDashboard).slice(0, 2).join(" | "),
    );

    // With the app stopped, an action has to say so rather than do nothing.
    app.kill();
    await sleep(900);
    await evaluate(`document.querySelector('.nav[data-view="forge"]').click()`);
    await evaluate(
      `(() => { const input = document.querySelector("#scanDir"); input.value = "/tmp/nothing"; input.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#scanBtn").click(); return true; })()`,
    );
    let toastText = "";
    const toastDeadline = Date.now() + 12000;
    while (Date.now() < toastDeadline) {
      toastText = String(
        await evaluate(
          `document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`,
        ),
      );
      if (/Cannot reach/i.test(toastText)) break;
      await sleep(250);
    }
    const probe = await evaluate(
      `JSON.stringify({ scanBtn: Boolean(document.querySelector("#scanBtn")), scanDir: Boolean(document.querySelector("#scanDir")), hidden: document.getElementById("toast").hidden, text: document.getElementById("toast").textContent })`,
    );
    check(
      "an action against a stopped app says so",
      /Cannot reach/i.test(toastText),
      `${toastText.slice(0, 60)} · ${probe}`,
    );
  } finally {
    try {
      app.kill();
    } catch {
      /* already gone */
    }
    await rm(appRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---------------- the dashboard's own safety refresh ----------------
  // The event stream is left working and only /api/state is failed, so the
  // interval is the only thing that can notice: exactly the case it exists for.
  const SWEEP_PORT = 8099;
  const sweepRoot = "/tmp/pv_sweep";
  await rm(sweepRoot, { recursive: true, force: true });
  await mkdir(join(sweepRoot, "data"), { recursive: true });
  const sweepSource = join(sweepRoot, "seed", "PPSA08888");
  await mkdir(join(sweepSource, "sce_sys"), { recursive: true });
  await writeFile(
    join(sweepSource, "sce_sys", "param.json"),
    JSON.stringify({ titleId: "PPSA08888", titleName: "Sweep Test" }),
  );
  await writeFile(
    join(sweepRoot, "config.json"),
    JSON.stringify({ port: SWEEP_PORT, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
  );
  const sweepApp = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "app", "server.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PV_CONFIG: join(sweepRoot, "config.json"),
      PV_DATA: join(sweepRoot, "data"),
      PV_PORT: String(SWEEP_PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    check("the sweep app answers", await reach(`http://127.0.0.1:${SWEEP_PORT}/api/state`, 15000));
    await fetch(`http://127.0.0.1:${SWEEP_PORT}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ titleId: "PPSA08888", title: "Sweep Test", path: sweepSource, kind: "Game folder", size: 0 }],
      }),
    });

    const sweepPage = await openPage(`http://127.0.0.1:${SWEEP_PORT}/`, "window.PV_SWEEP_MS = 1200;");
    let blockState = false;
    try {
      let tiles = 0;
      const showDeadline = Date.now() + 18000;
      while (Date.now() < showDeadline) {
        tiles = Number(await sweepPage.run(`document.querySelectorAll(".tile[data-title]").length`));
        if (tiles > 0) break;
        await sleep(200);
      }
      check("the sweep page paints its library", tiles > 0, `${tiles} tiles`);
      check(
        "the sweep interval was the injected one",
        Number(await sweepPage.run(`window.PV_SWEEP_MS`)) === 1200,
        String(await sweepPage.run(`window.PV_SWEEP_MS`)),
      );

      // Only this tab's /api/state is failed; its event stream stays healthy.
      sweepPage.hooks.set("Fetch.requestPaused", (params) => {
        const url = String(params?.request?.url ?? "");
        if (blockState && url.includes("/api/state")) {
          void sweepPage.call("Fetch.failRequest", { requestId: params.requestId, errorReason: "Failed" });
        } else {
          void sweepPage.call("Fetch.continueRequest", { requestId: params.requestId });
        }
      });
      await sweepPage.call("Fetch.enable", { patterns: [{ urlPattern: "*api/state*" }] });

      blockState = true;
      let marked = false;
      const markDeadline = Date.now() + 12000;
      while (Date.now() < markDeadline) {
        marked = Boolean(await sweepPage.run(`document.getElementById("pills").textContent.includes("Not updating")`));
        if (marked) break;
        await sleep(200);
      }
      check("a state poll that stops answering is noticed with the stream still up", marked);

      const stillListed = Number(await sweepPage.run(`document.querySelectorAll(".tile[data-title]").length`));
      check("a stale list is marked rather than left looking live", marked && stillListed > 0, `${stillListed} tiles`);

      blockState = false;
      let cleared = false;
      const clearDeadline = Date.now() + 12000;
      while (Date.now() < clearDeadline) {
        cleared = Boolean(
          await sweepPage.run(`!document.getElementById("pills").textContent.includes("Not updating")`),
        );
        if (cleared) break;
        await sleep(200);
      }
      check("the mark clears when state answers again", marked && cleared, `marked ${marked}, cleared ${cleared}`);
    } finally {
      sweepPage.close();
    }
  } finally {
    sweepApp.kill();
    await rm(sweepRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---------------- both interfaces writing one library ----------------
  // One app, two pages: the dashboard and the console UI add, build and delete
  // against the same library at the same time.
  const SHARED_PORT = 8098;
  const SHARED_PREVIEW = 8097;
  const sharedRoot = "/tmp/pv_shared";
  await rm(sharedRoot, { recursive: true, force: true });
  const seed = async (id: string, title: string) => {
    const dir = join(sharedRoot, "seed", id);
    await mkdir(join(dir, "sce_sys"), { recursive: true });
    await writeFile(join(dir, "sce_sys", "param.json"), JSON.stringify({ titleId: id, titleName: title }));
    await writeFile(join(dir, "eboot.bin"), "x");
    return dir;
  };
  const seedA = await seed("PTST00031", "Remove Me");
  const seedB = await seed("PTST00032", "Build Me");
  // A dump folder of its own, with no package beside it: the shared run must
  // convert, not find a leftover package from the earlier phase.
  const sharedDump = await seed("PTST00001", "Dump On The Console");
  await mkdir(join(sharedRoot, "data"), { recursive: true });
  await writeFile(
    join(sharedRoot, "config.json"),
    JSON.stringify({ port: SHARED_PORT, consoleHost: null, engine: "mock", enginePaths: {}, scanDirs: [] }),
  );

  const sharedApp = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "app", "server.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PV_CONFIG: join(sharedRoot, "config.json"),
      PV_PORT: String(SHARED_PORT),
      PV_DATA: join(sharedRoot, "data"),
      // Hold the console's conversion so both interfaces are writing at once.
      PV_MOCK_HOLD_ID: "PTST00001",
      PV_MOCK_HOLD_MS: "3000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const sharedPreview = Bun.spawn([process.execPath, "run", "tools/preview-console-ui.ts"], {
    env: {
      ...process.env,
      PV_PREVIEW_PORT: String(SHARED_PREVIEW),
      PV_APP_URL: `http://127.0.0.1:${SHARED_PORT}`,
      PV_DEMO: join(sharedRoot, "seed"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    check("the shared app answers", await reach(`http://127.0.0.1:${SHARED_PORT}/api/state`, 15000));
    check("the shared console preview answers", await reach(`http://127.0.0.1:${SHARED_PREVIEW}/`, 15000));

    // The payload's endpoints, pushed at with what a broken client sends. The
    // console page parses JSON from all of them, so a stack page or a bare
    // "Not found" is a defect even though the real UI never sends one.
    const consoleUrl = `http://127.0.0.1:${SHARED_PREVIEW}`;
    const consolePost = (path: string, body: string) =>
      fetch(`${consoleUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const readJson = async (res: Response) => {
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: res.status, text, parsed };
    };
    const [badConvert, numericConvert, unknownConvert] = await Promise.all([
      consolePost("/api/convert", "{oops"),
      consolePost("/api/convert", '{"id":17}'),
      consolePost("/api/convert", '{"id":"NOPE00001"}'),
    ].map((pending) => pending.then(readJson)));
    check(
      "the console refuses a malformed convert with a reason",
      badConvert.status === 400 && badConvert.parsed?.ok === false && Boolean(badConvert.parsed?.message),
      `${badConvert.status} ${badConvert.text.slice(0, 40)}`,
    );
    check("the console refuses a numeric title id", numericConvert.status === 400, String(numericConvert.status));
    check("the console refuses to convert an unknown title", unknownConvert.status === 404, String(unknownConvert.status));

    const badAddress = await readJson(await consolePost("/api/config", '{"mac":5}'));
    check(
      "a wrong-typed console address is a named 400, not a stack page",
      badAddress.status === 400 && badAddress.parsed?.ok === false && !badAddress.text.includes("<"),
      `${badAddress.status} ${badAddress.text.slice(0, 40)}`,
    );
    const unknownConsoleApi = await readJson(await fetch(`${consoleUrl}/api/nope`));
    check(
      "an unknown console endpoint answers in JSON",
      unknownConsoleApi.status === 404 && typeof unknownConsoleApi.parsed?.message === "string",
      `${unknownConsoleApi.status} ${unknownConsoleApi.text.slice(0, 30)}`,
    );
    const wrongConsoleMethod = await fetch(`${consoleUrl}/api/games`, { method: "DELETE" });
    check("a wrong method on the console's game list is refused", wrongConsoleMethod.status === 404, String(wrongConsoleMethod.status));
    const consoleStillAnswers = await readJson(await fetch(`${consoleUrl}/api/games`));
    check(
      "the console list still answers after the hostile calls",
      consoleStillAnswers.status === 200 && Array.isArray(consoleStillAnswers.parsed?.games),
      String(consoleStillAnswers.status),
    );
    // The console stores its Mac's address; a preview starts without one, and a
    // conversion is refused until it is set — as it is on a fresh console.
    await fetch(`http://127.0.0.1:${SHARED_PREVIEW}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mac: `127.0.0.1:${SHARED_PORT}` }),
    });

    await fetch(`http://127.0.0.1:${SHARED_PORT}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { titleId: "PTST00031", title: "Remove Me", path: seedA, kind: "Game folder", size: 0 },
          { titleId: "PTST00032", title: "Build Me", path: seedB, kind: "Game folder", size: 0 },
        ],
      }),
    });

    const dashboard = await openPage(`http://127.0.0.1:${SHARED_PORT}/`);
    const consolePage = await openPage(`http://127.0.0.1:${SHARED_PREVIEW}/`);
    try {
      let dashTiles = 0;
      const dashDeadline = Date.now() + 15000;
      while (Date.now() < dashDeadline) {
        dashTiles = Number(await dashboard.run(`document.querySelectorAll(".tile[data-title]").length`));
        if (dashTiles >= 2) break;
        await sleep(250);
      }
      check("the dashboard lists both seeded titles", dashTiles >= 2, `${dashTiles} tiles`);

      let consoleTiles = 0;
      const consoleDeadline = Date.now() + 15000;
      while (Date.now() < consoleDeadline) {
        consoleTiles = Number(await consolePage.run(`document.querySelectorAll(".tile[data-id]").length`));
        if (consoleTiles > 0) break;
        await sleep(250);
      }
      check("the console UI lists its games", consoleTiles > 0, `${consoleTiles} tiles`);

      // Both panels open first (reads), then both writes go out together.
      await dashboard.run(`document.querySelector('.tile[data-title="PTST00031"]').click()`);
      await consolePage.run(`document.querySelector('[data-id="PTST00001"]').click()`);
      const panelsOpen = async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const ready = await Promise.all([
            dashboard.run(`!!document.querySelector('.drawer [data-action="remove"]')`),
            consolePage.run(`!!document.querySelector('#scrim [data-action="confirmYes"]')`),
          ]);
          if (ready[0] && ready[1]) return true;
          await sleep(150);
        }
        return false;
      };
      check("both interfaces opened their panel for the same title set", await panelsOpen());

      // Remove one title from the dashboard at the same moment the console asks
      // for a conversion that will be held for three seconds.
      await Promise.all([
        dashboard.run(`document.querySelector('.drawer [data-action="remove"]').click()`),
        consolePage.run(
          `[...document.querySelectorAll('#scrim [data-action]')].find((b) => b.dataset.action === "confirmYes").click()`,
        ),
      ]);

      // And queue a second build from the dashboard while the pull is running.
      await sleep(200);
      await dashboard.run(`document.querySelector('.tile[data-title="PTST00032"]').click()`);
      const built32 = await dashboard.run(`(() => {
        const button = document.querySelector('.drawer [data-action="build"]');
        if (!button) return "no build button: " + document.querySelector('.drawer')?.textContent;
        if (button.disabled) return "build disabled: " + document.querySelector('.drawer')?.textContent;
        // Two taps in one tick: the second used to become a second request,
        // which the app refused with 409 and the page showed as a red error
        // right after the success toast.
        button.click();
        button.click();
        return "clicked";
      })()`);
      check("the dashboard's build press reached the drawer", built32 === "clicked", String(built32).slice(0, 80));
      await sleep(600);
      const doubleToast = (await dashboard.run(`(() => {
        const t = document.getElementById('toast');
        return JSON.stringify({ text: t.textContent, cls: t.className, hidden: t.hidden });
      })()`)) as string;
      const toastState = JSON.parse(doubleToast) as { text: string; cls: string; hidden: boolean };
      check(
        "a double press shows no \"already building\" error",
        !/already|busy/i.test(toastState.text) && !/err/.test(toastState.cls),
        doubleToast,
      );

      type SharedGame = { titleId: string; state: string; pkgPath: string | null };
      let final: SharedGame[] = [];
      const settleDeadline = Date.now() + 45000;
      while (Date.now() < settleDeadline) {
        const state = (await (await fetch(`http://127.0.0.1:${SHARED_PORT}/api/state`)).json()) as {
          games: SharedGame[];
        };
        final = state.games;
        const busy = final.some((game) => game.state === "building" || game.state === "installing");
        if (!busy) break;
        await sleep(400);
      }

      const ids = final.map((game) => game.titleId);
      check("nothing was left pending in either interface", ids.length > 0 && final.every((g) => g.state !== "building" && g.state !== "installing"), final.map((g) => `${g.titleId}:${g.state}`).join(" "));
      check("no title was written twice", new Set(ids).size === ids.length, ids.join(" "));
      check("the deleted title is gone", !ids.includes("PTST00031"), ids.join(" "));
      check("the dashboard's build landed", final.find((g) => g.titleId === "PTST00032")?.state === "built", final.find((g) => g.titleId === "PTST00032")?.state);
      const jobSay = (await (await fetch(`http://127.0.0.1:${SHARED_PREVIEW}/api/convert/status`)).json()) as {
        message?: string;
        line?: string;
      };
      const toastSay = String(
        await consolePage.run(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`),
      );
      check(
        "the console's conversion landed",
        final.find((g) => g.titleId === "PTST00001")?.state === "built",
        `${final.find((g) => g.titleId === "PTST00001")?.state} | ${jobSay.message ?? jobSay.line ?? ""} | ${toastSay}`,
      );

      const built = final.filter((game) => game.pkgPath);
      const named = built.every((game) => game.pkgPath!.endsWith(`${game.titleId}.pkg`));
      const present = await Promise.all(built.map((game) => Bun.file(game.pkgPath!).exists()));
      check("every package belongs to the title that lists it", named && present.every(Boolean), `${built.length} packages`);

      const saved = await readFile(join(sharedRoot, "data", "library.json"), "utf8");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(saved);
      } catch {
        parsed = null;
      }
      check("the library file is still whole", Array.isArray(parsed) && (parsed as unknown[]).length === final.length, `${saved.length} bytes`);

      const scratches = await readdir(join(sharedRoot, "data", "tmp")).catch(() => [] as string[]);
      check("no build scratch was left behind", scratches.length === 0, scratches.join(", ") || "clean");

      check(
        "neither page logged an error while both were writing",
        dashboard.errors.length === 0 && consolePage.errors.length === 0,
        [...dashboard.errors, ...consolePage.errors].slice(0, 2).join(" | "),
      );
    } finally {
      dashboard.close();
      consolePage.close();
    }
  } finally {
    sharedApp.kill();
    sharedPreview.kill();
    await rm(sharedRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  ws.close();
} catch (error) {
  check("the flow ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  cleanup();
  await rm(PROFILE, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
