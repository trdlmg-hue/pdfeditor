/* =========================================================================
   PDF Studio — browser-based layered PDF editor
   - renders the original PDF with pdf.js
   - every edit is a fabric.js object on its own layer
   - exports with pdf-lib (vector overlay) or flattened raster
   ========================================================================= */
(function () {
  "use strict";

  /* ------------------------------ libraries ------------------------------ */
  const pdfjsLib = window.pdfjsLib;
  const fabric = window.fabric;
  const PDFLib = window.PDFLib;

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

  /* ------------------------------ dom ------------------------------ */
  const $ = (id) => document.getElementById(id);

  /* Build an <svg class="ico"><use href="#i-name"></use></svg> node that
     references the sprite defined in index.html. */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ico");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }
  function setIcon(node, name) {
    if (!node) return node;
    node.textContent = "";
    node.appendChild(svgIcon(name));
    return node;
  }

  const el = {
    stage: $("stage"),
    pageWrap: $("pageWrap"),
    bgCanvas: $("bgCanvas"),
    filename: $("fileName"),
    zoomLabel: $("zoomLabel"),
    pageLabel: $("pageLabel"),
    undo: $("undoBtn"),
    redo: $("redoBtn"),
    empty: $("emptyState"),
    dropVeil: $("dropVeil"),
    toast: $("toast"),
    progress: $("progress"),
    progressText: $("progressText"),
    layerList: $("layerList"),
    layerCount: $("layerCount"),
    fileInput: $("fileInput"),
    pdfInput: $("pdfInput"),
    exportBtn: $("exportBtn"),
    exportMenu: $("exportMenu"),
  };

  /* ------------------------------ state ------------------------------ */
  const S = {
    bytes: null,
    srcDoc: null,
    docs: new Map(),      // docId -> { doc, bytes, name, lib, encrypted }
    name: "",
    pages: [],
    index: 0,
    viewIndex: -1,        // page whose JSON is currently loaded on the canvas
    zoom: 1,
    tool: "select",
    ready: false,
    bgScale: 1,
    encrypted: false,
    drawing: null,
    drawStart: null,
    suppressHistory: false,
    pendingImage: null,
    hintShown: false,
    rotateHintShown: false,
    pageSel: new Set(),
    pageDrag: null,
    tableMeta: new Map(), // tableId -> table model
  };

  const DPR = () => Math.min(2, window.devicePixelRatio || 1);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const EXTRA = [
    "pdfFont",
    "isPatch",
    "isOriginalImage",
    "srcOp",
    "srcKey",
    "customFont",
    "uid",
    "patchUid",
    "tableId",
    "cellRow",
    "cellCol",
    "locked",
    "isSignature",
    "isTableGrid",
    "insertedTable",
  ];

  /* page-size presets, in PDF points */
  const PAGE_PRESETS = {
    a4: { label: "A4", w: 595.28, h: 841.89, unit: "mm" },
    a3: { label: "A3", w: 841.89, h: 1190.55, unit: "mm" },
    letter: { label: "Letter", w: 612, h: 792, unit: "in" },
    legal: { label: "Legal", w: 612, h: 1008, unit: "in" },
  };
  const UNIT_PT = { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, px: 0.75, pt: 1 };

  /* ------------------------------ canvas ------------------------------ */
  const canvas = new fabric.Canvas("c", {
    backgroundColor: null,
    preserveObjectStacking: true,
    selection: true,
    enableRetinaScaling: true,
    imageSmoothingEnabled: true,
  });

  fabric.Object.prototype.set({
    borderColor: "#3b82f6",
    cornerColor: "#3b82f6",
    cornerStrokeColor: "#0b0f19",
    cornerStyle: "circle",
    cornerSize: 10,
    transparentCorners: false,
    borderScaleFactor: 1.4,
  });

  /* A big, recognisable rotation handle above every selected object.  The
     stock fabric handle is a tiny dot and is easy to miss (and can be clipped
     when the object sits near the top of the page), so draw a white disc with
     a circular arrow instead. */
  (function styleRotationHandle() {
    const control = fabric.Object.prototype.controls && fabric.Object.prototype.controls.mtr;
    if (!control) return;
    control.sizeX = 30;
    control.sizeY = 30;
    control.offsetY = -46;
    const arrow = typeof Path2D === "function" ? new Path2D("M20 10a8 8 0 1 0-2.4 7.7M20 4v6h-6") : null;
    control.render = function (ctx, left, top) {
      const size = 30;
      ctx.save();
      ctx.translate(left, top);
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#3b82f6";
      ctx.stroke();
      if (arrow) {
        ctx.scale(size / 24, size / 24);
        ctx.translate(-12, -12);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = "#3b82f6";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke(arrow);
      }
      ctx.restore();
    };
  })();

  /* Locked objects stay selectable (so they can be unlocked) but cannot be
     moved, resized or rotated.  The flag is persisted through EXTRA. */
  function applyLock(o, locked) {
    if (!o) return;
    o.locked = !!locked;
    if (locked) {
      o.lockMovementX = true;
      o.lockMovementY = true;
      o.lockScalingX = true;
      o.lockScalingY = true;
      o.lockRotation = true;
      o.hasControls = false;
      o.hoverCursor = "pointer";
    } else {
      o.lockMovementX = false;
      o.lockMovementY = false;
      o.lockScalingX = false;
      o.lockScalingY = false;
      o.lockRotation = false;
      o.hasControls = true;
      o.hoverCursor = "move";
    }
    o.setCoords();
  }

  /* Objects restored from JSON carry `locked` but not fabric's lock flags. */
  canvas.on("object:added", (e) => {
    if (e.target && e.target.locked) applyLock(e.target, true);
  });

  const FONTS = {
    helvetica: { css: "Helvetica, Arial, sans-serif", label: "Helvetica", pdf: "helvetica" },
    times: { css: '"Times New Roman", Times, serif', label: "Times", pdf: "times" },
    courier: { css: '"Courier New", Courier, monospace', label: "Courier", pdf: "courier" },
  };

  /* ------------------------------ custom fonts ------------------------------ */
  const FONT_STORE_KEY = "pdfstudio.fonts.v1";
  const fontFaces = new Map();   // internal family -> FontFace (or null for Google)
  const googleLinks = new Map(); // internal family -> <link>
  const customFonts = new Map(); // key -> { key, family, label, source, css }

  function isCustomFont(o) {
    if (!o) return false;
    const key = o.pdfFont;
    if (key && FONTS[key] && FONTS[key].custom) return true;
    return !!(o.customFont && FONTS[o.customFont] && FONTS[o.customFont].custom);
  }

  function makeFontKey(family) {
    let k = "custom:" + String(family).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!FONTS[k]) return k;
    let n = 2;
    while (FONTS[k + "-" + n]) n++;
    return k + "-" + n;
  }

  function registerCustomFont(def) {
    const key = def.key || makeFontKey(def.family);
    const css = '"' + def.family.replace(/"/g, '\\"') + '", sans-serif';
    const entry = Object.assign({}, def, { key, css, custom: true });
    FONTS[key] = { css, label: entry.label, pdf: null, custom: true, family: entry.family, source: entry.source };
    customFonts.set(key, entry);
    ensureFontOptions();
    renderCustomFonts();
    return key;
  }

  function ensureFontOptions() {
    const sel = $("fontFamily");
    if (!sel) return;
    const current = sel.value;
    const std = ["helvetica", "times", "courier"];

    // remove old custom options
    Array.from(sel.querySelectorAll("option")).forEach((o) => {
      if (o.dataset.custom) o.remove();
    });

    if (!sel.querySelector("optgroup[data-custom]")) {
      const group = document.createElement("optgroup");
      group.label = "My fonts";
      group.dataset.custom = "1";
      sel.appendChild(group);
    }
    const group = sel.querySelector("optgroup[data-custom]");
    for (const [key] of customFonts) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = FONTS[key].label || key;
      opt.dataset.custom = "1";
      group.appendChild(opt);
    }
    if (std.includes(current) || customFonts.has(current)) sel.value = current;
  }

  function renderCustomFonts() {
    const wrap = $("customFonts");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!customFonts.size) {
      const d = document.createElement("div");
      d.className = "empty-layers";
      d.textContent = "No custom fonts yet. Add a font file or a Google Font.";
      wrap.appendChild(d);
      return;
    }
    for (const [key, f] of customFonts) {
      const row = document.createElement("div");
      row.className = "font-row";

      const name = document.createElement("span");
      name.className = "f-name";
      name.textContent = f.label;
      name.style.fontFamily = f.css;

      const tag = document.createElement("span");
      tag.className = "f-tag";
      tag.textContent = f.source === "google" ? "Google" : "File";

      const del = document.createElement("button");
      del.className = "l-btn";
      del.title = "Remove this font from the list";
      del.textContent = "×";
      del.addEventListener("click", () => removeCustomFont(key));

      row.append(name, tag, del);
      wrap.appendChild(row);
    }
  }

  function removeCustomFont(key) {
    const f = customFonts.get(key);
    if (!f) return;
    if (f.source === "google" && googleLinks.has(f.family)) {
      try { googleLinks.get(f.family).remove(); } catch (e) { /* ignore */ }
      googleLinks.delete(f.family);
    }
    if (fontFaces.has(f.family)) {
      try { document.fonts.delete(fontFaces.get(f.family)); } catch (e) { /* ignore */ }
      fontFaces.delete(f.family);
    }
    if (isCustomFont(canvas.getActiveObject())) syncProps();
    delete FONTS[key];
    customFonts.delete(key);
    persistFonts();
    ensureFontOptions();
    renderCustomFonts();
    fabric.util.clearFabricFontCache();
    canvas.requestRenderAll();
    toast("Font removed — text using it will fall back", 2600);
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  async function loadFontFace(family, buffer) {
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
    fontFaces.set(family, face);
    fabric.util.clearFabricFontCache();
    return face;
  }

  async function addFontFile(file) {
    if (!file) return;
    showProgress("Loading font…");
    try {
      const buf = await file.arrayBuffer();
      const base = (file.name || "font").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
      const label = base || "Custom font";
      // unique internal family so two files with the same label never clash
      const family = "PS " + label + " " + Date.now().toString(36);
      await loadFontFace(family, buf);
      let dataUrl = "";
      try { dataUrl = await blobToDataUrl(file); } catch (e) { /* ignore */ }
      const key = registerCustomFont({ family, label, source: "file", dataUrl });
      $("fontFamily").value = key;
      applyToSelection((o) => {
        o.set("fontFamily", FONTS[key].css);
        o.pdfFont = key;
        o.customFont = key;
      }, true);
      persistFonts();
      toast(`Font “${label}” added`, 2600);
    } catch (err) {
      console.warn("Font file failed to load", err);
      toast("Could not load that font file: " + err.message, 4000);
    } finally {
      hideProgress();
    }
  }

  async function addGoogleFont(name) {
    const clean = String(name || "").trim();
    if (!clean) return;
    showProgress("Loading Google font…");
    try {
      const family = clean;
      if (!googleLinks.has(family)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href =
          "https://fonts.googleapis.com/css2?family=" +
          encodeURIComponent(family).replace(/%20/g, "+") +
          ":ital,wght@0,400;0,700;1,400;1,700&display=swap";
        document.head.appendChild(link);
        const ok = await new Promise((res) => {
          link.onload = () => res(true);
          link.onerror = () => res(false);
          setTimeout(() => res(true), 4000);
        });
        if (!ok) {
          link.remove();
          throw new Error("font not found on Google Fonts");
        }
        googleLinks.set(family, link);
      }
      const loaded = await document.fonts.load(`400 20px "${family}"`);
      if (!loaded.length) {
        if (googleLinks.has(family)) {
          try { googleLinks.get(family).remove(); } catch (e) { /* ignore */ }
          googleLinks.delete(family);
        }
        throw new Error("that family was not found on Google Fonts");
      }
      await Promise.all([
        document.fonts.load(`700 20px "${family}"`).catch(() => []),
        document.fonts.load(`italic 400 20px "${family}"`).catch(() => []),
        document.fonts.load(`italic 700 20px "${family}"`).catch(() => []),
      ]);
      fabric.util.clearFabricFontCache();
      const key = registerCustomFont({ family, label: family, source: "google" });
      $("fontFamily").value = key;
      applyToSelection((o) => {
        o.set("fontFamily", FONTS[key].css);
        o.pdfFont = key;
        o.customFont = key;
      }, true);
      persistFonts();
      toast(`Google font “${family}” added`, 2600);
    } catch (err) {
      console.warn("Google font failed to load", err);
      toast("Could not load that Google Font: " + err.message, 4000);
    } finally {
      hideProgress();
    }
  }

  function persistFonts() {
    try {
      const defs = Array.from(customFonts.values()).map((f) => ({
        family: f.family,
        label: f.label,
        source: f.source,
        dataUrl: f.source === "file" ? f.dataUrl : "",
      }));
      localStorage.setItem(FONT_STORE_KEY, JSON.stringify(defs));
    } catch (e) {
      // quota exceeded -> keep them for this session only
      console.warn("Could not save custom fonts", e);
    }
  }

  async function restoreFonts() {
    let defs = [];
    try {
      defs = JSON.parse(localStorage.getItem(FONT_STORE_KEY) || "[]");
    } catch (e) {
      defs = [];
    }
    for (const def of defs) {
      try {
        if (def.source === "file" && def.dataUrl) {
          const res = await fetch(def.dataUrl);
          const buf = await res.arrayBuffer();
          await loadFontFace(def.family, buf);
          registerCustomFont(def);
        } else if (def.source === "google") {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href =
            "https://fonts.googleapis.com/css2?family=" +
            encodeURIComponent(def.family).replace(/%20/g, "+") +
            ":ital,wght@0,400;0,700;1,400;1,700&display=swap";
          document.head.appendChild(link);
          googleLinks.set(def.family, link);
          await document.fonts.load(`400 20px "${def.family}"`).catch(() => null);
          registerCustomFont(def);
        }
      } catch (e) {
        console.warn("Could not restore font", def.label, e);
      }
    }
    fabric.util.clearFabricFontCache();
  }


  /* ------------------------------ tiny utils ------------------------------ */
  let toastTimer = null;
  function toast(msg, ms = 2400) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
  }

  function showProgress(text) {
    el.progressText.textContent = text || "Working…";
    el.progress.classList.add("show");
  }
  function progress(text) {
    if (text) el.progressText.textContent = text;
  }
  function hideProgress() {
    el.progress.classList.remove("show");
  }

  const hex2 = (n) => n.toString(16).padStart(2, "0");
  const rgbToHex = (r, g, b) => "#" + hex2(r) + hex2(g) + hex2(b);

  function toHexColor(c) {
    try {
      if (!c || c === "none" || c === "transparent") return null;
      const col = new fabric.Color(c);
      if (col.getAlpha() === 0) return null;
      return col.toHex();
    } catch (e) {
      return null;
    }
  }

  function colorAlpha(c) {
    try {
      return new fabric.Color(c).getSource()[3];
    } catch (e) {
      return 1;
    }
  }

  function pdfColor(c) {
    const src = new fabric.Color(c || "#000").getSource();
    return rgb(src[0] / 255, src[1] / 255, src[2] / 255);
  }

  const isText = (o) => o && (o.type === "i-text" || o.type === "textbox" || o.type === "text");

  function rotatePoint(x, y, rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  function avgScale(o) {
    const sx = Math.abs(o.scaleX == null ? 1 : o.scaleX);
    const sy = Math.abs(o.scaleY == null ? 1 : o.scaleY);
    return (sx + sy) / 2;
  }

  function debounce(fn, wait) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  function guessFontKey(family) {
    const f = String(family || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    if (/courier|mono|consol|fixed|menlo|monaco|inconsolata|source code|typewriter/.test(f)) return "courier";
    if (/times|serif|roman|georgia|cambria|garamond|palatino|book antiqua|minion|baskerville|bodoni|century|caslon/.test(f)) return "times";
    if (/helvetica|arial|sans|calibri|verdana|tahoma|segoe|futura|myriad|avenir|roboto|lato|noto|open sans|inter|ui sans|system/.test(f)) return "helvetica";
    if (f.includes("helvetica")) return "helvetica";
    if (f.includes("times")) return "times";
    if (f.includes("courier")) return "courier";
    return "helvetica";
  }

  /* ======================================================================
     PAGE MODEL
     A page can come from a PDF (possibly a different document), a blank
     page, or an image.  extraRotation is the user rotation on top of the
     PDF's intrinsic rotation, so pages can be rotated without losing the
     original vector data.
     ====================================================================== */
  function emptyPageData(over) {
    return Object.assign(
      {
        docId: null,
        src: null,
        kind: "blank",          // pdf | blank | image
        image: null,            // data URL for image pages
        bgImage: null,          // raster override (background removal)
        viewBox: null,
        baseWidth: 595.28,
        baseHeight: 841.89,
        baseRotation: 0,
        extraRotation: 0,
        width: 595.28,
        height: 841.89,
        rotation: 0,
        json: null,
        text: null,
        tables: null,
        history: [],
        histIdx: -1,
        hiddenOcc: [],
        hiddenOps: [],
        imgOps: null,
        imgOpsPromise: null,
        thumb: null,
      },
      over || {}
    );
  }

  function isPdfPage(p) {
    return !!(p && p.kind === "pdf" && p.docId && p.src != null && S.docs.has(p.docId));
  }

  function docRecord(p) {
    return isPdfPage(p) ? S.docs.get(p.docId) : null;
  }

  async function pageProxyFor(p) {
    const rec = docRecord(p);
    if (!rec || !rec.doc) return null;
    return rec.doc.getPage(p.src + 1);
  }

  function pageViewportMatrix(p, rotation) {
    if (!p || !p.viewBox) return null;
    try {
      const vp = new pdfjsLib.PageViewport({
        viewBox: p.viewBox,
        scale: 1,
        rotation: rotation || 0,
        dontFlip: false,
      });
      return vp.transform;
    } catch (e) {
      return null;
    }
  }

  function invertAffine(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c || 1e-9;
    return [
      d / det,
      -b / det,
      -c / det,
      a / det,
      (c * f - d * e) / det,
      (b * e - a * f) / det,
    ];
  }

  function applyAffine(m, x, y) {
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  }

  /* base (intrinsic-rotation text space) -> display coordinates */
  function pageMap(p) {
    if (!p || !p.extraRotation) return null;
    const base = pageViewportMatrix(p, p.baseRotation);
    const disp = pageViewportMatrix(p, p.rotation);
    if (!base || !disp) return null;
    return mulMatrix(disp, invertAffine(base));
  }

  function toBasePoint(p, pt) {
    const m = pageMap(p);
    if (!m) return pt;
    return applyAffine(invertAffine(m), pt.x, pt.y);
  }

  function mapPageBox(p, box) {
    const m = pageMap(p);
    if (!m) {
      return { left: box.left, top: box.top, width: box.width, height: box.height, angle: 0 };
    }
    const q = applyAffine(m, box.left, box.top);
    const angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    return { left: q.x, top: q.y, width: box.width, height: box.height, angle };
  }

  function mapPageBBox(p, box) {
    const m = pageMap(p);
    if (!m) return { left: box.left, top: box.top, width: box.width, height: box.height };
    const pts = [
      applyAffine(m, box.left, box.top),
      applyAffine(m, box.left + box.width, box.top),
      applyAffine(m, box.left, box.top + box.height),
      applyAffine(m, box.left + box.width, box.top + box.height),
    ];
    const left = Math.min(...pts.map((q) => q.x));
    const top = Math.min(...pts.map((q) => q.y));
    const right = Math.max(...pts.map((q) => q.x));
    const bottom = Math.max(...pts.map((q) => q.y));
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  function rotateImageDataUrl(url, delta) {
    return new Promise((res) => {
      loadImageElement(url)
        .then((img) => {
          const swap = Math.abs(delta) % 180 === 90;
          const c = document.createElement("canvas");
          c.width = swap ? img.height : img.width;
          c.height = swap ? img.width : img.height;
          const ctx = c.getContext("2d");
          ctx.translate(c.width / 2, c.height / 2);
          ctx.rotate((delta * Math.PI) / 180);
          ctx.drawImage(img, -img.width / 2, -img.height / 2);
          res(c.toDataURL("image/png"));
        })
        .catch(() => res(url));
    });
  }

  function rotateObjectsAround(objs, oldW, oldH, newW, newH, delta) {
    const rad = (delta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = oldW / 2;
    const cy = oldH / 2;
    const ncx = newW / 2;
    const ncy = newH / 2;
    for (const o of objs) {
      let c;
      try {
        c = o.getCenterPoint();
      } catch (e) {
        continue;
      }
      const dx = c.x - cx;
      const dy = c.y - cy;
      const nx = ncx + dx * cos - dy * sin;
      const ny = ncy + dx * sin + dy * cos;
      /* angle first: setPositionByOrigin places the rotated bounds around the
         requested centre, so rotating afterwards would drag the object away */
      o.set("angle", (o.angle || 0) + delta);
      o.setPositionByOrigin(new fabric.Point(nx, ny), "center", "center");
      o.setCoords();
    }
  }

  async function rotateSavedPage(p, delta, newW, newH) {
    const objs = await enlivenPage(p);
    if (objs.length) {
      rotateObjectsAround(objs, p.width, p.height, newW, newH, delta);
      const res = {
        version: fabric.version,
        objects: objs.map((o) => o.toObject(EXTRA)),
      };
      p.json = JSON.stringify(res);
    }
    p.history = [{ json: p.json || "", hidden: (p.hiddenOcc || []).slice() }];
    p.histIdx = 0;
  }

  async function applyPageRotation(p, delta) {
    if (!p || !delta) return;
    const oldW = p.width;
    const oldH = p.height;
    const swap = Math.abs(delta) % 180 === 90;
    const newW = swap ? oldH : oldW;
    const newH = swap ? oldW : oldH;
    const isCurrent = S.pages[S.index] === p;

    if (isCurrent) {
      canvas.discardActiveObject();
      rotateObjectsAround(canvas.getObjects().slice(), oldW, oldH, newW, newH, delta);
      canvas.renderAll();
    } else if (p.json) {
      await rotateSavedPage(p, delta, newW, newH);
    }

    p.extraRotation = ((p.extraRotation + delta) % 360 + 360) % 360;
    p.width = newW;
    p.height = newH;
    p.rotation = ((p.baseRotation + p.extraRotation) % 360 + 360) % 360;
    p.text = null;
    p.tables = null;
    p.imgOps = null;
    p.imgOpsPromise = null;
    p.thumb = null;
    if (p.bgImage) p.bgImage = await rotateImageDataUrl(p.bgImage, delta);

    if (isCurrent) {
      p.json = snapshot();
      p.history = [{ json: p.json, hidden: (p.hiddenOcc || []).slice() }];
      p.histIdx = 0;
      applyViewport();
      await renderBackground();
      canvas.requestRenderAll();
      syncLayers();
      syncProps();
      refreshUndo();
      syncOriginals();
      syncTables();
    }
  }

  /* ======================================================================
     HISTORY  (one undo stack per page, snapshots of the fabric JSON)
     ====================================================================== */
  /* Absolute (page-space) bounds of an object, even while it is part of an
     active multi-selection (fabric stores group-relative coords then). */
  function objectRect(o) {
    if (!o) return null;
    if (!o.group) {
      const r = o.getBoundingRect(true, true);
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    const m = o.calcTransformMatrix();
    const dim = o._getTransformedDimensions();
    const xs = [-1, 1, 1, -1];
    const ys = [-1, -1, 1, 1];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < 4; i++) {
      const pt = fabric.util.transformPoint(
        new fabric.Point((xs[i] * dim.x) / 2, (ys[i] * dim.y) / 2),
        m
      );
      left = Math.min(left, pt.x);
      top = Math.min(top, pt.y);
      right = Math.max(right, pt.x);
      bottom = Math.max(bottom, pt.y);
    }
    return { left, top, width: right - left, height: bottom - top };
  }

  function snapshot() {
    const res = canvas.toJSON(EXTRA);
    const objs = canvas.getObjects();

    /* Objects inside an active multi-selection store group-relative
       coordinates. Serialize them in page space, otherwise switching page or
       undoing while several layers are selected would move them. */
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!o.group || !res.objects[i]) continue;
      const m = fabric.util.multiplyTransformMatrices(o.group.calcOwnMatrix(), o.calcOwnMatrix());
      const saved = {
        left: o.left,
        top: o.top,
        angle: o.angle,
        scaleX: o.scaleX,
        scaleY: o.scaleY,
        skewX: o.skewX,
        skewY: o.skewY,
        flipX: o.flipX,
        flipY: o.flipY,
      };
      try {
        fabric.util.applyTransformToObject(o, m);
        res.objects[i] = o.toObject(EXTRA);
      } finally {
        o.set(saved);
        o.setCoords();
      }
    }
    return JSON.stringify(res);
  }

  /* Hidden original-image layers are stored as "op:sub" keys, so a grouped
     or tiled image op can be peeled one layer at a time instead of all at
     once. hiddenOps is kept as the unique op-index list for export decisions. */
  function imgKey(op, sub) {
    return String(op) + ":" + String(sub == null ? 0 : sub);
  }

  function syncHiddenOps(p) {
    const occ = p.hiddenOcc || [];
    p.hiddenOps = Array.from(new Set(occ.map((k) => Number(String(k).split(":")[0]))))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }

  function isOccHidden(p, occ) {
    return !!(p && occ && (p.hiddenOcc || []).includes(imgKey(occ.op, occ.sub)));
  }

  function sameHidden(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function pushHistory() {
    if (!S.ready || S.suppressHistory) return;
    const p = S.pages[S.index];
    if (!p) return;
    const json = snapshot();
    const hidden = (p.hiddenOcc || []).slice();
    const last = p.history[p.histIdx];
    if (last && last.json === json && sameHidden(last.hidden, hidden)) return;
    p.history = p.history.slice(0, p.histIdx + 1);
    p.history.push({ json, hidden });
    if (p.history.length > 60) p.history.shift();
    p.histIdx = p.history.length - 1;
    p.json = json;
    refreshUndo();
  }

  const scheduleHistory = debounce(pushHistory, 350);

  function savePage() {
    if (!S.pages[S.index]) return;
    const p = S.pages[S.index];
    p.json = snapshot();
  }

  function refreshUndo() {
    const p = S.pages[S.index];
    el.undo.disabled = !p || p.histIdx <= 0;
    el.redo.disabled = !p || p.histIdx >= p.history.length - 1;
  }

  async function restore(json) {
    S.suppressHistory = true;
    await new Promise((res) => canvas.loadFromJSON(json, res));
    canvas.renderAll();
    S.suppressHistory = false;
    tableEditing = false;
    tableSelectGuard = false;
    syncLayers();
    syncProps();
  }

  async function undoRedo(dir) {
    const p = S.pages[S.index];
    if (!p) return;
    const next = p.histIdx + dir;
    if (next < 0 || next >= p.history.length) return;
    const prevHidden = (p.hiddenOcc || []).slice();
    const entry = p.history[next];
    p.histIdx = next;
    p.json = entry.json;
    p.hiddenOcc = (entry.hidden || []).slice();
    syncHiddenOps(p);
    await restore(entry.json);
    if (!sameHidden(prevHidden, p.hiddenOcc)) await renderBackground();
    syncOriginals();
    refreshUndo();
  }

  canvas.on("object:added", () => {
    pushHistory();
    syncLayers();
  });
  canvas.on("object:removed", () => {
    pushHistory();
    syncLayers();
  });
  /* A replaced text and its background patch move together, so dragging an
     edited word does not leave the patch behind. The patch stays a separate
     layer (selectable/deletable via No patch). */
  let tableClick = null;
  canvas.on("mouse:down", (opt) => {
    const down = opt.target;
    tableClick = null;
    if (screenshotMode) {
      const p = canvas.getPointer(opt.e);
      screenshotStart = { x: p.x, y: p.y };
      if (screenshotRect) { try { canvas.remove(screenshotRect); } catch (e) {} }
      screenshotRect = new fabric.Rect({ left: p.x, top: p.y, width: 0, height: 0, fill: "rgba(37,99,235,0.06)", stroke: "#2563eb", strokeWidth: 1, strokeDashArray: [2,2], selectable: false, evented: false, excludeFromExport: true });
      canvas.add(screenshotRect);
      canvas.bringToFront(screenshotRect);
      canvas.renderAll();
      return;
    }
    if (down && down.insertedTable) {
      if (down.isTableHeader) {
        if (down.headerType === "row" && down.cellRow != null && down.cellRow >= 0) {
          selectTableRow(down.insertedTable, down.cellRow);
          return;
        }
        if (down.headerType === "col" && down.cellCol != null && down.cellCol >= 0) {
          selectTableCol(down.insertedTable, down.cellCol);
          return;
        }
        if (down.headerType === "corner") {
          selectTableAll(down.insertedTable);
          return;
        }
      }
      if (down.type !== "activeSelection" && !down.group) {
        down._tablePos = { left: down.left || 0, top: down.top || 0 };
        tableClick = {
          obj: down,
          x: opt.e ? opt.e.clientX : 0,
          y: opt.e ? opt.e.clientY : 0,
        };
      }
    }
    for (const t of objectListOf(opt.target)) {
      if (t.patchUid) t._patchPos = { left: t.left || 0, top: t.top || 0 };
    }
  });

  canvas.on("mouse:move", (opt) => {
    if (screenshotMode && screenshotStart && screenshotRect) {
      const p = canvas.getPointer(opt.e);
      const left = Math.min(screenshotStart.x, p.x);
      const top = Math.min(screenshotStart.y, p.y);
      const w = Math.abs(p.x - screenshotStart.x);
      const h = Math.abs(p.y - screenshotStart.y);
      screenshotRect.set({ left, top, width: w, height: h });
      screenshotRect.setCoords();
      canvas.requestRenderAll();
    }
  });

  canvas.on("mouse:up", async (opt) => {
    if (screenshotMode && screenshotStart && screenshotRect) {
      const p = canvas.getPointer(opt.e);
      const left = Math.min(screenshotStart.x, p.x);
      const top = Math.min(screenshotStart.y, p.y);
      const w = Math.abs(p.x - screenshotStart.x);
      const h = Math.abs(p.y - screenshotStart.y);
      if (w > 1 && h > 1) {
        await captureScreenshotArea(left, top, w, h);
        return;
      } else {
        try { canvas.remove(screenshotRect); } catch (e) {}
        screenshotRect = null;
        screenshotStart = null;
        screenshotMode = false;
        document.querySelectorAll(".tool[data-action]").forEach((b) => b.classList.toggle("active", false));
        setTool("select");
        canvas.requestRenderAll();
        toast("Drag exactly on area to capture");
        return;
      }
    }
    const click = tableClick;
    tableClick = null;
    if (!click || tableEditing) return;
    const moved = opt.e
      ? Math.hypot(opt.e.clientX - click.x, opt.e.clientY - click.y)
      : 0;
    if (moved > 3) return;
    if (canvas.getActiveObject() !== click.obj) return;
    if (click.obj.isTableHeader) return;
    selectInsertedTable(click.obj);
  });
  canvas.on("object:moving", (opt) => {
    syncTableMove(opt.target);
    const moving = objectListOf(opt.target);
    const movingSet = new Set(moving);
    for (const t of moving) {
      if (!t.patchUid) continue;
      if (!t._patchPos) t._patchPos = { left: t.left || 0, top: t.top || 0 };
      const patch = findPatchFor(t);
      if (!patch || movingSet.has(patch)) continue;
      const dx = (t.left || 0) - t._patchPos.left;
      const dy = (t.top || 0) - t._patchPos.top;
      if (!dx && !dy) continue;
      patch.set({ left: (patch.left || 0) + dx, top: (patch.top || 0) + dy });
      patch.setCoords();
      t._patchPos = { left: t.left || 0, top: t.top || 0 };
    }
  });

  canvas.on("object:modified", (opt) => {
    for (const t of objectListOf(opt.target)) {
      delete t._patchPos;
      delete t._tablePos;
      if (t.insertedTable) tablePeers(t).forEach((q) => delete q._tablePos);
    }
    pushHistory();
    syncLayers();
    syncProps();
  });

  /* A plain click (no drag) on a table cell selects the whole table once the
     gesture has finished.  Doing it on mouse-up instead of selection:created
     leaves the drag path untouched, while keeping the block resize / rotate
     handles working. */
  canvas.on("mouse:up", (opt) => {
    const click = tableClick;
    tableClick = null;
    if (!click || tableEditing) return;
    const moved = opt.e
      ? Math.hypot(opt.e.clientX - click.x, opt.e.clientY - click.y)
      : 0;
    if (moved > 3) return;
    if (canvas.getActiveObject() !== click.obj) return;
    if (click.obj.isTableHeader) return;
    selectInsertedTable(click.obj);
  });
  /* Do NOT build an ActiveSelection here: selection:created fires in the
     middle of the very first mouse-down gesture, and swapping the active
     object there swallows that drag.  Clicking a cell keeps it selected, and
     syncTableMove() moves every peer so the table still drags as one unit. */
  canvas.on("selection:created", syncProps);
  canvas.on("selection:updated", syncProps);
  canvas.on("selection:cleared", syncProps);
  canvas.on("text:changed", () => scheduleHistory());
  canvas.on("text:editing:exited", () => {
    pushHistory();
    tableEditing = false;
  });

  /* Screen-only dashed outline around the whole inserted table while a cell
     is selected, so it is clear the whole grid will move together.  Export
     renders page JSON on a fresh StaticCanvas, so this never bakes in. */
  canvas.on("after:render", ({ ctx }) => {
    const active = canvas.getActiveObject();
    if (!active || active.type === "activeSelection" || !active.insertedTable) return;
    const peers = tablePeers(active);
    if (!peers.length || !ctx) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    peers.forEach((o) => {
      if (typeof o.getBoundingRect !== "function") return;
      const r = o.getBoundingRect(true, true);
      if (!r) return;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.left + r.width);
      maxY = Math.max(maxY, r.top + r.height);
    });
    if (!isFinite(minX)) return;
    const vpt = canvas.viewportTransform;
    const zoom = canvas.getZoom() || 1;
    ctx.save();
    ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
    ctx.strokeStyle = "rgba(59, 130, 246, 0.95)";
    ctx.lineWidth = 1.6 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.restore();
  });

  /* ======================================================================
     PAGES  /  RENDERING
     ====================================================================== */
  function fitZoom(p) {
    const pad = 80;
    const w = el.stage.clientWidth - pad;
    const h = el.stage.clientHeight - pad;
    if (!w || !h) return 1;
    return clamp(Math.min(w / p.width, h / p.height), 0.2, 3);
  }

  function applyViewport() {
    const p = S.pages[S.index];
    if (!p) return;
    const dpr = DPR();
    const w = Math.max(1, Math.round(p.width * S.zoom));
    const h = Math.max(1, Math.round(p.height * S.zoom));
    el.pageWrap.style.width = w + "px";
    el.pageWrap.style.height = h + "px";
    // Use device pixel ratio for crisp text rendering on high-DPI screens
    canvas.setDimensions({ width: w, height: h }, { backstoreOnly: false });
    if (typeof canvas.setZoom === "function") {
      canvas.setZoom(S.zoom);
    }
    canvas.calcOffset();
    canvas.requestRenderAll();
    el.zoomLabel.textContent = Math.round(S.zoom * 100) + "%";
  }

  /* --- pdf.js internals -------------------------------------------------
     page.render() does not call page.getOperatorList(); it executes the
     cached "display" operator list directly. So to hide selected image
     paint ops we grab that list, splice the ops out for one render pass and
     put it back afterwards. Indices in hiddenOps refer to this list. */
  function makeCapability() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function displayIntentState(pageProxy) {
    const it = pageProxy._transport.getRenderingIntent(
      "display",
      pdfjsLib.AnnotationMode.ENABLE,
      null
    );
    let st = pageProxy._intentStates.get(it.cacheKey);
    if (!st) {
      st = Object.create(null);
      st.operatorList = { fnArray: [], argsArray: [], lastChunk: false, separateAnnots: null };
      st.renderTasks = new Set();
      st.displayReadyCapability = makeCapability();
      pageProxy._intentStates.set(it.cacheKey, st);
      pageProxy._stats && pageProxy._stats.time("Page Request");
      pageProxy._pumpOperatorList(it);
    }
    return st;
  }

  async function fullDisplayList(pageProxy) {
    const st = displayIntentState(pageProxy);
    let waited = 0;
    while (!st.operatorList.lastChunk) {
      await new Promise((r) => setTimeout(r, 20));
      waited += 20;
      if (waited > 30000) throw new Error("Timed out while reading this PDF page");
    }
    return st;
  }

  /* Build a copy of the display operator list with the selected image
     occurrences removed. A single op can paint many pictures (tiles or a
     group), so we filter inside those ops instead of dropping them whole —
     that is what lets the user peel one layer at a time. */
  function filteredOpList(list, hiddenKeys) {
    const OPS = pdfjsLib.OPS;
    const hide = new Set(hiddenKeys);
    const srcFn = list.fnArray;
    const srcArgs = list.argsArray;
    const fnArray = [];
    const argsArray = [];

    for (let i = 0; i < srcFn.length; i++) {
      const fn = srcFn[i];
      const a = srcArgs[i];

      if (fn === OPS.paintImageXObjectRepeat) {
        const pos = a[3] || [];
        const keep = [];
        for (let k = 0, sub = 0; k + 1 < pos.length; k += 2, sub++) {
          if (!hide.has(imgKey(i, sub))) keep.push(pos[k], pos[k + 1]);
        }
        if (keep.length) {
          fnArray.push(fn);
          argsArray.push([a[0], a[1], a[2], keep]);
        }
        continue;
      }

      if (fn === OPS.paintInlineImageXObjectGroup) {
        const map = a[1] || [];
        const keep = map.filter((e, sub) => !hide.has(imgKey(i, sub)));
        if (keep.length) {
          fnArray.push(fn);
          argsArray.push([a[0], keep]);
        }
        continue;
      }

      if (
        (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) &&
        hide.has(imgKey(i, 0))
      ) {
        continue;
      }

      fnArray.push(fn);
      argsArray.push(a);
    }

    return { fnArray, argsArray };
  }

  async function renderSourceToCanvas(pageProxy, scale, hiddenKeys, pageData) {
    const rotation =
      pageData && pageData.rotation != null && pageData.extraRotation
        ? pageData.rotation
        : undefined;
    const vp = pageProxy.getViewport(rotation == null ? { scale } : { scale, rotation });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(vp.width));
    c.height = Math.max(1, Math.ceil(vp.height));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);

    const hide = Array.isArray(hiddenKeys) ? hiddenKeys.filter((k) => typeof k === "string" && k) : [];
    if (!hide.length) {
      await pageProxy.render({ canvasContext: ctx, viewport: vp }).promise;
      return c;
    }

    /* Re-render the page with the selected image occurrences removed.
       This gives a true "clean plate" for detached original images. */
    const st = await fullDisplayList(pageProxy);
    const list = st.operatorList;
    const saveFn = list.fnArray;
    const saveArgs = list.argsArray;
    const filtered = filteredOpList(list, hide);
    list.fnArray = filtered.fnArray;
    list.argsArray = filtered.argsArray;
    try {
      await pageProxy.render({ canvasContext: ctx, viewport: vp }).promise;
    } finally {
      list.fnArray = saveFn;
      list.argsArray = saveArgs;
    }
    return c;
  }

  function drawImageContain(ctx, img, w, h, pad) {
    const p = pad || 0;
    const s = Math.min((w - p * 2) / (img.width || 1), (h - p * 2) / (img.height || 1));
    const dw = Math.max(1, img.width * s);
    const dh = Math.max(1, img.height * s);
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /* Render just the page background (original PDF, image page or blank)
     at the requested scale.  Never includes editable fabric layers. */
  async function renderPageBase(p, scale) {
    const w = Math.max(1, Math.round(p.width * scale));
    const h = Math.max(1, Math.round(p.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    if (p.bgImage) {
      try {
        const img = await loadImageElement(p.bgImage);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
      } catch (e) {
        console.warn("Could not draw the cleaned page background", e);
      }
      return c;
    }

    if (p.kind === "image" && p.image) {
      try {
        const img = await loadImageElement(p.image);
        drawImageContain(ctx, img, w, h, 0);
      } catch (e) {
        console.warn("Could not draw this image page", e);
      }
      return c;
    }

    if (!isPdfPage(p)) return c;

    const page = await pageProxyFor(p);
    if (!page) return c;
    const src = await renderSourceToCanvas(page, scale, p.hiddenOcc, p);
    c.width = src.width;
    c.height = src.height;
    ctx.drawImage(src, 0, 0);
    return c;
  }

  async function renderBackground() {
    const p = S.pages[S.index];
    if (!p) return;
    const scale = S.zoom * DPR();
    const src = await renderPageBase(p, scale);
    el.bgCanvas.width = src.width;
    el.bgCanvas.height = src.height;
    const c2 = el.bgCanvas.getContext("2d");
    c2.clearRect(0, 0, src.width, src.height);
    c2.drawImage(src, 0, 0);
    S.bgScale = el.bgCanvas.width / p.width;
  }

  /* ======================================================================
     ORIGINAL PDF IMAGES  (scan / detach / remove)
     ====================================================================== */
  function mulMatrix(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1],
      A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3],
      A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4],
      A[1] * B[4] + A[3] * B[5] + A[5],
    ];
  }

  function imageToCanvas(imgData) {
    if (!imgData) return null;
    const w = imgData.width || 0;
    const h = imgData.height || 0;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");

    if (imgData.bitmap) {
      ctx.drawImage(imgData.bitmap, 0, 0);
      return c;
    }
    if (typeof ImageBitmap !== "undefined" && imgData instanceof ImageBitmap) {
      ctx.drawImage(imgData, 0, 0);
      return c;
    }
    if (typeof HTMLCanvasElement !== "undefined" && imgData instanceof HTMLCanvasElement) {
      ctx.drawImage(imgData, 0, 0);
      return c;
    }
    if (typeof HTMLImageElement !== "undefined" && imgData instanceof HTMLImageElement) {
      ctx.drawImage(imgData, 0, 0);
      return c;
    }
    const src = imgData.data;
    if (!src) return null;

    try {
      if (imgData.kind === 1) return null; // 1-bit stencil mask, not a photo
      if (src.length >= w * h * 4) {
        const arr = src instanceof Uint8ClampedArray ? src : new Uint8ClampedArray(src.buffer || src);
        ctx.putImageData(new ImageData(arr, w, h), 0, 0);
        return c;
      }
      if (src.length >= w * h * 3) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let i = 0, j = 0; i < w * h * 3; i += 3) {
          out[j++] = src[i];
          out[j++] = src[i + 1];
          out[j++] = src[i + 2];
          out[j++] = 255;
        }
        ctx.putImageData(new ImageData(out, w, h), 0, 0);
        return c;
      }
    } catch (err) {
      console.warn("Could not decode an image from the PDF", err);
    }
    return null;
  }

  function makeThumb(canvasEl, max = 72) {
    const w = canvasEl.width;
    const h = canvasEl.height;
    const s = Math.min(1, max / Math.max(w, h));
    const t = document.createElement("canvas");
    t.width = Math.max(1, Math.round(w * s));
    t.height = Math.max(1, Math.round(h * s));
    const ctx = t.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvasEl, 0, 0, t.width, t.height);
    return t.toDataURL("image/png");
  }

  function loadImageElement(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("Could not load image data"));
      im.src = url;
    });
  }

  async function resolvePageObject(pageProxy, arg) {
    if (!arg) return null;
    if (typeof arg !== "string") return arg;
    const store = arg.startsWith("g_") ? pageProxy.commonObjs : pageProxy.objs;
    if (!store) return null;
    try {
      if (store.has(arg)) return store.get(arg);
    } catch (e) {
      /* fall through and wait */
    }
    return await new Promise((res) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        res(v || null);
      };
      try {
        store.get(arg, (data) => finish(data));
      } catch (e) {
        finish(null);
      }
      setTimeout(() => finish(null), 4000);
    });
  }

  function occurrenceGeometry(occ) {
    const m = occ.m;
    const pt = (u, v) => ({
      x: m[0] * u + m[2] * v + m[4],
      y: m[1] * u + m[3] * v + m[5],
    });
    const TL = pt(0, 1);
    const TR = pt(1, 1);
    const BL = pt(0, 0);
    const BR = pt(1, 0);
    const xa = { x: TR.x - TL.x, y: TR.y - TL.y };
    const ya = { x: BL.x - TL.x, y: BL.y - TL.y };
    const det = xa.x * ya.y - xa.y * ya.x;
    return {
      corners: [TL, TR, BR, BL],
      cx: (TL.x + TR.x + BL.x + BR.x) / 4,
      cy: (TL.y + TR.y + BL.y + BR.y) / 4,
      angle: (Math.atan2(xa.y, xa.x) * 180) / Math.PI,
      sx: Math.hypot(xa.x, xa.y) / Math.max(1, occ.w),
      sy: Math.hypot(ya.x, ya.y) / Math.max(1, occ.h),
      flipY: det < 0,
    };
  }

  function pointInQuad(pt, corners) {
    let inside = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const a = corners[i];
      const b = corners[j];
      if (
        a.y > pt.y !== b.y > pt.y &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-9) + a.x
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  async function scanPageImages(p) {
    if (!p) return [];
    if (p.imgOps) return p.imgOps;
    if (p.imgOpsPromise) return p.imgOpsPromise;
    if (!S.ready || !isPdfPage(p)) {
      p.imgOps = [];
      return p.imgOps;
    }

    p.imgOpsPromise = (async () => {
      const page = await pageProxyFor(p);
      if (!page) return [];
      const st = await fullDisplayList(page);
      const list = st.operatorList;
      const OPS = pdfjsLib.OPS;
      const V = page.getViewport({ scale: 1, rotation: p.rotation || 0 }).transform;
      const found = [];

      let m = V.slice();
      const stack = [];
      const pushOcc = (op, mat, imgData, sub) => {
        const c = imageToCanvas(imgData);
        if (!c) return;
        const w = imgData.width || c.width;
        const h = imgData.height || c.height;
        const occ = {
          op,
          sub,
          key: imgKey(op, sub),
          w,
          h,
          m: mat,
          dataUrl: c.toDataURL("image/png"),
          thumb: makeThumb(c),
        };
        const g = occurrenceGeometry(occ);
        if (Math.hypot(g.corners[1].x - g.corners[0].x, g.corners[1].y - g.corners[0].y) < 1) return;
        if (Math.hypot(g.corners[3].x - g.corners[0].x, g.corners[3].y - g.corners[0].y) < 1) return;
        found.push(occ);
      };

      for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i];
        const a = list.argsArray[i];

        if (fn === OPS.save) {
          stack.push(m.slice());
          continue;
        }
        if (fn === OPS.restore) {
          const s = stack.pop();
          if (s) m = s;
          continue;
        }
        if (fn === OPS.transform) {
          m = mulMatrix(m, a);
          continue;
        }
        if (fn === OPS.paintFormXObjectBegin) {
          stack.push(m.slice());
          if (Array.isArray(a[0]) && a[0].length === 6) m = mulMatrix(m, a[0]);
          continue;
        }
        if (fn === OPS.paintFormXObjectEnd) {
          const s = stack.pop();
          if (s) m = s;
          continue;
        }

        const isSingle = fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject;
        const isRepeat = fn === OPS.paintImageXObjectRepeat;
        const isGroup = fn === OPS.paintInlineImageXObjectGroup;
        if (!isSingle && !isRepeat && !isGroup) continue;

        try {
          if (isSingle) {
            const img = await resolvePageObject(page, a[0]);
            if (img) pushOcc(i, m.slice(), img, 0);
          } else if (isRepeat) {
            const img = await resolvePageObject(page, a[0]);
            if (!img) continue;
            const positions = a[3] || [];
            for (let k = 0, n = 0; k + 1 < positions.length; k += 2, n++) {
              const T = [a[1], 0, 0, a[2], positions[k], positions[k + 1]];
              pushOcc(i, mulMatrix(m, T), img, n);
            }
          } else {
            const img = a[0];
            const map = a[1] || [];
            for (let k = 0; k < map.length; k++) {
              const e = map[k];
              if (!e || !e.transform) continue;
              pushOcc(i, mulMatrix(m, e.transform), img, k);
            }
          }
        } catch (err) {
          console.warn("Could not read one image on this page", err);
        }
      }

      found.sort((x, y) => x.op - y.op || x.sub - y.sub);
      p.imgOps = found;
      return found;
    })()
      .catch((err) => {
        console.warn("Image scan failed", err);
        p.imgOps = [];
        return p.imgOps;
      })
      .finally(() => {
        p.imgOpsPromise = null;
      });

    return p.imgOpsPromise;
  }

  function occKeyOf(occ) {
    return imgKey(occ.op, occ.sub);
  }

  function downloadFile(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function detachOccurrence(occ, opts = {}) {
    const p = S.pages[S.index];
    if (!p || !occ) return null;
    if (!opts.keepTool) setTool("select");

    const key = occKeyOf(occ);
    const imgEl = await loadImageElement(occ.dataUrl);
    const g = occurrenceGeometry(occ);
    const img = new fabric.Image(imgEl, {
      left: g.cx,
      top: g.cy,
      originX: "center",
      originY: "center",
      angle: g.angle,
      scaleX: g.sx,
      scaleY: g.sy,
      flipY: g.flipY,
    });
    img.isOriginalImage = true;
    img.srcOp = occ.op;
    img.srcKey = key;
    img.uid = "img-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (opts.keepTool) {
      img.selectable = false;
      img.evented = false;
    }

    p.hiddenOcc = Array.from(new Set([...(p.hiddenOcc || []), key]));
    syncHiddenOps(p);
    await renderBackground();

    S.suppressHistory = true;
    canvas.add(img);
    S.suppressHistory = false;
    if (!opts.noSelect) canvas.setActiveObject(img);
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
    pushHistory();
    syncOriginals();
    if (!opts.silent) {
      toast(
        opts.keepTool
          ? "Top image layer detached — click again to peel the next one"
          : "Original image detached — drag it now",
        2600
      );
    }
    return img;
  }

  async function removeOccurrence(occ) {
    const p = S.pages[S.index];
    if (!p || !occ) return;
    p.hiddenOcc = Array.from(new Set([...(p.hiddenOcc || []), occKeyOf(occ)]));
    syncHiddenOps(p);
    await renderBackground();
    canvas.requestRenderAll();
    pushHistory();
    syncOriginals();
    toast("Original image removed from this page", 2600);
  }

  /* Accepts an "op:sub" key (precise layer) or an op number (all layers). */
  async function restoreOccurrence(arg) {
    const p = S.pages[S.index];
    if (!p) return;
    const keys =
      typeof arg === "number"
        ? (p.hiddenOcc || []).filter((k) => Number(String(k).split(":")[0]) === arg)
        : [String(arg)];
    p.hiddenOcc = (p.hiddenOcc || []).filter((k) => !keys.includes(k));
    syncHiddenOps(p);
    S.suppressHistory = true;
    canvas.getObjects().slice().forEach((o) => {
      if (!o.isOriginalImage) return;
      if (keys.includes(o.srcKey) || (typeof arg === "number" && o.srcOp === arg)) canvas.remove(o);
    });
    S.suppressHistory = false;
    await renderBackground();
    canvas.requestRenderAll();
    syncLayers();
    pushHistory();
    syncOriginals();
  }

  async function restoreAllOriginals() {
    const p = S.pages[S.index];
    if (!p || !(p.hiddenOcc || []).length) return toast("Nothing to restore on this page");
    p.hiddenOcc = [];
    syncHiddenOps(p);
    S.suppressHistory = true;
    canvas.getObjects().slice().forEach((o) => {
      if (o.isOriginalImage) canvas.remove(o);
    });
    S.suppressHistory = false;
    await renderBackground();
    canvas.requestRenderAll();
    syncLayers();
    pushHistory();
    syncOriginals();
    toast("Original images restored");
  }

  /* Click-to-peel: every click takes the topmost visible image under the
     cursor, so stacked pictures/frames come off one at a time. */
  async function handleDetachClick(pt) {
    const p = S.pages[S.index];
    if (!p || !S.ready) return;
    const ops = await scanPageImages(p);
    if (!ops.length) return toast("This page has no original images", 2600);

    const hits = ops.filter(
      (o) => !isOccHidden(p, o) && pointInQuad(pt, occurrenceGeometry(o).corners)
    );
    if (!hits.length) {
      return toast("Nothing left here — use the Original images panel to restore", 3000);
    }
    const top = hits[hits.length - 1];
    const stacked = hits.length > 1;
    await detachOccurrence(top, { keepTool: stacked, noSelect: stacked, silent: true });
    toast(
      stacked
        ? `Detached the top layer — ${hits.length - 1} more here. Click again to peel it.`
        : "Detached — press V to drag it, or use the panel",
      3000
    );
  }

  function setOriginalsEmpty(text) {
    const wrap = $("originals");
    if (!wrap) return;
    wrap.innerHTML = "";
    const d = document.createElement("div");
    d.className = "empty-layers";
    d.textContent = text;
    wrap.appendChild(d);
    const cnt = $("origCount");
    if (cnt) cnt.textContent = "0";
  }

  async function syncOriginals() {
    const wrap = $("originals");
    if (!wrap) return;
    const p = S.pages[S.index];
    if (!S.ready || !p) return setOriginalsEmpty("Open a PDF to scan its images.");

    setOriginalsEmpty(p.src === null ? "This page has no original images." : "Scanning images…");
    let ops = [];
    try {
      ops = await scanPageImages(p);
    } catch (e) {
      return setOriginalsEmpty("Could not scan the images on this page.");
    }
    if (S.pages[S.index] !== p) return;

    const cnt = $("origCount");
    if (cnt) cnt.textContent = String(ops.length);
    if (!ops.length) return setOriginalsEmpty("This page has no original images.");

    wrap.innerHTML = "";
    const hidden = new Set(p.hiddenOcc || []);

    ops.forEach((occ, idx) => {
      const isHidden = hidden.has(occ.key);
      const row = document.createElement("div");
      row.className = "orig-row" + (isHidden ? " is-hidden" : "");

      const thumb = document.createElement("img");
      thumb.className = "orig-thumb";
      thumb.src = occ.thumb;
      thumb.alt = "";
      thumb.draggable = false;

      const meta = document.createElement("div");
      meta.className = "orig-meta";
      const b = document.createElement("b");
      b.textContent = "Image " + (idx + 1) + (isHidden ? " · detached" : "");
      const s = document.createElement("span");
      s.textContent = occ.w + " × " + occ.h + " px";
      meta.append(b, s);

      row.append(thumb, meta);

      if (isHidden) {
        const undo = document.createElement("button");
        undo.className = "l-btn";
        undo.title = "Put this original image back";
        setIcon(undo, "restore");
        undo.addEventListener("click", () => restoreOccurrence(occ.key));
        const save = document.createElement("button");
        save.className = "l-btn";
        save.title = "Save this image as a PNG file";
        setIcon(save, "download");
        save.addEventListener("click", () =>
          downloadFile(occ.dataUrl, `pdf-image-${idx + 1}.png`)
        );
        row.append(undo, save);
      } else {
        const det = document.createElement("button");
        det.className = "l-btn";
        det.title = "Turn this image into a movable layer (one layer at a time)";
        setIcon(det, "scissors");
        det.addEventListener("click", () => detachOccurrence(occ));
        const del = document.createElement("button");
        del.className = "l-btn";
        del.title = "Erase this image from the page";
        setIcon(del, "trash");
        del.addEventListener("click", () => removeOccurrence(occ));
        const save = document.createElement("button");
        save.className = "l-btn";
        save.title = "Save this image as a PNG file";
        setIcon(save, "download");
        save.addEventListener("click", () =>
          downloadFile(occ.dataUrl, `pdf-image-${idx + 1}.png`)
        );
        row.append(det, del, save);
      }

      row.addEventListener("mouseenter", () => {
        occ._hot = true;
      });
      row.addEventListener("mouseleave", () => {
        occ._hot = false;
      });
      row.addEventListener("click", (e) => {
        if (e.target && e.target.tagName === "BUTTON") return;
        if (!hidden.has(occ.key)) detachOccurrence(occ);
      });

      wrap.appendChild(row);
    });
  }

  async function setPage(i, opts = {}) {
    if (!S.pages.length) return;
    /* Only persist when the canvas still shows the current page. Callers that
       change S.index first (add/delete/insert) already saved the old page; saving
       again here would copy the visible canvas into the *new* page. */
    if (S.viewIndex >= 0 && S.viewIndex === S.index && S.pages[S.index]) savePage();

    S.index = clamp(i, 0, S.pages.length - 1);
    const p = S.pages[S.index];
    if (opts.fit) S.zoom = fitZoom(p);

    applyViewport();
    await renderBackground();

    S.suppressHistory = true;
    await new Promise((res) => {
      if (p.json) canvas.loadFromJSON(p.json, res);
      else {
        canvas.discardActiveObject();
        canvas.getObjects().slice().forEach((o) => canvas.remove(o));
        res();
      }
    });
    canvas.renderAll();
    S.suppressHistory = false;
    tableEditing = false;
    tableSelectGuard = false;

    if (!p.history.length) {
      p.history = [{ json: snapshot(), hidden: (p.hiddenOcc || []).slice() }];
      p.histIdx = 0;
    }

    S.viewIndex = S.index;
    updatePageChrome();
    syncLayers();
    syncProps();
    refreshUndo();
    syncOriginals();
    syncTables();
  }

  function updatePageChrome() {
    el.pageLabel.textContent = S.pages.length ? `${S.index + 1} / ${S.pages.length}` : "– / –";
    document.getElementById("prevPageBtn").disabled = S.index <= 0;
    document.getElementById("nextPageBtn").disabled = S.index >= S.pages.length - 1;
    document.getElementById("delPageBtn").disabled = S.pages.length <= 1;
  }

  /* ======================================================================
     OPEN PDF  (one or several source documents)
     ====================================================================== */
  async function openPdfDocument(bytes, name) {
    let doc = null;
    let password = null;
    let encrypted = false;
    for (let attempt = 0; attempt < 4 && !doc; attempt++) {
      try {
        doc = await pdfjsLib.getDocument({ data: bytes.slice(0), password }).promise;
      } catch (err) {
        if (err && err.name === "PasswordException" && attempt < 3) {
          encrypted = true;
          password = window.prompt(
            (name || "This PDF") + " is password protected. Enter the password:"
          );
          if (password == null) throw new Error("Cancelled");
        } else {
          throw err;
        }
      }
    }
    if (!doc) throw new Error("Could not open PDF");
    return { doc, bytes, name: name || "document.pdf", lib: undefined, encrypted };
  }

  async function makePdfPage(docId, src) {
    const rec = S.docs.get(docId);
    if (!rec) throw new Error("Missing PDF source");
    const proxy = await rec.doc.getPage(src + 1);
    const vp = proxy.getViewport({ scale: 1 });
    return emptyPageData({
      docId,
      src,
      kind: "pdf",
      viewBox: Array.from(proxy.view),
      baseWidth: vp.width,
      baseHeight: vp.height,
      baseRotation: vp.rotation || 0,
      rotation: vp.rotation || 0,
      width: vp.width,
      height: vp.height,
      imgOps: null,
    });
  }

  async function loadPdf(bytes, name) {
    if (S.srcDoc) {
      try { S.srcDoc.destroy(); } catch (e) { /* ignore */ }
      S.srcDoc = null;
    }
    S.docs.forEach((rec) => {
      if (rec.doc) {
        try { rec.doc.destroy(); } catch (e) { /* ignore */ }
      }
    });
    S.docs.clear();

    S.bytes = bytes;
    S.name = name || "document.pdf";
    S.pages = [];
    S.index = 0;
    S.viewIndex = -1;
    S.ready = false;
    S.encrypted = false;
    S.pageSel.clear();

    showProgress("Opening PDF…");
    try {
      const rec = await openPdfDocument(bytes, S.name);
      S.docs.set("main", rec);
      S.srcDoc = rec.doc;
      S.encrypted = rec.encrypted;

      for (let i = 0; i < rec.doc.numPages; i++) {
        S.pages.push(await makePdfPage("main", i));
        progress(`Loading page ${i + 1} / ${rec.doc.numPages}…`);
      }

      S.ready = true;
      el.empty.classList.add("hidden");
      el.pageWrap.classList.remove("hidden");
      el.filename.textContent = S.name;
      document.title = S.name + " — PDF Studio";

      await setPage(0, { fit: true });
      toast("PDF ready — double-click any text to edit it", 3200);
    } catch (err) {
      console.error(err);
      toast("Could not open the PDF: " + err.message, 4000);
      el.empty.classList.remove("hidden");
      el.pageWrap.classList.add("hidden");
      S.ready = false;
    } finally {
      hideProgress();
    }
  }

  async function openFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast("That file is not a PDF");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadPdf(bytes, file.name);
  }

  /* ======================================================================
     TEXT EXTRACTION
     ====================================================================== */
  async function getTextLines(p) {
    if (p.text) return p.text;
    if (!isPdfPage(p)) {
      p.text = [];
      return p.text;
    }

    const page = await pageProxyFor(p);
    if (!page) {
      p.text = [];
      return p.text;
    }
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    if (!p.viewBox) p.viewBox = Array.from(page.view);
    p.baseWidth = vp.width;
    p.baseHeight = vp.height;
    p.baseRotation = vp.rotation || 0;
    const items = [];

    /* pdf.js keeps the real font object (with bold/italic flags and the
       actual font name) in page.commonObjs — much better than guessing. */
    const fontMeta = {};
    for (const name of Object.keys(tc.styles || {})) {
      fontMeta[name] = null;
      try {
        if (page.commonObjs && page.commonObjs.has(name)) {
          const fo = page.commonObjs.get(name);
          fontMeta[name] = {
            name: fo.name || "",
            fallback: fo.fallbackName || "",
            bold: !!fo.bold,
            italic: !!fo.italic,
            black: !!fo.black,
          };
        }
      } catch (e) {
        fontMeta[name] = null;
      }
    }

    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tr = pdfjsLib.Util.transform(vp.transform, it.transform);
      items.push({
        str: it.str,
        x: tr[4],
        y: tr[5],
        w: it.width || 0,
        fs: Math.hypot(tr[2], tr[3]) || it.height || 10,
        family: (tc.styles && tc.styles[it.fontName] && tc.styles[it.fontName].fontFamily) || "",
        meta: fontMeta[it.fontName] || null,
      });
    }

    items.sort((a, b) => a.y - b.y || a.x - b.x);

    const groups = [];
    for (const it of items) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(last.y - it.y) < Math.max(1.5, it.fs * 0.35)) {
        last.items.push(it);
      } else {
        groups.push({ y: it.y, items: [it] });
      }
    }

    const lines = [];
    for (const g of groups) {
      g.items.sort((a, b) => a.x - b.x);
      const fs = g.items.reduce((m, it) => Math.max(m, it.fs), 0);

      /* Split every pdf.js run into words. A run often holds several words
         (or a whole table row); using its per-character advance gives each
         word a usable box, which is what makes word-level and table-cell
         editing possible without collapsing the row into one line. */
      const words = [];
      for (const it of g.items) {
        const str = it.str || "";
        const unit = it.w > 0 && str.length ? it.w / str.length : (it.fs || fs) * 0.5;
        const re = /\S+/g;
        let m;
        while ((m = re.exec(str))) {
          const text = m[0];
          const left = it.x + unit * m.index;
          words.push({ text, left, width: Math.max(0.6, unit * text.length) });
        }
      }
      if (!words.length) continue;
      words.sort((a, b) => a.left - b.left);

      const left = Math.min(...words.map((w) => w.left));
      const right = Math.max(...words.map((w) => w.left + w.width));

      /* Runs of words separated by a big gutter become separate cells.
         Normal inter-word gaps stay inside one cell, so a table row is
         never flattened into a single editable line. */
      const cellGap = Math.max(8, fs * 1.9);
      const cells = [];
      let cur = null;
      for (const w of words) {
        if (cur && w.left - (cur.left + cur.width) <= cellGap) {
          cur.text += " " + w.text;
          cur.width = w.left + w.width - cur.left;
        } else {
          cur = {
            text: w.text,
            left: w.left,
            width: w.width,
            top: g.y - fs * 0.82,
            height: Math.max(1, fs * 1.08),
          };
          cells.push(cur);
        }
      }

      const text = words.map((w) => w.text).join(" ").trim();
      if (!text) continue;

      const metas = g.items.map((it) => it.meta).filter(Boolean);
      const realName = metas.map((m) => m.name).find(Boolean) || "";

      lines.push({
        text,
        left,
        top: g.y - fs * 0.82,
        width: Math.max(1, right - left),
        height: Math.max(1, fs * 1.08),
        fontSize: fs,
        family: g.items[0].family,
        fontName: realName,
        bold: metas.some((m) => m.bold || m.black),
        italic: metas.some((m) => m.italic),
        words,
        cells,
        baseline: g.y,
      });
    }

    p.text = lines;
    p.tables = null;
    return lines;
  }

  /* Hit-test: returns the line plus the exact word (and table cell) under
     the pointer. A click between two words snaps to the nearest word. */
  function hitText(p) {
    const page = S.pages[S.index];
    const lines = (page && page.text) || [];
    const q = page ? toBasePoint(page, p) : p;
    let line = null;
    let bestDy = Infinity;
    for (const l of lines) {
      if (q.x < l.left - 2 || q.x > l.left + l.width + 2) continue;
      if (q.y < l.top - 2 || q.y > l.top + l.height + 2) continue;
      const dy = Math.abs(l.top + l.height / 2 - q.y);
      if (dy < bestDy) {
        bestDy = dy;
        line = l;
      }
    }
    if (!line) return null;

    const words = line.words || [];
    let word = null;
    let bestDist = Infinity;
    for (const w of words) {
      if (q.x >= w.left - 1 && q.x <= w.left + w.width + 1) {
        word = w;
        break;
      }
      const d = Math.min(Math.abs(q.x - w.left), Math.abs(q.x - (w.left + w.width)));
      if (d < bestDist) {
        bestDist = d;
        word = w;
      }
    }

    let cell = null;
    if (word) {
      for (const c of line.cells || []) {
        if (word.left >= c.left - 1 && word.left <= c.left + c.width + 1) {
          cell = c;
          break;
        }
      }
    }
    return { line, word, cell };
  }

  /* ---- colour analysis on the rendered page ---- */
  function analyzeColors(box) {
    const ctx = el.bgCanvas.getContext("2d");
    const x = clamp(Math.floor(box.left * S.bgScale), 0, el.bgCanvas.width - 1);
    const y = clamp(Math.floor(box.top * S.bgScale), 0, el.bgCanvas.height - 1);
    const w = clamp(Math.ceil(box.width * S.bgScale), 1, el.bgCanvas.width - x);
    const h = clamp(Math.ceil(box.height * S.bgScale), 1, el.bgCanvas.height - y);

    let data;
    try {
      data = ctx.getImageData(x, y, w, h).data;
    } catch (e) {
      return { bg: "#ffffff", fg: "#111111" };
    }

    const hist = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      hist.set(key, (hist.get(key) || 0) + 1);
      total++;
    }
    if (!total) return { bg: "#ffffff", fg: "#111111" };

    let bgKey = 0;
    let bgCount = -1;
    for (const [k, c] of hist) {
      if (c > bgCount) { bgCount = c; bgKey = k; }
    }

    const br = (bgKey >> 16) & 255;
    const bgc = (bgKey >> 8) & 255;
    const bb = bgKey & 255;

    let fgKey = null;
    let fgCount = 0;
    const minCount = Math.max(2, total * 0.002);
    for (const [k, c] of hist) {
      if (c < minCount) continue;
      const r = (k >> 16) & 255;
      const g = (k >> 8) & 255;
      const b = k & 255;
      const dist = Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb);
      if (dist > 45 && c > fgCount) {
        fgCount = c;
        fgKey = k;
      }
    }

    return {
      bg: rgbToHex((bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255),
      fg: fgKey == null ? "#111111" : rgbToHex((fgKey >> 16) & 255, (fgKey >> 8) & 255, fgKey & 255),
    };
  }

  function sampleBgAt(p) {
    const ctx = el.bgCanvas.getContext("2d");
    const x = clamp(Math.round(p.x * S.bgScale), 0, el.bgCanvas.width - 1);
    const y = clamp(Math.round(p.y * S.bgScale), 0, el.bgCanvas.height - 1);
    try {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return rgbToHex(d[0], d[1], d[2]);
    } catch (e) {
      return "#ffffff";
    }
  }

  /* ---- estimate weight from the rendered pixels ----
     Bold/italic normally come from pdf.js font flags; this fallback is used
     when a PDF's fonts carry no flags (e.g. Type3 or broken descriptors).
     Calibrated on the standard-14 set: regular ≤ 0.115em, bold ≥ 0.143em. */
  function detectTextStyle(box, bgHex) {
    const out = { bold: false, italic: false };
    const ctx = el.bgCanvas.getContext("2d");
    const s = S.bgScale || 1;
    const x = clamp(Math.floor(box.left * s), 0, el.bgCanvas.width - 1);
    const y = clamp(Math.floor(box.top * s), 0, el.bgCanvas.height - 1);
    const w = clamp(Math.ceil(box.width * s), 1, el.bgCanvas.width - x);
    const h = clamp(Math.ceil(box.height * s), 1, el.bgCanvas.height - y);

    let data;
    try {
      data = ctx.getImageData(x, y, w, h).data;
    } catch (e) {
      return out;
    }

    const bg = new fabric.Color(bgHex || "#ffffff").getSource();
    const ink = new Uint8Array(w * h);
    let inkCount = 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4;
        const d =
          Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
        if (d > 120) {
          ink[yy * w + xx] = 1;
          inkCount++;
        }
      }
    }
    if (inkCount < 24) return out;

    const runs = [];
    for (let yy = 0; yy < h; yy++) {
      let run = 0;
      for (let xx = 0; xx < w; xx++) {
        if (ink[yy * w + xx]) {
          run++;
        } else if (run) {
          runs.push(run);
          run = 0;
        }
      }
      if (run) runs.push(run);
    }
    if (runs.length < 8) return out;

    runs.sort((a, b) => a - b);
    const pct = (q) => runs[Math.min(runs.length - 1, Math.floor(q * runs.length))] || 0;
    const em = Math.max(1, (box.fontSize || 12) * s);
    const stemRatio = pct(0.35) / em;

    out.bold = stemRatio > 0.128;
    out.stats = { stem: pct(0.35), em, stemRatio: +stemRatio.toFixed(3) };
    return out;
  }

  /* ---- replace original text in place ----
     target = { line, word, cell } from hitText(). By default only the clicked
     word is replaced, so neighbouring words and other table cells keep their
     original pixels. Alt/Shift double-click replaces the whole line (or the
     cell, when the line is a table row). */
  async function replaceTextAt(target, opts = {}) {
    if (!target) return false;
    const line = target.line || target;
    const cells = line.cells || [];
    let source = target.word || line;
    if (opts.wholeLine) {
      source = cells.length > 1 && target.cell ? target.cell : line;
    }
    const fs = Math.max(1, line.fontSize);
    const padX = Math.max(0.4, fs * 0.04);
    const padY = Math.max(0.4, fs * 0.06);
    const box = {
      left: source.left - padX,
      top: line.top - padY,
      width: Math.max(1, source.width) + padX * 2,
      height: line.height + padY * 2,
    };

    /* Sample the background from a slightly larger ring around the target:
       a tight word box can be mostly ink (bold/short words), which would
       otherwise make the patch dark. The ring is only used for colour
       sampling — the patch itself stays tight around the word. */
    const sampleBox = {
      left: box.left - fs * 0.3,
      top: box.top - fs * 0.45,
      width: box.width + fs * 0.6,
      height: box.height + fs * 0.9,
    };
    const page = S.pages[S.index];
    const dispBox = page ? mapPageBox(page, box) : box;
    const dispSample = page ? mapPageBBox(page, sampleBox) : sampleBox;
    const colors = analyzeColors(dispSample);
    const key = guessFontKey(line.fontName || line.family);
    const patchBox = $("patchOnReplace");
    const wantPatch = opts.patch == null ? !!(patchBox && patchBox.checked) : !!opts.patch;
    const uid = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    let patch = null;
    if (wantPatch) {
      patch = new fabric.Rect({
        left: dispBox.left,
        top: dispBox.top,
        width: dispBox.width,
        height: dispBox.height,
        angle: dispBox.angle || 0,
        fill: colors.bg,
        stroke: null,
        strokeWidth: 0,
        selectable: true,
        hoverCursor: "move",
      });
      patch.isPatch = true;
      patch.uid = "p" + uid;
      patch.patchFor = uid;
    }

    const text = new fabric.IText(source.text || line.text, {
      left: dispBox.left + padX * 0.25,
      top: dispBox.top + padY * 0.25,
      angle: dispBox.angle || 0,
      fontSize: fs,
      fontFamily: FONTS[key].css,
      fill: colors.fg,
      lineHeight: 1.0,
      editable: true,
    });
    text.pdfFont = key;
    text.uid = uid;
    text.wordLevel = !opts.wholeLine;
    if (FONTS[key].custom) text.customFont = key;
    if (patch) text.patchUid = patch.uid;

    const style = detectTextStyle(Object.assign({ fontSize: line.fontSize }, dispSample), colors.bg);
    const bold =
      line.bold ||
      style.bold ||
      /bold|black|heavy|semibold|demi/i.test(line.fontName + " " + line.family);
    const italic = line.italic || /italic|oblique/i.test(line.fontName + " " + line.family);
    if (bold) text.set("fontWeight", "bold");
    if (italic) text.set("fontStyle", "italic");

    if (patch) canvas.add(patch);
    canvas.add(text);
    canvas.setActiveObject(text);
    pushHistory();
    syncLayers();

    text.enterEditing();
    text.selectAll();
    if (!wantPatch) {
      toast("Transparent text added — the original text is still visible underneath", 3200);
    }
    return true;
  }

  function findPatchFor(o) {
    if (!o || !o.patchUid) return null;
    return canvas.getObjects().find((q) => q.uid === o.patchUid) || null;
  }

  function objectListOf(target) {
    if (!target) return [];
    if (target.type === "activeSelection" && typeof target.getObjects === "function") {
      return target.getObjects();
    }
    return [target];
  }

  /* ---- inserted tables: select, move and edit as a single unit ---- */
  let tableSelectGuard = false;
  let tableEditing = false;

  function tablePeers(o) {
    if (!o || !o.insertedTable) return [];
    return canvas.getObjects().filter((q) => q.insertedTable === o.insertedTable);
  }

  function selectInsertedTable(o) {
    const peers = tablePeers(o);
    if (peers.length < 2) return false;
    tableSelectGuard = true;
    try {
      canvas.discardActiveObject();
      canvas.setActiveObject(new fabric.ActiveSelection(peers, { canvas }));
      canvas.requestRenderAll();
      syncLayers();
      syncProps();
    } finally {
      tableSelectGuard = false;
    }
    return true;
  }

  function cellTextFor(o) {
    if (!o) return null;
    if (isText(o)) return o;
    return (
      canvas.getObjects().find(
        (q) =>
          q.insertedTable &&
          q.insertedTable === o.insertedTable &&
          isText(q) &&
          q.cellRow === o.cellRow &&
          q.cellCol === o.cellCol
      ) || null
    );
  }

  function getTableMeta(id) {
    if (!id) return null;
    return S.tableMeta.get(id) || null;
  }

  function ensureTableMeta(id, data) {
    if (!id) return null;
    let meta = S.tableMeta.get(id);
    if (!meta) {
      meta = Object.assign({}, data || {});
      S.tableMeta.set(id, meta);
    } else if (data) {
      Object.assign(meta, data);
    }
    return meta;
  }

  function editTableCell(o) {
    const cell = cellTextFor(o);
    if (!cell) return false;
    tableEditing = true;
    tableSelectGuard = true;
    try {
      canvas.discardActiveObject();
      canvas.setActiveObject(cell);
      cell.enterEditing();
      cell.selectAll();
      tableEditing = !!cell.isEditing;
    } finally {
      tableSelectGuard = false;
    }
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
    return !!cell.isEditing;
  }

  /* Point test in page space.  containsPoint() cannot be trusted while the
     cell is inside an ActiveSelection (fabric then stores group-relative
     coordinates), so map the point into the cell's own local frame instead. */
  function pointInCell(o, p) {
    let m;
    try {
      m = o.calcTransformMatrix(); // includes the parent group transform
    } catch (e) {
      return false;
    }
    const local = fabric.util.transformPoint(p, fabric.util.invertTransform(m));
    const hw = Math.abs((o.width || 0) * (o.scaleX == null ? 1 : o.scaleX)) / 2;
    const hh = Math.abs((o.height || 0) * (o.scaleY == null ? 1 : o.scaleY)) / 2;
    return Math.abs(local.x) <= hw + 0.5 && Math.abs(local.y) <= hh + 0.5;
  }

  function tableCellAtPoint(p) {
    const objs = canvas.getObjects();
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (!o.insertedTable || o.visible === false) continue;
      if (pointInCell(o, p)) return o;
    }
    return null;
  }

  /* When one cell is dragged without a group selection, move every peer by
     the same delta so the grid stays together. */
  function syncTableMove(target) {
    if (!target || !target.insertedTable) return;
    if (target.type === "activeSelection" || target.group) return;
    const base = target._tablePos;
    if (!base) return;
    const dx = (target.left || 0) - base.left;
    const dy = (target.top || 0) - base.top;
    if (!dx && !dy) return;
    tablePeers(target).forEach((peer) => {
      if (peer === target) return;
      peer.set({ left: (peer.left || 0) + dx, top: (peer.top || 0) + dy });
      peer.setCoords();
    });
    target._tablePos = { left: target.left || 0, top: target.top || 0 };
  }

  function rotateTablePeers(peers, nextAngle) {
    if (!peers || !peers.length) return;
    const current = peers[0].angle || 0;
    const delta = nextAngle - current;
    if (!delta) return;
    const rad = (delta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    peers.forEach((o) => {
      const r = objectRect(o);
      if (!r) return;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.left + r.width);
      maxY = Math.max(maxY, r.top + r.height);
    });
    if (!isFinite(minX)) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    peers.forEach((o) => {
      const c = o.getCenterPoint();
      const dx = c.x - cx;
      const dy = c.y - cy;
      const nx = cx + dx * cos - dy * sin;
      const ny = cy + dx * sin + dy * cos;
      /* angle first, then place the rotated bounds around the new centre */
      o.set("angle", (o.angle || 0) + delta);
      o.setPositionByOrigin(new fabric.Point(nx, ny), "center", "center");
      o.setCoords();
    });
  }

  /* Angle input / ±90 buttons: rotate an inserted table around its own
     centre instead of spinning every cell in place. */
  function tableAngleSelection(target, delta) {
    const objs = canvas.getActiveObjects();
    const tableObjs = objs.filter((o) => o.insertedTable);
    if (!tableObjs.length) return false;
    const anchor = tableObjs[0];
    const peers = tablePeers(anchor);
    if (peers.some((o) => o.locked)) {
      toast("Unlock this table before rotating it");
      return true;
    }
    canvas.discardActiveObject();
    const next = delta == null ? target : (peers[0].angle || 0) + delta;
    rotateTablePeers(peers, next);
    canvas.requestRenderAll();
    if (peers.length > 1) selectInsertedTable(peers[0]);
    else if (peers[0]) canvas.setActiveObject(peers[0]);
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
    pushHistory();
    return true;
  }

  let tableResize = null;

  function getTableCellObjs(tableId) {
    return canvas.getObjects().filter((o) => o.insertedTable === tableId);
  }

  function rebuildTableLayout(tableId) {
    const meta = getTableMeta(tableId);
    if (!meta) return;
    const objs = getTableCellObjs(tableId);
    if (!objs.length) return;
    if (!meta.colWidths || meta.colWidths.length !== meta.cols) {
      meta.colWidths = Array(meta.cols).fill(meta.cellW || 100);
    }
    if (!meta.rowHeights || meta.rowHeights.length !== meta.rows) {
      meta.rowHeights = Array(meta.rows).fill(meta.cellH || 30);
    }
    const headerW = meta.headerW != null ? meta.headerW : Math.max(24, (meta.fontSize || 12) * 2);
    const headerH = meta.headerH != null ? meta.headerH : Math.max(22, (meta.fontSize || 12) * 1.8);
    meta.headerW = headerW;
    meta.headerH = headerH;
    let baseLeft = meta.left != null ? meta.left - (meta.hasRowHeader ? headerW : 0) : Infinity;
    let baseTop = meta.top != null ? meta.top - (meta.hasColHeader ? headerH : 0) : Infinity;
    objs.forEach((o) => {
      if (typeof o.left === "number" && (o.headerType === "row" || o.cellCol === -1)) baseLeft = Math.min(baseLeft, o.left);
      if (typeof o.top === "number" && (o.headerType === "col" || o.cellRow === -1)) baseTop = Math.min(baseTop, o.top);
      if (o.isTableHeader && o.headerType === "corner") {
        baseLeft = Math.min(baseLeft, o.left);
        baseTop = Math.min(baseTop, o.top);
      }
    });
    if (!isFinite(baseLeft)) baseLeft = 0;
    if (!isFinite(baseTop)) baseTop = 0;
    const left = baseLeft;
    const top = baseTop;
    const offsetX = meta.hasRowHeader !== false ? headerW : 0;
    const offsetY = meta.hasColHeader !== false ? headerH : 0;
    meta.left = left + offsetX;
    meta.top = top + offsetY;

    // Headers
    if (meta.hasColHeader !== false) {
      for (let c = 0; c < meta.cols; c++) {
        let cx = left + offsetX;
        for (let cc = 0; cc < c; cc++) cx += meta.colWidths[cc];
        const rect = objs.find((o) => o.isTableHeader && o.headerType === "col" && o.cellCol === c);
        const txt = objs.find((o) => o.isTableHeader && o.headerType === "col" && o.cellCol === c && isText(o));
        if (rect) {
          rect.set({ left: cx, top: top, width: meta.colWidths[c], height: headerH });
          rect.setCoords();
        }
        if (txt) {
          txt.set({ left: cx + 4, top: top + 2, width: Math.max(10, meta.colWidths[c] - 8), textAlign: "center" });
          txt.setCoords();
        }
      }
      const corner = objs.find((o) => o.isTableHeader && o.headerType === "corner");
      if (corner) {
        corner.set({ left: left, top: top, width: headerW, height: headerH });
        corner.setCoords();
      }
    }
    if (meta.hasRowHeader !== false) {
      for (let r = 0; r < meta.rows; r++) {
        let cy = meta.top;
        for (let rr = 0; rr < r; rr++) cy += meta.rowHeights[rr];
        const rect = objs.find((o) => o.isTableHeader && o.headerType === "row" && o.cellRow === r);
        const txt = objs.find((o) => o.isTableHeader && o.headerType === "row" && o.cellRow === r && isText(o));
        if (rect) {
          rect.set({ left: left, top: cy, width: headerW, height: meta.rowHeights[r] });
          rect.setCoords();
        }
        if (txt) {
          txt.set({ left: left + 2, top: cy + 2, width: Math.max(10, headerW - 4), textAlign: "center" });
          txt.setCoords();
        }
      }
    }

    let cx = meta.left;
    for (let c = 0; c < meta.cols; c++) {
      const cw = meta.colWidths[c] || meta.cellW || 100;
      let cy = meta.top;
      for (let r = 0; r < meta.rows; r++) {
        const rh = meta.rowHeights[r] || meta.cellH || 30;
        const rect = objs.find((o) => o.isTableGrid && !o.isTableHeader && o.cellRow === r && o.cellCol === c);
        const txt = objs.find((o) => isText(o) && !o.isTableHeader && o.cellRow === r && o.cellCol === c);
        if (rect) {
          rect.set({ left: cx, top: cy, width: cw, height: rh });
          rect.setCoords();
        }
        if (txt) {
          const tw = Math.max(10, cw - Math.max(8, cw * 0.08));
          txt.set({
            left: cx + Math.max(4, cw * 0.04),
            top: cy + Math.max(2, rh * 0.08),
            width: tw,
          });
          if (txt.type === "textbox") {
            txt.set({ width: tw });
          }
          txt.setCoords();
        }
        cy += rh;
      }
      cx += cw;
    }
    canvas.requestRenderAll();
    syncLayers();
  }

  function addTableRow(tableId, afterIdx) {
    const meta = getTableMeta(tableId);
    if (!meta) return toast("No table selected");
    const rows = meta.rows || 0;
    const cols = meta.cols || 0;
    const r = afterIdx == null || afterIdx < 0 ? rows : clamp(afterIdx + 1, 0, rows);
    if (!meta.rowHeights || meta.rowHeights.length !== rows) {
      meta.rowHeights = Array(rows).fill(meta.cellH || 30);
    }
    meta.rowHeights.splice(r, 0, meta.cellH || 30);
    meta.rows = rows + 1;
    const objs = getTableCellObjs(tableId);
    objs.forEach((o) => {
      if (o.isTableHeader && o.headerType === "row" && o.cellRow >= r) o.cellRow++;
    });
    objs.forEach((o) => {
      if (!o.isTableHeader && o.cellRow >= r) o.cellRow++;
    });
    const border = meta.border || "#94a3b8";
    const borderW = meta.borderW || 1;
    const bodyFill = meta.bodyFill || "#ffffff";
    const fs = meta.fontSize || 12;
    const headerH = meta.headerH || Math.max(22, fs * 1.8);
    const headerW = meta.headerW || Math.max(24, fs * 2);
    let cy = meta.top || 0;
    for (let rr = 0; rr < r; rr++) cy += meta.rowHeights[rr] || meta.cellH || 30;
    // row header
    if (meta.hasRowHeader !== false) {
      const rh = meta.rowHeights[r] || meta.cellH || 30;
      const rectH = new fabric.Rect({
        left: (meta.left || 0) - headerW,
        top: cy,
        width: headerW,
        height: rh,
        fill: meta.headerFill || "#e8eefb",
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "pointer",
      });
      rectH.isTableGrid = true;
      rectH.insertedTable = tableId;
      rectH.tableId = tableId;
      rectH.isTableHeader = true;
      rectH.headerType = "row";
      rectH.cellRow = r;
      rectH.cellCol = -1;
      canvas.add(rectH);
      const txtH = new fabric.Textbox(String(r + 1), {
        left: (meta.left || 0) - headerW + 2,
        top: cy + 2,
        width: Math.max(10, headerW - 4),
        fontSize: fs - 1,
        fontFamily: FONTS.helvetica.css,
        fill: contrastOn(meta.headerFill || "#e8eefb"),
        lineHeight: 1.1,
        editable: false,
        textAlign: "center",
        splitByGrapheme: true,
        wordWrap: true,
      });
      txtH.insertedTable = tableId;
      txtH.tableId = tableId;
      txtH.isTableHeader = true;
      txtH.headerType = "row";
      txtH.cellRow = r;
      txtH.cellCol = -1;
      if (meta.headerBold) txtH.set("fontWeight", "bold");
      canvas.add(txtH);
    }
    for (let c = 0; c < cols; c++) {
      let cx = meta.left || 0;
      for (let cc = 0; cc < c; cc++) cx += (meta.colWidths && meta.colWidths[cc]) || meta.cellW || 100;
      const cw = (meta.colWidths && meta.colWidths[c]) || meta.cellW || 100;
      const rh = meta.rowHeights[r] || meta.cellH || 30;
      const rect = new fabric.Rect({
        left: cx,
        top: cy,
        width: cw,
        height: rh,
        fill: bodyFill,
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "move",
      });
      rect.isTableGrid = true;
      rect.insertedTable = tableId;
      rect.tableId = tableId;
      rect.cellRow = r;
      rect.cellCol = c;
      canvas.add(rect);
      const txt = new fabric.Textbox("", {
        left: cx + Math.max(4, cw * 0.04),
        top: cy + Math.max(2, rh * 0.08),
        width: Math.max(10, cw - Math.max(8, cw * 0.08)),
        fontSize: fs,
        fontFamily: FONTS.helvetica.css,
        fill: "#111827",
        lineHeight: 1.15,
        editable: true,
        splitByGrapheme: true,
        wordWrap: true,
      });
      txt.pdfFont = "helvetica";
      txt.insertedTable = tableId;
      txt.tableId = tableId;
      txt.cellRow = r;
      txt.cellCol = c;
      canvas.add(txt);
    }
    rebuildTableLayout(tableId);
    pushHistory();
    toast("Row added");
  }

  function addTableCol(tableId, afterIdx) {
    const meta = getTableMeta(tableId);
    if (!meta) return toast("No table selected");
    const rows = meta.rows || 0;
    const cols = meta.cols || 0;
    const c = afterIdx == null || afterIdx < 0 ? cols : clamp(afterIdx + 1, 0, cols);
    if (!meta.colWidths || meta.colWidths.length !== cols) {
      meta.colWidths = Array(cols).fill(meta.cellW || 100);
    }
    meta.colWidths.splice(c, 0, meta.cellW || 100);
    meta.cols = cols + 1;
    if (!meta.rowHeights || meta.rowHeights.length !== rows) {
      meta.rowHeights = Array(rows).fill(meta.cellH || 30);
    }
    const objs = getTableCellObjs(tableId);
    objs.forEach((o) => {
      if (o.isTableHeader && o.headerType === "col" && o.cellCol >= c) o.cellCol++;
    });
    objs.forEach((o) => {
      if (!o.isTableHeader && o.cellCol >= c) o.cellCol++;
    });
    const border = meta.border || "#94a3b8";
    const borderW = meta.borderW || 1;
    const bodyFill = meta.bodyFill || "#ffffff";
    const fs = meta.fontSize || 12;
    const headerH = meta.headerH || Math.max(22, fs * 1.8);
    let cx = meta.left || 0;
    for (let cc = 0; cc < c; cc++) cx += meta.colWidths[cc] || meta.cellW || 100;
    // column header
    if (meta.hasColHeader !== false) {
      const cw = meta.colWidths[c] || meta.cellW || 100;
      const rectH = new fabric.Rect({
        left: cx,
        top: (meta.top || 0) - headerH,
        width: cw,
        height: headerH,
        fill: meta.headerFill || "#e8eefb",
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "pointer",
      });
      rectH.isTableGrid = true;
      rectH.insertedTable = tableId;
      rectH.tableId = tableId;
      rectH.isTableHeader = true;
      rectH.headerType = "col";
      rectH.cellRow = -1;
      rectH.cellCol = c;
      canvas.add(rectH);
      const label = String.fromCharCode(65 + (c % 26)) + (c >= 26 ? String.fromCharCode(65 + Math.floor(c/26)-1) : "");
      const txtH = new fabric.Textbox(label, {
        left: cx + 4,
        top: (meta.top || 0) - headerH + 2,
        width: Math.max(10, cw - 8),
        fontSize: fs - 1,
        fontFamily: FONTS.helvetica.css,
        fill: contrastOn(meta.headerFill || "#e8eefb"),
        lineHeight: 1.1,
        editable: false,
        textAlign: "center",
        splitByGrapheme: true,
        wordWrap: true,
      });
      txtH.insertedTable = tableId;
      txtH.tableId = tableId;
      txtH.isTableHeader = true;
      txtH.headerType = "col";
      txtH.cellRow = -1;
      txtH.cellCol = c;
      if (meta.headerBold) txtH.set("fontWeight", "bold");
      canvas.add(txtH);
    }
    for (let r = 0; r < rows; r++) {
      let cy = meta.top || 0;
      for (let rr = 0; rr < r; rr++) cy += meta.rowHeights[rr] || meta.cellH || 30;
      const cw = meta.colWidths[c] || meta.cellW || 100;
      const rh = meta.rowHeights[r] || meta.cellH || 30;
      const rect = new fabric.Rect({
        left: cx,
        top: cy,
        width: cw,
        height: rh,
        fill: r === 0 ? (meta.headerFill || "#e8eefb") : bodyFill,
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "move",
      });
      rect.isTableGrid = true;
      rect.insertedTable = tableId;
      rect.tableId = tableId;
      rect.cellRow = r;
      rect.cellCol = c;
      canvas.add(rect);
      const txt = new fabric.Textbox("", {
        left: cx + Math.max(4, cw * 0.04),
        top: cy + Math.max(2, rh * 0.08),
        width: Math.max(10, cw - Math.max(8, cw * 0.08)),
        fontSize: fs,
        fontFamily: FONTS.helvetica.css,
        fill: r === 0 ? contrastOn(meta.headerFill || "#e8eefb") : "#111827",
        lineHeight: 1.15,
        editable: true,
        splitByGrapheme: true,
        wordWrap: true,
      });
      txt.pdfFont = "helvetica";
      txt.insertedTable = tableId;
      txt.tableId = tableId;
      txt.cellRow = r;
      txt.cellCol = c;
      if (r === 0 && meta.headerBold) txt.set("fontWeight", "bold");
      canvas.add(txt);
    }
    rebuildTableLayout(tableId);
    pushHistory();
    toast("Column added");
  }

  function delTableRow(tableId, idx) {
    const meta = getTableMeta(tableId);
    if (!meta) return toast("No table selected");
    if ((meta.rows || 0) <= 1) return toast("Cannot delete last row");
    const rows = meta.rows || 0;
    const r = idx == null || idx < 0 ? rows - 1 : clamp(idx, 0, rows - 1);
    if (!meta.rowHeights || meta.rowHeights.length !== rows) {
      meta.rowHeights = Array(rows).fill(meta.cellH || 30);
    }
    meta.rowHeights.splice(r, 1);
    meta.rows = rows - 1;
    const toRemove = getTableCellObjs(tableId).filter((o) => !o.isTableHeader && o.cellRow === r);
    toRemove.forEach((o) => canvas.remove(o));
    getTableCellObjs(tableId).filter((o) => o.isTableHeader && o.headerType === "row" && o.cellRow === r).forEach((o) => canvas.remove(o));
    getTableCellObjs(tableId).forEach((o) => {
      if (o.isTableHeader && o.headerType === "row" && o.cellRow > r) o.cellRow--;
    });
    getTableCellObjs(tableId).forEach((o) => {
      if (!o.isTableHeader && o.cellRow > r) o.cellRow--;
    });
    rebuildTableLayout(tableId);
    pushHistory();
    toast("Row deleted");
  }

  function delTableCol(tableId, idx) {
    const meta = getTableMeta(tableId);
    if (!meta) return toast("No table selected");
    if ((meta.cols || 0) <= 1) return toast("Cannot delete last column");
    const cols = meta.cols || 0;
    const c = idx == null || idx < 0 ? cols - 1 : clamp(idx, 0, cols - 1);
    if (!meta.colWidths || meta.colWidths.length !== cols) {
      meta.colWidths = Array(cols).fill(meta.cellW || 100);
    }
    meta.colWidths.splice(c, 1);
    meta.cols = cols - 1;
    const toRemove = getTableCellObjs(tableId).filter((o) => !o.isTableHeader && o.cellCol === c);
    toRemove.forEach((o) => canvas.remove(o));
    getTableCellObjs(tableId).filter((o) => o.isTableHeader && o.headerType === "col" && o.cellCol === c).forEach((o) => canvas.remove(o));
    getTableCellObjs(tableId).forEach((o) => {
      if (o.isTableHeader && o.headerType === "col" && o.cellCol > c) o.cellCol--;
    });
    getTableCellObjs(tableId).forEach((o) => {
      if (!o.isTableHeader && o.cellCol > c) o.cellCol--;
    });
    rebuildTableLayout(tableId);
    pushHistory();
    toast("Column deleted");
  }

  /* Turn a replaced text back into fully transparent text by deleting the
     background patch that was placed under it. Works for multi-selections. */
  function removePatchForText(obj) {
    const target = obj || canvas.getActiveObject();
    const targets = objectListOf(target).filter((o) => o && o.patchUid);
    if (!targets.length) return toast("This text has no background patch");

    let removed = 0;
    targets.forEach((t) => {
      const patch = findPatchFor(t);
      if (patch) {
        canvas.remove(patch);
        removed++;
      }
      t.patchUid = null;
    });
    if (!removed) return toast("The patch was already removed");

    canvas.requestRenderAll();
    pushHistory();
    syncLayers();
    toast(
      removed > 1
        ? `Removed the background patch from ${removed} texts`
        : "Patch removed — this text is transparent now"
    );
  }

  /* ======================================================================
     TABLES  (detect from cell runs, extract as editable cells)
     ====================================================================== */
  function detectTables(p) {
    if (!p) return [];
    if (p.tables) return p.tables;
    if (!p.text) return [];

    const lines = (p.text || [])
      .filter((l) => (l.cells || []).length >= 2)
      .sort((a, b) => a.top - b.top);
    const tol = Math.max(6, (p.width || 600) * 0.012);

    const blocks = [];
    for (const l of lines) {
      const last = blocks[blocks.length - 1];
      const maxGap = Math.max(10, l.height * 1.9);
      if (last && l.top - last.bottom <= maxGap) {
        last.rows.push(l);
        last.bottom = Math.max(last.bottom, l.top + l.height);
      } else {
        blocks.push({ rows: [l], top: l.top, bottom: l.top + l.height });
      }
    }

    const tables = [];
    for (const b of blocks) {
      if (b.rows.length < 2) continue;
      const totalCells = b.rows.reduce((n, r) => n + r.cells.length, 0);
      if (totalCells < 4) continue;
      const maxCells = Math.max(...b.rows.map((r) => r.cells.length));
      const avgLen =
        b.rows.reduce((n, r) => n + r.cells.reduce((m, c) => m + c.text.length, 0), 0) /
        totalCells;
      /* Two-column body text can look like a 2-cell table; require either a
         third column or short cell contents before calling it a table. */
      if (maxCells < 3 && avgLen > 28) continue;

      const seeds = [];
      for (const r of b.rows) for (const c of r.cells) seeds.push(c.left);
      seeds.sort((a, b2) => a - b2);
      const cols = [];
      for (const x0 of seeds) {
        const col = cols.find((c) => Math.abs(c.x - x0) <= tol);
        if (col) {
          col.x = (col.x * col.n + x0) / (col.n + 1);
          col.n++;
        } else {
          cols.push({ x: x0, n: 1 });
        }
      }
      const keep = cols.filter((c) => c.n >= Math.max(2, Math.ceil(b.rows.length * 0.5)));
      if (keep.length < 2) continue;
      keep.sort((a, b2) => a.x - b2.x);

      for (const r of b.rows) {
        for (const c of r.cells) {
          let idx = 0;
          for (let ci = 0; ci < keep.length; ci++) if (c.left >= keep[ci].x - tol) idx = ci;
          c.col = idx;
        }
        r.cells.sort((a, b2) => a.col - b2.col || a.left - b2.left);
      }

      tables.push({
        id: "table-" + (tables.length + 1),
        rows: b.rows,
        cols: Math.max(keep.length, maxCells),
        left: Math.min(...b.rows.map((r) => r.left)),
        right: Math.max(...b.rows.map((r) => r.left + r.width)),
        top: b.top,
        bottom: b.bottom,
      });
    }

    p.tables = tables;
    return tables;
  }

  function tableCsv(table) {
    const rows = table.rows.map((r) => {
      const arr = new Array(table.cols).fill("");
      for (const c of r.cells) {
        const i = clamp(c.col || 0, 0, table.cols - 1);
        arr[i] = arr[i] ? arr[i] + " " + c.text : c.text;
      }
      return arr;
    });
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    return rows.map((r) => r.map(q).join(",")).join("\r\n");
  }

  function downloadTableCsv(table) {
    if (!table) return;
    const blob = new Blob(["\ufeff" + tableCsv(table)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    downloadFile(url, table.id + ".csv");
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("Table saved as CSV");
  }

  /* Every cell becomes its own patch + text layer, so each value can be
     edited independently while the table grid drawn in the page stays. */
  async function extractTable(table) {
    const p = S.pages[S.index];
    if (!p || !table) return;
    const existing = canvas.getObjects().find((o) => o.tableId === table.id && o.type === "i-text");
    if (existing) {
      canvas.setActiveObject(existing);
      canvas.requestRenderAll();
      return toast("This table is already editable — click any cell to change it", 3000);
    }
    showProgress("Extracting table…");
    try {
      const made = [];
      const patchBoxEl = $("patchOnReplace");
      const wantPatch = !patchBoxEl || patchBoxEl.checked;
      S.suppressHistory = true;
      table.rows.forEach((row, ri) => {
        const fs = Math.max(1, row.fontSize);
        const key = guessFontKey(row.fontName || row.family);
        for (const cell of row.cells) {
          const padX = Math.max(0.5, fs * 0.06);
          const padY = Math.max(0.5, fs * 0.08);
          const box = {
            left: cell.left - padX,
            top: row.top - padY,
            width: Math.max(1, cell.width) + padX * 2,
            height: row.height + padY * 2,
          };
          const sampleBox = {
            left: box.left - fs * 0.2,
            top: box.top - fs * 0.3,
            width: box.width + fs * 0.4,
            height: box.height + fs * 0.6,
          };
          const dispBox = mapPageBox(p, box);
          const dispSample = mapPageBBox(p, sampleBox);
          const colors = analyzeColors(dispSample);

          let patch = null;
          if (wantPatch) {
            patch = new fabric.Rect({
              left: dispBox.left,
              top: dispBox.top,
              width: dispBox.width,
              height: dispBox.height,
              angle: dispBox.angle || 0,
              fill: colors.bg,
              stroke: null,
              strokeWidth: 0,
              selectable: true,
              hoverCursor: "move",
            });
            patch.isPatch = true;
            patch.tableId = table.id;
          }

          const t = new fabric.IText(cell.text, {
            left: dispBox.left,
            top: dispBox.top,
            angle: dispBox.angle || 0,
            fontSize: fs,
            fontFamily: FONTS[key].css,
            fill: colors.fg,
            lineHeight: 1.1,
            editable: true,
          });
          t.pdfFont = key;
          t.tableId = table.id;
          t.cellRow = ri;
          t.cellCol = cell.col || 0;
          t.uid = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
          if (patch) {
            patch.uid = "p" + t.uid;
            t.patchUid = patch.uid;
          }
          if (FONTS[key].custom) t.customFont = key;

          const style = detectTextStyle(Object.assign({ fontSize: fs }, dispSample), colors.bg);
          const bold = row.bold || style.bold || /bold|black|heavy|semibold|demi/i.test((row.fontName || "") + " " + (row.family || ""));
          const italic = row.italic || /italic|oblique/i.test((row.fontName || "") + " " + (row.family || ""));
          if (bold) t.set("fontWeight", "bold");
          if (italic) t.set("fontStyle", "italic");

          if (patch) canvas.add(patch);
          canvas.add(t);
          made.push(t);
        }
      });
      S.suppressHistory = false;
      canvas.renderAll();
      pushHistory();
      syncLayers();
      if (made.length) canvas.setActiveObject(made[0]);
      toast(
        wantPatch
          ? `Table extracted — ${made.length} editable cells. Click any cell to edit it.`
          : `Table extracted — ${made.length} transparent cells (original text stays visible underneath).`,
        3600
      );
    } finally {
      S.suppressHistory = false;
      hideProgress();
    }
  }

  /* Save the table as it currently looks — original page pixels plus any
     edited cells on top, cropped to the table bounds. */
  async function exportTablePng(table) {
    const p = S.pages[S.index];
    if (!p || !table) return;
    showProgress("Rendering table…");
    try {
      const pad = 4;
      const tb = mapPageBBox(p, {
        left: table.left,
        top: table.top,
        width: Math.max(1, table.right - table.left),
        height: Math.max(1, table.bottom - table.top),
      });
      const left = Math.max(0, Math.floor(tb.left) - pad);
      const top = Math.max(0, Math.floor(tb.top) - pad);
      const right = Math.min(p.width, Math.ceil(tb.left + tb.width) + pad);
      const bottom = Math.min(p.height, Math.ceil(tb.top + tb.height) + pad);
      const w = Math.max(1, right - left);
      const h = Math.max(1, bottom - top);

      const bgScale = S.bgScale || 1;
      const fCanvas = canvas.lowerCanvasEl;
      const fScale = fCanvas && fCanvas.width ? fCanvas.width / p.width : bgScale;
      const scale = Math.max(bgScale, fScale);

      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(h * scale));
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);

      if (el.bgCanvas && el.bgCanvas.width) {
        ctx.drawImage(
          el.bgCanvas,
          left * bgScale,
          top * bgScale,
          w * bgScale,
          h * bgScale,
          0,
          0,
          out.width,
          out.height
        );
      }
      if (fCanvas && fCanvas.width) {
        ctx.drawImage(
          fCanvas,
          left * fScale,
          top * fScale,
          w * fScale,
          h * fScale,
          0,
          0,
          out.width,
          out.height
        );
      }

      downloadFile(out.toDataURL("image/png"), table.id + ".png");
      toast("Table image saved");
    } finally {
      hideProgress();
    }
  }

  function setTablesEmpty(text) {
    const wrap = $("tables");
    if (!wrap) return;
    wrap.innerHTML = "";
    const d = document.createElement("div");
    d.className = "empty-layers";
    d.textContent = text;
    wrap.appendChild(d);
    const cnt = $("tableCount");
    if (cnt) cnt.textContent = "0";
  }

  async function syncTables() {
    const wrap = $("tables");
    if (!wrap) return;
    const p = S.pages[S.index];
    if (!S.ready || !p) return setTablesEmpty("Open a PDF to find tables.");

    setTablesEmpty(isPdfPage(p) ? "Looking for tables…" : "This page has no tables.");
    try {
      await getTextLines(p);
    } catch (e) {
      return setTablesEmpty("Could not read the text on this page.");
    }
    if (S.pages[S.index] !== p) return;

    const tables = detectTables(p);
    const cnt = $("tableCount");
    if (cnt) cnt.textContent = String(tables.length);
    if (!tables.length) return setTablesEmpty("No table detected on this page.");

    wrap.innerHTML = "";
    tables.forEach((table, i) => {
      const row = document.createElement("div");
      row.className = "table-row";

      const meta = document.createElement("div");
      meta.className = "table-meta";
      const b = document.createElement("b");
      b.textContent = "Table " + (i + 1);
      const s = document.createElement("span");
      s.textContent = table.rows.length + " rows × " + table.cols + " cols";
      meta.append(b, s);

      const ext = document.createElement("button");
      ext.className = "l-btn";
      ext.title = "Make every cell editable";
      setIcon(ext, "pencil");
      ext.addEventListener("click", () => extractTable(table));

      const csv = document.createElement("button");
      csv.className = "l-btn wide";
      csv.title = "Save this table as a CSV file";
      csv.textContent = "CSV";
      csv.addEventListener("click", () => downloadTableCsv(table));

      const png = document.createElement("button");
      png.className = "l-btn";
      png.title = "Save this table as a PNG image";
      setIcon(png, "download");
      png.addEventListener("click", () => exportTablePng(table));

      row.append(meta, ext, csv, png);
      wrap.appendChild(row);
    });
  }

  /* Save the selected layer(s) as a cropped, transparent PNG. The layer is
     rendered on its own off-screen canvas, so no page background is baked in
     and the user can drop the file anywhere later. */
  async function exportSelectionPng() {
    const active = canvas.getActiveObjects().slice();
    if (!active.length) return toast("Select a layer first (click it, or use the Layers list)", 3000);

    const objs = canvas.getObjects();
    const keep = new Set(active.map((o) => objs.indexOf(o)).filter((i) => i >= 0));
    let json;
    try {
      json = JSON.parse(snapshot());
    } catch (e) {
      return toast("Could not read the selected layer");
    }
    json.objects = (json.objects || []).filter((_, i) => keep.has(i));
    if (!json.objects.length) return toast("Nothing to save in this selection");
    delete json.background;
    delete json.backgroundImage;
    delete json.overlay;
    delete json.overlayImage;

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const o of active) {
      let r;
      try {
        r = objectRect(o);
      } catch (e) {
        continue;
      }
      if (!r) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.left + r.width);
      bottom = Math.max(bottom, r.top + r.height);
    }
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) {
      return toast("Could not measure this layer");
    }

    /* small breathing room so anti-aliased edges are not cut off */
    left = Math.floor(left - 2);
    top = Math.floor(top - 2);
    right = Math.ceil(right + 2);
    bottom = Math.ceil(bottom + 2);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    showProgress("Saving layer…");
    let stat = null;
    try {
      const p = S.pages[S.index];
      const cw = Math.max(1, Math.ceil(Math.max(p ? p.width : 0, right)));
      const ch = Math.max(1, Math.ceil(Math.max(p ? p.height : 0, bottom)));

      stat = new fabric.StaticCanvas(null, {
        width: cw,
        height: ch,
        backgroundColor: null,
        enableRetinaScaling: false,
      });
      await new Promise((res) => stat.loadFromJSON(json, res));
      stat.setDimensions({ width: cw, height: ch });
      stat.backgroundColor = null;
      stat.renderAll();

      /* up to 2× resolution, capped so huge pages stay manageable */
      const multiplier = Math.min(2, Math.max(1, 6000 / Math.max(width, height)));
      const dataUrl = stat.toDataURL({
        format: "png",
        multiplier,
        left,
        top,
        width,
        height,
      });

      const first = active[0];
      let base = (first ? layerLabel(first) : "layer").replace(/[^\w\-. ]+/g, "").trim();
      if (!base) base = "layer";
      if (active.length > 1) base += "-" + active.length + "-layers";
      downloadFile(dataUrl, base + ".png");
      toast("Layer saved as a transparent PNG", 2600);
    } catch (e) {
      console.warn("Layer export failed", e);
      toast("Could not save the layer: " + (e && e.message ? e.message : e), 3600);
    } finally {
      if (stat) {
        try {
          stat.dispose();
        } catch (e) {
          /* ignore */
        }
      }
      hideProgress();
    }
  }

  /* ======================================================================
     TOOLS
     ====================================================================== */
  const DRAW_TOOLS = new Set(["rect", "ellipse", "line", "patch", "highlight"]);
  let rotateGesture = null;
  let screenshotMode = false;
  let screenshotStart = null;
  let screenshotRect = null;

  function setTool(tool) {
    S.tool = tool;
    screenshotMode = false;
    screenshotStart = null;
    if (screenshotRect) {
      try { canvas.remove(screenshotRect); } catch (e) {}
      screenshotRect = null;
    }
    if (canvas.lowerCanvasEl) {
      try { canvas.lowerCanvasEl.style.cursor = ""; } catch (e) {}
    }
    if (canvas.upperCanvasEl) {
      try { canvas.upperCanvasEl.style.cursor = ""; } catch (e) {}
    }
    document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    document.querySelectorAll(".tool[data-action]").forEach((b) => b.classList.toggle("active", false));
    const selectLike = tool === "select" || tool === "rotate";
    canvas.isDrawingMode = tool === "pen";
    canvas.selection = tool === "select";
    canvas.defaultCursor = tool === "rotate" ? "grab" : tool === "select" ? "default" : "crosshair";
    canvas.hoverCursor = tool === "rotate" ? "grab" : tool === "select" ? "move" : "crosshair";
    canvas.moveCursor = tool === "rotate" ? "grabbing" : "move";
    canvas.getObjects().forEach((o) => {
      if (o.isTableHeader) { o.selectable = false; o.evented = true; return; }
      o.selectable = selectLike;
      o.evented = selectLike;
    });
    if (tool === "pen") {
      canvas.freeDrawingBrush.color = $("strokeColor").value;
      canvas.freeDrawingBrush.width = Number($("strokeWidth").value) || 2;
    }
    if (selectLike) syncProps();
    if (tool === "rotate" && !S.rotateHintShown) {
      S.rotateHintShown = true;
      toast("Drag any object on the page to rotate it. Hold Shift for 15° steps.", 4600);
    }
  }

  function makeShape(tool, p) {
    const fill = $("fillColor").value;
    const stroke = $("strokeColor").value;
    const sw = Number($("strokeWidth").value) || 0;
    const op = clamp(Number($("opacityInput").value) || 1, 0, 1);

    if (tool === "rect") {
      return new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill, stroke, strokeWidth: sw, opacity: op });
    }
    if (tool === "patch") {
      const color = $("autoPatch").checked ? sampleBgAt(p) : fill;
      const r = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: color, stroke: null, strokeWidth: 0, opacity: 1 });
      r.isPatch = true;
      return r;
    }
    if (tool === "highlight") {
      const r = new fabric.Rect({
        left: p.x, top: p.y, width: 1, height: 1,
        fill: "#fde047", stroke: null, strokeWidth: 0, opacity: 0.4,
      });
      return r;
    }
    if (tool === "ellipse") {
      return new fabric.Ellipse({ left: p.x, top: p.y, rx: 1, ry: 1, fill, stroke, strokeWidth: sw, opacity: op });
    }
    if (tool === "line") {
      return new fabric.Line([p.x, p.y, p.x, p.y], { stroke, strokeWidth: Math.max(sw, 1), fill: null, opacity: op });
    }
    return null;
  }

  async function captureScreenshotArea(lx, ty, w, h) {
    if (!S.ready) return;
    const p = S.pages[S.index];
    if (!p) return;
    const left2 = Math.max(0, Math.floor(Math.min(lx, lx + w)));
    const top2 = Math.max(0, Math.floor(Math.min(ty, ty + h)));
    const rw = Math.max(1, Math.abs(w));
    const rh = Math.max(1, Math.abs(h));
    const w2 = Math.max(1, Math.min(p.width - left2, rw));
    const h2 = Math.max(1, Math.min(p.height - top2, rh));
    const bgScale = S.bgScale || 1;
    const fCanvas = canvas.lowerCanvasEl;
    const fScale = fCanvas && fCanvas.width ? fCanvas.width / p.width : bgScale;
    const scale = Math.max(bgScale, fScale, Math.ceil((window.devicePixelRatio || 1) * 3), 6);
    if (screenshotRect) {
      try { canvas.remove(screenshotRect); } catch (e) {}
      screenshotRect = null;
    }
    try {
      canvas.discardActiveObject();
      canvas.selection = false;
      canvas.skipTargetFind = true;
      canvas.renderAll();
    } catch (e) {}
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w2 * scale));
    out.height = Math.max(1, Math.round(h2 * scale));
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    if (el.bgCanvas && el.bgCanvas.width) {
      ctx.drawImage(el.bgCanvas, left2 * bgScale, top2 * bgScale, w2 * bgScale, h2 * bgScale, 0, 0, out.width, out.height);
    }
    if (fCanvas && fCanvas.width) {
      ctx.drawImage(fCanvas, left2 * fScale, top2 * fScale, w2 * fScale, h2 * fScale, 0, 0, out.width, out.height);
    }
    try {
      canvas.skipTargetFind = false;
      canvas.selection = true;
    } catch (e) {}
    const dataUrl = out.toDataURL("image/png");
    fabric.Image.fromURL(dataUrl, (img) => {
      img.set({
        left: left2,
        top: top2,
        originX: "left",
        originY: "top",
        scaleX: 1 / scale,
        scaleY: 1 / scale,
      });
      img.uid = "img-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      screenshotMode = false;
      screenshotStart = null;
      if (screenshotRect) { try { canvas.remove(screenshotRect); } catch (e) {} screenshotRect = null; }
      if (screenshotRect) { try { canvas.remove(screenshotRect); } catch (e) {} screenshotRect = null; }
      if (screenshotRect) { try { canvas.remove(screenshotRect); } catch (e) {} screenshotRect = null; }
      document.querySelectorAll(".tool[data-action]").forEach((b) => b.classList.toggle("active", false));
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      pushHistory();
      syncLayers();
      setTool("select");
      toast("Screenshot captured as image layer");
    }, { crossOrigin: "anonymous" });
  }

  function updateShape(obj, a, b, tool) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const w = Math.max(1, Math.abs(b.x - a.x));
    const h = Math.max(1, Math.abs(b.y - a.y));

    if (tool === "line") {
      obj.set({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    } else if (obj.type === "ellipse") {
      obj.set({ left, top, width: w, height: h, rx: w / 2, ry: h / 2 });
    } else {
      obj.set({ left, top, width: w, height: h });
    }
    obj.setCoords();
  }

  /* ----------------------------------------------------------------------
     MOUSE ROTATION TOOL
     Drag an inserted text, image, vector shape, multi-selection or table
     around its own visual centre.  Radius + angle are measured from the
     pointer, so the object never jumps when the drag starts.
     ---------------------------------------------------------------------- */
  function boundsCentre(objs) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    objs.forEach((o) => {
      const r = objectRect(o);
      if (!r) return;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.left + r.width);
      maxY = Math.max(maxY, r.top + r.height);
    });
    if (!isFinite(minX)) {
      const c = objs[0] && objs[0].getCenterPoint ? objs[0].getCenterPoint() : { x: 0, y: 0 };
      return { x: c.x, y: c.y };
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  function startRotateGesture(opt) {
    const target = opt.target || canvas.getActiveObject();
    if (!target) return false;
    const tableAnchor = target.insertedTable
      ? target
      : objectListOf(target).find((o) => o.insertedTable);
    const peers = tableAnchor ? tablePeers(tableAnchor) : [];
    const mode = tableAnchor && peers.length ? "table" : "object";
    const participants = mode === "table" ? peers : objectListOf(target);
    if (participants.some((o) => o.locked)) {
      toast("Unlock this object before rotating it");
      return false;
    }
    const centre = mode === "table" ? boundsCentre(peers) : target.getCenterPoint();
    const p = canvas.getPointer(opt.e);
    const pointerAngle = (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;

    rotateGesture = {
      target,
      mode,
      anchor: tableAnchor || null,
      peers,
      centre,
      startAngle: mode === "table" ? peers[0].angle || 0 : target.angle || 0,
      lastPointerAngle: pointerAngle,
      accumulated: 0,
      moved: false,
    };

    /* ActiveSelection stores group-relative coordinates.  Restore the table
       cells to page space before rotating them individually. */
    if (mode === "table" && canvas.getActiveObject() && canvas.getActiveObject().type === "activeSelection") {
      canvas.discardActiveObject(opt.e);
    }

    /* Stop fabric's own move/scale/rotate transform; ours runs instead. */
    canvas._currentTransform = null;
    canvas._groupSelector = null;
    canvas.upperCanvasEl.style.cursor = "grabbing";
    return true;
  }

  function moveRotateGesture(opt) {
    const g = rotateGesture;
    if (!g) return false;
    const p = canvas.getPointer(opt.e);
    const pointerAngle = (Math.atan2(p.y - g.centre.y, p.x - g.centre.x) * 180) / Math.PI;

    /* Accumulate the shortest step so a full turn keeps going instead of
       flipping at the -180/180 boundary. */
    let step = pointerAngle - g.lastPointerAngle;
    if (step > 180) step -= 360;
    else if (step < -180) step += 360;
    g.lastPointerAngle = pointerAngle;
    g.accumulated += step;
    if (Math.abs(g.accumulated) > 0.2) g.moved = true;

    let next = g.startAngle + g.accumulated;
    if (opt.e && opt.e.shiftKey) next = Math.round(next / 15) * 15;

    if (g.mode === "table") {
      rotateTablePeers(g.peers, next);
    } else {
      const t = g.target;
      t.set("angle", next);
      t.setPositionByOrigin(new fabric.Point(g.centre.x, g.centre.y), "center", "center");
      t.setCoords();
    }

    if ($("angleInput")) $("angleInput").value = String(Math.round(next * 10) / 10);
    canvas.upperCanvasEl.style.cursor = "grabbing";
    canvas.requestRenderAll();
    return true;
  }

  function endRotateGesture() {
    const g = rotateGesture;
    if (!g) return false;
    rotateGesture = null;
    canvas.upperCanvasEl.style.cursor = "";
    if (g.mode === "table" && g.peers.length > 1 && g.anchor) selectInsertedTable(g.anchor);
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
    if (g.moved) pushHistory();
    return true;
  }

  canvas.on("mouse:down", (opt) => {
    if (!S.ready) return;
    if (S.tool === "rotate") {
      if (startRotateGesture(opt)) return;
    }
    const p = canvas.getPointer(opt.e);

    if (S.tool === "detach") {
      handleDetachClick(p);
      return;
    }
    if (S.tool === "text") {
      addTextAt(p.x, p.y);
      return;
    }
    if (S.tool === "image") {
      S.pendingImage = { x: p.x, y: p.y };
      el.fileInput.accept = "image/*";
      el.fileInput.dataset.mode = "image";
      el.fileInput.click();
      return;
    }
    if (DRAW_TOOLS.has(S.tool)) {
      S.drawStart = p;
      S.drawing = makeShape(S.tool, p);
      if (!S.drawing) return;
      S.suppressHistory = true;
      canvas.add(S.drawing);
      canvas.requestRenderAll();
    }
  });

  canvas.on("mouse:move", (opt) => {
    if (moveRotateGesture(opt)) return;
    if (!S.drawing || !S.drawStart) return;
    const p = canvas.getPointer(opt.e);
    updateShape(S.drawing, S.drawStart, p, S.tool);
    canvas.requestRenderAll();
  });

  canvas.on("mouse:up", () => {
    if (endRotateGesture()) return;
    if (!S.drawing) return;
    const obj = S.drawing;
    S.drawing = null;
    S.drawStart = null;
    S.suppressHistory = false;

    if (obj.width * obj.scaleX < 2 || obj.height * obj.scaleY < 2) {
      canvas.remove(obj);
    } else {
      obj.setCoords();
      canvas.setActiveObject(obj);
    }
    pushHistory();
    syncProps();
  });

  canvas.on("mouse:dblclick", async (opt) => {
    if (!S.ready || S.tool !== "select") return;

    /* A table may be grouped as a whole (or just one cell selected), so
       double-click has to reach the individual cell text ourselves. */
    const p = canvas.getPointer(opt.e);
    const tableHit =
      opt.target && opt.target.insertedTable ? opt.target : tableCellAtPoint(p);
    if (tableHit && tableHit.insertedTable) {
      if (editTableCell(tableHit)) return;
    }

    if (opt.target) return;

    await getTextLines(S.pages[S.index]);
    const hit = hitText(p);

    if (hit) {
      /* Default: only the word under the cursor. Alt/Shift: the whole line,
         or the single table cell when the line is a table row. */
      await replaceTextAt(hit, { wholeLine: opt.e.altKey || opt.e.shiftKey });
    } else if (!S.hintShown) {
      S.hintShown = true;
      toast("Double-click a word to replace just that word (Alt/Shift: whole line)", 3600);
    }
  });

  /* ======================================================================
     ADD OBJECTS
     ====================================================================== */
  function addTextAt(x, y, text) {
    const picked = $("fontFamily").value;
    const fontKey = FONTS[picked] ? picked : "helvetica";
    const t = new fabric.IText(text || "Text", {
      left: x,
      top: y - 6,
      fontSize: clamp(Number($("fontSize").value) || 18, 1, 400),
      fontFamily: FONTS[fontKey].css,
      fill: $("fillColor").value,
      opacity: clamp(Number($("opacityInput").value) || 1, 0, 1),
      lineHeight: 1.1,
      editable: true,
    });
    t.pdfFont = fontKey;
    if (FONTS[fontKey].custom) t.customFont = fontKey;
    canvas.add(t);
    canvas.setActiveObject(t);
    syncLayers();
    pushHistory();
    if (!text) {
      t.enterEditing();
      t.selectAll();
    }
  }

  function addImage(file, x, y) {
    if (!file || !/^image\//.test(file.type || "")) return;
    const reader = new FileReader();
    reader.onload = () => {
      fabric.Image.fromURL(reader.result, (img) => {
        const p = S.pages[S.index];
        const maxW = p.width * 0.55;
        const s = Math.min(1, maxW / (img.width || 1));
        img.set({
          left: x - (img.width * s) / 2,
          top: y - (img.height * s) / 2,
          scaleX: s,
          scaleY: s,
          opacity: clamp(Number($("opacityInput").value) || 1, 0, 1),
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        syncLayers();
        pushHistory();
      });
    };
    reader.readAsDataURL(file);
  }

  /* ======================================================================
     LAYERS
     ====================================================================== */
  function layerLabel(o) {
    if (isText(o)) {
      const t = (o.text || "").trim().replace(/\s+/g, " ");
      return t ? (t.length > 20 ? t.slice(0, 20) + "…" : t) : "Text";
    }
    if (o.type === "image") return "Image";
    if (o.type === "path") return "Drawing";
    if (o.type === "line") return "Line";
    if (o.type === "ellipse") return "Ellipse";
    if (o.type === "rect") return o.isPatch ? "Patch" : "Rectangle";
    return o.type;
  }

  function layerIcon(o) {
    if (isText(o)) return "text";
    if (o.type === "image") return "image";
    if (o.type === "path") return "pencil";
    if (o.type === "line") return "line";
    if (o.type === "ellipse") return "ellipse";
    if (o.type === "rect") return o.isPatch ? "patch" : "rect";
    return "rect";
  }

  function syncLayers() {
    const objs = canvas.getObjects();
    el.layerCount.textContent = String(objs.length);
    const active = canvas.getActiveObjects();
    const frag = document.createDocumentFragment();

    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      const row = document.createElement("div");
      row.className = "layer" + (active.indexOf(o) >= 0 ? " sel" : "");
      row.dataset.index = String(i);

      const ico = document.createElement("span");
      ico.className = "l-ico";
      setIcon(ico, layerIcon(o));

      const name = document.createElement("span");
      name.className = "l-name";
      name.textContent = layerLabel(o);

      const vis = document.createElement("button");
      vis.className = "l-btn";
      vis.title = "Show / hide";
      setIcon(vis, o.visible === false ? "eye-off" : "eye");

      const lockBtn = document.createElement("button");
      lockBtn.className = "l-btn" + (o.locked ? " on" : "");
      lockBtn.title = o.locked ? "Unlock this layer" : "Lock this layer";
      setIcon(lockBtn, o.locked ? "lock" : "unlock");
      lockBtn.onclick = (e) => {
        e.stopPropagation();
        const lock = !o.locked;
        const list = o.insertedTable ? tablePeers(o) : [o];
        list.forEach((q) => applyLock(q, lock));
        canvas.requestRenderAll();
        syncLayers();
        syncProps();
        pushHistory();
      };

      const up = document.createElement("button");
      up.className = "l-btn";
      up.title = "Bring forward";
      setIcon(up, "arrow-up");

      const down = document.createElement("button");
      down.className = "l-btn";
      down.title = "Send backward";
      setIcon(down, "arrow-down");

      vis.onclick = (e) => {
        e.stopPropagation();
        const hide = o.visible !== false;
        const list = o.insertedTable ? tablePeers(o) : [o];
        list.forEach((q) => (q.visible = !hide));
        canvas.requestRenderAll();
        syncLayers();
        pushHistory();
      };
      up.onclick = (e) => {
        e.stopPropagation();
        canvas.bringForward(o);
        canvas.requestRenderAll();
        syncLayers();
        pushHistory();
      };
      down.onclick = (e) => {
        e.stopPropagation();
        canvas.sendBackwards(o);
        canvas.requestRenderAll();
        syncLayers();
        pushHistory();
      };
      row.onclick = (e) => {
        if (S.tool !== "select") setTool("select");
        /* Ctrl/Cmd/Shift-click adds or removes a layer from the selection,
           so several layers can be moved or saved as one PNG. */
        if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
          let now = canvas.getActiveObjects().slice();
          const list = o.insertedTable ? tablePeers(o) : [o];
          const allIn = list.every((q) => now.indexOf(q) >= 0);
          if (allIn) now = now.filter((q) => list.indexOf(q) < 0);
          else list.forEach((q) => { if (now.indexOf(q) < 0) now.push(q); });
          canvas.discardActiveObject();
          if (now.length > 1) canvas.setActiveObject(new fabric.ActiveSelection(now, { canvas }));
          else if (now.length === 1) canvas.setActiveObject(now[0]);
        } else {
          /* Clicking any cell row selects the whole inserted table. */
          if (!selectInsertedTable(o)) canvas.setActiveObject(o);
        }
        canvas.requestRenderAll();
        syncLayers();
        syncProps();
      };

      row.append(ico, name, vis, lockBtn, up, down);
      frag.appendChild(row);
    }

    el.layerList.innerHTML = "";
    if (!objs.length) {
      const empty = document.createElement("div");
      empty.className = "empty-layers";
      empty.textContent = "No layers yet — add text, images or shapes.";
      el.layerList.appendChild(empty);
    } else {
      el.layerList.appendChild(frag);
    }
  }

  /* ======================================================================
     PROPERTIES PANEL
     ====================================================================== */
  function applyToSelection(fn, textOnly) {
    const objs = canvas.getActiveObjects();
    if (!objs.length) return;
    let touched = false;
    objs.forEach((o) => {
      if (textOnly && !isText(o)) return;
      fn(o);
      o.setCoords();
      touched = true;
    });
    if (!touched) return;
    canvas.requestRenderAll();
    syncLayers();
    scheduleHistory();
  }

  /* Rotate the active object — or the whole multi-selection — around its
     visual centre. Setting fabric's `angle` alone pivots around the
     origin (top-left for objects created by this editor), which makes the
     selection swing away from the cursor. */
  function rotateActiveSelection(value, absolute) {
    const active = canvas.getActiveObject();
    if (!active) return false;
    if (objectListOf(active).some((o) => o.locked)) {
      toast("Unlock this object before rotating it");
      return false;
    }
    const centre = active.getCenterPoint();
    const next = absolute ? value : (active.angle || 0) + value;
    active.set("angle", Math.round(next * 10) / 10);
    active.setPositionByOrigin(new fabric.Point(centre.x, centre.y), "center", "center");
    active.setCoords();
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
    pushHistory();
    return true;
  }

  function syncProps() {
    const o = canvas.getActiveObject();
    const objs = canvas.getActiveObjects();
    const first = objs[0];

    if (!first) return;

    const fillHex = toHexColor(first.fill);
    if (fillHex) $("fillColor").value = fillHex;

    const strokeHex = toHexColor(first.stroke);
    if (strokeHex) $("strokeColor").value = strokeHex;

    if (first.strokeWidth != null) $("strokeWidth").value = String(first.strokeWidth);
    if (first.opacity != null) $("opacityInput").value = String(Math.round(first.opacity * 100) / 100);
    if ($("angleInput")) {
      const angleObj = o && o.type === "activeSelection" ? o : first;
      const a = Math.round(((angleObj.angle || 0) % 360) * 10) / 10;
      $("angleInput").value = String(a);
    }
    if ($("lockObj")) $("lockObj").checked = !!first.locked;

    const textObj = objs.find(isText) || (isText(o) ? o : null);
    if (textObj) {
      $("fontSize").value = String(Math.round((textObj.fontSize || 18) * 10) / 10);
      const key = textObj.pdfFont && FONTS[textObj.pdfFont] ? textObj.pdfFont : guessFontKey(textObj.fontFamily);
      $("fontFamily").value = key;
      $("boldBtn").classList.toggle("active", String(textObj.fontWeight) === "bold" || Number(textObj.fontWeight) >= 600);
      $("italicBtn").classList.toggle("active", textObj.fontStyle === "italic");
      document.querySelectorAll("[data-align]").forEach((b) => {
        b.classList.toggle("active", (textObj.textAlign || "left") === b.dataset.align);
      });
    }
  }

  $("fillColor").addEventListener("input", (e) => applyToSelection((o) => o.set("fill", e.target.value)));
  $("strokeColor").addEventListener("input", (e) =>
    applyToSelection((o) => {
      o.set("stroke", e.target.value);
      if (!(Number(o.strokeWidth) > 0)) o.set("strokeWidth", 1);
    })
  );
  $("strokeWidth").addEventListener("input", (e) => {
    const v = clamp(Number(e.target.value) || 0, 0, 40);
    applyToSelection((o) => o.set("strokeWidth", v));
  });
  $("opacityInput").addEventListener("input", (e) => {
    const v = clamp(Number(e.target.value) || 0, 0, 1);
    applyToSelection((o) => o.set("opacity", v));
  });
  $("angleInput").addEventListener("change", (e) => {
    const v = Number(e.target.value) || 0;
    if (tableAngleSelection(v, null)) return;
    rotateActiveSelection(v, true);
  });
  document.querySelectorAll("[data-rotate]").forEach((b) => {
    b.addEventListener("click", () => {
      const delta = Number(b.dataset.rotate) || 0;
      if (tableAngleSelection(0, delta)) return;
      rotateActiveSelection(delta, false);
    });
  });
  $("lockObj").addEventListener("change", (e) => {
    const locked = e.target.checked;
    applyToSelection((o) => applyLock(o, locked));
    syncProps();
    syncLayers();
    pushHistory();
  });

  $("fontFamily").addEventListener("change", (e) => {
    const key = FONTS[e.target.value] ? e.target.value : "helvetica";
    applyToSelection((o) => {
      o.set("fontFamily", FONTS[key].css);
      o.pdfFont = key;
      o.customFont = FONTS[key].custom ? key : null;
    }, true);
  });
  $("fontSize").addEventListener("input", (e) => {
    const v = clamp(Number(e.target.value) || 1, 1, 400);
    applyToSelection((o) => o.set("fontSize", v), true);
  });

  $("boldBtn").addEventListener("click", () => {
    const objs = canvas.getActiveObjects().filter(isText);
    if (!objs.length) return;
    const isBold = String(objs[0].fontWeight) === "bold" || Number(objs[0].fontWeight) >= 600;
    applyToSelection((o) => o.set("fontWeight", isBold ? "normal" : "bold"), true);
    syncProps();
  });
  $("italicBtn").addEventListener("click", () => {
    const objs = canvas.getActiveObjects().filter(isText);
    if (!objs.length) return;
    const isItalic = objs[0].fontStyle === "italic";
    applyToSelection((o) => o.set("fontStyle", isItalic ? "normal" : "italic"), true);
    syncProps();
  });

  document.querySelectorAll("[data-align]").forEach((b) => {
    b.addEventListener("click", () => {
      applyToSelection((o) => o.set("textAlign", b.dataset.align), true);
      document.querySelectorAll("[data-align]").forEach((x) => x.classList.toggle("active", x === b));
    });
  });

  document.querySelectorAll(".swatches button").forEach((b) => {
    b.addEventListener("click", () => {
      const color = b.dataset.color;
      if (b.dataset.target === "stroke") {
        $("strokeColor").value = color;
        applyToSelection((o) => {
          o.set("stroke", color);
          if (!(Number(o.strokeWidth) > 0)) o.set("strokeWidth", 1);
        });
      } else {
        $("fillColor").value = color;
        applyToSelection((o) => o.set("fill", color));
      }
    });
  });

  document.querySelectorAll("[data-arrange]").forEach((b) => {
    b.addEventListener("click", () => {
      const act = b.dataset.arrange;
      const actives = canvas.getActiveObjects();
      if (act === "delete") {
        deleteSelection();
        return;
      }
      if (!actives.length) return;
      actives.forEach((o) => {
        if (act === "front") canvas.bringToFront(o);
        else if (act === "back") canvas.sendToBack(o);
        else if (act === "forward") canvas.bringForward(o);
        else if (act === "backward") canvas.sendBackwards(o);
      });
      canvas.requestRenderAll();
      syncLayers();
      pushHistory();
    });
  });

  function deleteSelection() {
    const objs = canvas.getActiveObjects();
    if (!objs.length) return;
    const remove = new Set();
    objs.forEach((o) => {
      /* Deleting one cell of an inserted table deletes the whole table. */
      if (o.insertedTable) tablePeers(o).forEach((p) => remove.add(p));
      else remove.add(o);
      const patch = findPatchFor(o);
      if (patch) remove.add(patch);
    });
    remove.forEach((o) => canvas.remove(o));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
    pushHistory();
  }

  function duplicateSelection() {
    const objs = canvas.getActiveObjects();
    if (!objs.length) return;
    const copyTableId = "it-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    let copiesTable = false;

    /* duplicate the patch together with its text, so the copy is usable;
       an inserted table is duplicated as a whole with a fresh table id */
    const list = [];
    const seen = new Set();
    objs.forEach((o) => {
      const group = o.insertedTable ? tablePeers(o) : [o];
      group.forEach((g) => {
        if (!seen.has(g)) {
          seen.add(g);
          list.push(g);
        }
        const patch = findPatchFor(g);
        if (patch && !seen.has(patch)) {
          seen.add(patch);
          list.push(patch);
        }
      });
    });

    const clones = [];
    let pending = list.length;
    list.forEach((src) => {
      src.clone((clone) => {
        clone.set({ left: (clone.left || 0) + 12, top: (clone.top || 0) + 12 });
        clones.push({ src, clone });
        if (--pending === 0) {
          const bySrc = new Map(clones.map((x) => [x.src, x.clone]));
          const remappedPatches = new Set();

          for (const { src, clone } of clones) {
            if (src.insertedTable) {
              clone.insertedTable = copyTableId;
              clone.tableId = copyTableId;
              copiesTable = true;
            }
            if (src.type !== "i-text") continue;
            const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            clone.uid = id;
            const origPatch = src.patchUid ? findPatchFor(src) : null;
            const patchClone = origPatch ? bySrc.get(origPatch) : null;
            if (patchClone) {
              clone.patchUid = "p" + id;
              patchClone.uid = "p" + id;
              remappedPatches.add(patchClone);
            } else {
              clone.patchUid = null;
            }
          }
          for (const { clone } of clones) {
            if (clone.isPatch && !remappedPatches.has(clone)) {
              clone.uid = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            }
          }

          clones.forEach((x) => canvas.add(x.clone));
          canvas.discardActiveObject();
          if (copiesTable) {
            const firstCopy = clones.find((x) => x.clone.insertedTable === copyTableId);
            if (firstCopy) {
              if (!selectInsertedTable(firstCopy.clone)) canvas.setActiveObject(firstCopy.clone);
            }
          } else if (clones.length === 1) {
            canvas.setActiveObject(clones[0].clone);
          }
          canvas.requestRenderAll();
          syncLayers();
          pushHistory();
        }
      });
    });
  }

  /* ======================================================================
     KEYBOARD / WHEEL / DROP
     ====================================================================== */
  window.addEventListener("keydown", (e) => {
    const active = canvas.getActiveObject();
    const editing = active && active.isEditing;

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoRedo(e.shiftKey ? 1 : -1);
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      undoRedo(1);
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      buildPdf("vector").then((bytes) => downloadPdf(bytes)).catch((err) => toast(err.message, 3500));
      return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (editing) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (e.key === "Escape") {
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      return;
    }

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      const objs = canvas.getActiveObjects();
      if (!objs.length) return;
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      objs.forEach((o) => {
        if (e.key === "ArrowUp") o.set("top", o.top - d);
        if (e.key === "ArrowDown") o.set("top", o.top + d);
        if (e.key === "ArrowLeft") o.set("left", o.left - d);
        if (e.key === "ArrowRight") o.set("left", o.left + d);
        o.setCoords();
      });
      canvas.requestRenderAll();
      scheduleHistory();
      return;
    }

    if (!mod) {
      const map = { v: "select", g: "rotate", t: "text", p: "pen", r: "rect", o: "ellipse", l: "line", h: "highlight", i: "image", b: "patch", d: "detach" };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    }
  });

  document.querySelectorAll(".tool[data-tool]").forEach((b) => {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  });
  document.querySelectorAll(".tool[data-action]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.action === "bg") openBackgroundTool();
      else if (b.dataset.action === "signature") openSignatureTool();
      else if (b.dataset.action === "table") openTableTool();
    });
  });

  /* drag & drop */
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    el.dropVeil.classList.add("show");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropVeil.classList.remove("show");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropVeil.classList.remove("show");

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const file = files[0];

    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      await openFile(file);
      return;
    }
    if (/^image\//.test(file.type)) {
      if (!S.ready) return toast("Open a PDF first");
      const rect = el.pageWrap.getBoundingClientRect();
      const p = { x: (e.clientX - rect.left) / S.zoom, y: (e.clientY - rect.top) / S.zoom };
      addImage(file, clamp(p.x, 0, S.pages[S.index].width), clamp(p.y, 0, S.pages[S.index].height));
    }
  });

  window.addEventListener("paste", (e) => {
    if (!S.ready) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const file = it.getAsFile();
        if (file) {
          const p = S.pages[S.index];
          addImage(file, p.width / 2, p.height / 3);
          e.preventDefault();
        }
        break;
      }
    }
  });

  window.addEventListener("resize", () => canvas.calcOffset());

  /* ======================================================================
     PAGE MANAGEMENT  (thumbnails, rotate, delete, add, reorder)
     ====================================================================== */

  /* Reusable page-size form.  Returns dimensions in PDF points. */
  function setupSizeControls(root, defaults) {
    if (!root) return { getSize: () => ({ width: 595.28, height: 841.89 }) };
    const preset = root.querySelector('[data-size="preset"]');
    const unit = root.querySelector('[data-size="unit"]');
    const wInp = root.querySelector('[data-size="w"]');
    const hInp = root.querySelector('[data-size="h"]');
    const orient = root.querySelector('[data-size="orient"]');
    const lock = root.querySelector('[data-size="lock"]');
    const info = root.querySelector('[data-size="info"]');

    let ptW = (defaults && defaults.width) || PAGE_PRESETS.a4.w;
    let ptH = (defaults && defaults.height) || PAGE_PRESETS.a4.h;
    let suppress = false;

    const currentUnit = () => UNIT_PT[unit.value] || UNIT_PT.mm;
    const round = (v) => Math.round(v * 100) / 100;

    function render() {
      suppress = true;
      const u = currentUnit();
      wInp.value = String(round(ptW / u));
      hInp.value = String(round(ptH / u));
      if (preset.value !== "custom") {
        orient.value = ptW > ptH ? "landscape" : "portrait";
      }
      if (info) {
        info.textContent =
          round(ptW) + " × " + round(ptH) + " pt  (" +
          round(ptW / UNIT_PT.mm) + " × " + round(ptH / UNIT_PT.mm) + " mm)";
      }
      suppress = false;
    }

    function applyPreset() {
      if (preset.value === "custom") {
        render();
        return;
      }
      const p = PAGE_PRESETS[preset.value] || PAGE_PRESETS.a4;
      let w = p.w;
      let h = p.h;
      if (orient.value === "landscape" && w < h) [w, h] = [h, w];
      if (orient.value === "portrait" && w > h) [w, h] = [h, w];
      ptW = w;
      ptH = h;
      render();
    }

    preset.addEventListener("change", () => {
      if (preset.value !== "custom") {
        /* show the preset in its natural unit */
        const p = PAGE_PRESETS[preset.value];
        if (p && p.unit) {
          unit.value = p.unit;
        }
      }
      applyPreset();
    });
    unit.addEventListener("change", render);
    orient.addEventListener("change", () => {
      if (preset.value !== "custom") applyPreset();
      else {
        if (orient.value === "landscape" && ptW < ptH) [ptW, ptH] = [ptH, ptW];
        if (orient.value === "portrait" && ptW > ptH) [ptW, ptH] = [ptH, ptW];
        render();
      }
    });
    const onDim = () => {
      if (suppress) return;
      const u = currentUnit();
      let w = Math.max(1, Number(wInp.value) || 1) * u;
      let h = Math.max(1, Number(hInp.value) || 1) * u;
      if (lock && lock.checked) {
        const ratio = ptW / ptH || 1;
        if (document.activeElement === wInp) h = w / ratio;
        else if (document.activeElement === hInp) w = h * ratio;
        else h = w / ratio;
      }
      ptW = w;
      ptH = h;
      preset.value = "custom";
      render();
    };
    wInp.addEventListener("input", onDim);
    hInp.addEventListener("input", onDim);

    if (defaults && defaults.preset) preset.value = defaults.preset;
    render();
    return {
      getSize: () => ({ width: ptW, height: ptH }),
      setSize: (w, h) => {
        ptW = w;
        ptH = h;
        preset.value = "custom";
        render();
      },
    };
  }

  const sizeControls = {
    pages: setupSizeControls(document.querySelector('[data-size-root="pages"]')),
    table: setupSizeControls(document.querySelector('[data-size-root="table"]')),
  };

  async function pageThumb(p, max) {
    if (p.thumb) return p.thumb;
    const limit = max || 150;
    const scale = Math.max(0.08, Math.min(2, limit / Math.max(1, p.width, p.height)));
    const c = await renderPageBase(p, scale);
    p.thumb = makeThumb(c, limit);
    return p.thumb;
  }

  function selectedPageIndices() {
    const list = Array.from(S.pageSel).filter((i) => i >= 0 && i < S.pages.length);
    if (list.length) return Array.from(new Set(list)).sort((a, b) => a - b);
    return S.pages.length ? [S.index] : [];
  }

  function syncPageSelUI() {
    const grid = $("pageGrid");
    if (grid) {
      grid.querySelectorAll(".page-thumb").forEach((node) => {
        const i = Number(node.dataset.index);
        node.classList.toggle("sel", S.pageSel.has(i));
        node.classList.toggle("current", i === S.index);
      });
    }
    const n = S.pageSel.size;
    const info = $("pagesSelInfo");
    if (info) {
      info.textContent = n
        ? n + " page" + (n === 1 ? "" : "s") + " selected"
        : "Click a page to select it";
    }
    const splitHint = $("splitSelHint");
    if (splitHint) {
      splitHint.textContent = n ? "(" + n + " selected)" : "(select pages in the Pages panel)";
    }
  }

  async function renderPagesGrid() {
    const grid = $("pageGrid");
    if (!grid) return;
    grid.innerHTML = "";
    $("pagesInfo").textContent = S.pages.length + " page" + (S.pages.length === 1 ? "" : "s");

    S.pages.forEach((p, i) => {
      const node = document.createElement("div");
      node.className = "page-thumb";
      node.dataset.index = String(i);
      node.draggable = true;
      node.title = "Page " + (i + 1) + " — drag to reorder";

      const img = document.createElement("img");
      img.alt = "Page " + (i + 1);
      img.src =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#111827"/><text x="60" y="84" fill="#64748b" font-family="sans-serif" font-size="12" text-anchor="middle">rendering…</text></svg>'
        );
      node.appendChild(img);

      const num = document.createElement("span");
      num.className = "p-num";
      num.textContent = "Page " + (i + 1);
      node.appendChild(num);

      if (p.extraRotation) {
        const r = document.createElement("span");
        r.className = "p-rot";
        r.textContent = p.extraRotation + "°";
        node.appendChild(r);
      }

      node.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (S.pageSel.has(i)) S.pageSel.delete(i);
          else S.pageSel.add(i);
        } else if (e.shiftKey && S.pageSel.size) {
          const anchor = Array.from(S.pageSel)[S.pageSel.size - 1];
          const a = Math.min(anchor, i);
          const b = Math.max(anchor, i);
          for (let k = a; k <= b; k++) S.pageSel.add(k);
        } else {
          S.pageSel.clear();
          S.pageSel.add(i);
        }
        syncPageSelUI();
      });

      node.addEventListener("dblclick", async () => {
        closeModal("pagesModal");
        await setPage(i);
      });

      node.addEventListener("dragstart", (e) => {
        S.pageDrag = i;
        node.classList.add("dragging");
        try {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(i));
        } catch (err) {
          /* ignore */
        }
      });
      node.addEventListener("dragend", () => {
        S.pageDrag = null;
        node.classList.remove("dragging");
        grid.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
      });
      node.addEventListener("dragover", (e) => {
        e.preventDefault();
        node.classList.add("drop-target");
      });
      node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
      node.addEventListener("drop", async (e) => {
        e.preventDefault();
        node.classList.remove("drop-target");
        const from = S.pageDrag;
        if (from == null || from === i) return;
        await movePage(from, i);
      });

      grid.appendChild(node);
    });

    syncPageSelUI();

    for (let i = 0; i < S.pages.length; i++) {
      const p = S.pages[i];
      pageThumb(p)
        .then((url) => {
          const im = grid.querySelector('.page-thumb[data-index="' + i + '"] img');
          if (im) im.src = url;
        })
        .catch(() => {});
    }
  }

  function openModal(id) {
    const m = $(id);
    if (!m) return;
    /* only one modal at a time — stacked blurred backdrops are slow and
       confusing, and a tool should never open underneath another dialog */
    document.querySelectorAll(".modal.open").forEach((other) => {
      if (other !== m) {
        other.classList.remove("open");
        other.setAttribute("aria-hidden", "true");
      }
    });
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }

  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
  }

  async function openPagesModal() {
    if (!S.ready) return toast("Open a PDF first");
    savePage();
    S.pageSel.clear();
    S.pageSel.add(S.index);
    openModal("pagesModal");
    await renderPagesGrid();
  }

  async function movePage(from, to) {
    if (from === to || from < 0 || to < 0 || from >= S.pages.length || to >= S.pages.length) return;
    savePage();
    const current = S.pages[S.index];
    const selected = new Set();
    S.pageSel.forEach((i) => {
      if (i !== from) selected.add(i);
    });
    const [page] = S.pages.splice(from, 1);
    S.pages.splice(to, 0, page);
    S.index = S.pages.indexOf(current);
    if (S.index < 0) S.index = Math.min(to, S.pages.length - 1);
    S.pageSel.clear();
    selected.forEach((i) => {
      let n = i;
      if (from < i) n--;
      if (to <= n) n++;
      if (n >= 0 && n < S.pages.length) S.pageSel.add(n);
    });
    await setPage(S.index);
    await renderPagesGrid();
  }

  async function rotateSelectedPages(delta, silent) {
    savePage();
    const idxs = selectedPageIndices();
    if (!idxs.length) return toast("Select at least one page");
    for (const i of idxs) {
      const p = S.pages[i];
      if (p) await applyPageRotation(p, delta);
    }
    await setPage(S.index, { fit: false });
    await renderPagesGrid();
    if (!silent)
      toast(
        "Rotated " + idxs.length + " page" + (idxs.length === 1 ? "" : "s") + " by " + delta + "°"
      );
  }

  async function deleteSelectedPages() {
    const idxs = selectedPageIndices();
    if (!idxs.length) return;
    if (idxs.length >= S.pages.length) {
      return toast("Keep at least one page — add a blank page first", 3000);
    }
    if (!window.confirm("Delete " + idxs.length + " selected page" + (idxs.length === 1 ? "" : "s") + "?")) {
      return;
    }
    savePage();
    const current = S.pages[S.index];
    const remove = new Set(idxs);
    const first = idxs[0];
    S.pages = S.pages.filter((_, i) => !remove.has(i));
    let next = S.pages.indexOf(current);
    if (next < 0) next = clamp(first, 0, S.pages.length - 1);
    S.pageSel.clear();
    S.pageSel.add(next);
    S.index = next;
    await setPage(next);
    await renderPagesGrid();
    toast("Deleted " + idxs.length + " page" + (idxs.length === 1 ? "" : "s"));
  }

  async function addBlankPage(where) {
    if (!S.ready) return toast("Open a PDF first");
    savePage();
    const size = sizeControls.pages.getSize();
    const anchor = selectedPageIndices()[0] != null ? selectedPageIndices()[0] : S.index;
    const at = clamp(where === "before" ? anchor : anchor + 1, 0, S.pages.length);
    const p = emptyPageData({
      kind: "blank",
      baseWidth: size.width,
      baseHeight: size.height,
      width: size.width,
      height: size.height,
      imgOps: [],
    });
    S.pages.splice(at, 0, p);
    S.pageSel.clear();
    S.pageSel.add(at);
    S.index = at;
    await setPage(at);
    await renderPagesGrid();
    toast("Blank page added (" + Math.round(size.width) + " × " + Math.round(size.height) + " pt)");
  }

  async function insertPdfPages(files, anchorIndex) {
    if (!files || !files.length) return;
    showProgress("Inserting pages…");
    try {
      savePage();
      const at0 = clamp((anchorIndex == null ? S.index : anchorIndex) + 1, 0, S.pages.length);
      let at = at0;
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const rec = await openPdfDocument(bytes, file.name);
        const docId = "doc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        S.docs.set(docId, rec);
        for (let i = 0; i < rec.doc.numPages; i++) {
          S.pages.splice(at++, 0, await makePdfPage(docId, i));
        }
        progress(file.name + " — " + rec.doc.numPages + " pages");
      }
      S.pageSel.clear();
      S.pageSel.add(at0);
      S.index = at0;
      await setPage(at0, { fit: true });
      await renderPagesGrid();
      toast("Inserted pages from " + files.length + " PDF" + (files.length === 1 ? "" : "s"));
    } catch (err) {
      console.error(err);
      toast("Could not insert the PDF: " + err.message, 4000);
    } finally {
      hideProgress();
    }
  }

  async function insertImagePages(files, anchorIndex) {
    if (!files || !files.length) return;
    showProgress("Inserting images…");
    try {
      savePage();
      const size = sizeControls.pages.getSize();
      let at = clamp((anchorIndex == null ? S.index : anchorIndex) + 1, 0, S.pages.length);
      const start = at;
      for (const file of files) {
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(file);
        });
        const img = await loadImageElement(dataUrl);
        /* keep the chosen page size; portrait/landscape follows the image when
           the user left the default orientation */
        let w = size.width;
        let h = size.height;
        if (Math.abs(w / h - img.width / img.height) > 0.02) {
          const looksDefault = Math.abs(w - PAGE_PRESETS.a4.w) < 2 && Math.abs(h - PAGE_PRESETS.a4.h) < 2;
          if (looksDefault) {
            h = w * (img.height / img.width);
          }
        }
        const p = emptyPageData({
          kind: "image",
          image: dataUrl,
          baseWidth: w,
          baseHeight: h,
          width: w,
          height: h,
          imgOps: [],
        });
        S.pages.splice(at++, 0, p);
      }
      S.pageSel.clear();
      S.pageSel.add(start);
      S.index = start;
      await setPage(start, { fit: true });
      await renderPagesGrid();
      toast("Inserted " + files.length + " image page" + (files.length === 1 ? "" : "s"));
    } catch (err) {
      console.error(err);
      toast("Could not insert the image: " + err.message, 4000);
    } finally {
      hideProgress();
    }
  }

  /* ======================================================================
     MERGE & SPLIT
     Merge is a page-level organiser: every page from every added PDF is
     shown as a large thumbnail and can be reordered, rotated or removed
     before the files are combined.  Thumbnails are rendered lazily while
     the list scrolls so very large documents stay usable.
     ====================================================================== */
  const MERGE = {
    files: [], /* { id, name, bytes, pageCount, docPromise } */
    pages: [], /* { id, fileId, pageIndex, rotation, thumb, thumbRotation, el, imgEl } */
    cardMap: new Map(),
    drag: null,
    observer: null,
    seq: 0,
  };

  function mergeId(prefix) {
    MERGE.seq += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + MERGE.seq;
  }

  function mergeAngle(value) {
    return ((Math.round(value) % 360) + 360) % 360;
  }

  function mergeFileById(id) {
    return MERGE.files.find((f) => f.id === id) || null;
  }

  function mergePageIndex(id) {
    return MERGE.pages.findIndex((p) => p.id === id);
  }

  function updateMergeInfo() {
    const info = $("mergeInfo");
    const pageCount = MERGE.pages.length;
    const fileCount = MERGE.files.filter((f) => MERGE.pages.some((p) => p.fileId === f.id)).length;
    if (info) {
      info.textContent = pageCount
        ? pageCount + " page" + (pageCount === 1 ? "" : "s") + " from " + fileCount + " PDF" + (fileCount === 1 ? "" : "s")
        : "No pages added yet";
    }
    ["mergeDownload", "mergeOpen"].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = !pageCount;
    });
  }

  function renderMergeFileChips() {
    const wrap = $("mergeFiles");
    if (!wrap) return;
    wrap.innerHTML = "";
    MERGE.files.forEach((file) => {
      const remaining = MERGE.pages.filter((p) => p.fileId === file.id).length;
      if (!remaining) return;
      const chip = document.createElement("span");
      chip.className = "m-file-chip";
      const name = document.createElement("span");
      name.className = "m-file-name";
      name.textContent = file.name;
      name.title = file.name;
      const count = document.createElement("span");
      count.className = "m-file-count";
      count.textContent = remaining + " page" + (remaining === 1 ? "" : "s");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "m-file-del";
      del.title = "Remove all pages from " + file.name;
      setIcon(del, "trash");
      del.addEventListener("click", () => removeMergeFile(file.id));
      chip.append(name, count, del);
      wrap.appendChild(chip);
    });
  }

  function destroyMergeFile(file) {
    if (!file) return;
    const docPromise = file.docPromise;
    file.docPromise = null;
    if (docPromise) {
      docPromise
        .then((doc) => {
          try {
            doc.destroy();
          } catch (e) {}
        })
        .catch(() => {});
    }
  }

  function removeMergeFile(fileId) {
    if (!MERGE.files.some((f) => f.id === fileId)) return;
    MERGE.pages = MERGE.pages.filter((p) => p.fileId !== fileId);
    MERGE.files = MERGE.files.filter((f) => {
      if (f.id !== fileId) return true;
      destroyMergeFile(f);
      return false;
    });
    renderMergeList();
  }

  function mergeDocFor(file) {
    if (!file.docPromise) {
      /* hand pdf.js its own copy: it may transfer the underlying buffer */
      const data = file.bytes.slice(0);
      file.docPromise = pdfjsLib.getDocument({ data }).promise.catch((err) => {
        file.docPromise = null;
        throw err;
      });
    }
    return file.docPromise;
  }

  async function renderMergeThumb(entry) {
    const file = mergeFileById(entry.fileId);
    if (!file) throw new Error("The source PDF was removed");
    const doc = await mergeDocFor(file);
    const page = await doc.getPage(entry.pageIndex + 1);
    const rotation = mergeAngle((page.rotate || 0) + entry.rotation);
    const base = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(440 / Math.max(1, base.width), 560 / Math.max(1, base.height));
    const viewport = page.getViewport({ scale, rotation });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(viewport.width));
    c.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
    return c.toDataURL("image/jpeg", 0.86);
  }

  function applyMergeThumb(entry) {
    if (!entry.el) return;
    const img = entry.imgEl;
    const ready = !!(entry.thumb && entry.thumbRotation === entry.rotation);
    entry.el.classList.toggle("has-thumb", ready);
    entry.el.classList.remove("no-thumb");
    if (img) {
      if (ready) {
        img.src = entry.thumb;
        img.alt = "Page " + (entry.pageIndex + 1) + " of " + (mergeFileById(entry.fileId) || {}).name;
      } else {
        img.removeAttribute("src");
        const note = entry.el.querySelector(".m-loading");
        if (note) note.textContent = "Rendering…";
      }
    }
  }

  function ensureMergeThumb(entry) {
    if (!entry || !entry.el) return null;
    const rotation = entry.rotation;
    if (entry.thumb && entry.thumbRotation === rotation) {
      applyMergeThumb(entry);
      return null;
    }
    if (entry.thumbPromise && entry.thumbPromiseRotation === rotation) return entry.thumbPromise;
    entry.thumbPromiseRotation = rotation;
    entry.thumbPromise = renderMergeThumb(entry)
      .then((url) => {
        if (entry.rotation !== rotation) return null;
        entry.thumb = url;
        entry.thumbRotation = rotation;
        applyMergeThumb(entry);
        return url;
      })
      .catch((err) => {
        if (entry.rotation !== rotation || !entry.el) return null;
        entry.el.classList.add("no-thumb");
        const note = entry.el.querySelector(".m-loading");
        if (note) note.textContent = "Preview unavailable";
        return null;
      })
      .finally(() => {
        if (entry.thumbPromiseRotation === rotation) entry.thumbPromise = null;
      });
    return entry.thumbPromise;
  }

  function observeMergeCards() {
    if (MERGE.observer) {
      MERGE.observer.disconnect();
      MERGE.observer = null;
    }
    const wrap = $("mergeList");
    if (!wrap) return;
    if (typeof IntersectionObserver !== "function") {
      MERGE.pages.slice(0, 24).forEach(ensureMergeThumb);
      return;
    }
    MERGE.observer = new IntersectionObserver(
      (records) => {
        records.forEach((rec) => {
          if (!rec.isIntersecting) return;
          const entry = MERGE.cardMap.get(rec.target.dataset.id);
          if (entry) ensureMergeThumb(entry);
        });
      },
      { root: wrap, rootMargin: "700px 0px", threshold: 0.01 }
    );
    MERGE.pages.forEach((entry) => {
      if (entry.el) MERGE.observer.observe(entry.el);
    });
  }

  function updateMergeCard(entry, index) {
    if (!entry.el) return;
    const order = entry.el.querySelector(".m-page-order");
    if (order) order.textContent = "#" + (index + 1);
    entry.el.title = "Position " + (index + 1) + " in the merged PDF — drag to move";
    const rot = entry.el.querySelector(".m-page-rot");
    if (rot) {
      rot.hidden = !entry.rotation;
      rot.textContent = entry.rotation + "°";
    }
  }

  function buildMergeCard(entry, index) {
    const file = mergeFileById(entry.fileId) || { name: "PDF" };
    const card = document.createElement("div");
    card.className = "m-page";
    card.draggable = true;
    card.dataset.id = entry.id;

    const thumb = document.createElement("div");
    thumb.className = "m-page-thumb";
    const loading = document.createElement("span");
    loading.className = "m-loading";
    loading.textContent = "Rendering…";
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    thumb.append(loading, img);

    const order = document.createElement("span");
    order.className = "m-page-order";
    const rot = document.createElement("span");
    rot.className = "m-page-rot";
    rot.hidden = true;
    thumb.append(order, rot);

    const meta = document.createElement("div");
    meta.className = "m-page-meta";
    const grip = document.createElement("span");
    grip.className = "m-grip";
    grip.title = "Drag to reorder";
    setIcon(grip, "grip");
    const src = document.createElement("span");
    src.className = "m-page-src";
    const srcName = document.createElement("b");
    srcName.textContent = file.name;
    src.append(srcName, document.createTextNode(" · p." + (entry.pageIndex + 1)));
    src.title = file.name + " — page " + (entry.pageIndex + 1);
    meta.append(grip, src);

    const actions = document.createElement("div");
    actions.className = "m-page-actions";
    const action = (icon, title, cls, handler) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m-act" + (cls ? " " + cls : "");
      b.title = title;
      b.setAttribute("aria-label", title);
      setIcon(b, icon);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        handler();
      });
      return b;
    };
    actions.append(
      action("chevron-left", "Move this page earlier", "", () => moveMergePage(entry.id, -1)),
      action("restore", "Rotate this page 90° anticlockwise", "", () => rotateMergePage(entry, -90)),
      action("rotate-cw", "Rotate this page 90° clockwise", "", () => rotateMergePage(entry, 90)),
      action("chevron-right", "Move this page later", "", () => moveMergePage(entry.id, 1)),
      action("trash", "Remove this page from the merge", "m-del", () => removeMergePage(entry.id))
    );

    card.append(thumb, meta, actions);
    entry.el = card;
    entry.imgEl = img;

    card.addEventListener("dragstart", (e) => {
      MERGE.drag = entry.id;
      card.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", entry.id);
      } catch (err) {}
    });
    card.addEventListener("dragend", () => {
      MERGE.drag = null;
      card.classList.remove("dragging");
      document.querySelectorAll("#mergeList .drop-before, #mergeList .drop-after").forEach((x) => {
        x.classList.remove("drop-before", "drop-after");
      });
    });
    const clearDropMarks = () => {
      document.querySelectorAll("#mergeList .drop-before, #mergeList .drop-after").forEach((x) => {
        x.classList.remove("drop-before", "drop-after");
      });
    };
    card.addEventListener("dragover", (e) => {
      if (!MERGE.drag) return;
      e.preventDefault();
      clearDropMarks();
      const r = card.getBoundingClientRect();
      card.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    });
    card.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && card.contains(e.relatedTarget)) return;
      card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drop-before", "drop-after");
      const from = MERGE.drag;
      if (!from || from === entry.id) return;
      const r = card.getBoundingClientRect();
      moveMergePageTo(from, entry.id, e.clientX < r.left + r.width / 2);
    });

    updateMergeCard(entry, index);
    applyMergeThumb(entry);
    return card;
  }

  function renderMergeList() {
    const wrap = $("mergeList");
    if (!wrap) return;
    const scrollTop = wrap.scrollTop;
    if (MERGE.observer) {
      MERGE.observer.disconnect();
      MERGE.observer = null;
    }
    wrap.innerHTML = "";
    MERGE.cardMap.clear();
    MERGE.pages.forEach((entry) => {
      entry.el = null;
      entry.imgEl = null;
    });
    renderMergeFileChips();
    updateMergeInfo();

    if (!MERGE.pages.length) {
      const empty = document.createElement("div");
      empty.className = "merge-empty";
      const icon = document.createElement("span");
      icon.className = "merge-empty-icon";
      setIcon(icon, "doc");
      const title = document.createElement("strong");
      title.textContent = "Add PDFs to start";
      const hint = document.createElement("span");
      hint.textContent = "All pages from all files will appear here. Drag a page to reorder it, rotate it, or remove it before merging.";
      empty.append(icon, title, hint);
      wrap.appendChild(empty);
      return;
    }

    MERGE.pages.forEach((entry, i) => {
      const card = buildMergeCard(entry, i);
      wrap.appendChild(card);
      MERGE.cardMap.set(entry.id, entry);
    });
    observeMergeCards();
    wrap.scrollTop = scrollTop;
  }

  function moveMergePage(id, delta) {
    const from = mergePageIndex(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= MERGE.pages.length) return;
    const [entry] = MERGE.pages.splice(from, 1);
    MERGE.pages.splice(to, 0, entry);
    const wrap = $("mergeList");
    if (wrap) {
      MERGE.pages.forEach((p) => {
        if (p.el) wrap.appendChild(p.el);
      });
      MERGE.pages.forEach((p, i) => updateMergeCard(p, i));
    }
  }

  function moveMergePageTo(dragId, targetId, before) {
    const from = mergePageIndex(dragId);
    const target = mergePageIndex(targetId);
    if (from < 0 || target < 0 || from === target) return;
    let insert = target + (before ? 0 : 1);
    if (from < insert) insert -= 1;
    if (insert === from) return;
    const [entry] = MERGE.pages.splice(from, 1);
    MERGE.pages.splice(insert, 0, entry);
    const wrap = $("mergeList");
    if (wrap) {
      MERGE.pages.forEach((p) => {
        if (p.el) wrap.appendChild(p.el);
      });
      MERGE.pages.forEach((p, i) => updateMergeCard(p, i));
    }
  }

  function rotateMergePage(entry, delta) {
    entry.rotation = mergeAngle(entry.rotation + delta);
    entry.thumb = null;
    entry.thumbRotation = null;
    applyMergeThumb(entry);
    const index = mergePageIndex(entry.id);
    updateMergeCard(entry, index);
    ensureMergeThumb(entry);
  }

  function removeMergePage(id) {
    const index = mergePageIndex(id);
    if (index < 0) return;
    const [entry] = MERGE.pages.splice(index, 1);
    if (entry && entry.el) entry.el.remove();
    if (entry) {
      entry.el = null;
      entry.imgEl = null;
    }
    MERGE.cardMap.delete(id);
    const fileStillUsed = MERGE.pages.some((p) => p.fileId === entry.fileId);
    if (!fileStillUsed) {
      const file = mergeFileById(entry.fileId);
      if (file) {
        destroyMergeFile(file);
        MERGE.files = MERGE.files.filter((f) => f.id !== file.id);
      }
    }
    renderMergeFileChips();
    updateMergeInfo();
    MERGE.pages.forEach((p, i) => updateMergeCard(p, i));
    if (!MERGE.pages.length) renderMergeList();
  }

  async function addMergeFiles(files) {
    if (!files || !files.length) return;
    showProgress("Reading PDFs…");
    try {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let doc = null;
        try {
          doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        } catch (e) {
          toast(file.name + " could not be read: " + e.message, 3200);
          continue;
        }
        const pageCount = doc.getPageCount();
        if (!pageCount) {
          toast(file.name + " has no pages", 2400);
          continue;
        }
        const fileId = mergeId("mf");
        MERGE.files.push({ id: fileId, name: file.name, bytes, pageCount, docPromise: null });
        for (let i = 0; i < pageCount; i++) {
          MERGE.pages.push({
            id: mergeId("mp"),
            fileId,
            pageIndex: i,
            rotation: 0,
            thumb: null,
            thumbRotation: null,
            thumbPromise: null,
            el: null,
            imgEl: null,
          });
        }
        progress(file.name + " — " + pageCount + " pages");
      }
      renderMergeList();
    } finally {
      hideProgress();
    }
  }

  function clearMergeList() {
    MERGE.files.forEach(destroyMergeFile);
    MERGE.files = [];
    MERGE.pages = [];
    renderMergeList();
  }

  async function mergePdfs() {
    if (!MERGE.pages.length) throw new Error("Add at least one PDF page first");
    showProgress("Merging…");
    try {
      const out = await PDFDocument.create();
      const sources = new Map();
      for (const entry of MERGE.pages) {
        const file = mergeFileById(entry.fileId);
        if (!file) continue;
        let src = sources.get(file.id);
        if (!src) {
          src = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
          sources.set(file.id, src);
        }
        const copied = await out.copyPages(src, [entry.pageIndex]);
        const page = copied[0];
        if (entry.rotation) {
          const base = page.getRotation();
          page.setRotation(degrees(mergeAngle((base && base.angle ? base.angle : 0) + entry.rotation)));
        }
        out.addPage(page);
      }
      out.setProducer("PDF Studio");
      out.setCreator("PDF Studio (browser)");
      const bytes = await out.save();
      return bytes;
    } finally {
      hideProgress();
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function parsePageRanges(text, max) {
    const out = [];
    String(text || "")
      .split(/[,\s]+/)
      .filter(Boolean)
      .forEach((token) => {
        const m = token.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
          let a = clamp(Number(m[1]), 1, max);
          let b = clamp(Number(m[2]), 1, max);
          if (a > b) [a, b] = [b, a];
          for (let i = a; i <= b; i++) out.push(i - 1);
        } else if (/^\d+$/.test(token)) {
          const i = clamp(Number(token), 1, max);
          out.push(i - 1);
        }
      });
    return Array.from(new Set(out));
  }

  async function splitAndDownload() {
    if (!S.ready) return toast("Open a PDF first");
    savePage();
    const modeEl = document.querySelector('input[name="splitMode"]:checked');
    const mode = modeEl ? modeEl.value : "range";
    const n = S.pages.length;
    let groups = [];
    const base = (S.name || "document").replace(/\.pdf$/i, "");

    if (mode === "range") {
      const idx = parsePageRanges($("splitRange").value, n);
      if (!idx.length) return toast("Enter a page range like 1-5, 8-10");
      groups = [idx];
    } else if (mode === "every") {
      const step = clamp(Number($("splitEvery").value) || 1, 1, n);
      for (let i = 0; i < n; i += step) {
        groups.push(Array.from({ length: Math.min(step, n - i) }, (_, k) => i + k));
      }
    } else if (mode === "single") {
      groups = Array.from({ length: n }, (_, i) => [i]);
    } else {
      const idx = selectedPageIndices();
      if (!idx.length) return toast("Select pages in the Pages panel first");
      groups = [idx];
    }

    try {
      if (groups.length === 1) {
        const bytes = await buildPdf("vector", groups[0]);
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), base + "-pages.pdf");
        toast("Split PDF downloaded");
        return;
      }
      const files = [];
      for (let i = 0; i < groups.length; i++) {
        progress("Building part " + (i + 1) + " / " + groups.length + "…");
        const bytes = await buildPdf("vector", groups[i]);
        files.push({
          name: base + "-part-" + String(i + 1).padStart(2, "0") + ".pdf",
          bytes,
        });
      }
      if (window.JSZip) {
        const zip = new window.JSZip();
        files.forEach((f) => zip.file(f.name, f.bytes));
        const blob = await zip.generateAsync({ type: "blob" });
        downloadBlob(blob, base + "-split.zip");
        toast("Created " + files.length + " PDFs in one ZIP");
      } else {
        for (const f of files) {
          downloadBlob(new Blob([f.bytes], { type: "application/pdf" }), f.name);
          await new Promise((r) => setTimeout(r, 250));
        }
        toast("Downloaded " + files.length + " PDFs");
      }
    } catch (err) {
      console.error(err);
      toast("Split failed: " + err.message, 4000);
    }
  }


  /* ======================================================================
     BACKGROUND REMOVAL  (magic wand / lasso / polygon / smart select)
     ====================================================================== */
  const BG = {
    target: null,
    work: null,
    mask: null,
    w: 0,
    h: 0,
    tool: "wand",
    history: [],
    points: [],
    dragging: false,
    poly: null,
    path: null,
    pathClosed: false,
    scale: 1,
    zoom: 1,
    minZoom: 0.25,
    maxZoom: 4,
  };

  function bgClearPath() {
    BG.path = null;
    BG.pathClosed = false;
  }

  function bgMaxDimension() {
    return 1600;
  }

  function applyBgZoom(z) {
    const inner = $("bgCanvasInner");
    const lbl = $("bgZoomLabel");
    if (!inner) return;
    const nz = Math.max(BG.minZoom || 0.25, Math.min(BG.maxZoom || 4, typeof z === "number" ? z : BG.zoom || 1));
    BG.zoom = nz;
    inner.style.transform = "scale(" + nz + ")";
    if (lbl) lbl.textContent = Math.round(nz * 100) + "%";
  }

  async function openBackgroundTool() {
    if (!S.ready) return toast("Open a PDF first");
    const active = canvas.getActiveObject();
    let src = null;
    let target = null;

    if (active && active.type === "image" && !(active instanceof fabric.ActiveSelection)) {
      const elImg = active._element || active._originalElement;
      if (elImg && elImg.width && elImg.height) {
        const c = document.createElement("canvas");
        c.width = elImg.width;
        c.height = elImg.height;
        c.getContext("2d").drawImage(elImg, 0, 0);
        src = c;
        target = { type: "image", obj: active };
      }
    }

    if (!src) {
      const p = S.pages[S.index];
      const base = await renderPageBase(p, 2);
      src = base;
      target = { type: "page", page: p };
    }

    const cap = bgMaxDimension();
    const factor = Math.min(1, cap / Math.max(src.width, src.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * factor));
    c.height = Math.max(1, Math.round(src.height * factor));
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);

    BG.target = target;
    BG.work = c;
    BG.w = c.width;
    BG.h = c.height;
    BG.mask = new Uint8Array(c.width * c.height);
    BG.history = [];
    BG.points = [];
    BG.poly = null;
    BG.dragging = false;
    BG.tool = "wand";

    bgClearPath();
    const edit = $("bgEditCanvas");
    edit.width = BG.w;
    edit.height = BG.h;
    $("bgMaskCanvas").width = BG.w;
    $("bgMaskCanvas").height = BG.h;
    edit.getContext("2d").drawImage(c, 0, 0);
    $("bgTargetInfo").textContent =
      target.type === "image" ? "Selected image layer" : "Page " + (S.index + 1);
    $("bgReplaceImage").disabled = target.type !== "image";
    $("bgApplyPage").disabled = target.type !== "page";
    setBgTool("wand");
    bgRefresh();
    BG.zoom = 1;
    applyBgZoom(1);
    const wrap = $("bgCanvasWrap");
    if (wrap) wrap.scrollTop = 0;
    if (wrap) wrap.scrollLeft = 0;
    $("bgStatus").textContent =
      "Click the colour you want to remove, then press “Make selected transparent”.";
    openModal("bgModal");
  }

  function setBgTool(tool) {
    BG.tool = tool;
    BG.poly = tool === "polygon" ? [] : null;
    BG.points = [];
    bgClearPath();
    bgRefresh();
    const bar = $("bgTools");
    if (bar) {
      bar.querySelectorAll("[data-bgtool]").forEach((b) => {
        b.classList.toggle("active", b.dataset.bgtool === tool);
      });
    }
    if (tool === "lasso") $("bgStatus").textContent = "Draw a freehand loop around the area to remove.";
    else if (tool === "polygon") $("bgStatus").textContent = "Click points around the area; double-click (or click the first point) to close.";
    else if (tool === "smart") $("bgStatus").textContent = "Click the background — edges are detected automatically.";
    else $("bgStatus").textContent = "Click the colour you want to remove, then press “Make selected transparent”.";
  }

  function bgRefresh() {
    const work = BG.work;
    const edit = $("bgEditCanvas");
    if (!work || !edit) return;
    const ctx = edit.getContext("2d");
    ctx.clearRect(0, 0, BG.w, BG.h);
    ctx.drawImage(work, 0, 0);

    const mc = $("bgMaskCanvas");
    const mctx = mc.getContext("2d");
    mctx.clearRect(0, 0, BG.w, BG.h);
    const img = mctx.createImageData(BG.w, BG.h);
    const d = img.data;
    for (let i = 0; i < BG.mask.length; i++) {
      if (BG.mask[i]) {
        d[i * 4] = 59;
        d[i * 4 + 1] = 130;
        d[i * 4 + 2] = 246;
        d[i * 4 + 3] = 110;
      }
    }
    mctx.putImageData(img, 0, 0);

    /* Dotted outline for lasso / polygon selections.  It is drawn on the
       mask canvas, so it is only a preview and never affects the image. */
    if (BG.path && BG.path.length > 1) {
      const pts = BG.path;
      const lw = Math.max(1.5, BG.w / 700);
      mctx.save();
      mctx.lineJoin = "round";
      mctx.lineCap = "round";
      mctx.setLineDash([lw * 3.5, lw * 3]);
      for (const stroke of [
        ["rgba(15, 23, 42, 0.9)", lw + 2.5],
        ["rgba(255, 255, 255, 0.98)", lw],
      ]) {
        mctx.strokeStyle = stroke[0];
        mctx.lineWidth = stroke[1];
        mctx.beginPath();
        mctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i].x, pts[i].y);
        if (BG.pathClosed) mctx.closePath();
        mctx.stroke();
      }
      mctx.restore();
    }
  }

  function bgPointer(e) {
    const wrap = $("bgCanvasWrap");
    const inner = $("bgCanvasInner");
    const edit = $("bgEditCanvas");
    if (!wrap || !inner || !edit) return { x: 0, y: 0 };
    const r = inner.getBoundingClientRect();
    const z = BG.zoom || 1;
    return {
      x: clamp(((e.clientX - r.left) / z), 0, BG.w - 1),
      y: clamp(((e.clientY - r.top) / z), 0, BG.h - 1),
    };
  }

  function bgPixelAt(x, y) {
    const data = BG.work.getContext("2d").getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }

  function colorDist2(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  /* Flood fill from a seed.  smart=true also stops at strong local edges.
     The seed and the queue indices are always integers: a fractional index
     would write to a named property on the typed arrays instead of a real
     pixel, letting the queue overflow and the loop run forever. */
  function bgFlood(seedX, seedY, tolerance, smart) {
    const ctx = BG.work.getContext("2d");
    const w = BG.w;
    const h = BG.h;
    if (!w || !h) return { mask: new Uint8Array(0), count: 0, seed: [0, 0, 0] };
    const sx = Math.min(w - 1, Math.max(0, Math.round(seedX) || 0));
    const sy = Math.min(h - 1, Math.max(0, Math.round(seedY) || 0));
    const data = ctx.getImageData(0, 0, w, h).data;
    const si = (sy * w + sx) * 4;
    const seed = [data[si], data[si + 1], data[si + 2]];
    const thr = Math.pow((tolerance / 100) * 150 * Math.SQRT2, 2);
    const edgeLimit = smart ? Math.pow(Math.max(18, (tolerance / 100) * 110), 2) : Infinity;
    const seen = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    let qh = 0;
    let qt = 0;
    const start = sy * w + sx;
    seen[start] = 1;
    q[qt++] = start;
    let count = 0;

    const push = (nx, ny, fromCol) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const ni = ny * w + nx;
      if (seen[ni]) return;
      const no = ni * 4;
      if (data[no + 3] >= 8) {
        const ncol = [data[no], data[no + 1], data[no + 2]];
        if (smart && colorDist2(ncol, fromCol) > edgeLimit && colorDist2(ncol, seed) > thr * 0.35) {
          return;
        }
      }
      seen[ni] = 1;
      if (qt >= q.length) return;
      q[qt++] = ni;
    };

    while (qh < qt) {
      const idx = q[qh++];
      const px = idx % w;
      const py = (idx / w) | 0;
      const o = idx * 4;
      const col = [data[o], data[o + 1], data[o + 2]];
      if (colorDist2(col, seed) > thr) continue;
      out[idx] = 1;
      count++;

      push(px + 1, py, col);
      push(px - 1, py, col);
      push(px, py + 1, col);
      push(px, py - 1, col);
    }
    return { mask: out, count, seed };
  }
  function bgAutoSelect() {
    const ctx = BG.work.getContext("2d");
    const data = ctx.getImageData(0, 0, BG.w, BG.h).data;
    const w = BG.w;
    const h = BG.h;
    const corners = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
    ];
    const samples = [];
    for (const [cx, cy] of corners) {
      for (let dy = 0; dy < 6; dy++) {
        for (let dx = 0; dx < 6; dx++) {
          const x = clamp(cx + (cx === 0 ? dx : -dx), 0, w - 1);
          const y = clamp(cy + (cy === 0 ? dy : -dy), 0, h - 1);
          const o = (y * w + x) * 4;
          if (data[o + 3] > 8) samples.push([data[o], data[o + 1], data[o + 2]]);
        }
      }
    }
    if (!samples.length) return 0;
    const med = [0, 1, 2].map((c) => {
      const vals = samples.map((s) => s[c]).sort((a, b) => a - b);
      return vals[(vals.length / 2) | 0];
    });

    const tol = Math.max(28, Number($("bgTolerance").value) || 30);
    const thr = Math.pow((tol / 100) * 150 * Math.SQRT2, 2);
    const seen = new Uint8Array(w * h);
    const mask = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    let qh = 0;
    let qt = 0;
    const seedIf = (x, y) => {
      const i = y * w + x;
      if (seen[i]) return;
      const o = i * 4;
      if (data[o + 3] < 8) {
        seen[i] = 1;
        q[qt++] = i;
        mask[i] = 1;
        return;
      }
      if (colorDist2([data[o], data[o + 1], data[o + 2]], med) <= thr) {
        seen[i] = 1;
        q[qt++] = i;
      }
    };
    for (let x = 0; x < w; x++) {
      seedIf(x, 0);
      seedIf(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      seedIf(0, y);
      seedIf(w - 1, y);
    }

    const edgeLimit = Math.pow(Math.max(18, (tol / 100) * 110), 2);
    while (qh < qt) {
      const idx = q[qh++];
      const px = idx % w;
      const py = (idx / w) | 0;
      const o = idx * 4;
      const col = [data[o], data[o + 1], data[o + 2]];
      if (colorDist2(col, med) > thr * 1.1) continue;
      mask[idx] = 1;
      const push = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const ni = ny * w + nx;
        if (seen[ni]) return;
        const no = ni * 4;
        const ncol = [data[no], data[no + 1], data[no + 2]];
        if (colorDist2(ncol, col) > edgeLimit && colorDist2(ncol, med) > thr * 0.4) return;
        seen[ni] = 1;
        if (qt >= q.length) return;
        q[qt++] = ni;
      };
      push(px + 1, py);
      push(px - 1, py);
      push(px, py + 1);
      push(px, py - 1);
    }

    BG.mask = mask;
    bgClearPath();
    bgRefresh();
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n;
  }

  function bgMaskFromPolygon(points) {
    if (!points || points.length < 3) return;
    const c = document.createElement("canvas");
    c.width = BG.w;
    c.height = BG.h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fill();
    const d = ctx.getImageData(0, 0, BG.w, BG.h).data;
    for (let i = 0; i < BG.mask.length; i++) BG.mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    bgRefresh();
  }

  function bgApplyMask() {
    const ctx = BG.work.getContext("2d");
    const img = ctx.getImageData(0, 0, BG.w, BG.h);
    const d = img.data;
    let n = 0;
    for (let i = 0; i < BG.mask.length; i++) {
      if (!BG.mask[i]) continue;
      d[i * 4 + 3] = 0;
      n++;
    }
    if (!n) return toast("Nothing selected — click or draw on the canvas first");
    BG.history.push({ data: ctx.getImageData(0, 0, BG.w, BG.h), mask: BG.mask.slice() });
    if (BG.history.length > 12) BG.history.shift();
    ctx.putImageData(img, 0, 0);
    BG.mask = new Uint8Array(BG.w * BG.h);
    bgClearPath();
    bgRefresh();
    toast("Made " + n.toLocaleString() + " pixels transparent");
  }

  function bgUndo() {
    if (!BG.history.length) return toast("Nothing to undo in this tool");
    const last = BG.history.pop();
    BG.work.getContext("2d").putImageData(last.data, 0, 0);
    BG.mask = last.mask;
    bgClearPath();
    bgRefresh();
  }

  async function bgApplyToPage() {
    if (!BG.target || BG.target.type !== "page") return toast("This tool is working on an image layer");
    const p = BG.target.page;
    p.bgImage = BG.work.toDataURL("image/png");
    p.thumb = null;
    p.text = null;
    p.tables = null;
    if (S.pages[S.index] === p) {
      await renderBackground();
      syncOriginals();
      syncTables();
    }
    toast("Background replaced on page " + (S.pages.indexOf(p) + 1));
  }

  function bgReplaceImage() {
    if (!BG.target || BG.target.type !== "image") return toast("Select an image layer first");
    const obj = BG.target.obj;
    const url = BG.work.toDataURL("image/png");
    const dispW = Math.abs((obj.width || 1) * (obj.scaleX == null ? 1 : obj.scaleX));
    const dispH = Math.abs((obj.height || 1) * (obj.scaleY == null ? 1 : obj.scaleY));
    fabric.Image.fromURL(url, (img) => {
      img.set({
        left: obj.left,
        top: obj.top,
        originX: obj.originX,
        originY: obj.originY,
        angle: obj.angle,
        flipX: obj.flipX,
        flipY: obj.flipY,
        opacity: obj.opacity,
        scaleX: dispW / (img.width || 1),
        scaleY: dispH / (img.height || 1),
      });
      const idx = canvas.getObjects().indexOf(obj);
      canvas.remove(obj);
      if (idx >= 0) canvas.insertAt(img, idx);
      else canvas.add(img);
      img.setCoords();
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
      pushHistory();
      syncLayers();
      toast("Image layer replaced with the transparent version");
      closeModal("bgModal");
    });
  }

  function bgDownloadPng() {
    const a = document.createElement("a");
    a.href = BG.work.toDataURL("image/png");
    a.download = "background-removed.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function bgHandleDown(e) {
    if (!BG.work) return;
    const pt = bgPointer(e);
    const tol = Number($("bgTolerance").value) || 30;

    if (BG.tool === "wand" || BG.tool === "smart") {
      const r = bgFlood(pt.x, pt.y, tol, BG.tool === "smart");
      BG.mask = r.mask;
      bgClearPath();
      bgRefresh();
      $("bgStatus").textContent =
        "Selected " + r.count.toLocaleString() + " pixels. Press “Make selected transparent”.";
      return;
    }

    if (BG.tool === "lasso") {
      BG.points = [pt];
      BG.path = BG.points;
      BG.pathClosed = false;
      BG.dragging = true;
      return;
    }

    if (BG.tool === "polygon") {
      if (!BG.poly) BG.poly = [];
      if (BG.poly.length > 2) {
        const first = BG.poly[0];
        if (Math.hypot(first.x - pt.x, first.y - pt.y) < Math.max(6, BG.w * 0.008)) {
          BG.path = BG.poly.slice();
          BG.pathClosed = true;
          bgMaskFromPolygon(BG.poly);
          BG.poly = null;
          $("bgStatus").textContent = "Polygon closed. Press “Make selected transparent”.";
          return;
        }
      }
      BG.poly.push(pt);
      BG.path = BG.poly.slice();
      BG.pathClosed = false;
      $("bgStatus").textContent =
        "Polygon: " + BG.poly.length + " points — double-click to close the shape.";
    }
  }

  function bgHandleMove(e) {
    if (!BG.work) return;
    const pt = bgPointer(e);
    if (BG.tool === "lasso" && BG.dragging) {
      const last = BG.points[BG.points.length - 1];
      if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 1.5) BG.points.push(pt);
      BG.path = BG.points;
      BG.pathClosed = false;
      if (BG.points.length > 2) bgMaskFromPolygon(BG.points);
      return;
    }
    if (BG.tool === "polygon" && BG.poly && BG.poly.length) {
      /* live preview: current polygon plus the hovered point */
      BG.path = BG.poly.concat([pt]);
      BG.pathClosed = false;
      bgMaskFromPolygon(BG.poly.concat([pt]));
    }
  }

  function bgHandleUp() {
    if (BG.tool === "lasso" && BG.dragging) {
      BG.dragging = false;
      if (BG.points.length > 2) {
        bgMaskFromPolygon(BG.points);
        BG.path = BG.points.slice();
        BG.pathClosed = true;
        bgRefresh();
        $("bgStatus").textContent = "Lasso closed. Press “Make selected transparent”.";
      } else {
        bgClearPath();
      }
      BG.points = [];
    }
  }

  /* ======================================================================
     SIGNATURE PANEL
     ====================================================================== */
  const SIG_KEY = "pdfstudio.signatures.v1";
  const SIG = {
    mode: "draw",
    upload: null,
    gallery: [],
    pick: null,
    drawing: false,
    last: null,
    ready: false,
  };

  function loadSignatures() {
    try {
      const raw = localStorage.getItem(SIG_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      SIG.gallery = Array.isArray(arr) ? arr : [];
    } catch (e) {
      SIG.gallery = [];
    }
    return SIG.gallery;
  }

  function saveSignatures() {
    try {
      localStorage.setItem(SIG_KEY, JSON.stringify(SIG.gallery.slice(0, 12)));
    } catch (e) {
      toast("Could not save — browser storage is full", 3000);
    }
  }

  function renderSignatureGallery() {
    const wrap = $("sigGallery");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!SIG.gallery.length) {
      const e = document.createElement("div");
      e.className = "empty-layers";
      e.style.cssText = "font-size:11.5px;color:var(--muted);padding:4px";
      e.textContent = "Saved signatures appear here.";
      wrap.appendChild(e);
      return;
    }
    SIG.gallery.forEach((item, i) => {
      const d = document.createElement("div");
      d.className = "sig-item" + (SIG.pick === item.url ? " sel" : "");
      const im = document.createElement("img");
      im.src = item.url;
      im.alt = item.name || "signature";
      const del = document.createElement("button");
      del.className = "s-del";
      del.textContent = "×";
      del.title = "Delete saved signature";
      d.appendChild(im);
      d.appendChild(del);
      d.addEventListener("click", (e) => {
        if (e.target === del) return;
        SIG.pick = item.url;
        renderSignatureGallery();
        toast("Saved signature selected — press Insert on page");
      });
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        SIG.gallery.splice(i, 1);
        if (SIG.pick === item.url) SIG.pick = null;
        saveSignatures();
        renderSignatureGallery();
      });
      wrap.appendChild(d);
    });
  }

  function sigTrim(canvasEl) {
    const ctx = canvasEl.getContext("2d");
    const { width: w, height: h } = canvasEl;
    let data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      return canvasEl;
    }
    let left = w;
    let top = h;
    let right = 0;
    let bottom = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (right <= left || bottom <= top) return canvasEl;
    const pad = 6;
    left = Math.max(0, left - pad);
    top = Math.max(0, top - pad);
    right = Math.min(w - 1, right + pad);
    bottom = Math.min(h - 1, bottom + pad);
    const out = document.createElement("canvas");
    out.width = right - left + 1;
    out.height = bottom - top + 1;
    out.getContext("2d").drawImage(canvasEl, left, top, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  function sigCompose() {
    if (SIG.pick) return Promise.resolve(SIG.pick);
    if (SIG.mode === "upload") return Promise.resolve(SIG.upload);

    if (SIG.mode === "draw") {
      const c = $("sigDrawCanvas");
      const trimmed = sigTrim(c);
      return Promise.resolve(trimmed.toDataURL("image/png"));
    }

    const text = ($("sigText").value || "").trim();
    if (!text) return Promise.resolve(null);
    const family = $("sigFont").value;
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 420;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(210, 1500 / Math.max(3, text.length));
    ctx.font = "600 " + size + "px " + family;
    /* Google Fonts may need the network.  Never leave the signature panel
       waiting forever when the font cannot load — fall back to the local
       cursive face after a short delay. */
    const fontReady =
      document.fonts && document.fonts.load
        ? Promise.race([
            document.fonts.load("600 " + size + "px " + family).catch(() => {}),
            new Promise((r) => setTimeout(r, 1800)),
          ])
        : Promise.resolve();
    return fontReady.then(() => {
      ctx.font = "600 " + size + "px " + family;
      ctx.fillText(text, c.width / 2, c.height / 2);
      return sigTrim(c).toDataURL("image/png");
    });
  }

  function initSigPad() {
    if (SIG.ready) return;
    SIG.ready = true;
    const c = $("sigDrawCanvas");
    const ctx = c.getContext("2d");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 4;

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) * c.width) / Math.max(1, r.width),
        y: ((e.clientY - r.top) * c.height) / Math.max(1, r.height),
      };
    };
    c.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      c.setPointerCapture && c.setPointerCapture(e.pointerId);
      SIG.drawing = true;
      SIG.last = pos(e);
      SIG.pick = null;
      renderSignatureGallery();
    });
    c.addEventListener("pointermove", (e) => {
      if (!SIG.drawing) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(SIG.last.x, SIG.last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      SIG.last = p;
    });
    c.addEventListener("pointerup", () => {
      SIG.drawing = false;
    });
    c.addEventListener("pointercancel", () => {
      SIG.drawing = false;
    });
  }

  function setSigTab(tab) {
    SIG.mode = tab;
    $("sigTabs").querySelectorAll("[data-sigtab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.sigtab === tab);
    });
    document.querySelectorAll("[data-sigpane]").forEach((p) => {
      p.hidden = p.dataset.sigpane !== tab;
    });
    if (tab !== "upload") { /* keep upload selection but it is not active */ }
  }

  function openSignatureTool() {
    if (!S.ready) return toast("Open a PDF first");
    initSigPad();
    loadSignatures();
    SIG.pick = null;
    SIG.upload = null;
    renderSignatureGallery();
    setSigTab("draw");
    updateSigPreview();
    openModal("sigModal");
  }

  function updateSigPreview() {
    const p = $("sigPreview");
    if (!p) return;
    p.style.fontFamily = $("sigFont").value;
    p.textContent = $("sigText").value || "Your Name";
  }

  async function insertSignature() {
    const url = await sigCompose();
    if (!url) return toast("Draw, type or upload a signature first");
    const img = await new Promise((res) => fabric.Image.fromURL(url, res));
    const p = S.pages[S.index];
    const targetW = Math.min(p.width * 0.38, 280);
    const targetH = Math.min(p.height * 0.16, 120);
    let s = targetW / (img.width || 1);
    if ((img.height || 1) * s > targetH) s = targetH / (img.height || 1);
    img.set({
      left: p.width / 2 - ((img.width || 1) * s) / 2,
      top: p.height * 0.72 - ((img.height || 1) * s) / 2,
      scaleX: s,
      scaleY: s,
    });
    img.isSignature = true;
    canvas.add(img);
    canvas.setActiveObject(img);
    canvas.requestRenderAll();
    syncLayers();
    pushHistory();
    closeModal("sigModal");
    setTool("select");
    toast("Signature placed — drag or resize it on the page");
  }

  async function saveCurrentSignature() {
    const url = await sigCompose();
    if (!url) return toast("Draw, type or upload a signature first");
    const name = ($("sigName").value || "").trim() || "Signature " + (SIG.gallery.length + 1);
    SIG.gallery.unshift({ name, url, date: Date.now() });
    if (SIG.gallery.length > 12) SIG.gallery.length = 12;
    saveSignatures();
    renderSignatureGallery();
    toast("Signature saved for reuse");
  }

  /* ======================================================================
     TABLE INSERT
     ====================================================================== */
  function contrastOn(hex) {
    const c = new fabric.Color(hex || "#ffffff").getSource();
    const l = (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;
    return l > 0.58 ? "#111827" : "#ffffff";
  }

  function openTableTool() {
    if (!S.ready) return toast("Open a PDF first");
    $("tblNewPage").checked = false;
    document.querySelector('[data-size-root="table"]').hidden = true;
    openModal("tableModal");
  }

  async function insertTableFromDialog() {
    if (!S.ready) return;
    const rows = clamp(Math.round(Number($("tblRows").value) || 3), 1, 40);
    const cols = clamp(Math.round(Number($("tblCols").value) || 3), 1, 20);
    const placeholder = $("tblDefault").value;
    const headerFill = $("tblHeaderFill").value;
    const bodyFill = $("tblFill").value;
    const border = $("tblBorder").value;
    const borderW = clamp(Number($("tblBorderWidth").value) || 0, 0, 8);
    const fs = clamp(Number($("tblFontSize").value) || 12, 4, 72);
    const headerBold = $("tblHeaderBold").checked;
    const newPage = $("tblNewPage").checked;

    savePage();
    if (newPage) {
      const size = sizeControls.table.getSize();
      const at = S.index + 1;
      const blank = emptyPageData({
        kind: "blank",
        baseWidth: size.width,
        baseHeight: size.height,
        width: size.width,
        height: size.height,
        imgOps: [],
      });
      S.pages.splice(at, 0, blank);
      S.index = at;
      await setPage(at);
    }

    const p = S.pages[S.index];
    const tableId = "it-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const cellW = Math.min(170, (p.width * 0.8) / cols);
    const cellH = Math.max(26, fs * 2.15);
    const totalW = cellW * cols;
    const totalH = cellH * rows;
    const left = (p.width - totalW) / 2;
    const top = Math.max(30, (p.height - totalH) / 2);
    const made = [];

  const colWidths = Array(cols).fill(cellW);
  const rowHeights = Array(rows).fill(cellH);
  const hasRowHeader = true;
  const hasColHeader = true;
  const headerW = Math.max(24, fs * 2);
  const headerH = Math.max(22, fs * 1.8);

  ensureTableMeta(tableId, {
    id: tableId,
    rows,
    cols,
    colWidths: colWidths.slice(),
    rowHeights: rowHeights.slice(),
    left,
    top,
    cellW,
    cellH,
    headerW,
    headerH,
    hasRowHeader,
    hasColHeader,
    border,
    borderW,
    headerFill,
    bodyFill,
    fontSize: fs,
    headerBold,
  });

  S.suppressHistory = true;

  // Column headers (A, B, C...)
  if (hasColHeader) {
    for (let c = 0; c < cols; c++) {
      let cx = left + headerW;
      for (let cc = 0; cc < c; cc++) cx += colWidths[cc];
      const rect = new fabric.Rect({
        left: cx,
        top: left >= 0 ? top - headerH : top,
        width: colWidths[c],
        height: headerH,
        fill: headerFill,
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "pointer",
      });
      rect.isTableGrid = true;
      rect.insertedTable = tableId;
      rect.tableId = tableId;
      rect.isTableHeader = true;
      rect.headerType = "col";
      rect.cellRow = -1;
      rect.cellCol = c;
      canvas.add(rect);
      const label = String.fromCharCode(65 + (c % 26)) + (c >= 26 ? String.fromCharCode(65 + Math.floor(c/26)-1) : "");
      const it = new fabric.Textbox(label, {
        left: cx + 4,
        top: (left >= 0 ? top - headerH : top) + 2,
        width: Math.max(10, colWidths[c] - 8),
        fontSize: fs - 1,
        fontFamily: FONTS.helvetica.css,
        fill: contrastOn(headerFill),
        lineHeight: 1.1,
        editable: false,
        textAlign: "center",
        splitByGrapheme: true,
        wordWrap: true,
      });
      it.insertedTable = tableId;
      it.tableId = tableId;
      it.isTableHeader = true;
      it.headerType = "col";
      it.cellRow = -1;
      it.cellCol = c;
      if (headerBold) it.set("fontWeight", "bold");
      canvas.add(it);
    }
    // Corner
    const corner = new fabric.Rect({
      left: left,
      top: top - headerH,
      width: headerW,
      height: headerH,
      fill: headerFill,
      stroke: borderW > 0 ? border : null,
      strokeWidth: borderW,
      strokeUniform: true,
      selectable: true,
      hoverCursor: "pointer",
    });
    corner.isTableGrid = true;
    corner.insertedTable = tableId;
    corner.tableId = tableId;
    corner.isTableHeader = true;
    corner.headerType = "corner";
    corner.cellRow = -2;
    corner.cellCol = -2;
    canvas.add(corner);
  }

  // Row headers
  if (hasRowHeader) {
    for (let r = 0; r < rows; r++) {
      let cy = top;
      for (let rr = 0; rr < r; rr++) cy += rowHeights[rr];
      const rect = new fabric.Rect({
        left: left,
        top: cy,
        width: headerW,
        height: rowHeights[r],
        fill: headerFill,
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "pointer",
      });
      rect.isTableGrid = true;
      rect.insertedTable = tableId;
      rect.tableId = tableId;
      rect.isTableHeader = true;
      rect.headerType = "row";
      rect.cellRow = r;
      rect.cellCol = -1;
      canvas.add(rect);
      const it = new fabric.Textbox(String(r + 1), {
        left: left + 2,
        top: cy + 2,
        width: Math.max(10, headerW - 4),
        fontSize: fs - 1,
        fontFamily: FONTS.helvetica.css,
        fill: contrastOn(headerFill),
        lineHeight: 1.1,
        editable: false,
        textAlign: "center",
        splitByGrapheme: true,
        wordWrap: true,
      });
      it.insertedTable = tableId;
      it.tableId = tableId;
      it.isTableHeader = true;
      it.headerType = "row";
      it.cellRow = r;
      it.cellCol = -1;
      if (headerBold) it.set("fontWeight", "bold");
      canvas.add(it);
    }
  }

  const offsetX = hasRowHeader ? headerW : 0;
  const offsetY = hasColHeader ? headerH : 0;
  meta.left = left + offsetX;
  meta.top = top + offsetY;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let cx = meta.left;
      for (let cc = 0; cc < c; cc++) cx += colWidths[cc];
      let cy = meta.top;
      for (let rr = 0; rr < r; rr++) cy += rowHeights[rr];

      const fill = r === 0 ? headerFill : bodyFill;
      const rect = new fabric.Rect({
        left: cx,
        top: cy,
        width: colWidths[c],
        height: rowHeights[r],
        fill,
        stroke: borderW > 0 ? border : null,
        strokeWidth: borderW,
        strokeUniform: true,
        selectable: true,
        hoverCursor: "move",
      });
      rect.isTableGrid = true;
      rect.insertedTable = tableId;
      rect.tableId = tableId;
      rect.cellRow = r;
      rect.cellCol = c;
      canvas.add(rect);

      const text = placeholder || "";
      const it = new fabric.Textbox(text, {
        left: cx + Math.max(4, colWidths[c] * 0.04),
        top: cy + Math.max(2, rowHeights[r] * 0.08),
        width: Math.max(10, colWidths[c] - Math.max(8, colWidths[c] * 0.08)),
        fontSize: fs,
        fontFamily: FONTS.helvetica.css,
        fill: contrastOn(fill),
        lineHeight: 1.15,
        editable: true,
        splitByGrapheme: true,
        wordWrap: true,
      });
      it.pdfFont = "helvetica";
      it.insertedTable = tableId;
      it.tableId = tableId;
      it.cellRow = r;
      it.cellCol = c;
      if (r === 0 && headerBold) it.set("fontWeight", "bold");
      if (placeholder) {
        if (r === 0 && c === 0) made.unshift(it);
        else made.push(it);
      } else {
        made.push(it);
      }
      canvas.add(it);
    }
  }
    S.suppressHistory = false;
    canvas.requestRenderAll();
    pushHistory();
    syncLayers();
    if (made.length) {
      const editing = placeholder ? editTableCell(made[0]) : false;
      if (!editing) canvas.setActiveObject(made[0]);
      canvas.requestRenderAll();
    }
    closeModal("tableModal");
    toast("Table inserted — drag as one unit, double-click a cell to edit", 3600);
  }

  /* ======================================================================
     PAGE CONTROLS
     ====================================================================== */
  /* The Open PDF buttons are <label for="pdfInput">, so the browser opens the
     native file picker directly (no programmatic input.click() needed).  The
     handler below only resets state before the dialog appears. */
  const preparePdfPicker = () => {
    S.pendingImage = null;
    el.pdfInput.value = "";
  };
  el.pdfInput.addEventListener("click", preparePdfPicker);

  /* Keyboard access: labels do not activate on Enter/Space by themselves. */
  ["openBtn", "emptyOpenBtn"].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        preparePdfPicker();
        el.pdfInput.click();
      }
    });
  });

  el.pdfInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    el.pdfInput.value = "";
    if (file) await openFile(file);
  });

  el.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    const mode = el.fileInput.dataset.mode;
    el.fileInput.value = "";
    delete el.fileInput.dataset.mode;
    if (!file) return;

    if (mode === "image") {
      if (!S.ready) return toast("Open a PDF first");
      const pos = S.pendingImage || { x: S.pages[S.index].width / 2, y: S.pages[S.index].height / 2 };
      S.pendingImage = null;
      addImage(file, pos.x, pos.y);
      setTool("select");
    }
  });

  /* ------------------------------ custom fonts ------------------------------ */
  $("fontFileBtn").addEventListener("click", () => {
    const inp = $("fontInput");
    inp.value = "";
    inp.click();
  });

  $("fontInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (!/\.(ttf|otf|woff2?)$/i.test(f.name || "")) {
      return toast("Please choose a .ttf, .otf, .woff or .woff2 file", 3200);
    }
    await addFontFile(f);
  });

  $("googleFontBtn").addEventListener("click", async () => {
    const name = window.prompt(
      "Google Font name — for example: Poppins, Lato, Merriweather, Roboto Slab"
    );
    if (name && name.trim()) await addGoogleFont(name.trim());
  });

  $("restoreOriginalsBtn").addEventListener("click", () => restoreAllOriginals());

  const exportLayerBtn = $("exportLayerBtn");
  if (exportLayerBtn) exportLayerBtn.addEventListener("click", () => exportSelectionPng());

  const removePatchBtn = $("removePatchBtn");
  if (removePatchBtn) removePatchBtn.addEventListener("click", () => removePatchForText());

  $("prevPageBtn").addEventListener("click", () => setPage(S.index - 1));
  $("nextPageBtn").addEventListener("click", () => setPage(S.index + 1));

  $("addPageBtn").addEventListener("click", async () => {
    if (!S.ready) return;
    await addBlankPage("after");
  });

  $("delPageBtn").addEventListener("click", async () => {
    if (!S.ready || S.pages.length <= 1) return;
    if (!window.confirm(`Delete page ${S.index + 1}?`)) return;
    S.pageSel.clear();
    S.pageSel.add(S.index);
    await deleteSelectedPages();
  });

  /* ------------------------------ pages modal ------------------------------ */
  $("pagesBtn").addEventListener("click", () => openPagesModal());
  $("pagesClose").addEventListener("click", () => closeModal("pagesModal"));
  $("pagesRotateCW").addEventListener("click", () => rotateSelectedPages(90));
  $("pagesRotateCCW").addEventListener("click", () => rotateSelectedPages(-90));
  $("pagesRotate180").addEventListener("click", () => rotateSelectedPages(180));
  $("pagesDelete").addEventListener("click", () => deleteSelectedPages());
  $("pagesMoveUp").addEventListener("click", async () => {
    const idx = selectedPageIndices();
    if (!idx.length || idx[0] <= 0) return;
    await movePage(idx[0], idx[0] - 1);
  });
  $("pagesMoveDown").addEventListener("click", async () => {
    const idx = selectedPageIndices();
    if (!idx.length || idx[idx.length - 1] >= S.pages.length - 1) return;
    await movePage(idx[idx.length - 1], idx[idx.length - 1] + 1);
  });
  $("addBlankBefore").addEventListener("click", () => addBlankPage("before"));
  $("addBlankAfter").addEventListener("click", () => addBlankPage("after"));

  $("insertPdfBtn").addEventListener("click", () => {
    const inp = $("insertPdfInput");
    inp.value = "";
    inp.click();
  });
  $("insertPdfInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await insertPdfPages(files, selectedPageIndices().slice(-1)[0]);
  });
  $("insertImagePageBtn").addEventListener("click", () => {
    const inp = $("insertImagePageInput");
    inp.value = "";
    inp.click();
  });
  $("insertImagePageInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await insertImagePages(files, selectedPageIndices().slice(-1)[0]);
  });

  /* ------------------------------ merge / split ------------------------------ */
  $("mergeBtn").addEventListener("click", () => {
    openModal("mergeModal");
    renderMergeList();
  });
  $("mergeClose").addEventListener("click", () => closeModal("mergeModal"));
  $("mergeTabs").querySelectorAll("[data-mtab]").forEach((b) => {
    b.addEventListener("click", () => {
      $("mergeTabs").querySelectorAll("[data-mtab]").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll("[data-mpane]").forEach((pane) => {
        pane.hidden = pane.dataset.mpane !== b.dataset.mtab;
      });
      if (b.dataset.mtab === "split") syncPageSelUI();
      else if (b.dataset.mtab === "merge") observeMergeCards();
    });
  });
  $("mergeAddBtn").addEventListener("click", () => {
    const inp = $("mergeInput");
    inp.value = "";
    inp.click();
  });
  $("mergeInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await addMergeFiles(files);
  });
  $("mergeClearBtn").addEventListener("click", () => {
    clearMergeList();
  });
  $("mergeDownload").addEventListener("click", async () => {
    try {
      const bytes = await mergePdfs();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), "merged.pdf");
      toast("Merged PDF downloaded");
    } catch (err) {
      console.error(err);
      toast("Merge failed: " + err.message, 4000);
    }
  });
  $("mergeOpen").addEventListener("click", async () => {
    try {
      const bytes = await mergePdfs();
      closeModal("mergeModal");
      await loadPdf(bytes, "merged.pdf");
    } catch (err) {
      console.error(err);
      toast("Merge failed: " + err.message, 4000);
    }
  });
  $("splitDownload").addEventListener("click", () => splitAndDownload());

  /* ------------------------------ background removal ------------------------------ */
  $("bgClose").addEventListener("click", () => closeModal("bgModal"));
  $("bgDone").addEventListener("click", () => closeModal("bgModal"));
  $("bgZoomIn").addEventListener("click", () => applyBgZoom((BG.zoom || 1) * 1.25));
  $("bgZoomOut").addEventListener("click", () => applyBgZoom((BG.zoom || 1) / 1.25));
  $("bgZoomReset").addEventListener("click", () => applyBgZoom(1));
  $("bgZoomFit").addEventListener("click", () => {
    const wrap = $("bgCanvasWrap");
    if (!wrap || !BG.w || !BG.h) return applyBgZoom(1);
    const pad = 32;
    const scale = Math.min((wrap.clientWidth - pad) / BG.w, (wrap.clientHeight - pad) / BG.h, 1);
    applyBgZoom(Math.max(BG.minZoom || 0.25, scale));
  });
  const bgWrap = $("bgCanvasWrap");
  if (bgWrap) {
    bgWrap.addEventListener("wheel", (e) => {
      if (!document.getElementById("bgModal").classList.contains("open")) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      applyBgZoom((BG.zoom || 1) * (dir > 0 ? 1.12 : 0.892));
    }, { passive: false });
  }
  $("bgTools").querySelectorAll("[data-bgtool]").forEach((b) => {
    b.addEventListener("click", () => setBgTool(b.dataset.bgtool));
  });
  $("bgTolerance").addEventListener("input", (e) => {
    $("bgTolVal").textContent = e.target.value;
  });
  $("bgAuto").addEventListener("click", () => {
    const n = bgAutoSelect();
    $("bgStatus").textContent = n
      ? "Auto-selected " + n.toLocaleString() + " background pixels. Press “Make selected transparent”."
      : "Could not find a background — try a different tolerance.";
  });
  $("bgInvert").addEventListener("click", () => {
    for (let i = 0; i < BG.mask.length; i++) BG.mask[i] = BG.mask[i] ? 0 : 1;
    bgClearPath();
    bgRefresh();
    $("bgStatus").textContent = "Selection inverted.";
  });
  $("bgClear").addEventListener("click", () => {
    BG.mask.fill(0);
    BG.poly = null;
    BG.points = [];
    bgClearPath();
    bgRefresh();
    $("bgStatus").textContent = "Selection cleared.";
  });
  $("bgUndo").addEventListener("click", bgUndo);
  $("bgTransparent").addEventListener("click", bgApplyMask);
  $("bgApplyPage").addEventListener("click", bgApplyToPage);
  $("bgReplaceImage").addEventListener("click", bgReplaceImage);
  $("bgDownloadPng").addEventListener("click", bgDownloadPng);

  $("bgEditCanvas").addEventListener("pointerdown", bgHandleDown);
  $("bgEditCanvas").addEventListener("pointermove", bgHandleMove);
  window.addEventListener("pointerup", bgHandleUp);
  $("bgEditCanvas").addEventListener("dblclick", (e) => {
    if (BG.tool !== "polygon" || !BG.poly || BG.poly.length < 3) return;
    e.preventDefault();
    BG.path = BG.poly.slice();
    BG.pathClosed = true;
    bgMaskFromPolygon(BG.poly);
    BG.poly = null;
    $("bgStatus").textContent = "Polygon closed. Press “Make selected transparent”.";
  });

  /* ------------------------------ signature ------------------------------ */
  $("sigClose").addEventListener("click", () => closeModal("sigModal"));
  $("sigClose2").addEventListener("click", () => closeModal("sigModal"));
  $("sigTabs").querySelectorAll("[data-sigtab]").forEach((b) => {
    b.addEventListener("click", () => setSigTab(b.dataset.sigtab));
  });
  $("sigText").addEventListener("input", updateSigPreview);
  $("sigFont").addEventListener("change", updateSigPreview);
  $("sigClearDraw").addEventListener("click", () => {
    const c = $("sigDrawCanvas");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    SIG.pick = null;
    renderSignatureGallery();
    toast("Drawing cleared");
  });
  $("sigUploadBtn").addEventListener("click", () => {
    const inp = $("sigUpload");
    inp.value = "";
    inp.click();
  });
  $("sigUpload").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      SIG.upload = String(fr.result);
      SIG.pick = null;
      setSigTab("upload");
      renderSignatureGallery();
      toast("Signature image loaded — press Insert on page");
    };
    fr.readAsDataURL(file);
  });
  $("sigSave").addEventListener("click", saveCurrentSignature);
  $("sigInsert").addEventListener("click", insertSignature);

  /* ------------------------------ insert table / screenshot ------------------------------ */
  $("tblClose").addEventListener("click", () => closeModal("tableModal"));
  $("tblClose2").addEventListener("click", () => closeModal("tableModal"));
  $("tblNewPage").addEventListener("change", (e) => {
    document.querySelector('[data-size-root="table"]').hidden = !e.target.checked;
  });
  $("tblInsert").addEventListener("click", insertTableFromDialog);

  document.querySelectorAll(".tool[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.action;
      if (act === "table") {
        openTableTool();
        document.querySelectorAll(".tool[data-action]").forEach((b) => b.classList.toggle("active", b === btn));
        return;
      }
      if (act === "screenshot") {
        if (!S.ready) return toast("Open a PDF first");
        screenshotMode = true;
        screenshotStart = null;
        if (screenshotRect) { try { canvas.remove(screenshotRect); } catch(e){} screenshotRect = null; }
        S.tool = "screenshot";
        document.querySelectorAll(".tool[data-tool]").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tool[data-action]").forEach((b) => b.classList.toggle("active", b === btn));
        canvas.isDrawingMode = false;
        canvas.selection = false;
        canvas.defaultCursor = "crosshair";
        canvas.hoverCursor = "crosshair";
        canvas.moveCursor = "crosshair";
        try { canvas.discardActiveObject(); canvas.renderAll(); } catch (e) {}
        canvas.getObjects().forEach((o) => { if (!o.isTableHeader) { o.selectable = false; o.evented = false; } });
        try {
          if (canvas.lowerCanvasEl) canvas.lowerCanvasEl.style.cursor = "crosshair";
          if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = "crosshair";
          const elc = canvas.getElement ? canvas.getElement() : null;
          if (elc) elc.style.cursor = "crosshair";
        } catch (e) {}
        if (canvas.lowerCanvasEl) canvas.lowerCanvasEl.style.cursor = "crosshair";
        if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.cursor = "crosshair";
        toast("Drag exactly on area to capture");
        return;
      }
      if (act === "signature") {
        openSignatureTool();
        return;
      }
      if (act === "bg") {
        openBackgroundTool();
        return;
      }
    });
  });

  function getActiveTableId() {
    const active = canvas.getActiveObject();
    if (!active) return null;
    if (active.type === "activeSelection" && active.getObjects) {
      const objs = active.getObjects();
      for (const o of objs) {
        if (o.insertedTable || o.tableId) return o.insertedTable || o.tableId;
      }
    }
    if (active.insertedTable || active.tableId) return active.insertedTable || active.tableId;
    return null;
  }

  function getActiveCell() {
    const active = canvas.getActiveObject();
    if (!active) return null;
    if (active.type === "activeSelection" && active.getObjects) {
      const objs = active.getObjects();
      for (const o of objs) {
        if (!o.isTableHeader || o.headerType === "row" || o.headerType === "col" || o.headerType === "corner") {
          if (o.insertedTable || o.tableId) return o;
        }
      }
      return objs[0] || null;
    }
    return active;
  }

  function selectTableRow(tableId, rowIdx) {
    const meta = getTableMeta(tableId);
    if (!meta) return;
    const objs = getTableCellObjs(tableId).filter((o) => !o.isTableHeader && o.cellRow === rowIdx);
    if (!objs.length) return;
    canvas.discardActiveObject();
    canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
  }

  function selectTableCol(tableId, colIdx) {
    const meta = getTableMeta(tableId);
    if (!meta) return;
    const objs = getTableCellObjs(tableId).filter((o) => !o.isTableHeader && o.cellCol === colIdx);
    if (!objs.length) return;
    canvas.discardActiveObject();
    canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
  }

  function selectTableAll(tableId) {
    const objs = getTableCellObjs(tableId).filter((o) => !o.isTableHeader);
    if (!objs.length) return;
    canvas.discardActiveObject();
    canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
    canvas.requestRenderAll();
    syncLayers();
    syncProps();
  }

  $("tblAddRow")?.addEventListener("click", () => {
    const id = getActiveTableId();
    if (!id) return toast("Select a table cell first");
    const cell = getActiveCell();
    let idx = null;
    if (cell && cell.cellRow != null) idx = cell.cellRow;
    addTableRow(id, idx);
  });
  $("tblAddCol")?.addEventListener("click", () => {
    const id = getActiveTableId();
    if (!id) return toast("Select a table cell first");
    const cell = getActiveCell();
    let idx = null;
    if (cell && cell.cellCol != null) idx = cell.cellCol;
    addTableCol(id, idx);
  });
  $("tblDelRow")?.addEventListener("click", () => {
    const id = getActiveTableId();
    if (!id) return toast("Select a table cell first");
    const cell = getActiveCell();
    const idx = cell && cell.cellRow != null ? cell.cellRow : null;
    delTableRow(id, idx);
  });
  $("tblDelCol")?.addEventListener("click", () => {
    const id = getActiveTableId();
    if (!id) return toast("Select a table cell first");
    const cell = getActiveCell();
    const idx = cell && cell.cellCol != null ? cell.cellCol : null;
    delTableCol(id, idx);
  });

  /* close modals on backdrop click / Escape */
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("mousedown", (e) => {
      if (e.target === m) {
        m.classList.remove("open");
        m.setAttribute("aria-hidden", "true");
      }
    });
  });

  $("zoomInBtn").addEventListener("click", () => setZoom(S.zoom * 1.2));
  $("zoomOutBtn").addEventListener("click", () => setZoom(S.zoom / 1.2));
  $("fitBtn").addEventListener("click", () => {
    if (!S.ready) return;
    setZoom(fitZoom(S.pages[S.index]));
  });

  async function setZoom(z) {
    if (!S.ready) return;
    S.zoom = clamp(z, 0.2, 3.5);
    applyViewport();
    await renderBackground();
    canvas.requestRenderAll();
  }

  $("undoBtn").addEventListener("click", () => undoRedo(-1));
  $("redoBtn").addEventListener("click", () => undoRedo(1));

  el.exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    el.exportMenu.parentElement.classList.toggle("open");
  });
  document.addEventListener("click", () => el.exportMenu.parentElement.classList.remove("open"));
  el.exportMenu.addEventListener("click", (e) => e.stopPropagation());

  el.exportMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      el.exportMenu.parentElement.classList.remove("open");
      if (!S.ready) return toast("Open a PDF first");
      try {
        const bytes = await buildPdf(b.dataset.mode);
        downloadPdf(bytes);
        toast(
          b.dataset.mode === "flatten"
            ? "Flattened PDF exported"
            : S.encrypted
            ? "Encrypted PDF — exported as flattened pages"
            : "PDF exported"
        );
      } catch (err) {
        console.error(err);
        toast("Export failed: " + err.message, 4000);
      }
    });
  });

  function downloadPdf(bytes) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = (S.name || "document").replace(/\.pdf$/i, "");
    a.href = url;
    a.download = base + "-edited.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ======================================================================
     EXPORT
     ====================================================================== */
  async function getFontFactory(out) {
    const cache = new Map();
    return async function getFont(key, bold, italic) {
      if (!FONTS[key] || FONTS[key].custom) key = "helvetica";
      const id = `${key}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
      if (cache.has(id)) return cache.get(id);

      let name;
      if (key === "times") {
        name = bold && italic ? "TimesRomanBoldItalic" : bold ? "TimesRomanBold" : italic ? "TimesRomanItalic" : "TimesRoman";
      } else if (key === "courier") {
        name = bold && italic ? "CourierBoldOblique" : bold ? "CourierBold" : italic ? "CourierOblique" : "Courier";
      } else {
        name = bold && italic ? "HelveticaBoldOblique" : bold ? "HelveticaBold" : italic ? "HelveticaOblique" : "Helvetica";
      }
      const font = await out.embedFont(StandardFonts[name]);
      cache.set(id, font);
      return font;
    };
  }

  function geom(obj, pageH) {
    const w = Math.abs(obj.width * (obj.scaleX == null ? 1 : obj.scaleX));
    const h = Math.abs(obj.height * (obj.scaleY == null ? 1 : obj.scaleY));
    const c = obj.getCenterPoint();
    return { w, h, cx: c.x, cy: pageH - c.y, angle: obj.angle || 0 };
  }

  function enlivenPage(p) {
    if (!p.json) return Promise.resolve([]);
    let parsed;
    try { parsed = JSON.parse(p.json); } catch (e) { return Promise.resolve([]); }
    const objects = parsed.objects || [];
    return new Promise((res) => fabric.util.enlivenObjects(objects, res));
  }

  /* --- exact text baseline layout, using fabric's own metrics ---
     Mirrors Text#_renderTextCommon + #_renderChars so the exported
     baseline lands on the same pixel row fabric paints it on. */
  function textLayout(obj) {
    const fontSize = obj.fontSize || 16;
    const lhFactor = obj.lineHeight || 1.16;
    const lineHeight =
      typeof obj.getHeightOfLine === "function"
        ? obj.getHeightOfLine(0)
        : fontSize * lhFactor * 1.13;
    const frac = obj._fontSizeFraction == null ? 0.222 : obj._fontSizeFraction;
    const topOffset =
      typeof obj._getTopOffset === "function" ? obj._getTopOffset() : -(obj.height || 0) / 2;
    return {
      lineHeight,
      topOffset,
      baselineInLine: (lineHeight / lhFactor) * (1 - frac),
    };
  }

  async function libForPage(p) {
    const rec = docRecord(p);
    if (!rec) return null;
    if (rec.lib !== undefined) return rec.lib;
    try {
      rec.lib = await PDFDocument.load(rec.bytes, { ignoreEncryption: true });
    } catch (e) {
      rec.lib = null;
    }
    return rec.lib;
  }

  async function buildPdf(mode, pageIndices) {
    if (!S.pages.length) throw new Error("No PDF loaded");
    savePage();
    showProgress("Preparing export…");

    try {
      /* Make sure every custom font is ready before text is rasterised. */
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
      const out = await PDFDocument.create();
      const getFont = await getFontFactory(out);
      let hiddenPages = 0;
      const seq =
        Array.isArray(pageIndices) && pageIndices.length
          ? pageIndices.filter((i) => i >= 0 && i < S.pages.length)
          : S.pages.map((_, i) => i);

      for (let k = 0; k < seq.length; k++) {
        const i = seq[k];
        const p = S.pages[i];
        progress(`Page ${k + 1} / ${seq.length}…`);

        const rec = docRecord(p);
        const srcPdf = rec ? await libForPage(p) : null;
        let page;
        if (srcPdf) {
          const [copied] = await out.copyPages(srcPdf, [p.src]);
          page = out.addPage(copied);
        } else {
          page = out.addPage([p.width, p.height]);
        }

        const hasHidden = !!(p.hiddenOcc && p.hiddenOcc.length);
        if (hasHidden) hiddenPages++;

        const needsRaster =
          mode === "flatten" ||
          !srcPdf ||
          (rec && rec.encrypted) ||
          hasHidden ||
          !!p.bgImage ||
          p.kind === "image" ||
          (p.rotation && p.rotation % 360 !== 0);

        if (needsRaster) {
          const scale = mode === "flatten" ? 2.5 : 2;
          const imgDataUrl = await renderComposite(i, scale);
          page.setRotation(degrees(0));
          page.setSize(p.width, p.height);
          if (mode === "flatten" && imgDataUrl.startsWith("data:image/png")) {
            // Use JPEG for flattened export to reduce size while maintaining quality
            try {
              const img = await loadImageElement(imgDataUrl);
              const c = document.createElement("canvas");
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext("2d");
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, c.width, c.height);
              ctx.drawImage(img, 0, 0);
              const jpg = await out.embedJpg(c.toDataURL("image/jpeg", 0.92));
              page.drawImage(jpg, { x: 0, y: 0, width: p.width, height: p.height });
            } catch (e) {
              const png = await out.embedPng(imgDataUrl);
              page.drawImage(png, { x: 0, y: 0, width: p.width, height: p.height });
            }
          } else {
            const png = await out.embedPng(imgDataUrl);
            page.drawImage(png, { x: 0, y: 0, width: p.width, height: p.height });
          }
        } else {
          const objects = await enlivenPage(p);
          const H = page.getHeight();
          for (const obj of objects) {
            await drawObject(page, obj, H, out, getFont);
          }
        }

        await new Promise((r) => setTimeout(r, 0));
      }

      out.setProducer("PDF Studio");
      out.setCreator("PDF Studio (browser)");
      progress("Saving…");
      return await out.save();
    } finally {
      hideProgress();
    }
  }

  async function renderComposite(index, scale) {
    const p = S.pages[index];
    const w = Math.max(1, Math.round(p.width * scale));
    const h = Math.max(1, Math.round(p.height * scale));

    const comp = document.createElement("canvas");
    comp.width = w;
    comp.height = h;
    const ctx = comp.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const base = await renderPageBase(p, scale);
    ctx.drawImage(base, 0, 0, w, h);

    const objects = await enlivenPage(p);
    if (objects.length) {
      const layerEl = document.createElement("canvas");
      const sc = new fabric.StaticCanvas(layerEl, {
        width: w,
        height: h,
        enableRetinaScaling: false,
        renderOnAddRemove: false,
      });
      sc.setZoom(scale);
      objects.forEach((o) => sc.add(o));
      sc.renderAll();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(layerEl, 0, 0);
      sc.dispose();
    }

    return comp.toDataURL("image/png");
  }

  async function drawObject(page, obj, pageH, out, getFont) {
    if (!obj || obj.visible === false) return;
    const op = obj.opacity == null ? 1 : obj.opacity;
    if (op <= 0.001) return;

    const type = obj.type;

    if (type === "i-text" || type === "textbox" || type === "text") {
      if (isCustomFont(obj)) {
        await drawCustomTextObject(page, obj, pageH, out, op);
        return;
      }
      await drawTextObject(page, obj, pageH, getFont, op);
      return;
    }
    if (type === "image") {
      await drawImageObject(page, obj, pageH, out, op);
      return;
    }
    if (type === "path") {
      drawPathObject(page, obj, pageH, op);
      return;
    }
    if (type === "line") {
      drawLineObject(page, obj, pageH, op);
      return;
    }

    const { w, h, cx, cy, angle } = geom(obj, pageH);
    if (w <= 0.1 || h <= 0.1) return;
    const theta = (-angle * Math.PI) / 180;

    const fillHex = toHexColor(obj.fill);
    const strokeHex = toHexColor(obj.stroke);
    const borderWidth = (obj.strokeWidth || 0) * avgScale(obj);

    if (type === "ellipse") {
      if (!fillHex && (!strokeHex || borderWidth <= 0)) return;
      page.drawEllipse({
        x: cx,
        y: cy,
        xScale: w / 2,
        yScale: h / 2,
        rotate: degrees(-angle),
        color: fillHex ? pdfColor(fillHex) : undefined,
        opacity: fillHex ? Math.min(1, op * colorAlpha(fillHex)) : undefined,
        borderColor: strokeHex ? pdfColor(strokeHex) : undefined,
        borderWidth: strokeHex ? borderWidth : undefined,
        borderOpacity: strokeHex ? op : undefined,
      });
      return;
    }

    if (!fillHex && (!strokeHex || borderWidth <= 0)) return;

    const v = rotatePoint(-w / 2, -h / 2, theta);
    page.drawRectangle({
      x: cx + v.x,
      y: cy + v.y,
      width: w,
      height: h,
      rotate: degrees(-angle),
      color: fillHex ? pdfColor(fillHex) : undefined,
      opacity: fillHex ? Math.min(1, op * colorAlpha(fillHex)) : undefined,
      borderColor: strokeHex ? pdfColor(strokeHex) : undefined,
      borderWidth: strokeHex ? borderWidth : undefined,
      borderOpacity: strokeHex ? op : undefined,
    });
  }

  async function drawTextObject(page, obj, pageH, getFont, op) {
    const text = obj.text || "";
    if (!text.trim()) return;

    const key = obj.pdfFont && FONTS[obj.pdfFont] ? obj.pdfFont : guessFontKey(obj.fontFamily);
    const bold = String(obj.fontWeight) === "bold" || Number(obj.fontWeight) >= 600;
    const italic = obj.fontStyle === "italic";
    const font = await getFont(key, bold, italic);

    const scaleY = obj.scaleY == null ? 1 : obj.scaleY;
    const size = Math.max(0.1, (obj.fontSize || 16) * scaleY);
    const angle = obj.angle || 0;

    const layout = textLayout(obj);
    const matrix = obj.calcTransformMatrix();
    const lines = text.split("\n");
    const fill = toHexColor(obj.fill) || "#000000";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const lx = obj._getLeftOffset() + obj._getLineLeftOffset(i);
      const ly = layout.topOffset + i * layout.lineHeight + layout.baselineInLine;

      const pt = fabric.util.transformPoint(new fabric.Point(lx, ly), matrix);

      page.drawText(line, {
        x: pt.x,
        y: pageH - pt.y,
        size,
        font,
        color: pdfColor(fill),
        opacity: op * colorAlpha(fill),
        rotate: degrees(-angle),
      });
    }
  }

  /* Custom (uploaded / Google) fonts cannot be embedded into the PDF without
     a fontkit-style writer, so a custom-font text object is rasterised at high
     resolution and placed exactly over its fabric bounding box. */
  function renderObjectToPng(obj, scale) {
    const b = obj.getBoundingRect(true, true);
    if (!b.width || !b.height) return null;
    const w = Math.max(1, Math.ceil(b.width * scale));
    const h = Math.max(1, Math.ceil(b.height * scale));
    const elc = document.createElement("canvas");
    const sc = new fabric.StaticCanvas(elc, {
      width: w,
      height: h,
      enableRetinaScaling: false,
      renderOnAddRemove: false,
    });
    sc.setZoom(scale);
    obj.set({ left: obj.left - b.left, top: obj.top - b.top });
    obj.setCoords();
    sc.add(obj);
    sc.renderAll();
    const url = elc.toDataURL("image/png");
    sc.dispose();
    return url;
  }

  async function drawCustomTextObject(page, obj, pageH, out, op) {
    const b = obj.getBoundingRect(true, true);
    if (!b.width || !b.height) return;
    const url = renderObjectToPng(obj, 4);
    if (!url) return;
    const png = await out.embedPng(url);
    page.drawImage(png, {
      x: b.left,
      y: pageH - b.top - b.height,
      width: b.width,
      height: b.height,
      opacity: op,
    });
  }

  async function drawImageObject(page, obj, pageH, out, op) {
    const element = obj._element;
    if (!element) return;

    const flipX = !!obj.flipX;
    const flipY = !!obj.flipY;
    let src = element.src || "";
    let image;
    try {
      /* fabric flips an image by mirroring its pixels inside the same box,
         so bake the mirror into the embedded bitmap and keep the box as-is. */
      if (flipX || flipY) {
        image = await out.embedPng(flipDataUrl(element, flipX, flipY));
      } else if (/^data:image\/jpe?g/i.test(src)) image = await out.embedJpg(src);
      else if (/^data:image\/png/i.test(src)) image = await out.embedPng(src);
      else image = await out.embedPng(toPngDataUrl(element));
    } catch (e) {
      console.warn("Could not embed image", e);
      return;
    }

    const { w, h, cx, cy, angle } = geom(obj, pageH);
    if (w <= 0.1 || h <= 0.1) return;
    const theta = (-angle * Math.PI) / 180;
    const v = rotatePoint(-w / 2, -h / 2, theta);

    page.drawImage(image, {
      x: cx + v.x,
      y: cy + v.y,
      width: w,
      height: h,
      rotate: degrees(-angle),
      opacity: op,
    });
  }

  function flipDataUrl(imgEl, flipX, flipY) {
    const w = imgEl.naturalWidth || imgEl.width || 1;
    const h = imgEl.naturalHeight || imgEl.height || 1;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.translate(flipX ? w : 0, flipY ? h : 0);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.drawImage(imgEl, 0, 0);
    return c.toDataURL("image/png");
  }

  function toPngDataUrl(imgEl) {
    const c = document.createElement("canvas");
    c.width = imgEl.naturalWidth || imgEl.width || 1;
    c.height = imgEl.naturalHeight || imgEl.height || 1;
    c.getContext("2d").drawImage(imgEl, 0, 0);
    return c.toDataURL("image/png");
  }

  function flattenPath(path, transform) {
    const polys = [];
    let cur = null;
    let last = null;
    let startPt = null;

    const pushRaw = (x, y) => {
      const pt = transform(x, y);
      if (!cur) {
        cur = [pt];
        polys.push(cur);
      } else {
        cur.push(pt);
      }
    };

    const quad = (p0, c1, p1, t) => ({
      x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c1.x + t * t * p1.x,
      y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c1.y + t * t * p1.y,
    });
    const cubic = (p0, c1, c2, p1, t) => ({
      x: Math.pow(1 - t, 3) * p0.x + 3 * Math.pow(1 - t, 2) * t * c1.x + 3 * (1 - t) * t * t * c2.x + t * t * t * p1.x,
      y: Math.pow(1 - t, 3) * p0.y + 3 * Math.pow(1 - t, 2) * t * c1.y + 3 * (1 - t) * t * t * c2.y + t * t * t * p1.y,
    });

    /* obj.path is already normalised by fabric (absolute M/L/Q/C/Z only). */
    for (const cmd of path) {
      const op = cmd[0];
      if (op === "M") {
        last = { x: cmd[1], y: cmd[2] };
        startPt = last;
        cur = null;
        pushRaw(cmd[1], cmd[2]);
      } else if (op === "L" || op === "H" || op === "V") {
        /* fabric normalises H/V to L; keep the fallbacks for safety. */
        const x = op === "V" ? (last ? last.x : 0) : cmd[1];
        const y = op === "H" ? (last ? last.y : 0) : op === "L" ? cmd[2] : cmd[1];
        last = { x, y };
        pushRaw(x, y);
      } else if (op === "Q") {
        const p0 = last || { x: cmd[1], y: cmd[2] };
        const c1 = { x: cmd[1], y: cmd[2] };
        const p1 = { x: cmd[3], y: cmd[4] };
        for (let i = 1; i <= 8; i++) {
          const q = quad(p0, c1, p1, i / 8);
          pushRaw(q.x, q.y);
        }
        last = p1;
      } else if (op === "C") {
        const p0 = last || { x: cmd[1], y: cmd[2] };
        const c1 = { x: cmd[1], y: cmd[2] };
        const c2 = { x: cmd[3], y: cmd[4] };
        const p1 = { x: cmd[5], y: cmd[6] };
        for (let i = 1; i <= 12; i++) {
          const q = cubic(p0, c1, c2, p1, i / 12);
          pushRaw(q.x, q.y);
        }
        last = p1;
      } else if (op === "Z") {
        if (cur && cur.length && startPt) pushRaw(startPt.x, startPt.y);
        last = startPt ? { x: startPt.x, y: startPt.y } : last;
      }
    }
    return polys;
  }

  function drawPathObject(page, obj, pageH, op) {
    const stroke = toHexColor(obj.stroke) || "#111111";
    const width = Math.max(0.2, (obj.strokeWidth || 1) * avgScale(obj));
    const m = obj.calcTransformMatrix();

    /* fabric renders paths after translate(-pathOffset.x, -pathOffset.y)
       in the object's local space, so undo that before the object matrix. */
    const off = obj.pathOffset || { x: 0, y: 0 };
    const transform = (x, y) => {
      const pt = fabric.util.transformPoint(new fabric.Point(x - off.x, y - off.y), m);
      return { x: pt.x, y: pageH - pt.y };
    };

    const polys = flattenPath(obj.path || [], transform);
    for (const poly of polys) {
      for (let i = 1; i < poly.length; i++) {
        page.drawLine({
          start: poly[i - 1],
          end: poly[i],
          thickness: width,
          color: pdfColor(stroke),
          opacity: op,
          lineCap: 1,
        });
      }
    }
  }

  function drawLineObject(page, obj, pageH, op) {
    const pts = obj.calcLinePoints ? obj.calcLinePoints() : { x1: 0, y1: 0, x2: 1, y2: 1 };
    const m = obj.calcTransformMatrix();
    const p1 = fabric.util.transformPoint(new fabric.Point(pts.x1, pts.y1), m);
    const p2 = fabric.util.transformPoint(new fabric.Point(pts.x2, pts.y2), m);
    const stroke = toHexColor(obj.stroke) || "#111111";

    page.drawLine({
      start: { x: p1.x, y: pageH - p1.y },
      end: { x: p2.x, y: pageH - p2.y },
      thickness: Math.max(0.2, (obj.strokeWidth || 1) * avgScale(obj)),
      color: pdfColor(stroke),
      opacity: op,
    });
  }

  /* ======================================================================
     DEBUG HOOKS (used for automated smoke tests)
     ====================================================================== */
  window.PDFStudio = {
    state: S,
    canvas,
    setTool,
    setPage,
    addTextAt,
    loadPdf,
    buildPdf,
    getTextLines,
    hitText,
    replaceTextAt,
    removePatchForText,
    detectTables,
    tableCsv,
    extractTable,
    exportTablePng,
    exportSelectionPng,
    detectTextStyle,
    analyzeColors,
    setZoom,
    scanPageImages,
    filteredOpList,
    detachOccurrence,
    handleDetachClick,
    removeOccurrence,
    restoreOccurrence,
    restoreAllOriginals,
    syncOriginals,
    syncTables,
    objectRect,
    customFonts,
    addGoogleFont,
    undoRedo,
    /* page model / management */
    addBlankPage,
    deleteSelectedPages,
    movePage,
    rotateSelectedPages,
    applyPageRotation,
    openPagesModal,
    renderPagesGrid,
    insertPdfPages,
    insertImagePages,
    emptyPageData,
    makePdfPage,
    openPdfDocument,
    libForPage,
    pageMap,
    mapPageBox,
    mapPageBBox,
    renderPageBase,
    renderBackground,
    sizeControls,
    setupSizeControls,
    /* merge / split */
    MERGE,
    mergePdfs,
    addMergeFiles,
    clearMergeList,
    renderMergeList,
    splitAndDownload,
    parsePageRanges,
    downloadBlob,
    /* background removal */
    BG,
    openBackgroundTool,
    setBgTool,
    bgAutoSelect,
    bgApplyMask,
    bgApplyToPage,
    bgReplaceImage,
    bgDownloadPng,
    /* signature */
    SIG,
    openSignatureTool,
    setSigTab,
    sigCompose,
    insertSignature,
    saveCurrentSignature,
    loadSignatures,
    /* inserted tables */
    openTableTool,
    insertTableFromDialog,
    tablePeers,
    selectInsertedTable,
    editTableCell,
    tableCellAtPoint,
    /* layer properties */
    applyLock,
    syncLayers,
    syncProps,
    pushHistory,
  };

  /* ------------------------------ init ------------------------------ */
  el.empty.classList.remove("hidden");
  el.pageWrap.classList.add("hidden");
  ensureFontOptions();
  renderCustomFonts();
  restoreFonts().catch((err) => console.warn("Font restore failed", err));
  setTool("select");
  syncLayers();
  updatePageChrome();
  refreshUndo();
  applyViewport();
})();
