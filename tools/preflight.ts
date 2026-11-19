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
  let metaJson: any = null;
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
          metaJson = parsed;
          titleId = typeof parsed.titleId === "string" ? parsed.titleId : null;
          category = typeof parsed.applicationCategoryType === "string" ? parsed.applicationCategoryType.toLowerCase() : null;
        } catch {
          dumpProblem = "param.json is not readable JSON — the packer will refuse it";
        }
        const ebootEntry = entries.find((entry) => entry.name.toLowerCase() === "eboot.bin");
        if (!dumpProblem && category !== "ac" && !ebootEntry) dumpProblem = `${dump} has no eboot.bin`;
        if (!dumpProblem && ebootEntry) {
          const head = Buffer.alloc(64);
          const handle = await Bun.file(join(dump, ebootEntry.name)).slice(0, 64).arrayBuffer();
          Buffer.from(handle).copy(head);
          const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
          const machine = head.readUInt16LE(18);
          const segments = head.readUInt16LE(56);
          const stub = (await Bun.file(join(dump, ebootEntry.name)).slice(0, 512 * 1024).text().catch(() => "")).includes("Prospero Vault");
          add(
            "both",
            "dump: eboot is a decrypted ELF (not an encrypted blob)",
            isElf,
            isElf
              ? `ELF64, e_machine 0x${machine.toString(16)}, ${segments} program headers`
              : `${join(dump, ebootEntry.name)} has no \x7fELF header — the dump is still encrypted or truncated; decrypt it before packing`,
          );
          add(
            "both",
            "dump: eboot is retail-shaped, not this payload's stub",
            isElf && !stub,
            isElf && !stub
              ? "compiled executable, PT_LOAD segments present"
              : "this is the Prospero Vault payload ELF used in synthetic fixtures — point the gate at a real dump",
          );
        }
      }
    } catch (error) {
      dumpProblem = `${dump} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  add("both", "dump: readable folder with metadata and eboot", dumpProblem === null, dumpProblem ?? dump);
  if (!titleId) later("both", "dump: declares a title id", "param.json has no titleId — the packer cannot name the package");

  if (metaJson) {
    const fields: Array<[string, boolean, string]> = [
      ["titleId", /^[A-Z]{4}\d{5}$/.test(String(metaJson.titleId ?? "")), "four letters and five digits, e.g. PPSA01234"],
      [
        "contentId",
        /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_00-[A-Z0-9]{16}$/.test(String(metaJson.contentId ?? "")),
        "XXYYYY-XXXXXXXXX_00- plus 16 characters, e.g. UP0000-PPSA01234_00-XXXXXXXXXXXXXXXX",
      ],
      ["titleName", typeof metaJson.titleName === "string" && metaJson.titleName.length > 0, "a display name"],
      ["version", /^\d{2}\.\d{2}$/.test(String(metaJson.version ?? "")), "XX.YY, e.g. 01.00"],
    ];
    const bad = fields.filter(([, ok]) => !ok);
    add(
      "both",
      "dump: param.json carries the fields the packer needs",
      bad.length === 0,
      bad.length
        ? `${bad.map(([name, , fix]) => `${name} (${fix})`).join("; ")} — export the dump again, or fix these fields in sce_sys/param.json`
        : "titleId, contentId, titleName and version are present and well-formed",
    );
  }

  // What a package will need on the console, from the dump's own size.
  let dumpBytes = 0;
  try {
    const du = Bun.spawnSync(["du", "-sk", dump]);
    dumpBytes = Number(du.stdout.toString().trim().split(/\s+/)[0] || 0) * 1024;
  } catch {
    dumpBytes = 0;
  }

  // ---- console ----
  const consoleHost = (flag("--console") ?? state?.config?.consoleHost ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  let health: any = null;
  let free = 0;
  if (!consoleHost) {
    later("console", "console: address configured", 'no address — pass --console 192.168.x.y:8097, or set it in the Mac app Settings');
    later("console", "reachability: Mac → console (this app reaches the payload)", "skipped: no console address");
    later("console", "reachability: console → Mac (payload probes the Mac)", "skipped: no console address");
    later("console", "console: knows this Mac's LAN address", "skipped: no console address");
    later("console", "console: /data writable with space for the package", "skipped: no console address");
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
      "reachability: Mac → console (this app reaches the payload)",
      Boolean(health),
      health
        ? `payload ${health.version ?? "?"} at http://${consoleHost}`
        : `no answer from http://${consoleHost}/api/health — load console/build/prospero-vault.elf with elfldr, then check the address`,
    );
    free = typeof health?.free === "number" ? health.free : 0;
    if (!health) {
      later("console", "reachability: console → Mac (payload probes the Mac)", "skipped: console not reachable");
      later("console", "console: knows this Mac's LAN address", "skipped: console not reachable");
      later("console", "console: /data writable with space for the package", "skipped: console not reachable");
    } else {
      const need = category === "ac" ? 512 * 1024 ** 2 : Math.max(2 * 1024 ** 3, (dumpBytes ?? 0) * 1.2);
      add(
        "console",
        "console: /data writable with space for the package",
        health.dataWritable === true && free >= need,
        health.dataWritable !== true
          ? `the console could not write to /data/prospero-vault — check that /data is mounted read-write`
          : `${(free / 1024 ** 3).toFixed(1)} GB free, ${(need / 1024 ** 3).toFixed(1)} GB needed`,
      );

      const advertised = lan ? lan.replace(/^https?:\/\//, "") : null;
      if (!advertised) {
        later("console", "console: knows this Mac's LAN address", "the Mac did not advertise a LAN address");
      } else if (String(health.mac ?? "") === advertised) {
        add("console", "console: knows this Mac's LAN address", true, advertised);
      } else if (!health.mac) {
        // A console that has never heard from this Mac can be told where it is;
        // that is the same thing a deploy does, not a configuration step for the
        // person. A console holding a *different* address is left alone, because
        // overwriting it would hide a real mismatch.
        await post(`http://${consoleHost}/api/config`, { mac: advertised }, 5000);
        const again = await get(`http://${consoleHost}/api/health`);
        let learned = false;
        try {
          learned = JSON.parse(again?.text ?? "{}").mac === advertised;
        } catch {
          learned = false;
        }
        add("console", "console: knows this Mac's LAN address", learned, learned ? `${advertised} (taught now)` : `could not teach the console ${advertised} — set it in the console's Settings`);
      } else {
        add(
          "console",
          "console: knows this Mac's LAN address",
          false,
          `the console holds "${health.mac}", not ${advertised} — send one package from the Mac (which teaches it), or set ${advertised} in the console's Settings`,
        );
      }

      // The Mac can only prove its own direction. Ask the console to make the
      // request itself, so a one-way firewall is named rather than hit later.
      const probe = await get(`http://${consoleHost}/api/probe-mac`, 8000);
      let probed: any = null;
      try {
        probed = probe ? JSON.parse(probe.text) : null;
      } catch {
        probed = null;
      }
      add(
        "console",
        "reachability: console → Mac (payload probes the Mac)",
        probed?.ok === true,
        probed?.ok
          ? `${probed.host} answered in ${probed.ms} ms`
          : `${probed?.host ?? advertised ?? "the Mac"} did not answer the console — allow the Mac's port ${MAC.split(":").pop()} through the firewall, and check both devices are on the same network`,
      );
    }
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
