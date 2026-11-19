import { dirname, join } from "node:path";
import { mkdir, open, readFile, rm, stat, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseSfo } from "./core";

/**
 * Pulls a source off the console so the packer can run on it here.
 *
 * Two shapes matter, because they are packed differently:
 *   - a dump folder  → every file, walked and streamed;
 *   - a disc image   → one enormous file, which fpkg-cli can pack directly
 *                      without extracting it first.
 *
 * Both resume: a 60 GB image that restarts because Wi-Fi blinked is not a
 * transfer anyone will finish twice.
 */

export const PULL_ROOT = join(process.cwd(), "data", "pulled");
const CONCURRENCY = 4;
/** A dropped packet should cost a retry, not a 60 GB pull. */
const ATTEMPTS = 3;
/** Headroom so a pull cannot fill the disk the package is about to be written to. */
const SPACE_MARGIN = 2 * 1024 * 1024 * 1024;

export type PullProgress = (pct: number, line: string) => void;

export type PullResult =
  | {
      ok: true;
      path: string;
      title: string;
      bytes: number;
      files: number;
      hasIcon: boolean;
      kind: "dump" | "image";
      /** "ac" for additional content, taken from the source's own param.json */
      category: string | null;
    }
  | { ok: false; detail: string };

type SourceInfo = { kind?: string; file?: string; size?: number };
type Tree = { files?: Array<{ p?: string; s?: number }>; bytes?: number; truncated?: boolean };

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;
const gb = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return Number(info.bfree) * Number(info.bsize);
  } catch {
    return null;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** A path from the console is untrusted: no absolute paths, no climbing out. */
function safeRelative(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return !path.split("/").includes("..");
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Fetches one URL into a file, continuing what is already on disk when the
 * console answers 206. A host that ignores Range answers 200 with the whole
 * file, and that starts over rather than appending a duplicate.
 */
type FetchOutcome = { ok: true } | { ok: false; detail: string; retryable?: boolean };

/**
 * No bytes for this long means the link died, rather than being slow.
 * PV_STALL_MS exists so a test can reach this watchdog in under two minutes.
 */
const STALL_MS = Number(process.env.PV_STALL_MS ?? 0) || 90_000;

async function fetchOnce(
  url: string,
  target: string,
  expected: number,
  onBytes: (count: number) => void,
): Promise<FetchOutcome> {
  let have = await sizeOf(target);
  if (expected > 0 && have > expected) {
    await rm(target, { force: true });
    have = 0;
  }
  if (expected > 0 && have === expected) return { ok: true };

  // A console that is switched off leaves the socket open, and fetch has no
  // timeout of its own: without a watchdog the job waits on the operating
  // system, which looks exactly like a transfer that is still working. The
  // clock is per byte, not per transfer, so a 60 GB pull over a slow link is
  // never cut — only one that has gone silent.
  const stall = new AbortController();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const bump = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => stall.abort(), STALL_MS);
  };
  const stop = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };

  let res: Response;
  try {
    bump();
    res = await fetch(url, {
      ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}),
      signal: stall.signal,
    });
  } catch (error) {
    stop();
    return {
      ok: false,
      detail: stall.signal.aborted
        ? "the console did not start sending in time"
        : `unreachable (${reason(error)})`,
    };
  }
  if (!res.ok || !res.body) {
    stop();
    // 4xx is an answer, not a glitch: retrying it just wastes time.
    return { ok: false, detail: `the console answered ${res.status}`, retryable: res.status >= 500 };
  }

  const resume = have > 0 && res.status === 206;
  // When the tree did not give a size, the response itself says how much this
  // transfer should add up to. Without one, a half-written file looks finished.
  const declared = Number(res.headers.get("content-length") ?? 0);
  const want = expected > 0 ? expected : declared > 0 ? (resume ? have : 0) + declared : 0;
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, resume ? "a" : "w");
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await handle.write(chunk);
      bump();
      onBytes(chunk.byteLength);
    }
  } catch (error) {
    return {
      ok: false,
      detail: stall.signal.aborted
        ? `the console stopped sending data (${Math.round(STALL_MS / 1000)}s with nothing)`
        : `transfer broke (${reason(error)})`,
      // A full disk is not a glitch: three retries fail the same way and bury
      // the one thing the user has to change.
      retryable: !/ENOSPC|no space left/i.test(String(error)),
    };
  } finally {
    stop();
    await handle.close();
  }

  const final = await sizeOf(target);
  if (want > 0 && final !== want) return { ok: false, detail: `stopped at ${final} of ${want} bytes` };
  return { ok: true };
}

/**
 * Retries the transport, never the answer. A resume continues where the last
 * attempt stopped, so the second try costs the lost bytes and nothing more.
 */
async function fetchToFile(
  url: string,
  target: string,
  expected: number,
  onBytes: (count: number) => void,
): Promise<FetchOutcome> {
  let last: FetchOutcome = { ok: false, detail: "not attempted" };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await fetchOnce(url, target, expected, onBytes);
    if (last.ok || last.retryable === false) return last;
    if (attempt < ATTEMPTS) await Bun.sleep(attempt === 1 ? 500 : 2000);
  }
  return last;
}

async function pullSourceOnce(
  consoleHost: string | null,
  titleId: string,
  progress: PullProgress,
): Promise<PullResult> {
  if (!consoleHost) {
    return { ok: false, detail: "No console is configured on this Mac, so there is nothing to pull from." };
  }
  // The id names the folder this pull writes into. The route already refused
  // anything with a separator, and this is the second door of the same room.
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(titleId)) {
    return { ok: false, detail: "That title id cannot be used as a folder name." };
  }
  const base = consoleHost.replace(/\/$/, "");

  progress(1, "asking the console what it has");
  let info: SourceInfo;
  try {
          const res = await fetch(`${base}/api/source/${encodeURIComponent(titleId)}`, {
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return {
        ok: false,
        detail:
          res.status === 404
            ? "The console no longer lists that title. Rescan on the console, then try again."
            : `The console answered ${res.status} when asked about that title.`,
      };
    }
    // Read then parse, so an unreadable answer is told apart from a console
    // that cannot be reached: the two need different things from the user.
    const raw = await res.text();
    try {
      info = JSON.parse(raw) as SourceInfo;
    } catch {
      return {
        ok: false,
        detail: "The console answered something that was not readable JSON. Check that the payload there is this version.",
      };
    }
  } catch (error) {
    return { ok: false, detail: `Could not reach the console: ${reason(error)}` };
  }

  const kind = info.kind ?? "";
  if (kind !== "dump" && kind !== "image") {
    return { ok: false, detail: `${titleId} is a ${kind || "unknown kind"}, which is not something to pack.` };
  }

  const dest = join(PULL_ROOT, titleId);
  const expected = info.size ?? 0;
  // Create the folder before measuring it: on a first run there is no
  // data/pulled yet, and a failed statfs used to skip the space check entirely.
  await mkdir(dest, { recursive: true });

  // Check the disk before writing a byte, not after filling it.
  const free = await freeSpace(PULL_ROOT);
  if (free !== null && expected > 0 && free < expected + SPACE_MARGIN) {
    return {
      ok: false,
      detail: `Not enough space on this Mac: ${gb(expected)} to pull, ${gb(free)} free in data/pulled.`,
    };
  }

  if (kind === "image") {
    if (!info.file) return { ok: false, detail: "The console did not name the image file." };
    // The filename comes from the other end of a network link: it may not carry
    // a path, or it would write wherever it named.
    if (!safeRelative(info.file)) {
      return { ok: false, detail: "The console named an image file that is not a plain file name." };
    }
    const target = join(dest, info.file);
    const total = info.size ?? (await sizeOf(target));
    // Bytes already on disk count towards the bar, so a resumed pull starts
    // where it left off instead of at zero.
    const already = await sizeOf(target);
    let written = 0;

    const pulled = await fetchToFile(`${base}/api/source-file/${encodeURIComponent(titleId)}`, target, total, (count) => {
      written += count;
      const have = already + written;
      const pct = total > 0 ? Math.min(92, Math.max(2, Math.round((have / total) * 92))) : 40;
      progress(pct, `pulling the image · ${mb(have)} / ${mb(total)}`);
    });
    if (!pulled.ok) return { ok: false, detail: `Pulling the image failed: ${pulled.detail}` };

    const bytes = await sizeOf(target);
    progress(94, `pulled ${info.file} · packing next`);
    return { ok: true, path: target, title: titleId, bytes, files: 1, hasIcon: false, kind: "image", category: null };
  }

  progress(2, "reading the dump's file list");
  let tree: Tree;
  try {
    const res = await fetch(`${base}/api/tree/${encodeURIComponent(titleId)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 160).trim();
      return { ok: false, detail: `The console refused the file list (${res.status})${text ? `: ${text}` : ""}` };
    }
    const raw = await res.text();
    try {
      tree = JSON.parse(raw) as Tree;
    } catch {
      return {
        ok: false,
        detail: "The console sent a file list that could not be read. Check that the payload there is this version.",
      };
    }
  } catch (error) {
    return { ok: false, detail: `Could not read the dump's file list: ${reason(error)}` };
  }

  const files = (tree.files ?? []).filter((file) => file && typeof file.p === "string");
  if (!files.length) return { ok: false, detail: "The console listed no files in that dump." };
  // A truncated list is worse than a refusal: the copy would be missing files
  // and the package built from it would install and then fail.
  if (tree.truncated || files.length > 20_000) {
    return {
      ok: false,
      detail: `The console could only list ${files.length} files, so that dump has more than one pass can carry. Nothing was copied — a partial copy would build a broken package.`,
    };
  }

  // No packer can work without sce_sys metadata, so refuse before transferring.
  const hasMetadata = files.some((file) => file.p === "sce_sys/param.json" || file.p === "sce_sys/param.sfo");
  if (!hasMetadata) {
    return {
      ok: false,
      detail: "That folder has no sce_sys/param.json or param.sfo, so no packer can package it.",
    };
  }

  const total = tree.bytes && tree.bytes > 0 ? tree.bytes : files.reduce((sum, f) => sum + (f.s ?? 0), 0);
  let done = 0;
  let next = 0;
  let failure: string | null = null;

  const worker = async (): Promise<void> => {
    while (!failure) {
      const index = next++;
      if (index >= files.length) return;

      const relative = String(files[index].p);
      if (!safeRelative(relative)) {
        failure = `The console sent an unsafe path (${relative.slice(0, 60)}).`;
        return;
      }

      const result = await fetchToFile(
        `${base}/api/dump/${encodeURIComponent(titleId)}/${encodePath(relative)}`,
        join(dest, relative),
        files[index].s ?? 0,
        (count) => {
          done += count;
          const pct = total > 0 ? Math.min(92, Math.round((done / total) * 92)) : 45;
          progress(pct, `pulling the dump · ${mb(done)} / ${mb(total)}`);
        },
      );
      if (!result.ok) {
        failure = `Pull failed at ${relative}: ${result.detail}`;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (failure) return { ok: false, detail: failure };

  let title = titleId;
  let category: string | null = null;
  try {
    const param = JSON.parse(await readFile(join(dest, "sce_sys", "param.json"), "utf8")) as {
      titleName?: string;
      applicationCategoryType?: string;
    };
    if (param.titleName) title = param.titleName;
    if (param.applicationCategoryType) category = param.applicationCategoryType.toLowerCase();
  } catch {
    try {
      const sfo = parseSfo(new Uint8Array(await readFile(join(dest, "sce_sys", "param.sfo"))));
      if (typeof sfo.TITLE === "string" && sfo.TITLE) title = sfo.TITLE;
    } catch {
      // The console already showed a title for this; keep the title id.
    }
  }

  const hasIcon = existsSync(join(dest, "sce_sys", "icon0.png"));
  progress(94, `pulled ${files.length} files · packing next`);
  return { ok: true, path: dest, title, bytes: total, files: files.length, hasIcon, kind: "dump", category };
}

/**
 * One pull per title at a time. Two requests for the same dump used to write
 * the same files from two workers, which corrupts both copies.
 */
const inFlight = new Map<string, Promise<PullResult>>();

export function pullSource(
  consoleHost: string | null,
  titleId: string,
  progress: PullProgress,
): Promise<PullResult> {
  const key = `${consoleHost ?? ""}|${titleId}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = pullSourceOnce(consoleHost, titleId, progress).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/** Left over from the first cut of this file; kept so callers do not break. */
export const pullDump = pullSource;
