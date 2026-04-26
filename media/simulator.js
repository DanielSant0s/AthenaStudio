/**
 * AthenaStudio preview runtime (phase A): API similar to Athena2ME;
 * engine is browser JavaScript — not RockScript.
 */
(function () {
  const init = window.__ATHENA_SIM_INIT__ || {};
  /** Canonical native ids from extension `targets/j2me-api.json` (same source as Athena2ME.java). */
  const j2meApi = init.j2meApi || null;
  if (j2meApi && Array.isArray(j2meApi.natives)) {
    window.__ATHENA_J2ME_NATIVES__ = j2meApi.natives;
  }
  let W = init.width || 240;
  let H = init.height || 320;
  const fileMap = init.fileMap || {};
  const consoleOutEl = document.getElementById("console-out");
  const errorsEl = document.getElementById("errors");
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");

  /** Current draw target (main screen or offscreen layer). */
  let activeCtx = ctx;
  let activeW = W;
  let activeH = H;
  function useMainTarget() {
    activeCtx = ctx;
    activeW = W;
    activeH = H;
  }

  function applyResolution(w, h) {
    w = w | 0;
    h = h | 0;
    if (w < 1) {
      w = 1;
    }
    if (h < 1) {
      h = 1;
    }
    W = w;
    H = h;
    canvas.width = w;
    canvas.height = h;
    useMainTarget();
    const badge = document.getElementById("screen-badge");
    if (badge) {
      badge.textContent = w + " × " + h;
    }
  }

  function logErr(msg) {
    if (!errorsEl) {
      return;
    }
    errorsEl.textContent += String(msg) + "\n";
    errorsEl.scrollTop = errorsEl.scrollHeight;
  }

  function appendConsoleLine(parts) {
    if (!consoleOutEl) {
      return;
    }
    consoleOutEl.textContent += parts.join(" ") + "\n";
    consoleOutEl.scrollTop = consoleOutEl.scrollHeight;
  }

  let microtasks = [];
  function flushPromises() {
    while (microtasks.length) {
      const fn = microtasks.shift();
      try {
        fn();
      } catch (e) {
        logErr(e && e.message ? e.message : e);
      }
    }
  }

  function colorCss(argb) {
    let n = argb >>> 0;
    if (typeof argb === "object" && argb && typeof argb.value === "number") {
      n = argb.value >>> 0;
    }
    const a = (n >>> 24) / 255;
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    if (!a || a === 0) {
      return "rgb(" + r + "," + g + "," + b + ")";
    }
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  let rawKeyStates = 0;
  const keyPadBits = {
    ArrowUp: 2,
    ArrowLeft: 4,
    ArrowRight: 32,
    ArrowDown: 64,
    " ": 256,
    Enter: 256,
    z: 512,
    Z: 512,
    x: 1024,
    X: 1024,
    c: 2048,
    C: 2048,
    v: 4096,
    V: 4096,
  };

  /** Do not capture game keys while the user types in the boot editor / form inputs. */
  function isSimulatorFormTarget(target) {
    if (!target || typeof target.closest !== "function") {
      return false;
    }
    return !!target.closest(
      "textarea, input, select, button, option, label, [contenteditable='true'], .boot-visual-wrap"
    );
  }

  window.addEventListener(
    "keydown",
    function (e) {
      if (isSimulatorFormTarget(e.target)) {
        return;
      }
      const b = keyPadBits[e.key];
      if (b) {
        rawKeyStates |= b;
        e.preventDefault();
      }
    },
    true
  );
  window.addEventListener(
    "keyup",
    function (e) {
      if (isSimulatorFormTarget(e.target)) {
        return;
      }
      const b = keyPadBits[e.key];
      if (b) {
        rawKeyStates &= ~b;
        e.preventDefault();
      }
    },
    true
  );

  const Pad = {
    UP: 2,
    LEFT: 4,
    RIGHT: 32,
    DOWN: 64,
    FIRE: 256,
    GAME_A: 512,
    GAME_B: 1024,
    GAME_C: 2048,
    GAME_D: 4096,
    PRESSED: 0,
    JUST_PRESSED: 1,
    NON_PRESSED: 2,
    _curr: 0,
    _prev: 0,
    _listeners: [],
    _nextId: 1,
    update: function () {
      this._prev = this._curr;
      this._curr = rawKeyStates;
      const snap = this._listeners.slice();
      for (let i = 0; i < snap.length; i++) {
        const L = snap[i];
        if (!L) {
          continue;
        }
        let ok = false;
        if (L.kind === 0) {
          ok = (this._curr & L.mask) !== 0;
        } else if (L.kind === 1) {
          ok = (this._curr & L.mask) !== 0 && (this._prev & L.mask) === 0;
        } else if (L.kind === 2) {
          ok = (this._curr & L.mask) === 0;
        }
        if (ok) {
          try {
            L.cb();
          } catch (err) {
            logErr(err && err.message ? err.message : err);
          }
        }
      }
    },
    pressed: function (mask) {
      return (this._curr & mask) !== 0;
    },
    justPressed: function (mask) {
      return (this._curr & mask) !== 0 && (this._prev & mask) === 0;
    },
    addListener: function (mask, kind, cb) {
      if (!mask || typeof cb !== "function") {
        return -1;
      }
      const id = this._nextId++;
      this._listeners.push({ id: id, mask: mask, kind: kind | 0, cb: cb });
      return id;
    },
    clearListener: function (id) {
      this._listeners = this._listeners.filter(function (L) {
        return L.id !== id;
      });
    },
  };

  const Screen = {
    get width() {
      return W;
    },
    get height() {
      return H;
    },
    clear: function (color) {
      activeCtx.fillStyle = color != null ? colorCss(color) : "#000000";
      activeCtx.fillRect(0, 0, activeW, activeH);
    },
    update: function () {},
    beginBatch: function () {},
    flushBatch: function () {},
    endBatch: function () {},
    createLayer: function (w, h) {
      w = w | 0;
      h = h | 0;
      if (w <= 0 || h <= 0) {
        return null;
      }
      const el = document.createElement("canvas");
      el.width = w;
      el.height = h;
      const x = el.getContext("2d");
      return { width: w, height: h, _el: el, _x: x };
    },
    setLayer: function (layer) {
      if (!layer) {
        useMainTarget();
      } else if (layer._x) {
        activeCtx = layer._x;
        activeW = layer.width | 0;
        activeH = layer.height | 0;
      }
    },
    clearLayer: function (layer, color) {
      if (!layer || !layer._x) {
        return;
      }
      layer._x.fillStyle = color != null ? colorCss(color) : "#000000";
      layer._x.fillRect(0, 0, layer.width, layer.height);
    },
    drawLayer: function (layer, x, y) {
      if (!layer || !layer._el) {
        return;
      }
      ctx.drawImage(layer._el, x | 0, y | 0);
    },
    freeLayer: function (layer) {
      if (layer && activeCtx === layer._x) {
        useMainTarget();
      }
    },
  };

  const Draw = {
    line: function (x1, y1, x2, y2, color) {
      activeCtx.strokeStyle = colorCss(color);
      activeCtx.beginPath();
      activeCtx.moveTo(x1, y1);
      activeCtx.lineTo(x2, y2);
      activeCtx.stroke();
    },
    rect: function (x, y, w, h, color) {
      activeCtx.fillStyle = colorCss(color);
      activeCtx.fillRect(x, y, w, h);
    },
    triangle: function (x1, y1, x2, y2, x3, y3, color) {
      activeCtx.fillStyle = colorCss(color);
      activeCtx.beginPath();
      activeCtx.moveTo(x1, y1);
      activeCtx.lineTo(x2, y2);
      activeCtx.lineTo(x3, y3);
      activeCtx.closePath();
      activeCtx.fill();
    },
    /**
     * Batched rectangles in interleaved Int32Array (Athena2ME-compatible).
     * @param packed Int32Array with stride ints per rect (default 5: x,y,w,h,color)
     * @param count number of rectangles to draw
     * @param stride step between rects (default 5)
     * @param xOff,yOff,wOff,hOff,colOff field indices within each block (default 0..4)
     */
    rects: function (packed, count, stride, xOff, yOff, wOff, hOff, colOff) {
      if (!packed || typeof packed.length !== "number") {
        return;
      }
      const s = stride !== undefined && stride > 0 ? stride | 0 : 5;
      const xi = xOff !== undefined ? xOff | 0 : 0;
      const yi = yOff !== undefined ? yOff | 0 : 1;
      const wi = wOff !== undefined ? wOff | 0 : 2;
      const hi = hOff !== undefined ? hOff | 0 : 3;
      const ci = colOff !== undefined ? colOff | 0 : 4;
      const max = count | 0;
      let i;
      for (i = 0; i < max; i++) {
        const b = i * s;
        if (b + ci >= packed.length) {
          break;
        }
        const x = packed[b + xi];
        const y = packed[b + yi];
        const rw = packed[b + wi];
        const rh = packed[b + hi];
        const c = packed[b + ci];
        activeCtx.fillStyle = colorCss(c);
        activeCtx.fillRect(x, y, rw, rh);
      }
    },
  };

  const Color = {
    new: function (r, g, b, a) {
      const A = a === undefined ? 255 : a;
      return ((A & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
    },
  };

  function normalizePath(p) {
    if (!p || typeof p !== "string") {
      return "/";
    }
    let s = p.replace(/\\/g, "/").trim();
    if (!s.length) {
      return "/";
    }
    if (s.charAt(0) !== "/") {
      s = "/" + s;
    }
    return s;
  }

  const imgBitmapCache = {};

  function getImageDataUrl(jarPath) {
    const key = normalizePath(jarPath);
    const raw = fileMap[key];
    if (!raw) {
      return null;
    }
    if (fileMap[key + ":encoding"] === "base64") {
      const ext = key.split(".").pop().toLowerCase();
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : "image/png";
      return "data:" + mime + ";base64," + raw;
    }
    return null;
  }

  /** Boot splash: macros / coords like BootSplashCanvas.java */
  const splashImageCache = Object.create(null);

  function replaceLiteral(s, from, to) {
    if (s == null || !from || from.length === 0) {
      return s;
    }
    if (to == null) {
      to = "";
    }
    const fl = from.length;
    const sl = s.length;
    let i = 0;
    let out = "";
    while (i < sl) {
      if (i <= sl - fl && s.substring(i, i + fl) === from) {
        out += to;
        i += fl;
      } else {
        out += s.charAt(i);
        i++;
      }
    }
    return out;
  }

  function expandScreenMacros(s, w, h) {
    if (s == null) {
      return "";
    }
    const w2 = (w / 2) | 0;
    const h2 = (h / 2) | 0;
    let r = String(s);
    r = replaceLiteral(r, "%W2%", String(w2));
    r = replaceLiteral(r, "%H2%", String(h2));
    r = replaceLiteral(r, "%W%", String(w));
    r = replaceLiteral(r, "%H%", String(h));
    return r;
  }

  function removeIniWhitespace(s) {
    if (s == null) {
      return s;
    }
    let b = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        continue;
      }
      b += c;
    }
    return b;
  }

  function readSignedIntValue(t, start, n, outEnd) {
    if (start > n) {
      outEnd[0] = -1;
      return 0;
    }
    let i = start;
    if (i < n) {
      const c0 = t.charAt(i);
      if (c0 === "+") {
        i++;
      } else if (c0 === "-") {
        i++;
      }
    }
    if (i >= n) {
      outEnd[0] = -1;
      return 0;
    }
    let v = 0;
    let any = false;
    while (i < n) {
      const c = t.charAt(i);
      if (c < "0" || c > "9") {
        break;
      }
      any = true;
      v = v * 10 + (c.charCodeAt(0) - 48);
      i++;
    }
    if (!any) {
      outEnd[0] = -1;
      return 0;
    }
    outEnd[0] = i;
    const neg = start < n && t.charAt(start) === "-";
    return neg ? -v : v;
  }

  function evalIntExpression(s, fallback) {
    if (s == null) {
      return fallback;
    }
    const t = removeIniWhitespace(s);
    if (t.length === 0) {
      return fallback;
    }
    const n = t.length;
    const end = [0];
    let acc = readSignedIntValue(t, 0, n, end);
    if (end[0] < 0) {
      return fallback;
    }
    let i = end[0];
    if (i >= n) {
      return acc;
    }
    while (i < n) {
      const op = t.charAt(i);
      if (op !== "+" && op !== "-") {
        return fallback;
      }
      i++;
      const v = readSignedIntValue(t, i, n, end);
      if (end[0] < 0) {
        return fallback;
      }
      if (op === "+") {
        acc += v;
      } else {
        acc -= v;
      }
      i = end[0];
    }
    return acc;
  }

  function resolveSplashCoord(spec, fallback, w, h) {
    if (spec == null || spec.length === 0) {
      return fallback;
    }
    const e = expandScreenMacros(spec.trim(), w, h);
    return evalIntExpression(e, fallback);
  }

  function splashFontPx(fontSize) {
    if (fontSize === 8) {
      return 11;
    }
    if (fontSize === 16) {
      return 18;
    }
    return 14;
  }

  function drawSplashFrame(bootCfg, slideIndex) {
    const w = W;
    const h = H;
    if (w <= 0 || h <= 0) {
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!bootCfg.slides || !bootCfg.slides.length) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const sl = bootCfg.slides[slideIndex];
    if (!sl) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
      return;
    }
    ctx.fillStyle = colorCss(0xff000000 | (sl.backgroundRgb & 0xffffff));
    ctx.fillRect(0, 0, w, h);
    if (sl.imageItems) {
      for (let ii = 0; ii < sl.imageItems.length; ii++) {
        const im = sl.imageItems[ii];
        if (!im || !im.path || !im.path.length) {
          continue;
        }
        const p = normalizePath(im.path);
        const img = splashImageCache[p];
        if (!img || !img.complete || img.naturalWidth === 0) {
          continue;
        }
        const ix = resolveSplashCoord(im.xSpec, im.x, w, h);
        const iy = resolveSplashCoord(im.ySpec, im.y, w, h);
        ctx.drawImage(img, ix, iy);
      }
    }
    if (sl.textItems) {
      for (let ti = 0; ti < sl.textItems.length; ti++) {
        const tx = sl.textItems[ti];
        if (!tx || !tx.text || !tx.text.length) {
          continue;
        }
        const fpx = splashFontPx(tx.fontSize);
        ctx.font = fpx + "px sans-serif";
        ctx.fillStyle = colorCss(0xff000000 | (tx.colorRgb & 0xffffff));
        const tdraw = expandScreenMacros(tx.text, w, h);
        const px = resolveSplashCoord(tx.xSpec, tx.x, w, h);
        const py = resolveSplashCoord(tx.ySpec, tx.y, w, h);
        if (tx.align === 1) {
          ctx.textAlign = "center";
        } else if (tx.align === 2) {
          ctx.textAlign = "right";
        } else {
          ctx.textAlign = "left";
        }
        ctx.textBaseline = "top";
        ctx.fillText(tdraw, px, py);
      }
    }
  }

  function preloadBootSplashImages(bootCfg, done) {
    for (const k in splashImageCache) {
      if (Object.prototype.hasOwnProperty.call(splashImageCache, k)) {
        delete splashImageCache[k];
      }
    }
    const paths = [];
    const seen = Object.create(null);
    if (bootCfg.slides) {
      for (let si = 0; si < bootCfg.slides.length; si++) {
        const slide = bootCfg.slides[si];
        if (!slide.imageItems) {
          continue;
        }
        for (let ii = 0; ii < slide.imageItems.length; ii++) {
          const im = slide.imageItems[ii];
          if (!im || !im.path || !im.path.length) {
            continue;
          }
          const p = normalizePath(im.path);
          if (!seen[p]) {
            seen[p] = true;
            paths.push(p);
          }
        }
      }
    }
    if (paths.length === 0) {
      done();
      return;
    }
    let left = paths.length;
    for (let i = 0; i < paths.length; i++) {
      const jarPath = paths[i];
      const url = getImageDataUrl(jarPath);
      if (!url) {
        left--;
        if (left <= 0) {
          done();
        }
        continue;
      }
      const img = new window.Image();
      img.onload = function () {
        splashImageCache[jarPath] = img;
        left--;
        if (left <= 0) {
          done();
        }
      };
      img.onerror = function () {
        left--;
        if (left <= 0) {
          done();
        }
      };
      img.src = url;
    }
  }

  function ImageCtor(path) {
    const self = this;
    self.path = normalizePath(path);
    self.startx = 0;
    self.starty = 0;
    self.endx = 0;
    self.endy = 0;
    self.width = 0;
    self.height = 0;
    self._bm = null;
    const url = getImageDataUrl(self.path);
    if (url && window.createImageBitmap) {
      fetch(url)
        .then(function (r) {
          return r.blob();
        })
        .then(function (blob) {
          return createImageBitmap(blob);
        })
        .then(function (bm) {
          self._bm = bm;
          self.width = bm.width;
          self.height = bm.height;
          self.endx = bm.width;
          self.endy = bm.height;
          imgBitmapCache[self.path] = bm;
        })
        .catch(function () {});
    } else if (url) {
      const im = new window.Image();
      im.onload = function () {
        self._bm = im;
        self.width = im.width;
        self.height = im.height;
        self.endx = im.width;
        self.endy = im.height;
      };
      im.src = url;
    }
  }
  ImageCtor.prototype.draw = function (x, y) {
    const bm = this._bm;
    if (!bm) {
      return;
    }
    const sx = this.startx | 0;
    const sy = this.starty | 0;
    const sw = (this.endx || bm.width) - sx;
    const sh = (this.endy || bm.height) - sy;
    activeCtx.drawImage(bm, sx, sy, sw, sh, x, y, sw, sh);
  };
  ImageCtor.prototype.free = function () {
    this._bm = null;
  };

  function FontCtor(a, b, c) {
    this.color = 0x00ffffff;
    this.align = 0;
    this._size = 14;
    if (typeof a === "string" && a === "default") {
      this._face = "10px monospace";
    } else {
      this._face = "14px sans-serif";
    }
  }
  FontCtor.FACE_MONOSPACE = 0;
  FontCtor.FACE_PROPORTIONAL = 1;
  FontCtor.FACE_SYSTEM = 2;
  FontCtor.STYLE_PLAIN = 0;
  FontCtor.STYLE_BOLD = 1;
  FontCtor.STYLE_ITALIC = 2;
  FontCtor.STYLE_UNDERLINED = 4;
  FontCtor.SIZE_SMALL = 8;
  FontCtor.SIZE_MEDIUM = 0;
  FontCtor.SIZE_LARGE = 16;
  FontCtor.ALIGN_TOP = 16;
  FontCtor.ALIGN_BOTTOM = 32;
  FontCtor.ALIGN_VCENTER = 64;
  FontCtor.ALIGN_LEFT = 4;
  FontCtor.ALIGN_RIGHT = 8;
  FontCtor.ALIGN_HCENTER = 1;
  FontCtor.ALIGN_NONE = 20;
  FontCtor.ALIGN_CENTER = 65;
  FontCtor.prototype.print = function (text, x, y) {
    activeCtx.font = this._face;
    activeCtx.fillStyle = colorCss(this.color);
    activeCtx.textBaseline = "top";
    activeCtx.fillText(String(text), x, y);
  };
  FontCtor.prototype.getTextSize = function (text) {
    activeCtx.font = this._face;
    const m = activeCtx.measureText(String(text));
    return { width: m.width | 0, height: 14 };
  };
  FontCtor.prototype.free = function () {};

  const FontAlign = {
    TOP: 16,
    BOTTOM: 32,
    VCENTER: 64,
    LEFT: 4,
    RIGHT: 8,
    HCENTER: 1,
    NONE: 20,
    CENTER: 65,
  };

  const Keyboard = {
    _last: 0,
    get: function () {
      return this._last;
    },
    KEY_NUM0: 48,
    KEY_NUM1: 49,
    KEY_NUM2: 50,
    KEY_NUM3: 51,
    KEY_NUM4: 52,
    KEY_NUM5: 53,
    KEY_NUM6: 54,
    KEY_NUM7: 55,
    KEY_NUM8: 56,
    KEY_NUM9: 57,
    KEY_STAR: 42,
    KEY_POUND: 35,
  };

  window.addEventListener(
    "keydown",
    function (e) {
      if (isSimulatorFormTarget(e.target)) {
        return;
      }
      if (e.key.length === 1) {
        Keyboard._last = e.key.charCodeAt(0);
      }
    },
    true
  );

  const moduleCache = {};
  function requireFn(p) {
    const path = normalizePath(p);
    if (moduleCache[path]) {
      return moduleCache[path];
    }
    let src = fileMap[path];
    if (src == null || fileMap[path + ":encoding"] === "base64") {
      return undefined;
    }
    const exports = {};
    const module = { exports: exports };
    try {
      const factory = new Function("exports", "module", "require", src);
      factory(exports, module, requireFn);
    } catch (e) {
      logErr("require " + path + ": " + e.message);
      return undefined;
    }
    const ex = module.exports !== undefined ? module.exports : exports;
    moduleCache[path] = ex;
    return ex;
  }

  function loadScript(p) {
    const path = normalizePath(p);
    const src = fileMap[path];
    if (src == null || fileMap[path + ":encoding"] === "base64") {
      return;
    }
    try {
      (0, eval)(src);
    } catch (e) {
      logErr("loadScript " + path + ": " + e.message);
    }
  }

  const console = {
    log: function () {
      const parts = Array.prototype.slice.call(arguments);
      appendConsoleLine(parts);
    },
  };

  let frameLoopId = null;
  let frameRunning = false;
  const os = {
    platform: "j2me",
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_NDELAY: 4,
    O_APPEND: 8,
    O_CREAT: 512,
    O_TRUNC: 1024,
    O_EXCL: 2048,
    SEEK_SET: 0,
    SEEK_CUR: 1,
    SEEK_END: 2,
    setExitHandler: function () {},
    open: function () {
      return -1;
    },
    close: function () {},
    seek: function () {
      return -1;
    },
    read: function () {
      return new Uint8Array(0);
    },
    write: function () {
      return -1;
    },
    fstat: function () {
      return { error: "stub" };
    },
    sleep: function () {
      flushPromises();
    },
    flushPromises: flushPromises,
    startFrameLoop: function (fn, fps) {
      if (frameLoopId != null) {
        cancelAnimationFrame(frameLoopId);
      }
      frameRunning = true;
      const frameMs = fps > 0 ? 1000 / fps : 16;
      /* Run first frame immediately (do not wait a full interval). */
      let last = performance.now() - frameMs;
      function tick(now) {
        if (!frameRunning) {
          return;
        }
        if (fps > 0 && now - last < frameMs) {
          frameLoopId = requestAnimationFrame(tick);
          return;
        }
        last = now;
        Pad.update();
        flushPromises();
        try {
          fn();
        } catch (e) {
          logErr(e.message || e);
          frameRunning = false;
          return;
        }
        flushPromises();
        frameLoopId = requestAnimationFrame(tick);
      }
      frameLoopId = requestAnimationFrame(tick);
    },
    stopFrameLoop: function () {
      frameRunning = false;
      if (frameLoopId != null) {
        cancelAnimationFrame(frameLoopId);
        frameLoopId = null;
      }
    },
    getSystemInfo: function () {
      return {
        "microedition.platform": "AthenaStudio-sim",
        "microedition.configuration": "CLDC-1.1",
        "microedition.profiles": "MIDP-2.0",
      };
    },
    getMemoryStats: function () {
      return { heapTotal: 0, heapFree: 0, heapUsed: 0 };
    },
    getStorageStats: function () {
      return { error: "stub" };
    },
    getProperty: function () {
      return null;
    },
    bluetoothGetCapabilities: function () {
      return { jsr82: 0, available: 0, error: "stub" };
    },
    bluetoothInquiry: function () {
      return Promise.reject(new Error("stub"));
    },
    currentTimeMillis: function () {
      return Date.now();
    },
    uptimeMillis: function () {
      return Date.now();
    },
    gc: function () {},
    threadYield: function () {},
    spawn: function (fn) {
      return Promise.resolve().then(function () {
        return fn();
      });
    },
    Thread: {
      start: function (fn) {
        return os.spawn(fn);
      },
    },
    Mutex: function () {},
    Semaphore: function () {},
    AtomicInt: function () {},
    pool: function () {
      return null;
    },
  };

  function RequestCtor() {
    this.responseCode = 0;
    this.error = "";
    this.contentLength = 0;
    this.keepalive = 0;
    this.useragent = "";
    this.userpwd = "";
    this.headers = [];
  }
  RequestCtor.prototype.get = function (url) {
    const self = this;
    return fetch(url)
      .then(function (r) {
        self.responseCode = r.status;
        return r.arrayBuffer();
      })
      .then(function (buf) {
        self.contentLength = buf.byteLength;
        return {
          responseCode: self.responseCode,
          error: self.error,
          contentLength: self.contentLength,
          body: new Uint8Array(buf),
        };
      })
      .catch(function (e) {
        throw { message: e.message || String(e) };
      });
  };
  RequestCtor.prototype.post = function () {
    return Promise.reject(new Error("stub"));
  };
  RequestCtor.prototype.download = function () {
    return Promise.reject(new Error("stub"));
  };

  function SocketCtor() {}
  function WebSocketCtor() {
    this.error = "stub";
  }
  function BTSocketCtor() {}
  function TimerCtor() {
    this._t0 = Date.now();
    this._paused = false;
  }
  TimerCtor.prototype.get = function () {
    return Date.now() - this._t0;
  };
  TimerCtor.prototype.set = function (v) {
    this._t0 = Date.now() - v;
  };
  TimerCtor.prototype.pause = function () {};
  TimerCtor.prototype.resume = function () {};
  TimerCtor.prototype.reset = function () {
    this._t0 = Date.now();
  };
  TimerCtor.prototype.playing = function () {
    return 1;
  };
  TimerCtor.prototype.free = function () {};

  const Sound = {
    setVolume: function () {},
    findChannel: function () {
      return undefined;
    },
    Stream: function () {
      return { play: function () {}, pause: function () {}, free: function () {}, playing: function () { return 0; }, rewind: function () {} };
    },
    Sfx: function () {
      return { play: function () {}, free: function () {}, playing: function () { return 0; } };
    },
  };

  let running = false;
  let bootTimer = null;
  let bootHandoffScheduled = false;
  let bootSplashState = null;
  let activeBootCfg = null;
  /** When true, boot sequence ends on canvas only (no main.js). */
  let suppressBootHandoffToMain = false;

  function getBootIniText() {
    return init.bootIni || "";
  }

  function parseBootConfig() {
    const p = window.__ATHENA_BOOT_INI__ && window.__ATHENA_BOOT_INI__.parse;
    if (typeof p !== "function") {
      return { tickMs: 50, handoffPolicy: 1, es6: true, slides: [] };
    }
    return p(getBootIniText());
  }

  function scheduleBootHandoff() {
    if (suppressBootHandoffToMain) {
      const idx = bootSplashState ? bootSplashState.slideIndex : 0;
      const cfgSnap = activeBootCfg;
      if (bootTimer != null) {
        clearInterval(bootTimer);
        bootTimer = null;
      }
      bootSplashState = null;
      activeBootCfg = null;
      bootHandoffScheduled = false;
      suppressBootHandoffToMain = false;
      if (cfgSnap && cfgSnap.slides && cfgSnap.slides.length) {
        const i = Math.max(0, Math.min(idx, cfgSnap.slides.length - 1));
        drawSplashFrame(cfgSnap, i);
      }
      return;
    }
    if (bootHandoffScheduled) {
      return;
    }
    bootHandoffScheduled = true;
    if (bootTimer != null) {
      clearInterval(bootTimer);
      bootTimer = null;
    }
    bootSplashState = null;
    activeBootCfg = null;
    runMain();
  }

  function splashTick() {
    if (!bootSplashState || !activeBootCfg) {
      return;
    }
    const cfg = activeBootCfg;
    const st = bootSplashState;
    const now = Date.now();

    if (!cfg.slides || cfg.slides.length === 0) {
      if (st.coldStartReady) {
        scheduleBootHandoff();
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }

    if (st.slideIndex < 0 || st.slideIndex >= cfg.slides.length) {
      st.slideIndex = 0;
    }

    if (st.sequenceDone) {
      if (st.coldStartReady) {
        scheduleBootHandoff();
      } else {
        drawSplashFrame(cfg, st.slideIndex);
      }
      return;
    }

    if (st.slideStartMs < 0) {
      st.slideStartMs = now;
    }

    const sl = cfg.slides[st.slideIndex];
    const elapsed = now - st.slideStartMs;
    if (elapsed < sl.holdMs) {
      drawSplashFrame(cfg, st.slideIndex);
      return;
    }

    if (st.coldStartReady) {
      scheduleBootHandoff();
      return;
    }

    if (st.slideIndex < cfg.slides.length - 1) {
      st.slideIndex++;
      st.slideStartMs = now;
      drawSplashFrame(cfg, st.slideIndex);
    } else {
      st.sequenceDone = true;
      drawSplashFrame(cfg, st.slideIndex);
    }
  }

  function startBootSequence(bootCfg) {
    activeBootCfg = bootCfg;
    bootHandoffScheduled = false;
    bootSplashState = {
      slideIndex: 0,
      slideStartMs: -1,
      sequenceDone: false,
      coldStartReady: false,
    };
    const period = bootCfg.tickMs > 0 ? bootCfg.tickMs : 50;
    if (bootTimer != null) {
      clearInterval(bootTimer);
    }
    bootTimer = setInterval(splashTick, period);
    splashTick();
    setTimeout(function () {
      if (bootSplashState) {
        bootSplashState.coldStartReady = true;
      }
      if (bootCfg.handoffPolicy === 0) {
        scheduleBootHandoff();
      } else {
        splashTick();
      }
    }, 0);
  }

  function runMain() {
    useMainTarget();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    Screen.clear(0xff000000);

    const code = (init.mainJs || "").trim();
    if (!code) {
      logErr(
        "main.js is empty in the simulator. Reload the panel (close and Open Simulator) or ensure res/main.js exists in the workspace."
      );
      running = false;
      return;
    }

    const globals = {
      Screen: Screen,
      Draw: Draw,
      Pad: Pad,
      Keyboard: Keyboard,
      Color: Color,
      Font: FontCtor,
      FontAlign: FontAlign,
      Image: ImageCtor,
      console: console,
      require: requireFn,
      loadScript: loadScript,
      os: os,
      Request: RequestCtor,
      Socket: SocketCtor,
      WebSocket: WebSocketCtor,
      BTSocket: BTSocketCtor,
      Timer: TimerCtor,
      Sound: Sound,
    };

    try {
      const keys = Object.keys(globals);
      const vals = keys.map(function (k) {
        return globals[k];
      });
      const decl = keys
        .map(function (k, i) {
          return "var " + k + " = __a[" + i + "];";
        })
        .join("\n");
      new Function("__a", decl + "\n" + code)(vals);
    } catch (e) {
      logErr(e.message || e);
    }
    running = true;
  }

  function run() {
    suppressBootHandoffToMain = false;
    if (bootTimer != null) {
      clearInterval(bootTimer);
      bootTimer = null;
    }
    bootHandoffScheduled = false;
    bootSplashState = null;
    activeBootCfg = null;

    if (consoleOutEl) {
      consoleOutEl.textContent = "";
    }
    if (errorsEl) {
      errorsEl.textContent = "";
    }
    rawKeyStates = 0;
    Pad._curr = Pad._prev = 0;
    Pad._listeners = [];
    for (const k in moduleCache) {
      delete moduleCache[k];
    }
    os.stopFrameLoop();
    frameRunning = false;
    running = false;

    const code = (init.mainJs || "").trim();
    if (!code) {
      useMainTarget();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      Screen.clear(0xff000000);
      logErr(
        "main.js is empty in the simulator. Reload the panel (close and Open Simulator) or ensure res/main.js exists in the workspace."
      );
      return;
    }

    const bootCfg = parseBootConfig();

    preloadBootSplashImages(bootCfg, function () {
      startBootSequence(bootCfg);
    });
  }

  document.getElementById("run").onclick = function () {
    const api = window.__ATHENA_VSCODE_API__;
    if (api && typeof api.postMessage === "function") {
      api.postMessage({ type: "simulatorReload" });
    } else {
      run();
    }
  };

  const resSel = document.getElementById("resolution-select");
  if (resSel) {
    resSel.addEventListener("change", function () {
      const opt = resSel.options[resSel.selectedIndex];
      const nw = parseInt(opt.getAttribute("data-w") || String(W), 10);
      const nh = parseInt(opt.getAttribute("data-h") || String(H), 10);
      applyResolution(nw, nh);
      run();
    });
  }

  function stopGameForBootEditing() {
    os.stopFrameLoop();
    frameRunning = false;
    running = false;
    if (bootTimer != null) {
      clearInterval(bootTimer);
      bootTimer = null;
    }
    bootSplashState = null;
    activeBootCfg = null;
    bootHandoffScheduled = false;
    suppressBootHandoffToMain = false;
  }

  function applyBootLivePreview(slideIndex) {
    if (slideIndex == null || slideIndex < 0) {
      slideIndex = 0;
    }
    stopGameForBootEditing();
    const cfg = parseBootConfig();
    const n = cfg.slides && cfg.slides.length ? cfg.slides.length : 0;
    const idx = n > 0 ? Math.min(slideIndex, n - 1) : 0;
    preloadBootSplashImages(cfg, function () {
      drawSplashFrame(cfg, idx);
    });
  }

  const BI = window.__ATHENA_BOOT_INI__;
  let bootVisualModel = null;
  let bootVisualSlideIdx = 0;
  let bootVisualCommitTimer = null;
  let bootVisualLastSent = "";

  function hexFromRgb(rgb) {
    let n = (rgb != null ? rgb : 0) & 0xffffff;
    let x = n.toString(16);
    while (x.length < 6) {
      x = "0" + x;
    }
    return "#" + x;
  }

  function newDefaultTextItem() {
    return {
      text: "",
      x: 0,
      y: 0,
      xSpec: null,
      ySpec: null,
      fontSize: 0,
      colorRgb: 0xffffff,
      align: 1,
    };
  }

  function newDefaultImageItem() {
    return { path: "", x: 0, y: 0, xSpec: null, ySpec: null };
  }

  function newDefaultSlide() {
    return {
      backgroundRgb: 0x202020,
      holdMs: 1000,
      textItems: [newDefaultTextItem()],
      imageItems: [newDefaultImageItem()],
    };
  }

  function coordFieldValue(spec, num) {
    if (spec != null && String(spec).length > 0) {
      return String(spec);
    }
    return String(num != null ? num : 0);
  }

  function normBootIniText(s) {
    return String(s || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  function scheduleBootVisualCommit() {
    if (bootVisualCommitTimer != null) {
      clearTimeout(bootVisualCommitTimer);
    }
    bootVisualCommitTimer = setTimeout(function () {
      bootVisualCommitTimer = null;
      if (!bootVisualModel || typeof BI.serialize !== "function") {
        return;
      }
      const text = BI.serialize(bootVisualModel);
      init.bootIni = text;
      bootVisualLastSent = text;
      applyBootLivePreview(bootVisualSlideIdx);
      vscodePost({ type: "saveBootIni", text: text });
    }, 140);
  }

  function renderBootVisualEditor() {
    const root = document.getElementById("boot-visual-root");
    if (!root || !bootVisualModel) {
      return;
    }
    root.innerHTML = "";
    const slides = bootVisualModel.slides || [];
    if (slides.length === 0) {
      return;
    }
    const si = Math.max(0, Math.min(bootVisualSlideIdx, slides.length - 1));
    bootVisualSlideIdx = si;
    const sl = slides[si];

    const g = document.createElement("div");
    g.className = "boot-visual-global";

    const tickLbl = document.createElement("label");
    tickLbl.textContent = "Tick ms";
    const tickInp = document.createElement("input");
    tickInp.type = "number";
    tickInp.min = "10";
    tickInp.max = "500";
    tickInp.value = String(bootVisualModel.tickMs > 0 ? bootVisualModel.tickMs : 50);
    tickInp.oninput = function () {
      bootVisualModel.tickMs = parseInt(tickInp.value, 10) || 50;
      scheduleBootVisualCommit();
    };
    tickLbl.appendChild(tickInp);
    g.appendChild(tickLbl);

    const handLbl = document.createElement("label");
    handLbl.textContent = "Handoff";
    const handSel = document.createElement("select");
    const ho1 = document.createElement("option");
    ho1.value = "after";
    ho1.textContent = "after_slide";
    const ho2 = document.createElement("option");
    ho2.value = "immediate";
    ho2.textContent = "immediate";
    handSel.appendChild(ho1);
    handSel.appendChild(ho2);
    handSel.value =
      bootVisualModel.handoffPolicy === BI.HANDOFF_IMMEDIATE ? "immediate" : "after";
    handSel.onchange = function () {
      bootVisualModel.handoffPolicy =
        handSel.value === "immediate" ? BI.HANDOFF_IMMEDIATE : BI.HANDOFF_AFTER_SLIDE;
      scheduleBootVisualCommit();
    };
    handLbl.appendChild(handSel);
    g.appendChild(handLbl);

    const es6Lbl = document.createElement("label");
    const es6cb = document.createElement("input");
    es6cb.type = "checkbox";
    es6cb.checked = bootVisualModel.es6 !== false;
    es6cb.onchange = function () {
      bootVisualModel.es6 = es6cb.checked;
      scheduleBootVisualCommit();
    };
    es6Lbl.appendChild(es6cb);
    es6Lbl.appendChild(document.createTextNode(" ES6 preprocess"));
    g.appendChild(es6Lbl);

    root.appendChild(g);

    const splashTabs = document.createElement("div");
    splashTabs.className = "boot-splash-tabs";
    for (let s = 0; s < slides.length; s++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "boot-splash-tab" + (s === si ? " active" : "");
      b.textContent = "Splash " + (s + 1);
      (function (idx) {
        b.onclick = function () {
          bootVisualSlideIdx = idx;
          vscodePost({ type: "bootSplashIdx", idx: idx });
          renderBootVisualEditor();
          applyBootLivePreview(bootVisualSlideIdx);
        };
      })(s);
      splashTabs.appendChild(b);
    }
    const addSp = document.createElement("button");
    addSp.type = "button";
    addSp.className = "boot-splash-tab boot-splash-add";
    addSp.textContent = "+ Splash";
    addSp.onclick = function () {
      bootVisualModel.slides.push(newDefaultSlide());
      bootVisualSlideIdx = bootVisualModel.slides.length - 1;
      vscodePost({ type: "bootSplashIdx", idx: bootVisualSlideIdx });
      scheduleBootVisualCommit();
      renderBootVisualEditor();
    };
    splashTabs.appendChild(addSp);
    if (slides.length > 1) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "boot-splash-tab boot-mini-btn danger";
      rm.textContent = "Remover splash";
      rm.onclick = function () {
        bootVisualModel.slides.splice(si, 1);
        if (bootVisualSlideIdx >= bootVisualModel.slides.length) {
          bootVisualSlideIdx = bootVisualModel.slides.length - 1;
        }
        vscodePost({ type: "bootSplashIdx", idx: bootVisualSlideIdx });
        scheduleBootVisualCommit();
        renderBootVisualEditor();
      };
      splashTabs.appendChild(rm);
    }
    root.appendChild(splashTabs);

    const form = document.createElement("div");
    form.className = "boot-slide-form";

    const grpBg = document.createElement("div");
    grpBg.className = "boot-field-group";
    const hBg = document.createElement("h4");
    hBg.textContent = "Slide";
    grpBg.appendChild(hBg);
    const rowBg = document.createElement("div");
    rowBg.className = "boot-field-row";
    const lbBg = document.createElement("label");
    lbBg.textContent = "Fundo";
    const colInp = document.createElement("input");
    colInp.type = "color";
    const hx = hexFromRgb(sl.backgroundRgb);
    colInp.value = hx.length === 7 ? hx : "#202020";
    colInp.oninput = function () {
      const v = colInp.value;
      if (v.length >= 7) {
        sl.backgroundRgb = parseInt(v.slice(1, 7), 16);
        scheduleBootVisualCommit();
      }
    };
    rowBg.appendChild(lbBg);
    rowBg.appendChild(colInp);
    const lbHold = document.createElement("label");
    lbHold.textContent = "holdMs";
    const holdInp = document.createElement("input");
    holdInp.type = "number";
    holdInp.min = "0";
    holdInp.value = String(sl.holdMs != null ? sl.holdMs : 800);
    holdInp.style.maxWidth = "90px";
    holdInp.oninput = function () {
      sl.holdMs = Math.max(0, parseInt(holdInp.value, 10) || 0);
      scheduleBootVisualCommit();
    };
    rowBg.appendChild(lbHold);
    rowBg.appendChild(holdInp);
    grpBg.appendChild(rowBg);
    form.appendChild(grpBg);

    const grpTx = document.createElement("div");
    grpTx.className = "boot-field-group";
    const hTx = document.createElement("h4");
    hTx.textContent = "Textos";
    grpTx.appendChild(hTx);
    if (!sl.textItems) {
      sl.textItems = [];
    }
    for (let ti = 0; ti < sl.textItems.length; ti++) {
      const t = sl.textItems[ti];
      if (!t) {
        continue;
      }
      const card = document.createElement("div");
      card.className = "boot-text-card";
      const ta = document.createElement("textarea");
      ta.placeholder = "Texto (macros %W%, %H2%, …)";
      ta.value = t.text != null ? t.text : "";
      ta.oninput = function () {
        t.text = ta.value;
        scheduleBootVisualCommit();
      };
      card.appendChild(ta);
      const r1 = document.createElement("div");
      r1.className = "boot-field-row";
      const lx = document.createElement("label");
      lx.textContent = "X";
      const ix = document.createElement("input");
      ix.type = "text";
      ix.value = coordFieldValue(t.xSpec, t.x);
      ix.oninput = function () {
        const raw = ix.value;
        t.xSpec = raw.length ? raw : null;
        const n = parseInt(raw, 10);
        t.x = isNaN(n) ? 0 : n;
        scheduleBootVisualCommit();
      };
      const ly = document.createElement("label");
      ly.textContent = "Y";
      const iy = document.createElement("input");
      iy.type = "text";
      iy.value = coordFieldValue(t.ySpec, t.y);
      iy.oninput = function () {
        const raw = iy.value;
        t.ySpec = raw.length ? raw : null;
        const n = parseInt(raw, 10);
        t.y = isNaN(n) ? 0 : n;
        scheduleBootVisualCommit();
      };
      r1.appendChild(lx);
      r1.appendChild(ix);
      r1.appendChild(ly);
      r1.appendChild(iy);
      card.appendChild(r1);
      const r2 = document.createElement("div");
      r2.className = "boot-field-row";
      const lsz = document.createElement("label");
      lsz.textContent = "Tam.";
      const sz = document.createElement("select");
      [["SMALL", 8], ["MEDIUM", 0], ["LARGE", 16]].forEach(function (opt) {
        const o = document.createElement("option");
        o.value = String(opt[1]);
        o.textContent = opt[0];
        sz.appendChild(o);
      });
      sz.value = String(t.fontSize === 8 ? 8 : t.fontSize === 16 ? 16 : 0);
      sz.onchange = function () {
        t.fontSize = parseInt(sz.value, 10);
        scheduleBootVisualCommit();
      };
      const lcl = document.createElement("label");
      lcl.textContent = "Cor";
      const ccol = document.createElement("input");
      ccol.type = "color";
      ccol.value = hexFromRgb(t.colorRgb);
      ccol.oninput = function () {
        if (ccol.value.length >= 7) {
          t.colorRgb = parseInt(ccol.value.slice(1, 7), 16);
          scheduleBootVisualCommit();
        }
      };
      const lal = document.createElement("label");
      lal.textContent = "Alinhar";
      const al = document.createElement("select");
      [
        ["left", 0],
        ["center", 1],
        ["right", 2],
      ].forEach(function (opt) {
        const o = document.createElement("option");
        o.value = String(opt[1]);
        o.textContent = opt[0];
        al.appendChild(o);
      });
      al.value = String(t.align != null ? t.align : 0);
      al.onchange = function () {
        t.align = parseInt(al.value, 10);
        scheduleBootVisualCommit();
      };
      r2.appendChild(lsz);
      r2.appendChild(sz);
      r2.appendChild(lcl);
      r2.appendChild(ccol);
      r2.appendChild(lal);
      r2.appendChild(al);
      card.appendChild(r2);
      const r3 = document.createElement("div");
      r3.className = "boot-field-row";
      const rmBt = document.createElement("button");
      rmBt.type = "button";
      rmBt.className = "boot-mini-btn danger";
      rmBt.textContent = "Remover texto";
      (function (idx) {
        rmBt.onclick = function () {
          sl.textItems.splice(idx, 1);
          if (sl.textItems.length === 0) {
            sl.textItems.push(newDefaultTextItem());
          }
          scheduleBootVisualCommit();
          renderBootVisualEditor();
        };
      })(ti);
      r3.appendChild(rmBt);
      card.appendChild(r3);
      grpTx.appendChild(card);
    }
    const addTx = document.createElement("button");
    addTx.type = "button";
    addTx.className = "boot-mini-btn";
    addTx.textContent = "+ Texto";
    addTx.onclick = function () {
      sl.textItems.push(newDefaultTextItem());
      scheduleBootVisualCommit();
      renderBootVisualEditor();
    };
    grpTx.appendChild(addTx);
    form.appendChild(grpTx);

    const grpIm = document.createElement("div");
    grpIm.className = "boot-field-group";
    const hIm = document.createElement("h4");
    hIm.textContent = "Imagens";
    grpIm.appendChild(hIm);
    if (!sl.imageItems) {
      sl.imageItems = [];
    }
    for (let ii = 0; ii < sl.imageItems.length; ii++) {
      const im = sl.imageItems[ii];
      if (!im) {
        continue;
      }
      const card = document.createElement("div");
      card.className = "boot-img-card";
      const r0 = document.createElement("div");
      r0.className = "boot-field-row";
      const lp = document.createElement("label");
      lp.textContent = "Caminho";
      const ip = document.createElement("input");
      ip.type = "text";
      ip.placeholder = "ex. /logo.png";
      ip.value = im.path != null ? im.path : "";
      ip.oninput = function () {
        im.path = ip.value;
        scheduleBootVisualCommit();
      };
      r0.appendChild(lp);
      r0.appendChild(ip);
      card.appendChild(r0);
      const r1 = document.createElement("div");
      r1.className = "boot-field-row";
      const lx = document.createElement("label");
      lx.textContent = "X";
      const ix = document.createElement("input");
      ix.type = "text";
      ix.value = coordFieldValue(im.xSpec, im.x);
      ix.oninput = function () {
        const raw = ix.value;
        im.xSpec = raw.length ? raw : null;
        const n = parseInt(raw, 10);
        im.x = isNaN(n) ? 0 : n;
        scheduleBootVisualCommit();
      };
      const ly = document.createElement("label");
      ly.textContent = "Y";
      const iy = document.createElement("input");
      iy.type = "text";
      iy.value = coordFieldValue(im.ySpec, im.y);
      iy.oninput = function () {
        const raw = iy.value;
        im.ySpec = raw.length ? raw : null;
        const n = parseInt(raw, 10);
        im.y = isNaN(n) ? 0 : n;
        scheduleBootVisualCommit();
      };
      r1.appendChild(lx);
      r1.appendChild(ix);
      r1.appendChild(ly);
      r1.appendChild(iy);
      card.appendChild(r1);
      const r2 = document.createElement("div");
      r2.className = "boot-field-row";
      const rmIm = document.createElement("button");
      rmIm.type = "button";
      rmIm.className = "boot-mini-btn danger";
      rmIm.textContent = "Remover imagem";
      (function (idx) {
        rmIm.onclick = function () {
          sl.imageItems.splice(idx, 1);
          if (sl.imageItems.length === 0) {
            sl.imageItems.push(newDefaultImageItem());
          }
          scheduleBootVisualCommit();
          renderBootVisualEditor();
        };
      })(ii);
      r2.appendChild(rmIm);
      card.appendChild(r2);
      grpIm.appendChild(card);
    }
    const addIm = document.createElement("button");
    addIm.type = "button";
    addIm.className = "boot-mini-btn";
    addIm.textContent = "+ Imagem";
    addIm.onclick = function () {
      sl.imageItems.push(newDefaultImageItem());
      scheduleBootVisualCommit();
      renderBootVisualEditor();
    };
    grpIm.appendChild(addIm);
    form.appendChild(grpIm);
    root.appendChild(form);
  }

  function refreshBootVisualEditor(doParse) {
    const root = document.getElementById("boot-visual-root");
    if (!root) {
      applyBootLivePreview(0);
      return;
    }
    if (!BI || typeof BI.parse !== "function") {
      applyBootLivePreview(0);
      return;
    }
    if (doParse !== false) {
      bootVisualModel = BI.parse(init.bootIni || "");
      if (!bootVisualModel.slides || bootVisualModel.slides.length === 0) {
        bootVisualModel.slides = [newDefaultSlide()];
      }
      if (bootVisualSlideIdx >= bootVisualModel.slides.length) {
        bootVisualSlideIdx = bootVisualModel.slides.length - 1;
      }
    }
    renderBootVisualEditor();
    applyBootLivePreview(bootVisualSlideIdx);
  }

  let activeSimTab = "runner";

  function vscodePost(o) {
    const api = window.__ATHENA_VSCODE_API__;
    if (api && typeof api.postMessage === "function") {
      api.postMessage(o);
    }
  }

  const appRoot = document.getElementById("sim-app-root");
  const panelRunner = document.getElementById("tab-runner");
  const panelBoot = document.getElementById("tab-boot");
  const tabButtons = document.querySelectorAll(".sim-tab");

  function setSimulatorTab(name, opts) {
    opts = opts || {};
    if (name !== "runner" && name !== "boot") {
      return;
    }
    activeSimTab = name;
    tabButtons.forEach(function (btn) {
      const on = btn.getAttribute("data-tab") === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (panelRunner) {
      panelRunner.classList.toggle("active", name === "runner");
    }
    if (panelBoot) {
      panelBoot.classList.toggle("active", name === "boot");
    }
    if (appRoot) {
      appRoot.classList.toggle("boot-tab-active", name === "boot");
    }
    const payload = { type: "simulatorTab", tab: name };
    if (name === "boot") {
      payload.openEditor = opts.openEditor !== false;
    }
    vscodePost(payload);
    try {
      const api = window.__ATHENA_VSCODE_API__;
      if (api && typeof api.setState === "function") {
        api.setState({
          mainTab: name,
          splashIdx: bootVisualSlideIdx,
        });
      }
    } catch (e) {
      /* ignore */
    }
    if (name === "boot") {
      refreshBootVisualEditor(true);
    } else {
      run();
    }
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const t = btn.getAttribute("data-tab");
      if (t) {
        setSimulatorTab(t);
      }
    });
  });

  window.addEventListener("message", function (ev) {
    const d = ev.data;
    if (d && d.type === "bootIniChanged" && typeof d.text === "string") {
      if (activeSimTab !== "boot") {
        return;
      }
      init.bootIni = d.text;
      if (normBootIniText(d.text) === normBootIniText(bootVisualLastSent)) {
        applyBootLivePreview(bootVisualSlideIdx);
        return;
      }
      refreshBootVisualEditor(true);
    }
  });

  applyResolution(W, H);
  const ur = init.uiRestore;
  if (ur && ur.mainTab === "boot") {
    bootVisualSlideIdx =
      typeof ur.splashIdx === "number" && ur.splashIdx >= 0 ? ur.splashIdx : 0;
    setSimulatorTab("boot", { openEditor: false });
  } else {
    if (ur && typeof ur.splashIdx === "number" && ur.splashIdx >= 0) {
      bootVisualSlideIdx = ur.splashIdx;
    }
    run();
  }
})();
