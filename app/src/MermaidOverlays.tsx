/**
 * MermaidOverlays — renders mermaid code blocks as diagram overlays.
 *
 * ProseMirror reverts any change to its own DOM, so we NEVER touch the <pre>.
 * Instead we:
 *   1. Hide the raw code + reserve space via injected <style> rules.
 *   2. Render each diagram to SVG and append it as an absolutely-positioned
 *      overlay into the editor's scroll container (so it scrolls natively).
 *   3. Reposition overlays on mutation/resize/scroll.
 *   4. Click → full-screen pan/zoom modal.
 *
 * Mermaid is lazy-loaded (dynamic import) the first time a diagram actually
 * appears, so it stays out of the main bundle. The observers + retry scans are
 * always set up, because the document loads asynchronously and the mermaid
 * code blocks land in the DOM well after this component mounts.
 */

import { useEffect } from "react";
import {
  buildMermaidPrintRules,
  type MermaidPrintEntry,
} from "./mermaid-print";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mermaid = any;

function natSize(svg: string): { w: number; h: number } {
  const m = svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.-]+) ([\d.-]+)"/);
  if (m && +m[1] > 0) return { w: +m[1], h: +m[2] };
  const w = svg.match(/width="([\d.]+)/);
  const h = svg.match(/height="([\d.]+)/);
  return { w: w ? +w[1] : 800, h: h ? +h[1] : 600 };
}

function openModal(svg: string) {
  const nat = natSize(svg);
  const ov = document.createElement("div");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.78);display:flex;flex-direction:column;";

  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:10px 12px;";

  function mkb(t: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = t;
    b.style.cssText =
      "font:14px system-ui;height:32px;min-width:34px;padding:0 12px;border:0;border-radius:6px;background:#ffffff26;color:#fff;cursor:pointer;";
    return b;
  }

  const bOut = mkb("−");
  const pct = document.createElement("span");
  const bIn = mkb("+");
  const bRst = mkb("Reset");
  const bX = mkb("✕ Close");

  pct.style.cssText =
    "min-width:52px;text-align:center;color:#fff;font:13px ui-monospace,monospace;";
  bar.append(bOut, pct, bIn, bRst, bX);

  const vp = document.createElement("div");
  vp.style.cssText =
    "flex:1;overflow:hidden;position:relative;cursor:grab;touch-action:none;";

  const stage = document.createElement("div");
  stage.style.cssText =
    "position:absolute;left:0;top:0;transform-origin:0 0;background:#fff;border-radius:8px;";
  // Safe: mermaid is initialized with securityLevel:"strict" (see below), which
  // runs its own DOMPurify over diagram labels — scripts and inline event
  // handlers (the stored-XSS / GitHub-token-exfil vector) are stripped before
  // the SVG ever reaches this innerHTML sink. See MermaidOverlays.test.ts.
  stage.innerHTML = svg;

  const sv = stage.querySelector("svg");
  if (sv) {
    sv.style.display = "block";
    sv.setAttribute("width", String(nat.w));
    sv.setAttribute("height", String(nat.h));
  }

  vp.appendChild(stage);
  ov.append(bar, vp);
  document.body.appendChild(ov);

  let scale = 1;
  let tx = 0;
  let ty = 0;

  function applyTransform() {
    stage.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
    pct.textContent = `${Math.round(scale * 100)}%`;
  }

  function fit() {
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    scale = Math.min(vw / nat.w, vh / nat.h) * 0.92;
    if (!isFinite(scale) || scale <= 0) scale = 1;
    tx = (vw - nat.w * scale) / 2;
    ty = (vh - nat.h * scale) / 2;
    applyTransform();
  }

  function zoomAt(cx: number, cy: number, f: number) {
    const ns = Math.min(Math.max(scale * f, 0.1), 20);
    tx = cx - ((cx - tx) * ns) / scale;
    ty = cy - ((cy - ty) * ns) / scale;
    scale = ns;
    applyTransform();
  }

  vp.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      zoomAt(
        e.clientX - r.left,
        e.clientY - r.top,
        e.deltaY < 0 ? 1.12 : 1 / 1.12,
      );
    },
    { passive: false },
  );

  bIn.onclick = () => {
    const r = vp.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1.25);
  };
  bOut.onclick = () => {
    const r = vp.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / 1.25);
  };
  bRst.onclick = fit;

  let pan: { x: number; y: number; tx: number; ty: number } | null = null;
  vp.addEventListener("pointerdown", (e) => {
    pan = { x: e.clientX, y: e.clientY, tx, ty };
    vp.style.cursor = "grabbing";
    try {
      vp.setPointerCapture(e.pointerId);
    } catch {}
  });
  vp.addEventListener("pointermove", (e) => {
    if (!pan) return;
    tx = pan.tx + (e.clientX - pan.x);
    ty = pan.ty + (e.clientY - pan.y);
    applyTransform();
  });
  vp.addEventListener("pointerup", () => {
    pan = null;
    vp.style.cursor = "grab";
  });

  function close() {
    ov.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", fit);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", fit);
  bX.onclick = close;
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });

  fit();
}

function runMermaidOverlays(signal: AbortSignal): () => void {
  const dark = document.documentElement.classList.contains("dark");
  const theme = dark
    ? { bg: "#0b0b0c", bd: "#27272a" }
    : { bg: "#ffffff", bd: "#e5e7eb" };

  // ── lazy mermaid loader (only fires once a real block exists) ──
  let mermaid: Mermaid = null;
  let mermaidPromise: Promise<Mermaid> | null = null;
  function ensureMermaid(): Promise<Mermaid> {
    if (mermaid) return Promise.resolve(mermaid);
    if (!mermaidPromise) {
      mermaidPromise = import("mermaid")
        .then((mod) => {
          mermaid = mod.default ?? mod;
          try {
            mermaid.initialize({
              startOnLoad: false,
              // strict disables clickable nodes + HTML <script>/event handlers in
              // labels — the stored-XSS path that could read the repo-write GitHub
              // token from sessionStorage. Diagrams come from arbitrary third-party
              // markdown, so they are untrusted. (Was "loose" — REC-380.)
              securityLevel: "strict",
              theme: dark ? "dark" : "default",
            });
          } catch {}
          return mermaid;
        })
        .catch((e) => {
          console.warn("[MermaidOverlays] failed to load mermaid:", e);
          return null;
        });
    }
    return mermaidPromise;
  }

  // ── scroll container (detected once the first block appears) ──
  let scrollerEl: Element = document.body;
  let scrollerWin = true;
  let scrollerDetected = false;
  let scrollListenerEl: Element | null = null;
  function detectScroller() {
    if (scrollerDetected) return;
    const firstCode = document.querySelector("pre > code.language-mermaid");
    if (!firstCode) return;
    scrollerDetected = true;
    let el: Element | null = firstCode.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      if (
        /(auto|scroll)/.test(s.overflowY) &&
        (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 4
      ) {
        scrollerEl = el;
        scrollerWin = false;
        break;
      }
      el = el.parentElement;
    }
    if (!scrollerWin && getComputedStyle(scrollerEl).position === "static") {
      (scrollerEl as HTMLElement).style.position = "relative";
    }
    if (!scrollerWin) {
      scrollerEl.addEventListener("scroll", scheduleReposition);
      scrollListenerEl = scrollerEl;
    }
  }

  // ── injected stylesheets (harmless when no blocks) ──
  const sizeSheet = document.createElement("style");
  sizeSheet.dataset.mermaidSizes = "true";
  (document.head || document.documentElement).appendChild(sizeSheet);

  const hideSheet = document.createElement("style");
  hideSheet.dataset.mermaidHide = "true";
  hideSheet.textContent =
    "pre:has(> code.language-mermaid){min-height:120px;}" +
    "pre:has(> code.language-mermaid) > code{opacity:0;}";
  (document.head || document.documentElement).appendChild(hideSheet);

  // Diagrams print as backgrounds on the reserved <pre> instead of as overlays,
  // which cannot paginate — see `mermaid-print.ts`.
  const printSheet = document.createElement("style");
  printSheet.dataset.mermaidPrint = "true";
  (document.head || document.documentElement).appendChild(printSheet);

  type BoxEntry = {
    box: HTMLElement;
    pre: HTMLElement;
    aspect: number;
    svg: string;
  };
  const done = new WeakSet<HTMLElement>();
  const boxes: BoxEntry[] = [];
  let idc = 0;
  const cache = new Map<string, string>();

  function renderDiagram(def: string): Promise<string> {
    const cached = cache.get(def);
    if (cached) return Promise.resolve(cached);
    return mermaid.render(`rn-m-${idc++}`, def).then((r: { svg: string }) => {
      cache.set(def, r.svg);
      return r.svg;
    });
  }

  function applySizes() {
    const rules: string[] = [];
    const printEntries: MermaidPrintEntry[] = [];
    for (const entry of boxes) {
      if (!entry.pre.isConnected) continue;
      const par = entry.pre.parentElement;
      if (!par) continue;
      const idx = Array.prototype.indexOf.call(par.children, entry.pre) + 1;
      if (idx < 1) continue;
      printEntries.push({ index: idx, svg: entry.svg, aspect: entry.aspect });
      const w = entry.pre.clientWidth || 700;
      const h = Math.min(
        Math.max(Math.round(w * entry.aspect) + 12, 70),
        Math.round(window.innerHeight * 0.85),
      );
      rules.push(
        `.ProseMirror>pre:nth-child(${idx}){height:${h}px!important;min-height:${h}px!important;}`,
        `.tiptap>pre:nth-child(${idx}){height:${h}px!important;min-height:${h}px!important;}`,
      );
    }
    sizeSheet.textContent = rules.join("");
    printSheet.textContent = buildMermaidPrintRules(printEntries);
  }

  function reposition() {
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (!boxes[i].pre.isConnected) {
        boxes[i].box.remove();
        boxes.splice(i, 1);
      }
    }
    applySizes();

    // Batch reads then writes to avoid layout thrashing on scroll/resize:
    // read every <pre> rect (and the scroller rect once) up front, then write
    // all overlay styles in a second pass.
    const ar = scrollerWin ? null : scrollerEl.getBoundingClientRect();
    const placements = boxes.map((entry) => ({
      box: entry.box,
      pr: entry.pre.getBoundingClientRect(),
    }));
    for (const { box, pr } of placements) {
      if (scrollerWin) {
        box.style.left = `${pr.left + window.scrollX}px`;
        box.style.top = `${pr.top + window.scrollY}px`;
      } else {
        const rect = ar as DOMRect;
        box.style.left = `${pr.left - rect.left + (scrollerEl as HTMLElement).scrollLeft}px`;
        box.style.top = `${pr.top - rect.top + (scrollerEl as HTMLElement).scrollTop}px`;
      }
      box.style.width = `${pr.width}px`;
      box.style.height = `${pr.height}px`;
    }
  }

  // rAF-throttle reposition so a burst of scroll/resize events collapses into
  // a single layout pass per frame.
  let repositionFrame: number | null = null;
  function scheduleReposition() {
    if (repositionFrame != null) return;
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = null;
      reposition();
    });
  }

  function applyBlock(pre: HTMLElement) {
    if (done.has(pre)) return;
    done.add(pre);
    const code = pre.firstElementChild as HTMLElement | null;
    if (!code) {
      done.delete(pre);
      return;
    }
    const def = code.textContent ?? "";
    ensureMermaid()
      .then((m) => {
        if (!m || signal.aborted) {
          done.delete(pre);
          return;
        }
        detectScroller();
        return renderDiagram(def).then((svg) => {
          if (signal.aborted) return;
          const n = natSize(svg);
          const aspect = n.w > 0 ? n.h / n.w : 0.5;
          const box = document.createElement("div");
          box.style.cssText = `position:absolute;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:12px;background:${theme.bg};border:1px solid ${theme.bd};border-radius:8px;overflow:hidden;cursor:zoom-in;`;
          box.title = "Click to zoom";
          box.innerHTML = svg; // strict-mode mermaid output is inert — see openModal note + tests
          const sv = box.querySelector("svg");
          if (sv) {
            sv.style.maxWidth = "100%";
            sv.style.maxHeight = "100%";
            sv.style.height = "auto";
            sv.style.pointerEvents = "none";
            sv.removeAttribute("height");
          }
          box.onclick = () => openModal(svg);
          // Hidden in print (style.css) in favour of the background-painted
          // <pre>, which paginates.
          box.dataset.mermaidOverlay = "true";
          scrollerEl.appendChild(box);
          boxes.push({ box, pre, aspect, svg });
          reposition();
        });
      })
      .catch((e) => {
        done.delete(pre);
        console.warn("[MermaidOverlays] render failed:", e);
      });
  }

  function scan() {
    const blocks = document.querySelectorAll<HTMLElement>(
      "pre > code.language-mermaid",
    );
    // Nothing to render and nothing already rendered → skip the layout work so a
    // diagram-free document doesn't reflow on every keystroke.
    if (blocks.length === 0 && boxes.length === 0) return;
    if (blocks.length) detectScroller();
    blocks.forEach((c) => applyBlock(c.parentElement as HTMLElement));
    reposition();
  }

  // Debounced MutationObserver — the doc content arrives after mount.
  let debTimer: ReturnType<typeof setTimeout> | null = null;
  const mutObs = new MutationObserver(() => {
    if (debTimer) clearTimeout(debTimer);
    debTimer = setTimeout(scan, 150);
  });
  const editorRoot =
    document.querySelector(".ProseMirror") ??
    document.querySelector(".tiptap") ??
    document.body;
  mutObs.observe(editorRoot, { childList: true, subtree: true });
  // Also observe body in case the editor root itself mounts later.
  const bodyObs = new MutationObserver(() => {
    if (debTimer) clearTimeout(debTimer);
    debTimer = setTimeout(scan, 150);
  });
  if (editorRoot === document.body) {
    // editorRoot already body; the single observer covers it.
    bodyObs.disconnect();
  } else {
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  let resObs: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    try {
      resObs = new ResizeObserver(scheduleReposition);
      resObs.observe(editorRoot);
    } catch {}
  }

  window.addEventListener("resize", scheduleReposition);

  // Retry scans — editor lays out async after the doc loads.
  const timers = [0, 300, 800, 1500, 2500, 4000].map((t) =>
    setTimeout(scan, t),
  );

  return () => {
    mutObs.disconnect();
    bodyObs.disconnect();
    resObs?.disconnect();
    window.removeEventListener("resize", scheduleReposition);
    if (scrollListenerEl)
      scrollListenerEl.removeEventListener("scroll", scheduleReposition);
    if (repositionFrame != null) cancelAnimationFrame(repositionFrame);
    if (debTimer) clearTimeout(debTimer);
    timers.forEach((t) => clearTimeout(t));
    for (const entry of boxes) entry.box.remove();
    boxes.length = 0;
    sizeSheet.remove();
    hideSheet.remove();
    printSheet.remove();
  };
}

export function MermaidOverlays() {
  useEffect(() => {
    const controller = new AbortController();
    const cleanup = runMermaidOverlays(controller.signal);
    return () => {
      controller.abort();
      cleanup();
    };
  }, []);
  return null;
}
