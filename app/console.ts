import { shortSize } from "./core";

export type ConsoleStatus = {
  mode: "payload" | "simulated" | "offline";
  host: string | null;
  connected: boolean;
  detail: string;
  version?: string;
  freeBytes?: number;
  freeLabel?: string;
};

/**
 * The console side is deliberately thin: a payload that accepts a package and
 * reports health. Everything clever happens in this app.
 */
/** A body this app cannot read is not a person's problem to decode. */
const unreadable = "The payload answered something this app could not read. Check that it is the version this app expects.";

async function probeOnce(base: string): Promise<ConsoleStatus> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) {
      return { mode: "offline", host: base, connected: false, detail: `Payload answered HTTP ${res.status}` };
    }
    const raw = await res.text();
    let info: { version?: string; free?: number };
    try {
      info = JSON.parse(raw) as { version?: string; free?: number };
    } catch {
      return { mode: "offline", host: base, connected: false, detail: unreadable };
    }
    return {
      mode: "payload",
      host: base,
      connected: true,
      detail: "Payload reachable",
      version: info.version,
      freeBytes: typeof info.free === "number" ? info.free : undefined,
      freeLabel: typeof info.free === "number" ? shortSize(info.free) : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: "offline",
      host: base,
      connected: false,
      detail: `Unreachable: ${message}`,
    };
  }
}

export async function probe(host: string | null): Promise<ConsoleStatus> {
  if (!host) {
    return {
      mode: "simulated",
      host: null,
      connected: false,
      detail: "No console configured. Deploys will be simulated.",
    };
  }

  const base = host.replace(/\/$/, "");
  const started = Date.now();
  const first = await probeOnce(base);
  // One dropped connection is a blink, not a console that is gone: try once
  // more before telling the interface it is offline. A probe that already
  // waited out its timeout is not a blink — asking again would only double the
  // time every state request blocks on a console that is switched off.
  const quickFailure = Date.now() - started < 1500;
  if (quickFailure && first.detail.startsWith("Unreachable")) {
    await Bun.sleep(250);
    const second = await probeOnce(base);
    if (second.mode !== "offline" || !second.detail.startsWith("Unreachable")) return second;
  }
  return first;
}

export type InstallResult = {
  ok: boolean;
  detail: string;
  simulated: boolean;
  label: string | null;
  /** true when the console accepted the job and is now doing the transfer */
  pulling: boolean;
};

/**
 * Asks the console to fetch the package. The payload pulls on its own worker
 * thread, so this answers in milliseconds rather than holding a request open
 * for a multi-gigabyte transfer — even over LAN Wi-Fi.
 */
export async function install(
  host: string | null,
  payload: { titleId: string; /** how the console should reach this Mac */ mac?: string },
): Promise<InstallResult> {
  if (!host) {
    // Simulated install often enough to be visible; a soak that runs hundreds
    // of cycles sets this to zero so it measures accumulation, not the fake wait.
    const simulatedMs = Number(process.env.PV_INSTALL_DELAY_MS ?? 900);
    if (simulatedMs > 0) await new Promise((r) => setTimeout(r, simulatedMs));
    return {
      ok: true,
      detail: "Simulated install — no console configured",
      simulated: true,
      label: "Simulated",
      pulling: false,
    };
  }

  const base = host.replace(/\/$/, "");
  // Well under the interface's own deadline: a console that never answers has
  // to come back as an answer, not as the page giving up on the app.
  const budget = Number(process.env.PV_CONSOLE_TIMEOUT_MS ?? 0) || 8_000;
  try {
    const res = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The address travels with the job so the console can pull even if it
      // has never been told where the Mac lives.
      body: JSON.stringify({ id: payload.titleId, ...(payload.mac ? { mac: payload.mac } : {}) }),
      signal: AbortSignal.timeout(budget),
    });

    const text = (await res.text()).slice(0, 4000);
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = String(parsed.message ?? parsed.error ?? "").trim();
    } catch {
      // A proxy, or a payload of another vintage, may answer with markup. Its
      // tags are not something to put in front of a person.
      const plain = text.replace(/\s+/g, " ").trim();
      detail = /<[a-z!/]/i.test(plain) ? "" : plain.slice(0, 200);
    }

    if (res.status === 202) {
      return {
        ok: true,
        pulling: true,
        simulated: false,
        label: base,
        detail: "The console is fetching the package.",
      };
    }

    if (res.status === 409) {
      // The console explains itself — busy, or a game is running — and that is
      // more useful than anything this side could guess.
      return {
        ok: false,
        pulling: false,
        simulated: false,
        label: base,
        detail:
          detail && detail.trim()
            ? detail
            : "The console is already processing a package. Wait for it there, then retry.",
      };
    }

    if (res.status === 400 || res.status === 404) {
      const explains = detail && !/unknown (title|endpoint)/i.test(detail);
      return {
        ok: false,
        pulling: false,
        simulated: false,
        label: base,
        detail: explains
          ? `${detail} Rescan on the console if it is not listed there.`
          : "The console does not list that title. Open Prospero Vault on the console, rescan, then retry.",
      };
    }

    return {
      ok: false,
      pulling: false,
      simulated: false,
      label: base,
      detail: detail || `The console answered HTTP ${res.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|timed out|aborted/i.test(message);
    return {
      ok: false,
      pulling: false,
      simulated: false,
      label: null,
      detail: timedOut
        ? `The console did not answer within ${Math.round(budget / 1000)} seconds. Check that the payload is still running on it, and that the address in Settings is right.`
        : `The console did not answer: ${message}`,
    };
  }
}
