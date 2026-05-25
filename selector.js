// Injected on demand when the user starts a screenshot capture. Lets them
// drag a rectangle, then forwards the selection back to the background
// worker which takes the actual screenshot.

(function () {
  if (window.__pinreelSelectorActive) return;
  window.__pinreelSelectorActive = true;

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "cursor:crosshair",
    "background:rgba(7,7,9,0.30)",
    "user-select:none",
  ].join(";");

  const hint = document.createElement("div");
  hint.textContent = "Drag to select a region · Esc to cancel";
  hint.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "padding:6px 12px",
    "background:rgba(7,7,9,0.85)",
    "color:#e8e8ef",
    "font:500 12px -apple-system,BlinkMacSystemFont,sans-serif",
    "border-radius:8px",
    "pointer-events:none",
  ].join(";");

  const rect = document.createElement("div");
  rect.style.cssText = [
    "position:fixed",
    "border:2px solid #a78bfa",
    "background:rgba(167,139,250,0.12)",
    "display:none",
    "pointer-events:none",
  ].join(";");

  overlay.appendChild(rect);
  overlay.appendChild(hint);
  document.documentElement.appendChild(overlay);

  let dragStart = null;

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    window.__pinreelSelectorActive = false;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
    }
  }
  document.addEventListener("keydown", onKey, true);

  overlay.addEventListener("mousedown", (e) => {
    dragStart = { x: e.clientX, y: e.clientY };
    rect.style.left = e.clientX + "px";
    rect.style.top = e.clientY + "px";
    rect.style.width = "0px";
    rect.style.height = "0px";
    rect.style.display = "block";
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!dragStart) return;
    const x = Math.min(dragStart.x, e.clientX);
    const y = Math.min(dragStart.y, e.clientY);
    const w = Math.abs(e.clientX - dragStart.x);
    const h = Math.abs(e.clientY - dragStart.y);
    rect.style.left = x + "px";
    rect.style.top = y + "px";
    rect.style.width = w + "px";
    rect.style.height = h + "px";
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!dragStart) return;
    const x = Math.min(dragStart.x, e.clientX);
    const y = Math.min(dragStart.y, e.clientY);
    const w = Math.abs(e.clientX - dragStart.x);
    const h = Math.abs(e.clientY - dragStart.y);
    dragStart = null;
    cleanup();
    if (w < 20 || h < 20) return;
    requestAnimationFrame(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          kind: "PINREEL_CAPTURE_SCREENSHOT_RECT",
          rect: {
            x,
            y,
            width: w,
            height: h,
            dpr: window.devicePixelRatio || 1,
          },
          sourceUrl: window.location.href,
          title: document.title,
        });
      }, 80);
    });
  });
})();
