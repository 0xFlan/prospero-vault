import { join, basename, extname, resolve, sep } from "node:path";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

export const ROOT = process.cwd();
/** PV_DATA lets a check run against its own library and packages. */
export const DATA_DIR = process.env.PV_DATA ? resolve(process.env.PV_DATA) : join(ROOT, "data");
export const PKG_DIR = join(DATA_DIR, "pkg");
/** PV_CONFIG lets a test point at its own config so the real one is untouched. */
export const CONFIG_PATH = process.env.PV_CONFIG || process.env.TITAN_CONFIG || join(DATA_DIR, "config.json");
export const LIBRARY_PATH = join(DATA_DIR, "library.json");

export type Config = {
  port: number;
  /** e.g. "http://192.168.1.50:8097" — the console payload, or null for simulated */
  consoleHost: string | null;
  engine: "auto" | "mock" | "psviethoa" | "command";
  enginePaths: {
    psviethoa?: string;
    /** Shell command template. Placeholders: {source} {titleId} {output} {pkg} */
    command?: string;
  };
  scanDirs: string[];
  /**
   * "all" is the shipped default because the console fetches packages over the
   * LAN; it is reported in /api/state so it is a visible choice, and
   * "loopback" keeps the console out entirely for a Mac used only via its UI.
   */
  bind: "all" | "loopback";
};

export const DEFAULTS: Config = {
  port: 8090,
  consoleHost: null,
  engine: "auto",
  enginePaths: {},
  scanDirs: [],
  bind: "all",
};

export async function ensureDirs(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PKG_DIR, { recursive: true });
}

/**
 * A settings file that could not be read, or that held values this app cannot
 * use. The app starts on defaults either way, but the interface says so: a
 * silently forgotten console address looks like the app lost its settings.
 */
export let configProblem: string | null = null;

export const ENGINE_IDS = ["auto", "mock", "psviethoa", "command"] as const;
const ENGINES = new Set<string>(ENGINE_IDS);

/**
 * The console address is the base of every request this app makes, so a value
 * that cannot become a URL is refused when it is saved instead of being stored
 * and mourned: "192.168.4.100:8097" without a scheme, a path, a username, a
 * 10 KB string or a javascript: URL all used to be written to config.json.
 * A bare host or host:port is accepted and given http://.
 */
export function normaliseHost(value: unknown): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, reason: "The console address must be text." };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > 200) {
    return { ok: false, reason: "That address is far too long to be one. Use http://192.168.1.50:8097." };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "That does not look like an address. Use http://192.168.1.50:8097." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only an http:// or https:// address can reach a console." };
  }
  if (!url.hostname) return { ok: false, reason: "That address has no host in it." };
  if (url.username || url.password) {
    return { ok: false, reason: "An address with a username and password is not used here." };
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, reason: "Give the console's address only — no path, query or fragment." };
  }
  return { ok: true, value: `${url.protocol}//${url.host}` };
}

function normaliseConfig(parsed: unknown): { config: Config; ignored: string[] } {
  const ignored: string[] = [];
  const config: Config = { ...DEFAULTS, enginePaths: {} };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config, ignored: ["the whole file"] };
  }
  const row = parsed as Record<string, unknown>;

  if (typeof row.port === "number" && Number.isFinite(row.port) && row.port > 0 && row.port < 65536) {
    config.port = row.port;
  } else if (row.port !== undefined) ignored.push("port");

  if (row.consoleHost === null) config.consoleHost = null;
  else if (row.consoleHost !== undefined) {
    const host = normaliseHost(row.consoleHost);
    if (host.ok) config.consoleHost = host.value;
    else ignored.push("consoleHost");
  }

  if (typeof row.engine === "string" && ENGINES.has(row.engine)) config.engine = row.engine as Config["engine"];
  else if (row.engine !== undefined) ignored.push("engine");

  if (row.enginePaths && typeof row.enginePaths === "object" && !Array.isArray(row.enginePaths)) {
    for (const [key, value] of Object.entries(row.enginePaths as Record<string, unknown>)) {
      if (typeof value === "string") (config.enginePaths as Record<string, string>)[key] = value;
      else ignored.push(`enginePaths.${key}`);
    }
  } else if (row.enginePaths !== undefined) ignored.push("enginePaths");

  if (Array.isArray(row.scanDirs)) {
    const dirs = row.scanDirs.filter((entry): entry is string => typeof entry === "string");
    if (dirs.length !== row.scanDirs.length) ignored.push("scanDirs");
    config.scanDirs = dirs;
  } else if (row.scanDirs !== undefined) ignored.push("scanDirs");

  if (row.bind === "all" || row.bind === "loopback") config.bind = row.bind;
  else if (row.bind !== undefined) ignored.push("bind");

  return { config, ignored };
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const { config, ignored } = normaliseConfig(JSON.parse(raw));
    configProblem = ignored.length
      ? `Some settings could not be used (${ignored.join(", ")}); defaults are in place for those.`
      : null;
    return config;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
    if (missing) {
      configProblem = null;
      return { ...DEFAULTS, enginePaths: {} };
    }
    // Keep the unreadable file instead of letting the next save overwrite it:
    // a hand-edited or half-written config is usually recoverable by hand.
    const kept = `${CONFIG_PATH}.bad`;
    let saved = false;
    try {
      await rename(CONFIG_PATH, kept);
      saved = true;
    } catch {
      /* leave the file where it is */
    }
    configProblem = saved
      ? `Your settings file could not be read. It was kept as ${basename(kept)} and the defaults are in use.`
      : `Your settings file could not be read, so the defaults are in use for this run.`;
    console.error(`[config] ${CONFIG_PATH} unreadable; ${saved ? `kept as ${kept}` : "left in place"}`);
    return { ...DEFAULTS, enginePaths: {} };
  }
}

/**
 * Write, flush, rename. A crash during a plain truncate-and-write leaves a
 * half-written file that the loader cannot tell from an empty one — which for
 * the library means every title disappears. The rename makes the new contents
 * appear all at once, and only after the bytes are on disk.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  // A name of its own per write. Two saves at the same moment used to share
  // one temp file: the first rename consumed it, the second failed with ENOENT
  // — a 500 to whoever asked, and their save lost.
  const temp = `${path}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await ensureDirs();
  await writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/* ------------------------------------------------------------------ *
 * param.sfo — the console metadata file inside every game payload.
 * Format: 20-byte header, 16-byte entry table, key table, data table.
 * ------------------------------------------------------------------ */

const SFO_MAGIC = 0x46535000; // "\0PSF"
const FMT_INTEGER = 0x0404;

export function parseSfo(bytes: Uint8Array): Record<string, string | number> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== SFO_MAGIC) {
    throw new Error("not an SFO file");
  }
  const keyTable = dv.getUint32(8, true);
  const dataTable = dv.getUint32(12, true);
  const count = dv.getUint32(16, true);
  const decoder = new TextDecoder();
  const out: Record<string, string | number> = {};

  for (let i = 0; i < count; i++) {
    const entry = 20 + i * 16;
    if (entry + 16 > bytes.byteLength) break;

    const keyOffset = dv.getUint16(entry, true);
    const format = dv.getUint16(entry + 2, true);
    const length = dv.getUint32(entry + 4, true);
    const dataOffset = dv.getUint32(entry + 12, true);

    let keyStart = keyTable + keyOffset;
    let keyEnd = keyStart;
    while (keyEnd < bytes.byteLength && bytes[keyEnd] !== 0) keyEnd++;
    const key = decoder.decode(bytes.subarray(keyStart, keyEnd));
    if (!key) continue;

    if (format === FMT_INTEGER) {
      if (dataTable + dataOffset + 4 <= bytes.byteLength) {
        out[key] = dv.getUint32(dataTable + dataOffset, true);
      }
      continue;
    }

    const start = dataTable + dataOffset;
    const end = Math.min(start + length, bytes.byteLength);
    if (start >= end) {
      out[key] = "";
      continue;
    }
    out[key] = decoder.decode(bytes.subarray(start, end)).replace(/\0+$/, "");
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Discovery — find things that can be packaged.
 * ------------------------------------------------------------------ */

const TITLE_ID = /^[A-Z]{4}\d{5}$/;

const IMAGE_KINDS: Record<string, string> = {
  ".exfat": "exFAT image",
  ".ffpfsc": "PFSC image",
  ".ffpfs": "PFS image",
  ".ffpkg": "UFS2 package",
  ".gp5": "GP5 project",
  ".pkg": "PKG",
};

export type Found = {
  titleId: string;
  title: string;
  path: string;
  kind: string;
  size: number;
  hasIcon: boolean;
  /** true when this is a bare retail/encrypted .pkg we cannot work with */
  retailPkg: boolean;
  /** "ac" for additional content, "gp" for an update, else null */
  category: string | null;
};

async function dirSize(path: string, budget = { n: 0 }): Promise<number> {
  let total = 0;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.n++ > 4000) break;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(child, budget);
    } else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch {
        /* ignore unreadable entries */
      }
    }
  }
  return total;
}

/**
 * A dump copied off a console, unpacked by a tool, or pulled from an archive
 * does not always keep Sony's lowercase names: `SCE_SYS/PARAM.JSON` and
 * `EBOOT.BIN` are common. Look entries up without case, or those dumps are
 * invisible to a scan that only believes in one spelling.
 */
export async function findEntry(dir: string, name: string): Promise<string | null> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === name.toLowerCase()) return entry.name;
    }
  } catch {
    /* unreadable or missing */
  }
  return null;
}

/** The category a source tree itself declares, never what a client claimed. */
export async function sourceCategory(dir: string): Promise<string | null> {
  return (await readTitleMeta(dir)).category;
}

async function readTitleMeta(
  dir: string,
): Promise<{ titleId: string; title: string; hasIcon: boolean; category: string | null }> {
  const folder = basename(dir);
  let titleId = TITLE_ID.test(folder) ? folder : "";
  let title = "";
  let hasIcon = false;
  let category: string | null = null;

  const metaDir = (await findEntry(dir, "sce_sys")) ?? "sce_sys";
  const sfoName = await findEntry(join(dir, metaDir), "param.sfo");
  const jsonName = await findEntry(join(dir, metaDir), "param.json");

  if (sfoName) {
    try {
      const sfo = parseSfo(await readFile(join(dir, metaDir, sfoName)));
      if (typeof sfo["TITLE_ID"] === "string" && sfo["TITLE_ID"]) titleId = sfo["TITLE_ID"];
      if (typeof sfo["TITLE"] === "string" && sfo["TITLE"]) title = sfo["TITLE"];
    } catch {
      /* a damaged SFO falls through to param.json */
    }
  }
  if (jsonName) {
    try {
      const meta = JSON.parse(await readFile(join(dir, metaDir, jsonName), "utf8"));
      if (meta.titleId) titleId = String(meta.titleId);
      if (meta.titleName) title = String(meta.titleName);
      else if (meta.title) title = String(meta.title);
      if (meta.applicationCategoryType) category = String(meta.applicationCategoryType).toLowerCase();
    } catch {
      /* no usable metadata — fall back to the folder name */
    }
  }

  hasIcon =
    Boolean(await findEntry(join(dir, metaDir), "icon0.png")) || Boolean(await findEntry(dir, "icon0.png"));
  if (!title) title = folder;
  if (!titleId) titleId = folder.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 9) || "UNKNOWN";
  return { titleId, title, hasIcon, category };
}

/**
 * A folder that carries an eboot but no metadata is almost a dump, and a scan
 * that returns nothing for it looks like the app did not see the folder at all.
 * Report those by path and what is missing, so the person can fix the copy.
 */
export async function findIncompleteDumps(
  dir: string,
  depth = 0,
): Promise<Array<{ path: string; message: string }>> {
  const root = resolve(dir);
  const problems: Array<{ path: string; message: string }> = [];
  if (depth > 3) return problems;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return problems;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    const metaDir = await findEntry(full, "sce_sys");
    const hasMetadata =
      metaDir !== null &&
      (Boolean(await findEntry(join(full, metaDir), "param.json")) ||
        Boolean(await findEntry(join(full, metaDir), "param.sfo")));
    if (hasMetadata) {
      // Metadata without an executable looks like a dump and packages to an
      // empty app. Only additional content is allowed to have no eboot.
      const meta = await readTitleMeta(full);
      if (meta.category !== "ac" && !(await findEntry(full, "eboot.bin"))) {
        problems.push({
          path: full,
          message: `${full} has sce_sys metadata but no eboot.bin; recopy the dump with its executable.`,
        });
      }
      continue;
    }
    const eboot = await findEntry(full, "eboot.bin");
    if (eboot) {
      problems.push({
        path: full,
        message: `${full} has ${eboot} but no sce_sys/param.json; copy the complete dump (param.json or param.sfo, icon0.png and eboot.bin).`,
      });
      continue;
    }
    problems.push(...(await findIncompleteDumps(full, depth + 1)));
  }
  return problems;
}

export async function scanDir(dir: string, depth = 0): Promise<Found[]> {
  const root = resolve(dir);
  const found: Found[] = [];
  if (depth > 3) return found;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);

    if (entry.isDirectory()) {
      // A dump is identified by the metadata inside it, not by its folder name.
      // Dumps named after the game — or after a content id, for DLC — used to be
      // invisible unless their folder happened to be a title id.
      const metaDir = await findEntry(full, "sce_sys");
      const hasMetadata =
        metaDir !== null &&
        (Boolean(await findEntry(join(full, metaDir), "param.json")) ||
          Boolean(await findEntry(join(full, metaDir), "param.sfo")));
      const looksLikeTitle = TITLE_ID.test(entry.name) && metaDir !== null;
      if (looksLikeTitle || hasMetadata) {
        const meta = await readTitleMeta(full);
        found.push({
          ...meta,
          path: full,
          kind: "Game folder",
          size: await dirSize(full),
          retailPkg: false,
        });
        continue;
      }
      found.push(...(await scanDir(full, depth + 1)));
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    const kind = IMAGE_KINDS[ext];
    if (!kind) continue;

    const size = (await stat(full)).size;
    const stem = basename(entry.name, extname(entry.name)).toUpperCase();
    const titleId = TITLE_ID.test(stem) ? stem : stem.slice(0, 9);
    found.push({
      titleId: TITLE_ID.test(stem) ? stem : titleId,
      title: basename(entry.name),
      path: full,
      kind,
      size,
      hasIcon: false,
      retailPkg: ext === ".pkg",
      category: null,
    });
  }

  return found;
}

export function isInside(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b + sep);
}

/**
 * The address the console should dial. A VPN or a VM bridge can sort ahead of
 * Wi-Fi and be unreachable from a console, so virtual adapters are skipped and
 * real LAN ones are preferred. A link-local address is useless to the console
 * even though it looks like one, so those are skipped too.
 */
export function lanAddress(): string {
  const nets = networkInterfaces();
  const preferred = ["en0", "en1", "en2", "en3", "eth0", "wlan0"];
  const virtual = /^(utun|ipsec|tun|tap|llw|awdl|bridge|gif|stf|vmnet|vmenet)/i;
  const candidates: Array<{ name: string; address: string }> = [];

  for (const name of Object.keys(nets)) {
    if (virtual.test(name)) continue;
    for (const net of nets[name] ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      if (net.address.startsWith("169.254.")) continue;
      candidates.push({ name, address: net.address });
    }
  }

  return (candidates.find((entry) => preferred.includes(entry.name)) ?? candidates[0])?.address ?? "127.0.0.1";
}

export function shortSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
