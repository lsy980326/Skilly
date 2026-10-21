import test from "node:test";
import assert from "node:assert/strict";
import { createViewerLayout } from "../ui/layout.js";

function fixture({ width = 1400, height = 800, preferences, denied = false } = {}) {
  const values = new Map([["connection-token", "preserved"]]);
  if (preferences !== undefined) values.set("skilly.viewer.layout.v1", JSON.stringify(preferences));
  const listeners = {}, nodes = new Map();
  const style = new Map();
  for (const name of [".workspace", ".service-panel", ".projects-panel", ".workstream", "#resize-sidebar", "#resize-dashboard", "#reset-layout"]) {
    const attributes = new Map(), events = {}, classes = new Set(), pointers = new Set();
    nodes.set(name, {
      open: true, style: { setProperty: (key, value) => style.set(key, value), removeProperty: key => style.delete(key) },
      classList: { add: key => classes.add(key), remove: (...keys) => keys.forEach(key => classes.delete(key)), toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
      setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key),
      addEventListener: (key, fn) => { events[key] = fn; }, focus() {},
      setPointerCapture: id => pointers.add(id), releasePointerCapture: id => pointers.delete(id), hasPointerCapture: id => pointers.has(id),
      getBoundingClientRect() {
        if (name === ".workspace") return { width, height };
        if (name === ".projects-panel") return { width: Number.parseFloat(style.get("--sidebar-size")) || (width <= 1100 ? 185 : 226) };
        return { height: Number.parseFloat(style.get("--dashboard-size")) || (nodes.get(".workstream").open ? 300 : 150) };
      },
      event(key, extra = {}) {
        const event = { pointerId: 1, button: 0, clientX: 0, clientY: 0, preventDefault() { this.prevented = true; }, ...extra };
        events[key]?.(event); return event;
      },
    });
  }
  createViewerLayout({ document: { querySelector: key => nodes.get(key) },
    window: { matchMedia: () => ({ matches: width >= 851 }), addEventListener: (key, fn) => { listeners[key] = fn; } },
    getStorage() { if (denied) throw new Error("Storage denied"); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; },
  });
  return { node: key => nodes.get(key), values, style, listeners, saved: () => JSON.parse(values.get("skilly.viewer.layout.v1") ?? "{}"),
    resize(w, h) { width = w; height = h; listeners.resize(); } };
}

test("pointer drag stores only layout preferences and restores on a new page", () => {
  const f = fixture(), handle = f.node("#resize-sidebar");
  handle.event("pointerdown", { clientX: 100 });
  handle.event("pointermove", { clientX: 200 });
  assert.equal(f.style.get("--sidebar-size"), "326px");
  assert.deepEqual(f.saved(), {}, "Do not persist each pointer move.");
  handle.event("pointerup");
  assert.deepEqual(f.saved(), { sidebar: 326 });
  assert.equal(f.values.get("connection-token"), "preserved");
  const reopened = fixture({ preferences: f.saved() });
  assert.equal(reopened.style.get("--sidebar-size"), "326px");
});

test("keyboard respects each axis and clamps sizes while preserving lower reading space", () => {
  const f = fixture(), vertical = f.node("#resize-sidebar"), horizontal = f.node("#resize-dashboard");
  vertical.event("keydown", { key: "ArrowRight", shiftKey: true });
  assert.equal(f.saved().sidebar, 274);
  assert.equal(vertical.event("keydown", { key: "ArrowDown" }).prevented, undefined);
  horizontal.event("keydown", { key: "ArrowDown" });
  assert.equal(f.saved().dashboard, 316);
  horizontal.event("keydown", { key: "End" });
  assert.equal(f.saved().dashboard, 480);
  horizontal.event("keydown", { key: "Home" });
  assert.equal(horizontal.getAttribute("aria-valuenow"), "140");
  vertical.event("keydown", { key: "End" });
  f.resize(900, 600);
  assert.equal(f.style.get("--sidebar-size"), "292px");
  assert.equal(vertical.getAttribute("aria-valuemax"), "292");
});

test("cancel, capture loss, escape and window blur revert an unfinished drag", () => {
  for (const cancel of ["pointercancel", "lostpointercapture", "Escape", "blur"]) {
    const f = fixture({ preferences: { sidebar: 250 } }), handle = f.node("#resize-sidebar");
    handle.event("pointerdown", { clientX: 100 });
    handle.event("pointermove", { clientX: 160 });
    handle.event("pointermove", { pointerId: 2, clientX: 500 });
    assert.equal(f.style.get("--sidebar-size"), "310px");
    if (cancel === "Escape") handle.event("keydown", { key: cancel });
    else if (cancel === "blur") f.listeners.blur();
    else handle.event(cancel);
    assert.equal(f.style.get("--sidebar-size"), "250px");
    assert.equal(handle.hasPointerCapture(1), false);
    assert.equal(f.saved().sidebar, 250);
  }
});

test("collapsed dashboard and narrow layouts keep preferences without unusable handles", () => {
  const f = fixture({ preferences: { sidebar: 280, dashboard: 420 } }), flow = f.node(".workstream");
  flow.open = false; flow.event("toggle");
  assert.equal(f.style.has("--dashboard-size"), false);
  assert.equal(f.node("#resize-dashboard").tabIndex, -1);
  f.node("#resize-dashboard").event("keydown", { key: "End" });
  flow.open = true; flow.event("toggle");
  assert.equal(f.style.get("--dashboard-size"), "420px");
  f.resize(800, 700);
  assert.equal(f.style.size, 0); assert.equal(f.node("#resize-sidebar").tabIndex, -1);
  f.resize(1400, 800);
  assert.equal(f.style.get("--sidebar-size"), "280px");
  assert.equal(f.style.get("--dashboard-size"), "420px");
});

test("invalid or unavailable storage cannot block records; reset never clears authentication", () => {
  const f = fixture({ preferences: { sidebar: "999px", dashboard: -100, token: "ignored" } });
  assert.equal(f.style.has("--sidebar-size"), false); assert.equal(f.style.get("--dashboard-size"), "140px");
  f.node("#reset-layout").event("click");
  assert.equal(f.style.size, 0); assert.deepEqual(f.saved(), {});
  assert.equal(f.values.get("connection-token"), "preserved");
  const denied = fixture({ denied: true });
  denied.node("#resize-sidebar").event("keydown", { key: "ArrowRight" });
  assert.equal(denied.style.get("--sidebar-size"), "242px");
});

test("dashboard space switches content density at measured height boundaries", () => {
  const f = fixture(), board = f.node(".service-panel"), handle = f.node("#resize-dashboard");
  assert.equal(board.getAttribute("data-density"), "compact");
  handle.event("keydown", { key: "ArrowDown" });
  assert.equal(board.getAttribute("data-density"), "compact");
  handle.event("keydown", { key: "ArrowDown" });
  assert.equal(board.getAttribute("data-density"), "comfortable");
  handle.event("keydown", { key: "End" });
  assert.equal(board.getAttribute("data-density"), "expanded");
  handle.event("keydown", { key: "ArrowUp" });
  assert.equal(board.getAttribute("data-density"), "comfortable");
  f.node("#reset-layout").event("click");
  assert.equal(board.getAttribute("data-density"), "compact");
});
