/** Reports computed styles for the shell via the Chrome DevTools Protocol. */
const targets = (await (await fetch("http://127.0.0.1:9222/json")).json()) as Array<{
  type: string;
  webSocketDebuggerUrl: string;
  url: string;
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

await send("Runtime.enable");
await new Promise((resolve) => setTimeout(resolve, 2500));

const expression = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      display: s.display,
      position: s.position,
      background: s.backgroundColor,
      backgroundImage: s.backgroundImage.slice(0, 40),
      color: s.color,
      flexDirection: s.flexDirection,
      alignItems: s.alignItems,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      borderRadius: s.borderRadius,
      overflow: s.overflow,
    };
  };
  return JSON.stringify({
    body: pick("body"),
    app: pick(".app"),
    bar: pick(".bar"),
    brand: pick(".brand"),
    mark: pick(".brand .mark"),
    nav: pick("#nav"),
    item: pick(".nav .item"),
    activeItem: pick(".nav .item.active"),
    tile: pick(".nav .tile"),
    label: pick(".nav .label"),
    barRight: pick(".bar-right"),
    main: pick(".main"),
    heading: pick(".topbar h1"),
    status: pick(".status"),
    tiles: pick(".tiles"),
    gameTile: pick(".tile[data-id]"),
    tileArt: pick(".tile[data-id] .art"),
    hint: pick(".hints"),
    navItems: document.querySelectorAll(".nav .item").length,
    topLevelChildren: [].slice.call(document.body.children).map((n) => n.tagName + "." + n.className),
  });
})()`;

const result = await send("Runtime.evaluate", { expression, returnByValue: true });
console.log(result?.result?.value ?? JSON.stringify(result));
ws.close();
