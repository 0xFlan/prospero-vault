/* Prospero Vault — one screen for packaging dumps and feeding the console. */

const S = {
  view: "library",
  games: [],
  engines: [],
  engine: "mock",
  console: { mode: "simulated", connected: false, detail: "" },
  config: { port: 8090, consoleHost: null, engine: "auto", enginePaths: {}, scanDirs: [] },
  lan: "",
  version: "",
  pkgDir: "",
  found: [],
  scanDir: "",
  selected: null,
  progress: {},
  linkDown: false,
};

const VIEW_META = {
  library: { title: "Library", sub: "Everything you own, in one place." },
  forge: { title: "Convert", sub: "Turn a dump into a package." },
  console: { title: "Console", sub: "Where the games actually land." },
  settings: { title: "Settings", sub: "Engines, paths and the console link." },
};

const $ = (sel, root = document) => root.querySelector(sel);
const content = $("#content");
const drawer = $("#drawer");
const scrim = $("#scrim");
const toastEl = $("#toast");

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function size(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function hue(seed) {
  let value = 0;
  for (const ch of String(seed)) value = (value * 31 + ch.charCodeAt(0)) % 360;
  return { h: value, h2: (value + 52) % 360 };
}

function initials(title) {
  const words = String(title || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.className = "toast" + (isError ? " err" : "");
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4200);
}

// The app answers in milliseconds. A request that has not answered in fifteen
// seconds is not going to, and waiting on it forever left the window looking
// alive while nothing in it could update.
function within(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            message || "The app did not answer in time. It may be busy or stopped — check that it is running, then reload this page.",
          ),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function api(method, path, payload, timeoutMs = 15000) {
  // The timeout has to reach the socket. Rejecting the promise while the
  // request stays open left a stuck app collecting one dead connection per
  // poll, until the browser's own limit made every later request queue.
  const control = new AbortController();
  const work = (async () => {
    let res;
    try {
      res = await fetch(path, {
        method,
        signal: control.signal,
        headers: payload ? { "content-type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch {
      // "Failed to fetch" is the browser's wording, and it tells a person
      // nothing about what happened or what to do next.
      throw new Error("Cannot reach the app. It may have stopped — reload this page once it is running.");
    }
    const text = await res.text();
    let data = null;
    let parsed = true;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
      data = null;
    }
    if (!res.ok) {
      const reason = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      throw new Error(reason);
    }
    // A 200 that is not this app's JSON is not a state. Handing it back used to
    // paint undefined fields and surface a raw
    // "Cannot read properties of undefined (reading 'mode')". Say what happened.
    if (!parsed || !data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(
        "The app answered something that could not be read. Check that it is running the same version, then reload.",
      );
    }
    return data;
  })();
  return within(work, timeoutMs).catch((error) => {
    control.abort();
    throw error;
  });
}

const CHIP_LABEL = {
  dumped: "Dump",
  building: "Building",
  built: "Packaged",
  installing: "Sending",
  installed: "On PS5",
  error: "Error",
};

/* ------------------------------------------------------------------ */
/* load + render                                                      */
/* ------------------------------------------------------------------ */

async function refresh() {
  if (refresh.busy) return; // one refresh at a time, whatever asked for it
  refresh.busy = true;
  try {
    const state = await api("GET", "/api/state");
    // Even a well-formed object is checked field by field: a missing console or
    // games list used to reach the renderer and throw there, outside this catch.
    S.games = Array.isArray(state.games) ? state.games : [];
    S.engines = Array.isArray(state.engines) ? state.engines : [];
    S.engine = state.engine ?? S.engine;
    S.console =
      state.console && typeof state.console === "object"
        ? state.console
        : { connected: false, mode: "offline", detail: "No console configured" };
    S.config = state.config && typeof state.config === "object" ? state.config : S.config;
    S.configProblem = state.configProblem || null;
    S.libraryProblem = state.libraryProblem || null;
    S.dataProblem = state.dataProblem || null;
    S.saveProblem = state.saveProblem || null;
    S.lan = state.lan;
    S.version = state.version;
    S.pkgDir = state.pkgDir;
    render();
    if (!drawer.hidden && S.selected) paintDrawer();
    if (S.linkDown) {
      S.linkDown = false;
      toast("Reconnected to the app");
    }
  } catch (error) {
    // Once per outage, not once per poll: a toast every few seconds hides the
    // very message it is repeating.
    if (!S.linkDown) {
      S.linkDown = true;
      toast(error.message, true);
    }
    // A toast fades; the list does not. Without this the page keeps showing a
    // stale set of titles that looks exactly like a live one.
    renderPills();
  } finally {
    refresh.busy = false;
  }
}

function render() {
  const meta = VIEW_META[S.view];
  $("#viewTitle").textContent = meta.title;
  $("#viewSub").textContent = meta.sub;
  $("#railVersion").textContent = `v${S.version}`;
  $("#lanHint").textContent = S.lan ? `PS5: ${S.lan}` : "";

  document.querySelectorAll(".nav").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === S.view);
  });

  renderPills();
  content.innerHTML = VIEWS[S.view]();
  content.scrollTop = 0;
}

function renderPills() {
  const engineName =
    S.engine === "mock" ? "Simulated engine" : S.engine === "psviethoa" ? "fpkg-cli" : "Custom command";
  const consoleOn = S.console.mode === "payload" && S.console.connected;
  const consoleLabel = consoleOn ? "Console linked" : S.console.mode === "simulated" ? "No console" : "Console offline";

  const stale = S.linkDown ? '<span class="pill"><span class="dot err"></span>Not updating</span>' : "";
  const settings = S.configProblem
    ? `<span class="pill" title="${esc(S.configProblem)}"><span class="dot warn"></span>Settings not read</span>`
    : "";
  const library = S.libraryProblem
    ? `<span class="pill" title="${esc(S.libraryProblem)}"><span class="dot err"></span>Library not read</span>`
    : "";
  const storage = S.dataProblem
    ? `<span class="pill" title="${esc(S.dataProblem)}"><span class="dot err"></span>Nothing can be saved</span>`
    : S.saveProblem
      ? `<span class="pill" title="${esc(S.saveProblem)}"><span class="dot err"></span>Library not saved</span>`
      : "";

  $("#pills").innerHTML = `
    ${stale}${settings}${library}${storage}
    <span class="pill"><span class="dot ${S.engine === "mock" ? "warn" : "accent"}"></span>${esc(engineName)}</span>
    <span class="pill"><span class="dot ${consoleOn ? "ok" : S.console.mode === "offline" ? "err" : "warn"}"></span>${esc(consoleLabel)}</span>
    <span class="pill">${S.games.length} title${S.games.length === 1 ? "" : "s"}</span>`;
}

/* ------------------------------------------------------------------ */
/* views                                                              */
/* ------------------------------------------------------------------ */

function tile(g) {
  const { h, h2 } = hue(g.titleId);
  const cover = g.hasIcon
    ? `<img src="/api/icon/${encodeURIComponent(g.titleId)}" alt="" onerror="this.remove()">`
    : `<span class="initials">${esc(initials(g.title))}</span>`;
  const chip =
    g.simulated && g.state === "built"
      ? `<span class="chip simulated">Simulated</span>`
      : `<span class="chip ${g.state}">${esc(CHIP_LABEL[g.state] || g.state)}</span>`;

  return `
    <button class="tile" data-focus data-title="${esc(g.titleId)}">
      <div class="cover" style="--h:${h};--h2:${h2}">${cover}${chip}</div>
      <div class="tile-text">
        <b>${esc(g.title)}</b>
        <span>${esc(g.titleId)}${g.pkgSize ? " · " + esc(size(g.pkgSize)) : g.sizeBytes ? " · " + esc(size(g.sizeBytes)) : ""}</span>
      </div>
    </button>`;
}

function viewLibrary() {
  if (!S.games.length) {
    // A first run used to say "open Forge" and stop there. Three steps, in the
    // order a person actually does them, and the console's state in context.
    const linked = S.console.mode === "payload" && S.console.connected;
    return `<div class="empty">
      <b>Three steps to a game on your PS5</b>
      <span>1. Open <strong>Forge</strong>, type the folder that holds your dumps, and press <strong>Scan</strong>.</span>
      <span>2. Add the game, open it, and press <strong>Build package</strong>.</span>
      <span>3. Press <strong>Send to PS5</strong>. It installs there and appears in your library.</span>
      <span class="meta">${linked ? "Console linked — the last step is ready." : "No console linked yet: open Console, paste the payload address, then Save."}</span>
    </div>`;
  }
  return `<div class="grid">${S.games.map(tile).join("")}</div>`;
}

function viewForge() {
  const quick = (S.config.scanDirs || []).map(
    (dir) => `<button class="tag" data-path="${esc(dir)}">${esc(dir)}</button>`,
  );

  const results = S.found.length
    ? `<div class="section-title">Found ${S.found.length}</div>
       <div class="list">${S.found
         .map(
           (item) => `
        <div class="item">
          <div class="grow">
            <div class="name">${esc(item.title)}</div>
            <div class="meta">${esc(item.kind)} · ${esc(size(item.size))} · ${esc(item.path)}</div>
          </div>
          ${
            item.inLibrary
              ? `<span class="pill"><span class="dot ok"></span>In library</span>`
              : item.retailPkg
                ? `<span class="pill"><span class="dot err"></span>Retail .pkg</span>`
                : `<button class="btn" data-add="${esc(item.titleId)}">Add</button>`
          }
        </div>`,
         )
         .join("")}</div>`
    : "";

  const busy = S.games.filter((g) => g.state === "building" || g.state === "installing");
  const queue = busy.length
    ? `<div class="section-title">Working</div>
       <div class="list">${busy
         .map((g) => {
           const p = S.progress[g.titleId] || { pct: 0, line: "Starting…" };
           return `<div class="item" style="flex-direction:column;align-items:stretch">
             <div class="row" style="justify-content:space-between">
               <span class="name">${esc(g.title)}</span>
               <span class="meta">${esc(g.state === "installing" ? "Sending to console" : `${p.pct}%`)}</span>
             </div>
             <div class="bar"><i data-bed="${esc(g.titleId)}" style="width:${p.pct}%"></i></div>
             <div class="meta" data-line="${esc(g.titleId)}" style="margin-top:7px">${esc(p.line)}</div>
           </div>`;
         })
         .join("")}</div>`
    : "";

  const ready = S.games.filter((g) => g.state === "built" || g.state === "error");
  const readyList = ready.length
    ? `<div class="section-title">Needs a hand</div>
       <div class="list">${ready
         .map(
           (g) => `
        <div class="item">
          <div class="grow">
            <div class="name">${esc(g.title)}</div>
            <div class="meta">${esc(g.note || (g.state === "built" ? "Packaged and ready" : "Failed"))}</div>
          </div>
          <button class="btn" data-title="${esc(g.titleId)}">Open</button>
        </div>`,
         )
         .join("")}</div>`
    : "";

  return `
    <section class="panel">
      <h2>Find a dump</h2>
      <p class="hint">Point this at a folder holding a game folder (<code>PPSA00000</code>), an <code>.exfat</code>, <code>.ffpfsc</code>, <code>.ffpfs</code>, <code>.ffpkg</code> or <code>.gp5</code>. Retail <code>.pkg</code> files cannot be re-signed by any packer here.</p>
      <div class="row">
        <input type="text" id="scanDir" data-focus placeholder="/Users/you/Downloads/games" value="${esc(S.scanDir)}">
        <button class="btn primary" id="scanBtn" data-focus>Scan</button>
      </div>
      <div class="quick">${quick.join("")}</div>
    </section>
    ${results}
    ${queue}
    ${readyList}`;
}

function viewConsole() {
  const c = S.console;
  const linked = c.mode === "payload" && c.connected;
  const installed = S.games.filter((g) => g.state === "installed");

  const installedList = installed.length
    ? `<div class="list">${installed
        .map(
          (g) => `
        <div class="item">
          <div class="grow">
            <div class="name">${esc(g.title)}</div>
            <div class="meta">${esc(g.titleId)} · ${esc(size(g.pkgSize))}${g.consoleLabel ? " · " + esc(g.consoleLabel) : ""}</div>
          </div>
          <span class="pill"><span class="dot ok"></span>Installed</span>
        </div>`,
        )
        .join("")}</div>`
    : `<div class="empty"><b>Nothing installed yet</b><span>Package a game, then use Send to PS5 from its card.</span></div>`;

  return `
    <section class="panel">
      <h2>Connection</h2>
      <p class="hint">The payload is a small ELF that listens on port 8097 and accepts one package at a time. Load it with your usual elfldr over port 9021, then point this at the console.</p>
      <div class="row">
        <input type="text" id="consoleHost" data-focus placeholder="http://192.168.1.50:8097" value="${esc(c.host || S.config.consoleHost || "")}">
        <button class="btn primary" id="saveConsole" data-focus>Save</button>
        <button class="btn" id="testConsole" data-focus>Test</button>
      </div>
      <div class="quick">
        <span class="pill"><span class="dot ${linked ? "ok" : c.mode === "offline" ? "err" : "warn"}"></span>${esc(c.detail || "No console configured")}</span>
        ${c.version ? `<span class="pill">payload ${esc(c.version)}</span>` : ""}
        ${c.freeLabel ? `<span class="pill">free ${esc(c.freeLabel)}</span>` : ""}
      </div>
      ${(() => {
        const host = String(c.host || S.config.consoleHost || "")
          .replace(/^https?:\/\//, "")
          .split("/")[0];
        const ip = host.split(":")[0];
        if (!ip) return "";
        const command = `nc -w 3 ${ip} 9021 < prospero-vault.elf`;
        return `<div class="note" style="margin-top:12px">
          <b>Send the payload</b>
          <div class="meta" style="margin:6px 0 10px">From the folder holding the ELF, after kstuff is loaded:</div>
          <code>${esc(command)}</code>
          <button class="btn" id="copySend" data-send="${esc(command)}">Copy command</button>
        </div>`;
      })()}
    </section>

    <div class="section-title">Installed</div>
    ${installedList}

    <div class="section-title">Storage layout</div>
    <section class="panel">
      <dl class="kv">
        <dt>Packages</dt><dd>${esc(S.pkgDir || "data/pkg")}</dd>
        <dt>LAN address</dt><dd>${esc(S.lan)}</dd>
        <dt>Console pull</dt><dd>${esc(S.lan)}/api/pkg/&lt;TITLE_ID&gt;</dd>
      </dl>
    </section>`;
}

function viewSettings() {
  const engineOption = (id, name, available, detail) => `
    <label class="item" style="cursor:pointer">
      <input type="radio" name="engine" value="${esc(id)}" data-focus ${S.config.engine === id ? "checked" : ""}>
      <div class="grow">
        <div class="name">${esc(name)}</div>
        <div class="meta">${esc(detail)}</div>
      </div>
      <span class="pill"><span class="dot ${available ? "ok" : "warn"}"></span>${available ? "Ready" : "Not set up"}</span>
    </label>`;

  const options = [
    engineOption("auto", "Automatic", true, "Use the first packer that is actually available."),
    ...S.engines.map((e) => engineOption(e.id, e.name, e.available, e.detail)),
  ].join("");

  return `
    <section class="panel">
      <h2>Packaging engine</h2>
      <p class="hint">This app drives a packer; it does not ship one. PSVIETHOA's <code>fpkg-cli</code> is the straightforward option. The custom command slot takes anything else — <code>orbis-pub-cmd</code> under Wine, <code>LibProsperoPkg</code>, a script.</p>
      <div class="list" style="margin-top:12px">${options}</div>
      <div class="row" style="margin-top:18px">
        <input type="text" id="psviethoaPath" data-focus placeholder="/Applications/fpkg-cli" value="${esc(S.config.enginePaths.psviethoa || "")}">
      </div>
      <div class="row" style="margin-top:10px">
        <textarea id="customCommand" data-focus placeholder='fpkg-cli build --source "{source}" --output "{output}"'>${esc(S.config.enginePaths.command || "")}</textarea>
      </div>
    </section>

    <section class="panel">
      <h2>Scan folders</h2>
      <p class="hint">One path per line. These appear as shortcuts in Forge.</p>
      <div class="row">
        <textarea id="scanDirs" data-focus>${esc((S.config.scanDirs || []).join("\n"))}</textarea>
      </div>
    </section>

    <div class="row">
      <button class="btn primary" id="saveSettings" data-focus>Save settings</button>
      <span class="pill">port ${esc(S.config.port)}</span>
    </div>`;
}

const VIEWS = {
  library: viewLibrary,
  forge: viewForge,
  console: viewConsole,
  settings: viewSettings,
};

/* ------------------------------------------------------------------ */
/* drawer                                                             */
/* ------------------------------------------------------------------ */

function openDrawer(titleId) {
  S.selected = titleId;
  drawer.hidden = false;
  scrim.hidden = false;
  paintDrawer();
  const first = drawer.querySelector("[data-action]");
  if (first) first.focus();
}

function closeDrawer() {
  drawer.hidden = true;
  scrim.hidden = true;
  S.selected = null;
}

function paintDrawer() {
  const g = S.games.find((item) => item.titleId === S.selected);
  if (!g) {
    closeDrawer();
    return;
  }
  const { h, h2 } = hue(g.titleId);
  const progress = S.progress[g.titleId];
  const cover = g.hasIcon
    ? `<img src="/api/icon/${encodeURIComponent(g.titleId)}" alt="" onerror="this.remove()">`
    : `<span class="initials" style="font-size:2.6rem">${esc(initials(g.title))}</span>`;

  const busy = g.state === "building" || g.state === "installing";

  drawer.innerHTML = `
    <div class="cover" style="--h:${h};--h2:${h2}">${cover}</div>
    <h2>${esc(g.title)}</h2>
    <div class="sub">${esc(g.titleId)} · ${esc(g.sourceKind)} · ${esc(size(g.sizeBytes))}</div>

    ${
      busy
        ? `<div class="bar"><i data-bed="${esc(g.titleId)}" style="width:${progress ? progress.pct : 0}%"></i></div>
           <div class="meta" data-line="${esc(g.titleId)}" style="margin-top:8px">${esc(progress ? progress.line : "Working…")}</div>`
        : ""
    }

    ${g.note ? `<div class="note ${g.state === "error" ? "error" : ""}">${esc(g.note)}</div>` : ""}

    <dl class="kv" style="margin-top:18px">
      <dt>Source</dt><dd>${esc(g.sourcePath || "—")}</dd>
      <dt>Package</dt><dd>${esc(g.pkgPath || "not built")}</dd>
      <dt>Size</dt><dd>${g.pkgSize ? esc(size(g.pkgSize)) : "—"}</dd>
      <dt>Engine</dt><dd>${esc(g.engine || "—")}</dd>
    </dl>

    <div class="actions">
      <button class="btn primary" data-action="build" data-title="${esc(g.titleId)}" data-focus ${busy || g.sourceKind === "PKG" ? "disabled" : ""}>
        ${g.pkgPath ? "Rebuild package" : "Build package"}
      </button>
      <button class="btn" data-action="deploy" data-title="${esc(g.titleId)}" data-focus ${!g.pkgPath || busy ? "disabled" : ""}>
        Send to PS5
      </button>
      <button class="btn" data-action="reveal" data-title="${esc(g.titleId)}" data-focus>Copy package path</button>
      <button class="btn ghost danger" data-action="remove" data-title="${esc(g.titleId)}" data-focus>Remove from library</button>
      <button class="btn ghost" data-action="close" data-focus>Close</button>
    </div>`;
}

function paintProgress(titleId, pct, line) {
  document.querySelectorAll(`[data-bed="${titleId}"]`).forEach((bar) => {
    bar.style.width = `${pct}%`;
  });
  document.querySelectorAll(`[data-line="${titleId}"]`).forEach((node) => {
    node.textContent = line;
  });
}

/* ------------------------------------------------------------------ */
/* actions                                                            */
/* ------------------------------------------------------------------ */

// A second tap on the same card while the first is still in the air used to
// fire a second request, which the app refused with 409 — a red "already being
// built" error right after a success. One press per action, plus a short
// cooldown so the tap that lands before the redraw is swallowed too.
const inFlight = new Set();
const lastPressed = new Map();
function once(key, cooldownMs = 1200) {
  const now = Date.now();
  if (inFlight.has(key)) return false;
  if (now - (lastPressed.get(key) || 0) < cooldownMs) return false;
  inFlight.add(key);
  lastPressed.set(key, now);
  return true;
}
function done(key) {
  inFlight.delete(key);
}

async function doBuild(titleId) {
  if (!once(`build:${titleId}`)) return;
  try {
    const result = await api("POST", "/api/build", { titleId });
    toast(`Building with ${result.engine}…`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    done(`build:${titleId}`);
  }
}

async function doDeploy(titleId) {
  if (!once(`deploy:${titleId}`)) return;
  try {
    closeDrawer();
    toast("Sending package to the console…");
    const result = await api("POST", "/api/deploy", { titleId });
    toast(result.detail, !result.ok);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    done(`deploy:${titleId}`);
  }
}

async function doRemove(titleId) {
  if (!once(`remove:${titleId}`, 2000)) return;
  try {
    await api("DELETE", `/api/game/${encodeURIComponent(titleId)}`);
    closeDrawer();
    toast("Removed from library");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    done(`remove:${titleId}`);
  }
}

async function doScan(dir) {
  if (!once("scan", 800)) return;
  const target = (dir || $("#scanDir")?.value || "").trim();
  if (!target) {
    toast("Enter a folder first", true);
    return;
  }
  S.scanDir = target;
  try {
    const result = await api("POST", "/api/scan", { dir: target });
    S.found = result.found;
    render();
    toast(result.found.length ? `Found ${result.found.length}` : "Nothing packageable in there", !result.found.length);
  } catch (error) {
    toast(error.message, true);
  } finally {
    done("scan");
  }
}

async function doAdd(titleId) {
  const item = S.found.find((f) => f.titleId === titleId);
  if (!item) return;
  try {
    await api("POST", "/api/import", { items: [item] });
    S.found = S.found.map((f) => (f.titleId === titleId ? { ...f, inLibrary: true } : f));
    toast(`Added ${item.title}`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveSettings(payload) {
  if (!once("settings", 600)) return;
  try {
    await api("POST", "/api/settings", payload);
    await refresh();
    toast("Saved");
  } catch (error) {
    toast(error.message, true);
  } finally {
    done("settings");
  }
}

/* ------------------------------------------------------------------ */
/* wiring                                                             */
/* ------------------------------------------------------------------ */

document.addEventListener("click", (event) => {
  const target = event.target;

  const nav = target.closest(".nav");
  if (nav) {
    S.view = nav.dataset.view;
    render();
    const first = content.querySelector("[data-focus]");
    if (first) first.focus();
    return;
  }

  const tag = target.closest(".tag");
  if (tag) {
    doScan(tag.dataset.path);
    return;
  }

  const add = target.closest("[data-add]");
  if (add) {
    doAdd(add.dataset.add);
    return;
  }

  if (target.closest("#scanBtn")) {
    doScan();
    return;
  }

  const copySend = target.closest("#copySend");
  if (copySend) {
    const command = copySend.dataset.send || "";
    if (navigator.clipboard && command) {
      navigator.clipboard.writeText(command).then(
        () => toast("Command copied"),
        () => toast(command),
      );
    }
    return;
  }

  if (target.closest("#saveConsole")) {
    saveSettings({ consoleHost: $("#consoleHost").value.trim() || null });
    return;
  }

  if (target.closest("#testConsole")) {
    saveSettings({ consoleHost: $("#consoleHost").value.trim() || null });
    return;
  }

  if (target.closest("#saveSettings")) {
    const engine = document.querySelector('input[name="engine"]:checked');
    saveSettings({
      engine: engine ? engine.value : "auto",
      enginePaths: {
        psviethoa: $("#psviethoaPath").value.trim(),
        command: $("#customCommand").value.trim(),
      },
      scanDirs: $("#scanDirs")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
    return;
  }

  const tileBtn = target.closest(".tile[data-title]");
  if (tileBtn) {
    openDrawer(tileBtn.dataset.title);
    return;
  }

  const open = target.closest(".item .btn[data-title]");
  if (open) {
    openDrawer(open.dataset.title);
    return;
  }

  const action = target.closest("[data-action]");
  if (action) {
    const titleId = action.dataset.title;
    if (action.dataset.action === "build") doBuild(titleId);
    else if (action.dataset.action === "deploy") doDeploy(titleId);
    else if (action.dataset.action === "remove") doRemove(titleId);
    else if (action.dataset.action === "close") closeDrawer();
    else if (action.dataset.action === "reveal") {
      const g = S.games.find((item) => item.titleId === titleId);
      if (g && g.pkgPath && navigator.clipboard) {
        navigator.clipboard.writeText(g.pkgPath).then(
          () => toast("Package path copied"),
          () => toast(g.pkgPath),
        );
      }
    }
    return;
  }

  if (target.id === "scrim" || target.closest("#scrim")) closeDrawer();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !drawer.hidden) {
    closeDrawer();
    return;
  }
  const map = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" };
  const direction = map[event.key];
  if (!direction) return;
  if (event.target.matches("input, textarea, select")) return;
  event.preventDefault();
  moveFocus(direction);
});

function moveFocus(direction) {
  const elements = Array.from(document.querySelectorAll("[data-focus]")).filter(
    (node) => node.offsetParent !== null && !node.disabled,
  );
  if (!elements.length) return;
  const current = document.activeElement;
  if (!current || !elements.includes(current)) {
    elements[0].focus();
    return;
  }
  const base = current.getBoundingClientRect();
  const cx = base.left + base.width / 2;
  const cy = base.top + base.height / 2;

  let best = null;
  let bestScore = Infinity;
  for (const node of elements) {
    if (node === current) continue;
    const box = node.getBoundingClientRect();
    const dx = box.left + box.width / 2 - cx;
    const dy = box.top + box.height / 2 - cy;
    const horizontal = direction === "left" || direction === "right";
    const forward = horizontal ? (direction === "right" ? dx > 10 : dx < -10) : direction === "down" ? dy > 10 : dy < -10;
    if (!forward) continue;
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
    const secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  (best || elements[0]).focus();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "progress") {
      S.progress[message.titleId] = { pct: message.pct, line: message.line };
      paintProgress(message.titleId, message.pct, message.line);
    } else if (message.type === "state") {
      clearTimeout(connectEvents.timer);
      connectEvents.timer = setTimeout(refresh, 220);
    }
  };
  // A reconnect after the app restarted has missed every event in between, so
  // the page resyncs on open rather than trusting the stream to be complete.
  source.onopen = () => {
    refresh();
  };
  source.onerror = () => {
    /* EventSource reconnects on its own */
  };
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

if (/PlayStation/i.test(navigator.userAgent)) document.body.classList.add("couch");

(async function boot() {
  await refresh();
  connectEvents();
  // The stream is the fast path; this is the one that notices a stream that
  // died without saying so, which otherwise left a page showing stale titles.
  // The interval is injectable so the browser check can drive this path
  // without waiting forty-five seconds for it.
  const sweepMs = Number(window.PV_SWEEP_MS) > 0 ? Number(window.PV_SWEEP_MS) : 45000;
  setInterval(() => {
    if (!document.hidden) refresh();
  }, sweepMs);
})();
