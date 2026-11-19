import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { closeSync, existsSync, openSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { shortSize, type Config } from "./core";

export type EngineId = "mock" | "psviethoa" | "command";
export type Progress = { pct: number; line: string };

export type BuildInput = {
  titleId: string;
  title: string;
  sourcePath: string;
  outDir: string;
  /** "ac" when the source is additional content; passed as {category} */
  category?: string | null;
};

export type EngineStatus = {
  id: EngineId;
  name: string;
  available: boolean;
  detail: string;
  simulated: boolean;
};

function which(bin: string): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  const res = Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "pipe" });
  const out = res.stdout.toString().trim();
  return res.exitCode === 0 && out ? out : null;
}

const PSVIETHOA_BIN = "fpkg-cli";

/**
 * Packers scatter intermediates next to their output: half-written parts, temp
 * files, sometimes a whole scaffolding folder. Those are named so they can be
 * recognised and removed.
 */
const TEMP_SUFFIXES = [".part", ".tmp", ".pkg.tmp", ".partial"];

/** Scratch space where a package is assembled before it is handed over. */
export function stagingRoot(outDir: string): string {
  return join(dirname(outDir), "tmp");
}

export function isTemporary(name: string): boolean {
  return TEMP_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}

/**
 * Removes what builds leave behind, so a packages folder ends up holding
 * packages and nothing else. Only our own temporary names are touched — real
 * .pkg files are never deleted here.
 */
export async function sweepWorkbench(outDir: string): Promise<number> {
  let removed = 0;

  try {
    for (const name of await readdir(outDir, { withFileTypes: true })) {
      if (!isTemporary(name.name) && name.name !== ".staging") continue;
      await rm(join(outDir, name.name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    /* nothing to clean */
  }

  try {
    for (const name of await readdir(stagingRoot(outDir))) {
      await rm(join(stagingRoot(outDir), name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    /* no scratch folder */
  }

  return removed;
}

export function probeEngines(cfg: Config): EngineStatus[] {
  const psviethoaPath = cfg.enginePaths.psviethoa || which(PSVIETHOA_BIN);
  const command = cfg.enginePaths.command?.trim();

  return [
    {
      id: "psviethoa",
      name: "PSVIETHOA FPKG Builder",
      available: Boolean(psviethoaPath),
      detail: psviethoaPath
        ? `fpkg-cli at ${psviethoaPath}`
        : "Not found. Set the fpkg-cli path in Settings, or install PSVIETHOA.",
      simulated: false,
    },
    {
      id: "command",
      name: "Custom command",
      available: Boolean(command),
      detail: command
        ? "Configured. Placeholders: {source} {titleId} {output} {pkg}"
        : "No command configured. Use this for orbis-pub-cmd, LibProsperoPkg or your own packer.",
      simulated: false,
    },
    {
      id: "mock",
      name: "Simulated engine",
      available: true,
      detail: "Moves a placeholder file through the whole pipeline. For trying the app before a real packer is wired up.",
      simulated: true,
    },
  ];
}

export function resolveEngineFrom(statuses: EngineStatus[], cfg: Config): EngineId {
  if (cfg.engine !== "auto") {
    const wanted = statuses.find((s) => s.id === cfg.engine);
    if (wanted?.available) return wanted.id as EngineId;
  }
  for (const id of ["psviethoa", "command", "mock"] as EngineId[]) {
    const found = statuses.find((s) => s.id === id);
    if (found?.available) return found.id;
  }
  return "mock";
}

export function resolveEngine(cfg: Config): EngineId {
  return resolveEngineFrom(probeEngines(cfg), cfg);
}

// Bun.sleep, not setTimeout: a build runs after its HTTP response has been
// sent, and timers created in that request context never fired — every await
// here simply stopped, which is what left builds stuck at "queued".
const sleep = (ms: number) => Bun.sleep(ms);

const MOCK_STEPS = [
  "Inspecting source",
  "Reading param.sfo metadata",
  "Building image",
  "Writing pubtool entry table",
  "Signing as debug package",
  "Verifying output",
];

/**
 * PV_MOCK_HOLD_ID / PV_MOCK_HOLD_MS stall the simulated engine on one title.
 * Nothing sets them outside a test; without them the hold is zero.
 */
async function mockHold(titleId: string): Promise<void> {
  const only = process.env.PV_MOCK_HOLD_ID;
  if (only && only !== titleId) return;
  const ms = Number(process.env.PV_MOCK_HOLD_MS ?? 0);
  if (ms > 0) await sleep(ms);
}

async function writePlaceholderPkg(pkgPath: string, titleId: string): Promise<void> {
  // A placeholder, not a package. The UI marks simulated builds explicitly.
  const header = Buffer.from(
    `PROSPERO-VAULT-SIMULATED-PKG\nthis file is a placeholder produced by the simulated engine\n` +
      `it is not installable and contains no game data\ntitle=${titleId}\n`,
    "utf8",
  );
  const body = Buffer.alloc(1_400_000);
  await Bun.write(pkgPath, Buffer.concat([header, body]));
}

function newestPkg(dir: string, since: number): Promise<string | null> {
  return (async () => {
    let best: { path: string; mtime: number } | null = null;
    try {
      for (const name of await readdir(dir)) {
        if (!name.toLowerCase().endsWith(".pkg")) continue;
        const full = join(dir, name);
        const info = await stat(full);
        if (info.mtimeMs < since - 2000) continue;
        if (!best || info.mtimeMs > best.mtime) best = { path: full, mtime: info.mtimeMs };
      }
    } catch {
      return null;
    }
    return best?.path ?? null;
  })();
}

/**
 * Runs a packer and reports its progress.
 *
 * Output goes to a log file rather than a pipe. Piped stdout deadlocked here:
 * Bun sometimes never closed the streams and sometimes left `proc.exited`
 * pending after they closed, so a build that had actually finished sat at
 * "queued" forever. A file cannot deadlock, survives a long pack, and gives the
 * same lines to parse.
 */
async function runCommand(
  argv: string[],
  shell: boolean,
  onProgress: (p: Progress) => void,
  basePct: number,
  span: number,
): Promise<{ code: number; tail: string[] }> {
  const logPath = join(tmpdir(), `pv-engine-${process.pid}-${Date.now()}.log`);
  // Synchronous on purpose: an awaited open inside the build chain stalled here.
  const sink = openSync(logPath, "w");

  // The exit code goes into its own file, written by a shell that wraps the
  // packer. Neither Bun.spawn nor node:child_process reported the exit of a
  // child here, and a marker in the log was worse: a packer that printed the
  // same string — or a line split across a read window — read as "finished"
  // while it was still writing. Separate files cannot be confused.
  const exitPath = join(tmpdir(), `pv-exit-${process.pid}-${Date.now()}`);
  const command = `"$0" "$@"; printf "%d" "$?" > "$PV_EXIT_FILE"; exit 0`;

  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", command, ...argv], {
      stdio: ["ignore", sink, sink],
      env: { ...process.env, PV_EXIT_FILE: exitPath },
    });
  } catch (error) {
    closeSync(sink);
    await rm(logPath, { force: true });
    await rm(exitPath, { force: true });
    throw new Error(`Could not start the packer: ${error instanceof Error ? error.message : String(error)}`);
  }
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
  });
  const tail: string[] = [];
  let pct = basePct;
  let offset = 0;
  let carry = "";

  /** Reads lines the packer has written since the last look. */
  const drain = async (): Promise<void> => {
    const size = (await stat(logPath)).size;
    if (size <= offset) return;
    // Only the end matters: progress lines and the last words on failure.
    if (size - offset > 512 * 1024) offset = size - 512 * 1024;
    // Read just the new window. Reading the whole log every 200 ms is quadratic
    // in its size, and a packer can log for hours.
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const handle = await open(logPath, "r");
    try {
      await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }
    const text = buffer.toString("utf8");
    offset = size;
    carry += text;

    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      tail.push(line);
      if (tail.length > 200) tail.shift();
      const match = line.match(/(\d{1,3})(?:\.\d+)?\s*%/);
      if (match) {
        const value = Math.min(100, parseInt(match[1], 10));
        pct = basePct + (value / 100) * span;
      }
      onProgress({ pct, line });
    }
  };

  // Six hours: a 100 GB title is a long pack, and an abandoned one is worse
  // than a slow one. Nothing here depends on a promise that may never settle.
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  let code: number | null = null;
  let readFailed = false;
  while (code === null) {
    await sleep(200);
    try {
      await drain();
    } catch (error) {
      // A log being written to is not always readable at that instant — but a
      // permanent failure here would hide the packer's own exit code.
      if (!readFailed) {
        readFailed = true;
        console.error(`[engine] cannot read its log: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const written = (await readFile(exitPath, "utf8")).trim();
      if (/^-?\d+$/.test(written)) code = parseInt(written, 10);
    } catch {
      /* still running */
    }
    if (spawnFailed) {
      code = -1;
      break;
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      code = -1;
      break;
    }
  }

  try {
    await drain();
  } catch {
    /* nothing more to read */
  }
  closeSync(sink);
  await rm(logPath, { force: true });
  await rm(exitPath, { force: true });
  return { code, tail };
}

type EngineResult = { path: string; simulated: boolean; log: string[] };

async function runEngine(
  engine: EngineId,
  work: BuildInput,
  cfg: Config,
  onProgress: (p: Progress) => void,
): Promise<EngineResult> {
  if (engine === "mock") {
    // Test-only hold, so a race (a delete or a second press while a build is in
    // flight) is a guard test instead of a flake on timing.
    await mockHold(work.titleId);
    onProgress({ pct: 4, line: `Source: ${work.sourcePath}` });
    for (let i = 0; i < MOCK_STEPS.length; i++) {
      await sleep(260);
      onProgress({ pct: Math.round(((i + 1) / MOCK_STEPS.length) * 96), line: MOCK_STEPS[i] });
    }
    const pkgPath = join(work.outDir, `${work.titleId}.pkg`);
    await writePlaceholderPkg(pkgPath, work.titleId);
    const size = (await stat(pkgPath)).size;
    onProgress({ pct: 98, line: `Simulated package written (${shortSize(size)}) — not installable` });
    return { path: pkgPath, simulated: true, log: ["simulated engine"] };
  }

  if (engine === "psviethoa") {
    const bin = cfg.enginePaths.psviethoa || PSVIETHOA_BIN;
    const started = Date.now();
    onProgress({ pct: 2, line: `fpkg-cli build --source ${work.sourcePath} --output ${work.outDir}` });
    const { code, tail } = await runCommand(
      [bin, "build", "--source", work.sourcePath, "--output", work.outDir],
      false,
      onProgress,
      4,
      92,
    );
    if (code !== 0) {
      const why = tail.slice(-4).join(" · ") || `exit ${code}`;
      throw new Error(`fpkg-cli failed (${code}): ${why}`);
    }
    const pkgPath = await newestPkg(work.outDir, started);
    if (!pkgPath) throw new Error("fpkg-cli exited 0 but wrote no .pkg in the output folder");
    return { path: pkgPath, simulated: false, log: tail.slice(-40) };
  }

  const template = cfg.enginePaths.command?.trim();
  if (!template) throw new Error("No custom command configured");

  const pkgPath = join(work.outDir, `${work.titleId}.pkg`);
  const script = template
    .replaceAll("{source}", work.sourcePath)
    .replaceAll("{titleId}", work.titleId)
    .replaceAll("{title}", work.title)
    .replaceAll("{output}", work.outDir)
    .replaceAll("{pkg}", pkgPath)
    .replaceAll("{category}", work.category ?? "");

  const started = Date.now();
  onProgress({ pct: 2, line: script });
  const { code, tail } = await runCommand(["/bin/bash", "-lc", script], true, onProgress, 4, 92);
  if (code !== 0) {
    const why = tail.slice(-4).join(" · ") || `exit ${code}`;
    throw new Error(`custom command failed (${code}): ${why}`);
  }

  if (existsSync(pkgPath)) return { path: pkgPath, simulated: false, log: tail.slice(-40) };
  const found = await newestPkg(work.outDir, started);
  if (!found) throw new Error("command exited 0 but produced no .pkg");
  return { path: found, simulated: false, log: tail.slice(-40) };
}

/**
 * Every PS5 container begins with 0x7F — "\x7FCNT" for metadata, "\x7FFIH" for
 * a finalized debug image. A packer that exits 0 having written something else
 * has not produced a package, and the console would be the one to find out.
 */
async function requirePackageMagic(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead >= 4 && head[0] === 0x7f) return;
  } finally {
    await handle.close();
  }
  throw new Error(
    "the packer reported success but its output is not a PS5 package (no 0x7F container header)",
  );
}

async function moveIntoPlace(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    // Different filesystem: fall back to a copy.
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/**
 * Runs a packer in a scratch folder, then hands over the one file that matters
 * and deletes everything else. What lands in outDir is exactly `<titleId>.pkg`
 * — no intermediates, no half-written parts, no second copy.
 */
export async function buildWith(
  engine: EngineId,
  input: BuildInput,
  cfg: Config,
  onProgress: (p: Progress) => void,
): Promise<{ pkgPath: string; simulated: boolean; log: string[] }> {
  const finalPath = join(input.outDir, `${input.titleId}.pkg`);
  const workDir = join(stagingRoot(input.outDir), `${input.titleId}-${Date.now()}`);

  await mkdir(workDir, { recursive: true });
  try {
    const result = await runEngine(engine, { ...input, outDir: workDir }, cfg, onProgress);
    if (!result.simulated) await requirePackageMagic(result.path);
    await moveIntoPlace(result.path, finalPath);
    const size = (await stat(finalPath)).size;
    onProgress({ pct: 100, line: `Package ready: ${finalPath} (${shortSize(size)})` });
    return { pkgPath: finalPath, simulated: result.simulated, log: result.log };
  } finally {
    // Whatever the packer left in the scratch folder goes, pass or fail.
    await rm(workDir, { recursive: true, force: true });
  }
}
