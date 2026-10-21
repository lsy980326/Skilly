const storageKey = "skilly.viewer.layout.v1";

// Preferences affect this browser's layout only; never touch the connection token.
export function createViewerLayout({ document, window, getStorage }) {
  const workspace = document.querySelector(".workspace");
  const board = document.querySelector(".service-panel");
  const flow = document.querySelector(".workstream");
  const handles = ["sidebar", "dashboard"].map(axis => [axis, document.querySelector(`#resize-${axis}`)]);
  let preferences = {}, drag = null;
  try {
    const saved = JSON.parse(getStorage().getItem(storageKey));
    for (const key of ["sidebar", "dashboard"]) {
      if (typeof saved?.[key] === "number" && Number.isFinite(saved[key])) preferences[key] = saved[key];
    }
  } catch { /* Layout storage is optional, including when the browser denies access. */ }
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function limits(axis) {
    const size = workspace.getBoundingClientRect();
    return axis === "sidebar" ? [160, Math.max(160, Math.min(360, size.width - 608))]
      : [140, Math.max(140, Math.min(size.height * .6, size.height - 248))];
  }
  function current(axis) {
    return (axis === "sidebar" ? document.querySelector(".projects-panel") : board).getBoundingClientRect()[axis === "sidebar" ? "width" : "height"];
  }
  function save() {
    try { getStorage().setItem(storageKey, JSON.stringify(preferences)); }
    catch { /* A failed preference save must not interrupt reading records. */ }
  }
  function render() {
    const desktop = window.matchMedia("(min-width: 851px)").matches;
    for (const [axis, handle] of handles) {
      const enabled = desktop && (axis !== "dashboard" || flow.open);
      const [min, max] = limits(axis);
      const value = clamp(preferences[axis] ?? current(axis), min, max);
      if (enabled && preferences[axis] !== undefined) workspace.style.setProperty(`--${axis}-size`, `${value}px`);
      else workspace.style.removeProperty(`--${axis}-size`);
      handle.setAttribute("aria-disabled", String(!enabled));
      handle.tabIndex = enabled ? 0 : -1;
      handle.setAttribute("aria-valuemin", String(Math.round(min)));
      handle.setAttribute("aria-valuemax", String(Math.round(max)));
      handle.setAttribute("aria-valuenow", String(Math.round(value)));
      handle.setAttribute("aria-valuetext", `${Math.round(value)}픽셀`);
    }
    workspace.classList.toggle("custom-dashboard", desktop && flow.open && preferences.dashboard !== undefined);
    const height = current("dashboard");
    board.setAttribute("data-density", !desktop ? "comfortable" : height >= 480 ? "expanded" : height >= 320 ? "comfortable" : "compact");
  }
  function set(axis, value) {
    const [min, max] = limits(axis);
    preferences[axis] = Math.round(clamp(value, min, max));
    render();
  }
  function end(event, commit) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const previous = drag;
    drag = null;
    workspace.classList.remove("resizing-sidebar", "resizing-dashboard");
    if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    if (commit) save();
    else { preferences = previous.preferences; render(); }
  }
  for (const [axis, handle] of handles) {
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || handle.getAttribute("aria-disabled") === "true" || drag) return;
      event.preventDefault();
      drag = { axis, handle, pointerId: event.pointerId, origin: axis === "sidebar" ? event.clientX : event.clientY,
        size: current(axis), preferences: { ...preferences } };
      handle.setPointerCapture(event.pointerId);
      handle.focus();
      workspace.classList.add(`resizing-${axis}`);
    });
    handle.addEventListener("pointermove", event => {
      if (drag?.pointerId !== event.pointerId || drag.handle !== handle) return;
      set(axis, drag.size + (axis === "sidebar" ? event.clientX : event.clientY) - drag.origin);
    });
    handle.addEventListener("pointerup", event => end(event, true));
    handle.addEventListener("pointercancel", event => end(event, false));
    handle.addEventListener("lostpointercapture", event => end(event, false));
    handle.addEventListener("keydown", event => {
      if (event.key === "Escape" && drag) { event.preventDefault(); end(null, false); return; }
      if (handle.getAttribute("aria-disabled") === "true" || drag) return;
      const keys = axis === "sidebar" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      if (![...keys, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const [min, max] = limits(axis), step = event.shiftKey ? 48 : 16;
      const value = event.key === "Home" ? min : event.key === "End" ? max : current(axis) + (event.key === keys[0] ? -step : step);
      set(axis, value); save();
    });
    handle.addEventListener("dblclick", () => {
      end(null, false); delete preferences[axis]; render(); save();
    });
  }
  document.querySelector("#reset-layout").addEventListener("click", () => {
    end(null, false); preferences = {}; render(); save();
  });
  flow.addEventListener("toggle", () => { end(null, false); render(); });
  window.addEventListener("resize", () => { end(null, false); render(); });
  window.addEventListener("blur", () => end(null, false));
  if (window.ResizeObserver) new window.ResizeObserver(render).observe(board);
  render();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  createViewerLayout({ document, window, getStorage: () => localStorage });
}
