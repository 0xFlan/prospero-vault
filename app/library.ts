import { copyFile, readFile, rename } from "node:fs/promises";
import { LIBRARY_PATH, ensureDirs, writeAtomic } from "./core";

export type GameState = "dumped" | "building" | "built" | "installing" | "installed" | "error";

export type Game = {
  titleId: string;
  title: string;
  /** where the dump (or image) lives on disk */
  sourcePath: string | null;
  sourceKind: string;
  sizeBytes: number;
  state: GameState;
  pkgPath: string | null;
  pkgSize: number;
  engine: string | null;
  hasIcon: boolean;
  /** "ac" for additional content, from the source's own param.json */
  category: string | null;
  /** true when the package was produced by the simulated engine */
  simulated: boolean;
  consoleLabel: string | null;
  note: string | null;
  updatedAt: string;
};

/** Rows the loader could not make sense of, for honest reporting. */
export let librarySkipped = 0;
/** Set when the library file itself could not be read. */
export let libraryProblem: string | null = null;

const STATES = new Set(["dumped", "building", "built", "installing", "installed", "error"]);

/**
 * Every row is rebuilt field by field. A library written by an older build (or
 * edited by hand) used to be cast straight to Game[], so a missing pkgPath or a
 * number where a path belongs reached the interfaces and the path helpers.
 */
function normaliseRow(raw: unknown): Game | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const titleId = typeof row.titleId === "string" ? row.titleId.trim() : "";
  if (!/^[A-Za-z0-9]{1,16}$/.test(titleId)) return null;

  const text = (value: unknown, fallback: string) => (typeof value === "string" && value ? value : fallback);
  const optional = (value: unknown) => (typeof value === "string" && value ? value : null);
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

  return {
    titleId,
    title: text(row.title, titleId),
    sourcePath: optional(row.sourcePath),
    sourceKind: text(row.sourceKind, "Unknown"),
    sizeBytes: count(row.sizeBytes),
    state: (STATES.has(String(row.state)) ? String(row.state) : "dumped") as GameState,
    pkgPath: optional(row.pkgPath),
    pkgSize: count(row.pkgSize),
    engine: optional(row.engine),
    hasIcon: row.hasIcon === true,
    category: optional(row.category),
    simulated: row.simulated === true,
    consoleLabel: optional(row.consoleLabel),
    note: optional(row.note),
    updatedAt: text(row.updatedAt, new Date().toISOString()),
  };
}

export function normaliseRows(rows: unknown[]): Game[] {
  const games: Game[] = [];
  librarySkipped = 0;
  for (const row of rows) {
    const game = normaliseRow(row);
    if (game) games.push(game);
    else librarySkipped++;
  }
  return games;
}

export async function loadLibrary(): Promise<Game[]> {
  try {
    const raw = await readFile(LIBRARY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normaliseRows(parsed) : [];
  } catch (error) {
    // A damaged file must not look like an empty library. Fall back to the copy
    // taken before the last save, and put it back so the next read is normal.
    try {
      const raw = await readFile(`${LIBRARY_PATH}.bak`, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      console.error("[library] primary file was unreadable; restored the backup");
      await writeAtomic(LIBRARY_PATH, raw);
      return normaliseRows(parsed);
    } catch {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (missing) return [];
      // Unreadable, with no usable backup. Keep the file: the next save would
      // otherwise replace it, and an empty list looks exactly like a new app.
      let kept = false;
      try {
        await rename(LIBRARY_PATH, `${LIBRARY_PATH}.bad`);
        kept = true;
      } catch {
        /* leave it where it is */
      }
      libraryProblem = kept
        ? "Your library file could not be read. It was kept as library.json.bad, so nothing was lost, and the list starts empty."
        : "Your library file could not be read, so the list starts empty. Its contents are still on disk.";
      console.error(`[library] could not read the library; ${kept ? "kept as .bad" : "left in place"}`);
      return [];
    }
  }
}

export async function saveLibrary(games: Game[]): Promise<void> {
  await ensureDirs();
  const text = JSON.stringify(games, null, 2);
  // Test-only: forces an older snapshot to finish late, so the checks can
  // prove that two overlapping saves cannot land out of order. Never set by
  // the app itself.
  const slowMs = Number(process.env.PV_SAVE_DELAY_MS ?? 0) || 0;
  const marker = process.env.PV_SAVE_DELAY_MARKER ?? "";
  if (slowMs > 0 && marker && text.includes(marker)) await Bun.sleep(slowMs);
  // Keep the previous version before replacing it: one bad save should not cost
  // the whole library.
  try {
    await copyFile(LIBRARY_PATH, `${LIBRARY_PATH}.bak`);
  } catch {
    /* nothing saved yet */
  }
  await writeAtomic(LIBRARY_PATH, text);
}

export function touch(game: Game): Game {
  game.updatedAt = new Date().toISOString();
  return game;
}
