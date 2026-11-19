/** Captures each console view through CDP so layout regressions are visible. */
const VIEWS: Array<[string, string]> = [
  ["library", ""],
  ["packages", `document.querySelector('[data-view="packages"]').click()`],
  ["console", `document.querySelector('[data-view="console"]').click()`],
  ["settings", `document.querySelector('[data-view="settings"]').click()`],
  [
    "confirm",
    `document.querySelector('[data-view="library"]').click();
     document.querySelector('[data-id="PTST00003"]').click()`,
  ],
  [
    "image",
    `const close = document.querySelector('#scrim [data-action="close"]'); if (close) close.click();
     document.querySelector('[data-view="library"]').click();
     document.querySelector('[data-id="PTST00005"]').click()`,
  ],
  // The tile row is both jobs: installed, pressing it asks before removing.
  [
    "home-app",
    `document.querySelector('#scrim [data-action="close"]')?.click();
     document.querySelector('[data-view="console"]').click();
     document.querySelector('[data-action="homeApp"]').click()`,
  ],
];

const targets = (await (await fetch("http://127.0.0.1:9222/json")).json()) as Array<{
  type: string;
  webSocketDebuggerUrl: string;
}>;
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((resolve) => (ws.onopen = () => resolve()));

let next = 0;
const pending = new Map<number, (value: any) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.reload", { ignoreCache: true });
await wait(2500);

for (const [name, expression] of VIEWS) {
  if (expression) {
    await send("Runtime.evaluate", { expression, awaitPromise: true });
    await wait(500);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(`docs/screens/view-${name}.png`, Buffer.from(shot.data, "base64"));
  console.log(`captured ${name}`);
}

// Report the geometry that matters: nothing may overlap the scroll region.
const geometry = await send("Runtime.evaluate", {
  expression: `(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return JSON.stringify({
      bar: r(".sysbar"), heading: r(".topbar h1"), scroll: r("#scroll"),
      hints: r(".hints"), navLabels: [].slice.call(document.querySelectorAll(".nav .label")).map((n) => n.textContent),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      tiles: document.querySelectorAll(".tile[data-id]").length,
      rows: document.querySelectorAll(".row").length,
    });
  })()`,
  returnByValue: true,
});
console.log(geometry?.result?.value ?? "");
ws.close();
