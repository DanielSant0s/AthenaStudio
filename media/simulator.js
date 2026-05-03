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
  /** Populated by prefetch before main.js runs (sync XHR to webview URIs is often blocked). */
  const m3gWebviewCache = Object.create(null);
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
      const k = kind | 0;
      if (k < 0 || k > 2) {
        return -1;
      }
      const id = this._nextId++;
      this._listeners.push({ id: id, mask: mask, kind: k, cb: cb });
      return id;
    },
    clearListener: function (id) {
      this._listeners = this._listeners.filter(function (L) {
        return L.id !== id;
      });
    },
  };

  let spriteBatchActive = false;
  let spriteBatchQueue = [];

  function flushQueuedSprites() {
    if (!spriteBatchQueue.length) {
      return;
    }
    const q = spriteBatchQueue;
    spriteBatchQueue = [];
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      try {
        e.ctx.drawImage(e.bm, e.sx, e.sy, e.sw, e.sh, e.dx, e.dy, e.sw, e.sh);
      } catch (err) {
        /* ignore draw errors */
      }
    }
  }

  const Screen = {
    get width() {
      return W;
    },
    get height() {
      return H;
    },
    clear: function (color) {
      flushQueuedSprites();
      activeCtx.fillStyle = color != null ? colorCss(color) : "#000000";
      activeCtx.fillRect(0, 0, activeW, activeH);
    },
    update: function () {
      flushQueuedSprites();
    },
    beginBatch: function () {
      spriteBatchActive = true;
    },
    flushBatch: function () {
      flushQueuedSprites();
    },
    endBatch: function () {
      flushQueuedSprites();
      spriteBatchActive = false;
    },
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
      flushQueuedSprites();
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
      flushQueuedSprites();
      if (!layer || !layer._el) {
        return;
      }
      ctx.drawImage(layer._el, x | 0, y | 0);
    },
    freeLayer: function (layer) {
      flushQueuedSprites();
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

  let interpreterBootMs = Date.now();
  const vfsData = Object.create(null);
  let nextFd = 10;
  const fdTable = Object.create(null);

  function resetSessionFs() {
    for (const k in vfsData) {
      if (Object.prototype.hasOwnProperty.call(vfsData, k)) {
        delete vfsData[k];
      }
    }
    for (const k in fdTable) {
      if (Object.prototype.hasOwnProperty.call(fdTable, k)) {
        delete fdTable[k];
      }
    }
    nextFd = 10;
  }

  function utf8Encode(str) {
    const s = String(str);
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(s);
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c < 0xd800 || c >= 0xe000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        i++;
        c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function prefetchM3gWebviewBinaries(done) {
    const pending = [];
    for (const k of Object.keys(fileMap)) {
      if (k.indexOf(":") >= 0) {
        continue;
      }
      if (fileMap[k + ":encoding"] !== "webview-uri") {
        continue;
      }
      const uri = fileMap[k + ":uri"];
      if (!uri) {
        continue;
      }
      pending.push({ k: k, uri: uri });
    }
    if (pending.length === 0) {
      done();
      return;
    }
    let left = pending.length;
    function oneDone() {
      left--;
      if (left <= 0) {
        done();
      }
    }
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      fetch(item.uri)
        .then(function (r) {
          if (!r.ok) {
            logErr("m3g prefetch HTTP " + r.status + " for " + item.k);
            return null;
          }
          return r.arrayBuffer();
        })
        .then(function (ab) {
          if (ab) {
            m3gWebviewCache[item.k] = new Uint8Array(ab);
          }
          oneDone();
        })
        .catch(function (e) {
          logErr("m3g prefetch " + item.k + ": " + (e && e.message ? e.message : e));
          oneDone();
        });
    }
  }

  function resolveFileMapKey(normPath) {
    if (normPath == null || normPath === "") {
      return null;
    }
    if (fileMap[normPath] != null || fileMap[normPath + ":encoding"] != null) {
      return normPath;
    }
    const tl = normPath.toLowerCase();
    for (const k of Object.keys(fileMap)) {
      if (k.indexOf(":") >= 0) {
        continue;
      }
      if (k.toLowerCase() === tl) {
        return k;
      }
    }
    return null;
  }

  function bytesFromFileMap(normPath) {
    const key = resolveFileMapKey(normPath) || normPath;
    const enc = fileMap[key + ":encoding"];
    if (enc === "webview-uri") {
      const cached = m3gWebviewCache[key];
      if (cached) {
        return cached;
      }
      const uri = fileMap[key + ":uri"];
      if (!uri) {
        return null;
      }
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", uri, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        const st = xhr.status;
        if (st !== 200 && st !== 0) {
          return null;
        }
        return new Uint8Array(xhr.response);
      } catch (e) {
        return null;
      }
    }
    const raw = fileMap[key];
    if (raw == null) {
      return null;
    }
    if (enc === "base64") {
      const bin = atob(raw);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        u8[i] = bin.charCodeAt(i) & 0xff;
      }
      return u8;
    }
    return utf8Encode(raw);
  }

  function parseOsPath(p) {
    if (!p || typeof p !== "string") {
      return null;
    }
    let s = p.trim();
    if (s.indexOf("file://") === 0) {
      s = s.slice(7);
      if (s.length >= 3 && s.charAt(0) === "/" && s.charAt(2) === ":") {
        s = s.slice(1);
      }
    }
    return normalizePath(s.replace(/\\/g, "/"));
  }

  function SimMutex() {
    this._locked = false;
  }
  SimMutex.prototype.lock = function () {
    this._locked = true;
  };
  SimMutex.prototype.tryLock = function () {
    if (this._locked) {
      return 0;
    }
    this._locked = true;
    return 1;
  };
  SimMutex.prototype.unlock = function () {
    this._locked = false;
  };

  function SimSemaphore(initial, max) {
    const ini = initial | 0;
    const mx = max | 0;
    this._permits = Math.max(0, Math.min(ini, mx > 0 ? mx : ini));
    this._max = Math.max(this._permits, mx > 0 ? mx : this._permits);
  }
  SimSemaphore.prototype.acquire = function () {
    if (this._permits > 0) {
      this._permits--;
    }
  };
  SimSemaphore.prototype.tryAcquire = function () {
    if (this._permits > 0) {
      this._permits--;
      return 1;
    }
    return 0;
  };
  SimSemaphore.prototype.release = function () {
    if (this._permits < this._max) {
      this._permits++;
    }
  };
  SimSemaphore.prototype.availablePermits = function () {
    return this._permits;
  };

  function SimAtomicInt(initial) {
    this._v = (initial != null ? initial : 0) | 0;
  }
  SimAtomicInt.prototype.get = function () {
    return this._v;
  };
  SimAtomicInt.prototype.set = function (n) {
    this._v = n | 0;
  };
  SimAtomicInt.prototype.addAndGet = function (delta) {
    this._v = (this._v + (delta | 0)) | 0;
    return this._v;
  };

  function SimPoolHandle(ctor, size) {
    const cap = Math.min(8192, Math.max(0, size | 0));
    this._ctor = ctor;
    this._cap = cap;
    this._shells = new Array(cap);
    this._free = [];
    for (let i = 0; i < cap; i++) {
      this._shells[i] = Object.create(ctor.prototype);
      this._free.push(i);
    }
    this._checkedOut = Object.create(null);
  }
  SimPoolHandle.prototype.acquire = function () {
    if (this._free.length === 0) {
      return null;
    }
    const idx = this._free.pop();
    const shell = this._shells[idx];
    const args = Array.prototype.slice.call(arguments);
    this._ctor.apply(shell, args);
    shell.__simPoolIndex = idx;
    this._checkedOut[idx] = true;
    return shell;
  };
  SimPoolHandle.prototype.release = function (obj) {
    if (!obj || obj.__simPoolIndex == null) {
      return;
    }
    const idx = obj.__simPoolIndex;
    if (!this._checkedOut[idx]) {
      return;
    }
    delete this._checkedOut[idx];
    obj.__simPoolIndex = null;
    this._free.push(idx);
  };
  SimPoolHandle.prototype.freeSlots = function () {
    return this._free.length;
  };
  SimPoolHandle.prototype.capacity = function () {
    return this._cap;
  };
  SimPoolHandle.prototype.inUseCount = function () {
    return this._cap - this._free.length;
  };

  function PoolBase() {}
  PoolBase.prototype.acquire = function () {};
  PoolBase.prototype.release = function () {};
  PoolBase.prototype.free = function () {
    return 0;
  };
  PoolBase.prototype.capacity = function () {
    return 0;
  };
  PoolBase.prototype.inUse = function () {
    return 0;
  };

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

  function getMediaBlobUrl(jarPath) {
    const key = normalizePath(jarPath);
    const raw = fileMap[key];
    if (!raw || fileMap[key + ":encoding"] !== "base64") {
      return null;
    }
    const ext = key.split(".").pop().toLowerCase();
    const mime =
      ext === "wav"
        ? "audio/wav"
        : ext === "mp3"
          ? "audio/mpeg"
          : ext === "mid" || ext === "midi"
            ? "audio/midi"
            : "application/octet-stream";
    try {
      const bin = atob(raw);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        u8[i] = bin.charCodeAt(i) & 0xff;
      }
      const blob = new Blob([u8], { type: mime });
      return URL.createObjectURL(blob);
    } catch (e) {
      return null;
    }
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
    if (spriteBatchActive) {
      spriteBatchQueue.push({
        ctx: activeCtx,
        bm: bm,
        sx: sx,
        sy: sy,
        sw: sw,
        sh: sh,
        dx: x | 0,
        dy: y | 0,
      });
      return;
    }
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
    const txt = String(text);
    activeCtx.font = this._face;
    activeCtx.fillStyle = colorCss(this.color);
    const a = this.align | 0;
    let vert = a & (FontCtor.ALIGN_TOP | FontCtor.ALIGN_BOTTOM | FontCtor.ALIGN_VCENTER);
    let horiz = a & (FontCtor.ALIGN_LEFT | FontCtor.ALIGN_RIGHT | FontCtor.ALIGN_HCENTER);
    const prevAlign = activeCtx.textAlign;
    const prevBaseline = activeCtx.textBaseline;
    if (!vert) {
      vert = FontCtor.ALIGN_TOP;
    }
    if (!horiz) {
      horiz = FontCtor.ALIGN_LEFT;
    }
    if (horiz & FontCtor.ALIGN_HCENTER) {
      activeCtx.textAlign = "center";
    } else if (horiz & FontCtor.ALIGN_RIGHT) {
      activeCtx.textAlign = "right";
    } else {
      activeCtx.textAlign = "left";
    }
    if (vert & FontCtor.ALIGN_VCENTER) {
      activeCtx.textBaseline = "middle";
    } else if (vert & FontCtor.ALIGN_BOTTOM) {
      activeCtx.textBaseline = "bottom";
    } else {
      activeCtx.textBaseline = "top";
    }
    activeCtx.fillText(txt, x, y);
    activeCtx.textAlign = prevAlign;
    activeCtx.textBaseline = prevBaseline;
  };
  FontCtor.prototype.getTextSize = function (text) {
    activeCtx.font = this._face;
    const m = activeCtx.measureText(String(text));
    let hText = 14;
    if (m.actualBoundingBoxAscent != null && m.actualBoundingBoxDescent != null) {
      hText = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) | 0;
      if (hText < 1) {
        hText = 14;
      }
    }
    return { width: m.width | 0, height: hText };
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
    open: function (pathStr, flags) {
      const path = parseOsPath(pathStr);
      if (!path) {
        return -1;
      }
      const fl = flags | 0;
      const acc = fl & 3;
      const canRead = acc === 0 || acc === 2;
      const canWrite = acc === 1 || acc === 2;
      const hasJar = bytesFromFileMap(path) != null;
      const hasVfs = Object.prototype.hasOwnProperty.call(vfsData, path);
      if ((fl & 2048) !== 0 && (fl & 512) !== 0 && (hasJar || hasVfs)) {
        return -1;
      }
      if ((fl & 1024) !== 0 && canWrite) {
        vfsData[path] = new Uint8Array(0);
      } else if (canWrite && !hasVfs) {
        if (hasJar) {
          vfsData[path] = new Uint8Array(bytesFromFileMap(path));
        } else if ((fl & 512) !== 0) {
          vfsData[path] = new Uint8Array(0);
        } else if (!canRead) {
          return -1;
        }
      }
      if (canWrite && hasVfs && (fl & 1024) !== 0) {
        vfsData[path] = new Uint8Array(0);
      }
      const bufNow = Object.prototype.hasOwnProperty.call(vfsData, path)
        ? vfsData[path]
        : bytesFromFileMap(path);
      if (canRead && bufNow == null) {
        return -1;
      }
      const fd = nextFd++;
      fdTable[fd] = { path: path, pos: 0, canRead: canRead, canWrite: canWrite };
      return fd;
    },
    close: function (fd) {
      if (fdTable[fd]) {
        delete fdTable[fd];
      }
    },
    seek: function (fd, offset, whence) {
      const rec = fdTable[fd];
      if (!rec) {
        return -1;
      }
      const path = rec.path;
      let buf = Object.prototype.hasOwnProperty.call(vfsData, path)
        ? vfsData[path]
        : bytesFromFileMap(path);
      if (buf == null) {
        buf = new Uint8Array(0);
      }
      const len = buf.length;
      let base = 0;
      const w = whence | 0;
      if (w === 1) {
        base = rec.pos;
      } else if (w === 2) {
        base = len;
      }
      let npos = base + (offset | 0);
      if (npos < 0) {
        npos = 0;
      }
      rec.pos = npos;
      return npos;
    },
    read: function (fd, maxBytes) {
      const rec = fdTable[fd];
      if (!rec || !rec.canRead) {
        return new Uint8Array(0);
      }
      let maxB = maxBytes !== undefined && maxBytes !== null ? maxBytes | 0 : 1024;
      if (maxB < 1) {
        maxB = 1024;
      }
      if (maxB > 1048576) {
        maxB = 1048576;
      }
      const path = rec.path;
      const buf = Object.prototype.hasOwnProperty.call(vfsData, path)
        ? vfsData[path]
        : bytesFromFileMap(path);
      if (buf == null || buf.length === 0) {
        return new Uint8Array(0);
      }
      const pos = rec.pos;
      if (pos >= buf.length) {
        return new Uint8Array(0);
      }
      const n = Math.min(maxB, buf.length - pos);
      const slice = buf.subarray(pos, pos + n);
      rec.pos = pos + n;
      return new Uint8Array(slice);
    },
    write: function (fd, data) {
      const rec = fdTable[fd];
      if (!rec || !rec.canWrite) {
        return -1;
      }
      let u8;
      if (typeof data === "string") {
        u8 = utf8Encode(data);
      } else if (data != null && data.buffer && typeof data.byteLength === "number") {
        u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      } else {
        return -1;
      }
      const path = rec.path;
      if (!Object.prototype.hasOwnProperty.call(vfsData, path)) {
        const jb = bytesFromFileMap(path);
        vfsData[path] = jb ? new Uint8Array(jb) : new Uint8Array(0);
      }
      let buf = vfsData[path];
      const pos = rec.pos;
      const need = pos + u8.length;
      if (need > buf.length) {
        const nb = new Uint8Array(need);
        nb.set(buf);
        buf = nb;
        vfsData[path] = buf;
      }
      buf.set(u8, pos);
      rec.pos = pos + u8.length;
      return u8.length;
    },
    fstat: function (fd) {
      const rec = fdTable[fd];
      if (!rec) {
        return { error: "bad fd" };
      }
      const path = rec.path;
      const buf = Object.prototype.hasOwnProperty.call(vfsData, path)
        ? vfsData[path]
        : bytesFromFileMap(path);
      if (buf == null) {
        return { error: "not found" };
      }
      return { size: buf.length, isDirectory: 0, lastModified: Date.now() };
    },
    sleep: function (ms) {
      flushPromises();
      void ms;
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
        flushQueuedSprites();
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
      let loc = null;
      try {
        if (typeof navigator !== "undefined" && navigator.language) {
          loc = navigator.language;
        }
      } catch (e) {
        loc = null;
      }
      return {
        "microedition.platform": "AthenaStudio-sim",
        "microedition.configuration": "CLDC-1.1",
        "microedition.profiles": "MIDP-2.0",
        "microedition.locale": loc,
        "microedition.encoding": "UTF-8",
      };
    },
    getMemoryStats: function (optRunGc) {
      if (optRunGc) {
        try {
          if (window.gc) {
            window.gc();
          }
        } catch (e) {}
      }
      return { heapTotal: 0, heapFree: 0, heapUsed: 0 };
    },
    getStorageStats: function (fileUrl) {
      if (!fileUrl || typeof fileUrl !== "string") {
        return { error: "fileUrl required" };
      }
      return { total: 536870912, free: 134217728 };
    },
    getProperty: function (key) {
      if (!key || typeof key !== "string") {
        return null;
      }
      if (key === "microedition.encoding") {
        return "UTF-8";
      }
      return null;
    },
    bluetoothGetCapabilities: function () {
      return { jsr82: 0, available: 0, powered: 0, name: "", address: "", error: "stub" };
    },
    bluetoothInquiry: function () {
      return Promise.reject(new Error("Bluetooth inquiry not available in simulator"));
    },
    currentTimeMillis: function () {
      return Date.now();
    },
    uptimeMillis: function () {
      return Date.now() - interpreterBootMs;
    },
    gc: function () {},
    threadYield: function () {},
    spawn: function (fn) {
      return new Promise(function (resolve, reject) {
        const run = function () {
          try {
            resolve(fn());
          } catch (e) {
            reject(e);
          }
        };
        if (typeof queueMicrotask === "function") {
          queueMicrotask(run);
        } else {
          setTimeout(run, 0);
        }
      });
    },
    Thread: {
      start: function (fn) {
        return os.spawn(fn);
      },
    },
    Mutex: SimMutex,
    Semaphore: SimSemaphore,
    AtomicInt: SimAtomicInt,
    pool: function (ctor, size) {
      if (typeof ctor !== "function") {
        return null;
      }
      try {
        const inner = new SimPoolHandle(ctor, size);
        const wrap = Object.create(PoolBase.prototype);
        wrap.acquire = function () {
          return inner.acquire.apply(inner, arguments);
        };
        wrap.release = function (obj) {
          inner.release(obj);
        };
        wrap.free = function () {
          return inner.freeSlots();
        };
        wrap.capacity = function () {
          return inner.capacity();
        };
        wrap.inUse = function () {
          return inner.inUseCount();
        };
        return wrap;
      } catch (e) {
        logErr(e && e.message ? e.message : e);
        return null;
      }
    },
    vibrate: function (durationMs) {
      try {
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(durationMs | 0);
        }
      } catch (e) {}
    },
    camera: {
      takeSnapshot: function (options) {
        return new Promise(function (resolve, reject) {
          if (typeof document === "undefined") {
            reject(new Error("No VideoControl"));
            return;
          }
          const nav = typeof navigator !== "undefined" ? navigator : null;
          if (!nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) {
            reject(new Error("Camera not available in simulator"));
            return;
          }
          const opts = options || {};
          const tw = (opts.width != null ? opts.width : 320) | 0;
          const th = (opts.height != null ? opts.height : 240) | 0;
          nav.mediaDevices
            .getUserMedia({ video: true, audio: false })
            .then(function (stream) {
              const video = document.createElement("video");
              video.playsInline = true;
              video.muted = true;
              video.srcObject = stream;
              video.onloadedmetadata = function () {
                video
                  .play()
                  .then(function () {
                    const cw = tw > 0 ? tw : video.videoWidth || 320;
                    const ch = th > 0 ? th : video.videoHeight || 240;
                    const canvas = document.createElement("canvas");
                    canvas.width = cw;
                    canvas.height = ch;
                    const g = canvas.getContext("2d");
                    if (!g) {
                      stream.getTracks().forEach(function (t) {
                        t.stop();
                      });
                      reject(new Error("Snapshot failed"));
                      return;
                    }
                    g.drawImage(video, 0, 0, cw, ch);
                    stream.getTracks().forEach(function (t) {
                      t.stop();
                    });
                    canvas.toBlob(
                      function (blob) {
                        if (!blob) {
                          reject(new Error("Snapshot failed"));
                          return;
                        }
                        blob
                          .arrayBuffer()
                          .then(function (ab) {
                            resolve(new Uint8Array(ab));
                          })
                          .catch(function () {
                            reject(new Error("Snapshot failed"));
                          });
                      },
                      "image/jpeg",
                      0.85
                    );
                  })
                  .catch(function () {
                    stream.getTracks().forEach(function (t) {
                      t.stop();
                    });
                    reject(new Error("Snapshot failed"));
                  });
              };
              video.onerror = function () {
                stream.getTracks().forEach(function (t) {
                  t.stop();
                });
                reject(new Error("Snapshot failed"));
              };
            })
            .catch(function () {
              reject(new Error("Camera not available in simulator"));
            });
        });
      },
    },
  };

  function RequestCtor() {
    this.responseCode = 0;
    this.error = "";
    this.contentLength = 0;
    this._busy = false;
    this.keepalive = 0;
    this.useragent = "";
    this.userpwd = "";
    this.headers = [];
  }
  function buildFetchHeaders(self) {
    const hdrs = {};
    const hp = self.headers || [];
    for (let i = 0; i + 1 < hp.length; i += 2) {
      hdrs[String(hp[i])] = String(hp[i + 1]);
    }
    return hdrs;
  }
  RequestCtor.prototype.get = function (url) {
    const self = this;
    if (self._busy) {
      return Promise.reject(new Error("Request busy"));
    }
    self._busy = true;
    return fetch(url, { headers: buildFetchHeaders(this) })
      .then(function (r) {
        self.responseCode = r.status;
        return r.arrayBuffer();
      })
      .then(function (buf) {
        self.contentLength = buf.byteLength;
        self._busy = false;
        return {
          responseCode: self.responseCode,
          error: self.error,
          contentLength: self.contentLength,
          body: new Uint8Array(buf),
        };
      })
      .catch(function (e) {
        self._busy = false;
        throw { message: e.message || String(e) };
      });
  };
  RequestCtor.prototype.post = function (url, data) {
    const self = this;
    if (self._busy) {
      return Promise.reject(new Error("Request busy"));
    }
    self._busy = true;
    let body = data;
    if (data != null && data.buffer && typeof data.byteLength === "number") {
      body = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    }
    return fetch(url, {
      method: "POST",
      headers: buildFetchHeaders(this),
      body: body,
    })
      .then(function (r) {
        self.responseCode = r.status;
        return r.arrayBuffer();
      })
      .then(function (buf) {
        self.contentLength = buf.byteLength;
        self._busy = false;
        return {
          responseCode: self.responseCode,
          error: self.error,
          contentLength: self.contentLength,
          body: new Uint8Array(buf),
        };
      })
      .catch(function (e) {
        self._busy = false;
        throw { message: e.message || String(e) };
      });
  };
  RequestCtor.prototype.download = function (url, fileUrl) {
    const self = this;
    if (self._busy) {
      return Promise.reject(new Error("Request busy"));
    }
    self._busy = true;
    return fetch(url, { headers: buildFetchHeaders(this) })
      .then(function (r) {
        self.responseCode = r.status;
        return r.arrayBuffer();
      })
      .then(function (buf) {
        const path = parseOsPath(fileUrl);
        if (!path) {
          self._busy = false;
          throw new Error("bad fileUrl");
        }
        vfsData[path] = new Uint8Array(buf);
        self.contentLength = buf.byteLength;
        self._busy = false;
        return {
          responseCode: self.responseCode,
          error: self.error,
          contentLength: self.contentLength,
          fileUrl: fileUrl,
        };
      })
      .catch(function (e) {
        self._busy = false;
        throw { message: e.message || String(e) };
      });
  };

  function SocketCtor(af, type) {
    this._af = af;
    this._type = type;
    this.error = "";
  }
  SocketCtor.AF_INET = 2;
  SocketCtor.SOCK_STREAM = 1;
  SocketCtor.SOCK_DGRAM = 2;
  SocketCtor.SOCK_RAW = 3;
  SocketCtor.prototype.connect = function () {
    throw new Error("Socket not supported in simulator");
  };
  SocketCtor.prototype.bind = function () {
    throw new Error("Socket not supported in simulator");
  };
  SocketCtor.prototype.listen = function () {
    throw new Error("Socket not supported in simulator");
  };
  SocketCtor.prototype.accept = function () {
    throw new Error("Socket not supported in simulator");
  };
  SocketCtor.prototype.send = function () {
    return -1;
  };
  SocketCtor.prototype.recv = function () {
    return new Uint8Array(0);
  };
  SocketCtor.prototype.close = function () {};

  function WebSocketCtor(url) {
    this.error = "";
    this._q = [];
    this._sock = null;
    const u = String(url || "");
    if (u.indexOf("ws://") !== 0) {
      this.error = "only ws:// is supported";
      return;
    }
    try {
      const w = new WebSocket(u);
      w.binaryType = "arraybuffer";
      this._sock = w;
      const self = this;
      w.onmessage = function (ev) {
        if (typeof ev.data === "string") {
          self._q.push(utf8Encode(ev.data));
        } else {
          self._q.push(new Uint8Array(ev.data));
        }
      };
      w.onerror = function () {
        self.error = "ws error";
      };
    } catch (e) {
      this.error = String(e.message || e);
    }
  }
  WebSocketCtor.prototype.send = function (uint8) {
    if (!this._sock || this._sock.readyState !== 1) {
      return;
    }
    let b = uint8;
    if (uint8 && !uint8.buffer) {
      b = new Uint8Array(uint8);
    }
    this._sock.send(b);
  };
  WebSocketCtor.prototype.recv = function () {
    if (this._q.length) {
      return this._q.shift();
    }
    return new Uint8Array(0);
  };
  WebSocketCtor.prototype.close = function () {
    if (this._sock) {
      this._sock.close();
      this._sock = null;
    }
  };

  function BTSocketCtor() {}
  BTSocketCtor.prototype.connect = function () {
    return Promise.reject(new Error("BTSocket not available in simulator"));
  };
  BTSocketCtor.prototype.send = function () {
    return -1;
  };
  BTSocketCtor.prototype.recv = function () {
    return new Uint8Array(0);
  };
  BTSocketCtor.prototype.close = function () {};

  function TimerCtor() {
    this._base = Date.now();
    this._offset = 0;
    this._pausedAt = null;
  }
  TimerCtor.prototype.get = function () {
    if (this._pausedAt != null) {
      return this._offset;
    }
    return (Date.now() - this._base) | 0;
  };
  TimerCtor.prototype.set = function (v) {
    this._base = Date.now() - (v | 0);
    this._offset = 0;
    this._pausedAt = null;
  };
  TimerCtor.prototype.pause = function () {
    if (this._pausedAt == null) {
      this._offset = (Date.now() - this._base) | 0;
      this._pausedAt = Date.now();
    }
  };
  TimerCtor.prototype.resume = function () {
    if (this._pausedAt != null) {
      this._base = Date.now() - this._offset;
      this._pausedAt = null;
    }
  };
  TimerCtor.prototype.reset = function () {
    this._base = Date.now();
    this._offset = 0;
    this._pausedAt = null;
  };
  TimerCtor.prototype.playing = function () {
    return this._pausedAt == null ? 1 : 0;
  };
  TimerCtor.prototype.free = function () {};

  const sfxSlots = new Array(8);

  const Sound = {
    setVolume: function (vol) {
      Sound._master = Math.max(0, Math.min(100, vol | 0)) / 100;
    },
    _master: 1,
    findChannel: function () {
      let i;
      for (i = 0; i < 8; i++) {
        const a = sfxSlots[i];
        if (!a || a.ended) {
          return i;
        }
      }
      return undefined;
    },
    Stream: function (pathStr) {
      const path = normalizePath(pathStr);
      const blobUrl = getMediaBlobUrl(path);
      const audio = blobUrl ? new Audio(blobUrl) : new Audio();
      const st = {
        position: 0,
        length: 0,
        loop: 0,
        _a: audio,
        _blobUrl: blobUrl,
        play: function () {
          audio.volume = Sound._master;
          audio.loop = !!st.loop;
          audio.play().catch(function () {});
        },
        pause: function () {
          audio.pause();
        },
        free: function () {
          audio.pause();
          audio.src = "";
          if (st._blobUrl) {
            try {
              URL.revokeObjectURL(st._blobUrl);
            } catch (e) {}
            st._blobUrl = null;
          }
        },
        playing: function () {
          return !audio.paused && !audio.ended ? 1 : 0;
        },
        rewind: function () {
          try {
            audio.currentTime = 0;
          } catch (e) {}
        },
      };
      audio.addEventListener("timeupdate", function () {
        st.position = (audio.currentTime * 1000) | 0;
      });
      audio.addEventListener("loadedmetadata", function () {
        if (audio.duration && !isNaN(audio.duration)) {
          st.length = (audio.duration * 1000) | 0;
        }
      });
      return st;
    },
    Sfx: function (pathStr) {
      const path = normalizePath(pathStr);
      const blobUrl = getMediaBlobUrl(path);
      const instances = [];
      const sx = {
        volume: 100,
        pan: 0,
        pitch: 0,
        _path: path,
        _blobUrl: blobUrl,
        play: function (ch) {
          if (!blobUrl) {
            return undefined;
          }
          let slot;
          if (ch !== undefined) {
            slot = ch | 0;
            if (slot < 0 || slot >= 8) {
              return undefined;
            }
            const cur = sfxSlots[slot];
            if (cur && !cur.ended && !cur.paused) {
              return undefined;
            }
          } else {
            const fc = Sound.findChannel();
            if (fc === undefined) {
              return undefined;
            }
            slot = fc;
          }
          const a = new Audio(blobUrl);
          a.volume = Sound._master * (sx.volume / 100);
          sfxSlots[slot] = a;
          instances.push({ slot: slot, a: a });
          a.addEventListener(
            "ended",
            function () {
              let j;
              for (j = 0; j < instances.length; j++) {
                if (instances[j].a === a) {
                  instances.splice(j, 1);
                  break;
                }
              }
              if (sfxSlots[slot] === a) {
                sfxSlots[slot] = null;
              }
            },
            false
          );
          a.play().catch(function () {});
          return slot;
        },
        free: function () {
          while (instances.length) {
            const x = instances.pop();
            x.a.pause();
            if (sfxSlots[x.slot] === x.a) {
              sfxSlots[x.slot] = null;
            }
          }
          if (sx._blobUrl) {
            try {
              URL.revokeObjectURL(sx._blobUrl);
            } catch (e) {}
            sx._blobUrl = null;
          }
        },
        playing: function (channel) {
          const a = sfxSlots[channel | 0];
          return a && !a.paused && !a.ended ? 1 : 0;
        },
      };
      return sx;
    },
  };

  const LS_PREFIX = "athenastudio-sim:";

  const localStorage = {
    getItem: function (key) {
      try {
        const v = window.sessionStorage.getItem(LS_PREFIX + String(key));
        return v;
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.sessionStorage.setItem(LS_PREFIX + String(key), String(value));
      } catch (e) {}
    },
    removeItem: function (key) {
      try {
        window.sessionStorage.removeItem(LS_PREFIX + String(key));
      } catch (e) {}
    },
    clear: function () {
      try {
        const ss = window.sessionStorage;
        const keys = [];
        let ki;
        for (ki = 0; ki < ss.length; ki++) {
          keys.push(ss.key(ki));
        }
        keys.forEach(function (k) {
          if (k && k.indexOf(LS_PREFIX) === 0) {
            ss.removeItem(k);
          }
        });
      } catch (e) {}
    },
  };

  const LZ4 = {
    compress: function () {
      throw new Error("LZ4 not implemented in AthenaStudio simulator");
    },
    decompress: function () {
      throw new Error("LZ4 not implemented in AthenaStudio simulator");
    },
  };

  const DEFLATE = {
    inflate: function (srcBuffer, uncompressedSize) {
      if (!srcBuffer || typeof srcBuffer.length !== "number") {
        throw new Error("DEFLATE.inflate: invalid buffer");
      }
      const f = typeof self !== "undefined" ? self.fflate : typeof window !== "undefined" ? window.fflate : null;
      if (!f || typeof f.inflateSync !== "function") {
        throw new Error("DEFLATE.inflate: fflate not loaded");
      }
      try {
        const ulen = uncompressedSize != null ? uncompressedSize | 0 : 0;
        const out = ulen > 0 ? f.inflateSync(srcBuffer, { out: new Uint8Array(ulen) }) : f.inflateSync(srcBuffer);
        return out instanceof Uint8Array ? out : new Uint8Array(out);
      } catch (e) {
        throw new Error("DEFLATE.inflate: " + (e.message || String(e)));
      }
    },
  };

  const ZIP = {
    open: function (buffer) {
      if (!buffer || typeof buffer.length !== "number") {
        return null;
      }
      const f = typeof self !== "undefined" ? self.fflate : typeof window !== "undefined" ? window.fflate : null;
      if (!f || typeof f.unzipSync !== "function") {
        logErr("ZIP.open: fflate not loaded");
        return null;
      }
      let map;
      try {
        map = f.unzipSync(buffer);
      } catch (e) {
        logErr("ZIP.open: " + (e.message || e));
        return null;
      }
      return {
        list: function () {
          return Object.keys(map);
        },
        get: function (name) {
          const u = map[name];
          if (!u) {
            return null;
          }
          return u instanceof Uint8Array ? u : new Uint8Array(u);
        },
      };
    },
  };

  const Render3D = (function () {
    /** "auto" → m3g when THREE+AthenaM3G exist, else "soft" (matches JSR-184-capable devices). */
    let backend = "auto";
    let inited = false;
    let glCanvas = null;
    let renderer = null;
    let m3gCtx = null;
    let m3gIr = null;
    let lastAnimMs = 0;
    /** When false, M3G clip time uses performance.now() − this (set on successful load). */
    let m3gAnimUseHostTime = false;
    let m3gSceneLoadPerf = 0;
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    /** RGB 0–255 for last 3D frame clear + 2D blit underlay (opaque compositing). */
    let frameClearR = 0;
    let frameClearG = 0;
    let frameClearB = 0;
    const animOverrides = Object.create(null);

    /** Immediate-mode (software/WebGL) pipeline — used when backend === "soft". */
    let softScene = null;
    let softMesh = null;
    let softCam = null;
    let softDirLight = null;
    let softAmbient = null;
    let softFov = 60;
    let softNear = 0.1;
    let softFar = 2000;
    let softCamUseLookAt = true;
    let softLookEx = 0;
    let softLookEy = 0;
    let softLookEz = 5;
    let softLookTx = 0;
    let softLookTy = 0;
    let softLookTz = 0;
    let softLookUx = 0;
    let softLookUy = 1;
    let softLookUz = 0;
    let softCamPx = 0;
    let softCamPy = 0;
    let softCamPz = 5.5;
    let softLightDx = 0;
    let softLightDy = 1;
    let softLightDz = 0;
    let softAmbR = 64;
    let softAmbG = 64;
    let softAmbB = 64;
    let softDiffR = 200;
    let softDiffG = 200;
    let softDiffB = 200;
    let softTexturePath = null;
    let softPositions = null;
    let softNormals = null;
    let softStripLens = null;
    let softUv = null;
    let softMeshRotationDeg = 0;
    let softBackfaceCull = true;

    function disposeM3gSceneOnly() {
      m3gCtx = null;
      m3gIr = null;
      lastAnimMs = 0;
      m3gAnimUseHostTime = false;
      m3gSceneLoadPerf = 0;
      for (const k in animOverrides) {
        if (Object.prototype.hasOwnProperty.call(animOverrides, k)) {
          delete animOverrides[k];
        }
      }
    }

    function disposeSoftImmediateScene() {
      if (softMesh) {
        try {
          if (softMesh.geometry) {
            softMesh.geometry.dispose();
          }
          if (softMesh.material) {
            const m = softMesh.material;
            if (m.map) {
              m.map.dispose();
            }
            m.dispose();
          }
        } catch (e) {}
        softMesh = null;
      }
      softScene = null;
      softCam = null;
      softDirLight = null;
      softAmbient = null;
    }

    function disposeRendererFull() {
      disposeSoftImmediateScene();
      if (renderer) {
        try {
          renderer.dispose();
        } catch (e) {}
      }
      renderer = null;
      glCanvas = null;
    }

    function expandTriangleStrips(stripLens) {
      if (!stripLens || !stripLens.length) {
        return null;
      }
      const tris = [];
      let base = 0;
      for (let s = 0; s < stripLens.length; s++) {
        const L = stripLens[s] | 0;
        if (L < 3) {
          base += L;
          continue;
        }
        for (let i = 2; i < L; i++) {
          const i0 = base + (i - 2);
          const i1 = base + (i - 1);
          const i2 = base + i;
          if ((i & 1) === 0) {
            tris.push(i0, i1, i2);
          } else {
            tris.push(i1, i0, i2);
          }
        }
        base += L;
      }
      return tris.length ? new Uint32Array(tris) : null;
    }

    function ensureSoftScene(THREE) {
      if (softScene) {
        return;
      }
      softScene = new THREE.Scene();
      const asp = (canvas.height | 0) > 0 ? (canvas.width | 0) / (canvas.height | 0) : 1;
      softCam = new THREE.PerspectiveCamera(softFov, asp, softNear, softFar);
      softAmbient = new THREE.AmbientLight(0xffffff, 0.45);
      softDirLight = new THREE.DirectionalLight(0xffffff, 0.85);
      softScene.add(softAmbient);
      softScene.add(softDirLight);
      softScene.add(softDirLight.target);
    }

    function renderSoftImmediate(THREE) {
      ensureSoftScene(THREE);
      const dw = canvas.width | 0;
      const dh = canvas.height | 0;
      if (dh < 1 || dw < 1) {
        return;
      }
      softCam.fov = softFov;
      softCam.aspect = dh > 0 ? dw / dh : 1;
      softCam.near = softNear;
      softCam.far = softFar;
      softCam.updateProjectionMatrix();
      if (softCamUseLookAt) {
        softCam.position.set(softLookEx, softLookEy, softLookEz);
        softCam.up.set(softLookUx, softLookUy, softLookUz);
        softCam.lookAt(softLookTx, softLookTy, softLookTz);
      } else {
        softCam.position.set(softCamPx, softCamPy, softCamPz);
        softCam.up.set(0, 1, 0);
        softCam.lookAt(0, 0, 0);
      }
      const llen = Math.sqrt(
        softLightDx * softLightDx + softLightDy * softLightDy + softLightDz * softLightDz
      );
      if (llen > 1e-6) {
        softDirLight.position.set(
          softLightDx / llen,
          softLightDy / llen,
          softLightDz / llen
        );
      } else {
        softDirLight.position.set(0.25, 0.95, 0.35);
      }
      softAmbient.color.setRGB(softAmbR / 255, softAmbG / 255, softAmbB / 255);

      const indexArr = expandTriangleStrips(softStripLens);
      if (
        softPositions &&
        softPositions.length >= 9 &&
        indexArr &&
        indexArr.length &&
        softNormals &&
        softNormals.length === softPositions.length
      ) {
        if (!softMesh) {
          const mat = new THREE.MeshPhongMaterial({
            color: new THREE.Color(softDiffR / 255, softDiffG / 255, softDiffB / 255),
            specular: 0x111111,
            shininess: 24,
          });
          mat.side = softBackfaceCull ? THREE.FrontSide : THREE.DoubleSide;
          const geo = new THREE.BufferGeometry();
          softMesh = new THREE.Mesh(geo, mat);
          softScene.add(softMesh);
        }
        const geo = softMesh.geometry;
        const mat = softMesh.material;
        mat.side = softBackfaceCull ? THREE.FrontSide : THREE.DoubleSide;
        mat.color.setRGB(softDiffR / 255, softDiffG / 255, softDiffB / 255);
        const IndexCtor =
          THREE.Uint32BufferAttribute != null
            ? THREE.Uint32BufferAttribute
            : THREE.BufferAttribute;
        geo.setIndex(new IndexCtor(indexArr, 1));
        geo.setAttribute("position", new THREE.BufferAttribute(softPositions, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(softNormals, 3));
        if (softUv && softUv.length >= (softPositions.length / 3) * 2) {
          geo.setAttribute("uv", new THREE.BufferAttribute(softUv, 2));
        } else {
          geo.deleteAttribute("uv");
        }
        if (softTexturePath) {
          const texKey = normalizePath(softTexturePath);
          const dataUrl = getImageDataUrl(texKey);
          const prevKey = mat.userData.simTexKey;
          if (dataUrl && (prevKey !== texKey || !mat.map)) {
            if (mat.map) {
              mat.map.dispose();
            }
            mat.userData.simTexKey = texKey;
            const tl = new THREE.TextureLoader();
            mat.map = tl.load(dataUrl);
            if (THREE.SRGBColorSpace != null) {
              mat.map.colorSpace = THREE.SRGBColorSpace;
            }
            mat.map.needsUpdate = true;
          }
          if (!dataUrl) {
            if (mat.map) {
              mat.map.dispose();
              mat.map = null;
            }
            mat.userData.simTexKey = null;
          }
        } else {
          if (mat.map) {
            mat.map.dispose();
            mat.map = null;
          }
          mat.userData.simTexKey = null;
        }
        mat.needsUpdate = true;
        geo.computeBoundingSphere();
        softMesh.rotation.set(0, (softMeshRotationDeg * Math.PI) / 180, 0);
      } else {
        if (softMesh) {
          softScene.remove(softMesh);
          if (softMesh.geometry) {
            softMesh.geometry.dispose();
          }
          if (softMesh.material) {
            softMesh.material.dispose();
          }
          softMesh = null;
        }
      }
      renderer.render(softScene, softCam);
    }

    function getTHREE() {
      if (typeof globalThis !== "undefined" && globalThis.THREE) {
        return globalThis.THREE;
      }
      return typeof window !== "undefined" ? window.THREE : null;
    }

    function m3gLibsOk() {
      return getTHREE() != null && typeof globalThis.AthenaM3G !== "undefined";
    }

    function m3gErrMsg() {
      if (!getTHREE()) {
        return "THREE.js not loaded";
      }
      if (typeof globalThis.AthenaM3G === "undefined") {
        return "AthenaM3G (m3g-bundle.js) not loaded";
      }
      return null;
    }

    /** Resolve "auto"/"default" and fix impossible m3g without libs. */
    function normalizeBackend() {
      if (backend === "auto" || backend === "default") {
        backend = m3gLibsOk() ? "m3g" : "soft";
      }
      if (backend === "m3g" && !m3gLibsOk()) {
        backend = "soft";
      }
    }

    function ensureRenderer() {
      const THREE = getTHREE();
      if (!THREE) {
        return false;
      }
      if (!glCanvas) {
        glCanvas = document.createElement("canvas");
      }
      if (!renderer) {
        renderer = new THREE.WebGLRenderer({
          canvas: glCanvas,
          alpha: false,
          antialias: true,
          preserveDrawingBuffer: true,
        });
        if (THREE.SRGBColorSpace != null) {
          renderer.outputColorSpace = THREE.SRGBColorSpace;
        }
      }
      const dw = canvas.width | 0;
      const dh = canvas.height | 0;
      if (dw < 1 || dh < 1) {
        return false;
      }
      renderer.setPixelRatio(1);
      renderer.setSize(dw, dh, false);
      return true;
    }

    function hasRenderable3DFrame() {
      return renderer != null && glCanvas != null;
    }

    return {
      getBackend: function () {
        normalizeBackend();
        return backend;
      },
      getCapabilities: function () {
        normalizeBackend();
        return {
          backend: backend,
          m3gPresent: m3gLibsOk() ? 1 : 0,
          maxTriangles: 65535,
          depthBufferOption: 1,
        };
      },
      setTextureFilter: function () {},
      setTextureWrap: function () {},
      setBackend: function (b) {
        const s = String(b || "auto").toLowerCase();
        if (s === "soft") {
          backend = "soft";
          disposeM3gSceneOnly();
          disposeSoftImmediateScene();
          return null;
        }
        if (s === "auto" || s === "default") {
          if (m3gLibsOk()) {
            backend = "m3g";
          } else {
            backend = "soft";
          }
          disposeM3gSceneOnly();
          disposeSoftImmediateScene();
          return null;
        }
        if (s === "m3g") {
          const err = m3gErrMsg();
          if (err) {
            return err;
          }
          backend = "m3g";
          disposeSoftImmediateScene();
          return null;
        }
        backend = "soft";
        disposeM3gSceneOnly();
        disposeSoftImmediateScene();
        return null;
      },
      init: function () {
        inited = true;
        normalizeBackend();
      },
      setPerspective: function (fov, near, far) {
        softFov = fov != null ? Number(fov) : 60;
        softNear = near != null ? Number(near) : 0.1;
        softFar = far != null ? Number(far) : 2000;
      },
      setBackground: function (r, g, b) {
        bgR = r | 0;
        bgG = g | 0;
        bgB = b | 0;
      },
      setCamera: function (x, y, z) {
        softCamUseLookAt = false;
        softCamPx = x != null ? Number(x) : 0;
        softCamPy = y != null ? Number(y) : 0;
        softCamPz = z != null ? Number(z) : 5.5;
      },
      setLookAt: function (ex, ey, ez, tx, ty, tz, ux, uy, uz) {
        softCamUseLookAt = true;
        softLookEx = ex != null ? Number(ex) : 0;
        softLookEy = ey != null ? Number(ey) : 0;
        softLookEz = ez != null ? Number(ez) : 5;
        softLookTx = tx != null ? Number(tx) : 0;
        softLookTy = ty != null ? Number(ty) : 0;
        softLookTz = tz != null ? Number(tz) : 0;
        softLookUx = ux != null ? Number(ux) : 0;
        softLookUy = uy != null ? Number(uy) : 1;
        softLookUz = uz != null ? Number(uz) : 0;
      },
      setMaxTriangles: function () {},
      setBackfaceCulling: function (on) {
        softBackfaceCull = !!on;
      },
      setGlobalLight: function (dx, dy, dz) {
        softLightDx = dx != null ? Number(dx) : 0;
        softLightDy = dy != null ? Number(dy) : 1;
        softLightDz = dz != null ? Number(dz) : 0;
      },
      setMaterialAmbient: function (r, g, b) {
        softAmbR = r | 0;
        softAmbG = g | 0;
        softAmbB = b | 0;
      },
      setMaterialDiffuse: function (r, g, b) {
        softDiffR = r | 0;
        softDiffG = g | 0;
        softDiffB = b | 0;
      },
      setTexture: function (path) {
        softTexturePath = path != null ? String(path) : null;
      },
      setTexCoords: function (uvs) {
        if (!uvs || typeof uvs.length !== "number") {
          softUv = null;
          return;
        }
        if (uvs instanceof Float32Array) {
          softUv = uvs;
        } else {
          softUv = new Float32Array(uvs.length);
          for (let i = 0; i < uvs.length; i++) {
            softUv[i] = uvs[i];
          }
        }
      },
      setDepthBuffer: function () {},
      setTriangleStripMesh: function (positions, stripLens, normals) {
        softPositions =
          positions && positions.length != null
            ? positions instanceof Float32Array
              ? positions
              : new Float32Array(positions)
            : null;
        if (!stripLens || typeof stripLens.length !== "number") {
          softStripLens = null;
        } else if (stripLens instanceof Int32Array) {
          softStripLens = stripLens;
        } else {
          softStripLens = new Int32Array(stripLens.length);
          for (let i = 0; i < stripLens.length; i++) {
            softStripLens[i] = stripLens[i] | 0;
          }
        }
        softNormals =
          normals && normals.length != null
            ? normals instanceof Float32Array
              ? normals
              : new Float32Array(normals)
            : null;
      },
      setIndexedMesh: function () {},
      pushObjectMatrix: function () {},
      popObjectMatrix: function () {},
      clearMesh: function () {
        disposeM3gSceneOnly();
        disposeSoftImmediateScene();
        disposeRendererFull();
        softPositions = null;
        softNormals = null;
        softStripLens = null;
        softUv = null;
        softTexturePath = null;
      },
      setMeshRotation: function (degrees) {
        softMeshRotationDeg = degrees != null ? Number(degrees) : 0;
      },
      setObjectMatrix: function () {},
      setObjectMatrixIdentity: function () {
        softMeshRotationDeg = 0;
      },
      load: function (path) {
        normalizeBackend();
        if (backend !== "m3g") {
          return 'Render3D.load: need m3g backend (setBackend("m3g") or use default "auto" with THREE+AthenaM3G)';
        }
        if (!m3gLibsOk()) {
          return m3gErrMsg() || "m3g not available";
        }
        const THREE = getTHREE();
        const p = normalizePath(path);
        const bytes = bytesFromFileMap(p);
        if (!bytes || bytes.length < 12) {
          const all = Object.keys(fileMap).filter(function (k) {
            return k.indexOf(":") < 0 && k.toLowerCase().endsWith(".m3g");
          });
          const got = bytes ? bytes.length + " bytes" : "null";
          const msg =
            "m3g load: file not found or empty: " + p +
            " (resolved=" + (resolveFileMapKey(p) || "<none>") + ", bytes=" + got +
            ", available .m3g=[" + all.join(", ") + "])";
          logErr(msg);
          return msg;
        }
        const ir = globalThis.AthenaM3G.parseFile(bytes);
        if (!ir.ok) {
          logErr("m3g parse failed for " + p + ": " + (ir.error || "?"));
          return ir.error || "m3g parse failed";
        }
        disposeM3gSceneOnly();
        disposeSoftImmediateScene();
        m3gIr = ir;
        m3gCtx = globalThis.AthenaM3G.buildThreeScene(ir, THREE, {});
        if (m3gCtx.error) {
          const msg = m3gCtx.error;
          m3gCtx = null;
          m3gIr = null;
          return msg;
        }
        if (typeof performance !== "undefined" && typeof performance.now === "function") {
          m3gSceneLoadPerf = performance.now();
        } else {
          m3gSceneLoadPerf = Date.now();
        }
        m3gAnimUseHostTime = false;
        return null;
      },
      getSceneInfo: function () {
        let extra = "";
        if (m3gIr && m3gIr.ok) {
          extra = " m3gObjects=" + (m3gIr.objects.length - 1);
        }
        return "sim backend=" + backend + " inited=" + (inited ? 1 : 0) + extra;
      },
      worldAnimate: function (timeMs) {
        lastAnimMs = +timeMs;
        m3gAnimUseHostTime = true;
      },
      m3gNodeTranslate: function (userId, dx, dy, dz) {
        if (backend !== "m3g" || !m3gCtx) {
          return m3gErrMsg() || "no scene";
        }
        const n = m3gCtx.userIdToObject[userId | 0];
        if (!n) {
          return "m3gNode: unknown userId " + userId;
        }
        n.position.x += dx;
        n.position.y += dy;
        n.position.z += dz;
        return null;
      },
      m3gNodeSetTranslation: function (userId, x, y, z) {
        if (backend !== "m3g" || !m3gCtx) {
          return m3gErrMsg() || "no scene";
        }
        const n = m3gCtx.userIdToObject[userId | 0];
        if (!n) {
          return "m3gNode: unknown userId " + userId;
        }
        n.position.set(x, y, z);
        return null;
      },
      m3gNodeGetTranslation: function (userId) {
        if (backend !== "m3g" || !m3gCtx) {
          return null;
        }
        const n = m3gCtx.userIdToObject[userId | 0];
        if (!n) {
          return null;
        }
        const p = n.position;
        return [p.x, p.y, p.z];
      },
      m3gNodeSetOrientation: function (userId, angleDeg, ax, ay, az) {
        const THREE = getTHREE();
        if (backend !== "m3g" || !m3gCtx || !THREE) {
          return m3gErrMsg() || "no scene";
        }
        const n = m3gCtx.userIdToObject[userId | 0];
        if (!n) {
          return "m3gNode: unknown userId " + userId;
        }
        const len = Math.sqrt(ax * ax + ay * ay + az * az);
        if (len > 1e-6) {
          n.quaternion.setFromAxisAngle(
            new THREE.Vector3(ax / len, ay / len, az / len),
            (angleDeg * Math.PI) / 180
          );
        }
        return null;
      },
      m3gAnimSetActiveInterval: function (userId, startMs, endMs) {
        if (backend !== "m3g" || !m3gIr) {
          return m3gErrMsg() || "no scene";
        }
        const uid = userId | 0;
        animOverrides[uid] = animOverrides[uid] || {};
        animOverrides[uid].activeStart = startMs | 0;
        animOverrides[uid].activeEnd = endMs | 0;
        return null;
      },
      m3gAnimSetPosition: function (userId, sequence, timeMs) {
        void sequence;
        if (backend !== "m3g" || !m3gIr) {
          return m3gErrMsg() || "no scene";
        }
        const uid = userId | 0;
        animOverrides[uid] = animOverrides[uid] || {};
        animOverrides[uid].positionMs = timeMs;
        return null;
      },
      m3gAnimSetSpeed: function (userId, speed) {
        if (backend !== "m3g" || !m3gIr) {
          return m3gErrMsg() || "no scene";
        }
        const uid = userId | 0;
        animOverrides[uid] = animOverrides[uid] || {};
        animOverrides[uid].speed = speed;
        return null;
      },
      m3gKeyframeDurationTrack0: function (userId) {
        if (!m3gIr || !m3gIr.ok || typeof globalThis.AthenaM3G === "undefined") {
          return -1;
        }
        return globalThis.AthenaM3G.keyframeDurationTrack0(m3gIr, userId | 0);
      },
      begin: function () {
        normalizeBackend();
        let cr = bgR;
        let cg = bgG;
        let cb = bgB;
        if (backend === "m3g" && m3gCtx && m3gCtx.scene && m3gCtx.scene.background) {
          const scBg = m3gCtx.scene.background;
          if (scBg && scBg.isColor) {
            cr = Math.round(Math.max(0, Math.min(255, scBg.r * 255)));
            cg = Math.round(Math.max(0, Math.min(255, scBg.g * 255)));
            cb = Math.round(Math.max(0, Math.min(255, scBg.b * 255)));
          }
        }
        frameClearR = cr;
        frameClearG = cg;
        frameClearB = cb;
        const THREE = getTHREE();
        if (!THREE || !ensureRenderer()) {
          return;
        }
        renderer.setClearColor(new THREE.Color(cr / 255, cg / 255, cb / 255), 1);
        if (THREE.LinearToneMapping != null && THREE.NoToneMapping != null) {
          renderer.toneMapping =
            backend === "m3g" ? THREE.LinearToneMapping : THREE.NoToneMapping;
        }
        if (renderer.toneMappingExposure !== undefined) {
          renderer.toneMappingExposure = backend === "m3g" ? 1.12 : 1.0;
        }
      },
      render: function () {
        normalizeBackend();
        const THREE = getTHREE();
        const useImmediate =
          backend === "soft" ||
          (backend === "m3g" && (!m3gCtx || !m3gIr || !m3gIr.ok));
        if (useImmediate) {
          if (!THREE || !ensureRenderer()) {
            return;
          }
          renderSoftImmediate(THREE);
          return;
        }
        if (backend !== "m3g" || !m3gCtx || !m3gIr || !m3gIr.ok) {
          return;
        }
        if (!ensureRenderer()) {
          return;
        }
        const cam = m3gCtx.camera;
        const dh = canvas.height | 0;
        const dw = canvas.width | 0;
        if (
          cam &&
          cam.isPerspectiveCamera &&
          !cam.userData.m3gPreserveProjection
        ) {
          cam.aspect = dh > 0 ? dw / dh : 1;
          cam.updateProjectionMatrix();
        }
        let animMs = lastAnimMs;
        if (
          !m3gAnimUseHostTime &&
          m3gSceneLoadPerf > 0 &&
          typeof performance !== "undefined" &&
          typeof performance.now === "function"
        ) {
          animMs = performance.now() - m3gSceneLoadPerf;
        }
        globalThis.AthenaM3G.stepAnimations(m3gIr, {
          THREE: THREE,
          threeByIndex: m3gCtx.threeByIndex,
          animOverrides: animOverrides,
        }, animMs);
        renderer.render(m3gCtx.scene, cam);
      },
      end: function () {
        if (!hasRenderable3DFrame()) {
          if (backend === "soft" || backend === "m3g") {
            try {
              activeCtx.save();
              activeCtx.globalCompositeOperation = "source-over";
              activeCtx.fillStyle =
                "rgb(" + frameClearR + "," + frameClearG + "," + frameClearB + ")";
              activeCtx.fillRect(0, 0, activeW, activeH);
              activeCtx.restore();
            } catch (e) {
              logErr("Render3D.end: " + (e.message || e));
            }
          }
          return;
        }
        try {
          activeCtx.save();
          activeCtx.globalCompositeOperation = "source-over";
          activeCtx.fillStyle =
            "rgb(" + frameClearR + "," + frameClearG + "," + frameClearB + ")";
          activeCtx.fillRect(0, 0, activeW, activeH);
          activeCtx.drawImage(glCanvas, 0, 0, activeW, activeH);
          activeCtx.restore();
        } catch (e) {
          logErr("Render3D.end: " + (e.message || e));
        }
      },
    };
  })();

  /** Athena2ME modules expect the same globals as main.js; dynamic Functions do not close over this IIFE. */
  const moduleCache = {};
  function buildGlobalsForModule() {
    return {
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
      Pool: PoolBase,
      localStorage: localStorage,
      LZ4: LZ4,
      DEFLATE: DEFLATE,
      ZIP: ZIP,
      Render3D: Render3D,
    };
  }
  function requireFn(p) {
    const path = normalizePath(p);
    if (moduleCache[path]) {
      return moduleCache[path];
    }
    const enc = fileMap[path + ":encoding"];
    let src = fileMap[path];
    if (src == null || enc === "base64" || enc === "webview-uri") {
      return undefined;
    }
    const exports = {};
    const module = { exports: exports };
    try {
      const g = buildGlobalsForModule();
      const injectKeys = Object.keys(g).filter(function (k) {
        return k !== "exports" && k !== "module" && k !== "require";
      });
      const injectVals = injectKeys.map(function (k) {
        return g[k];
      });
      const factory = new Function("exports", "module", "require", ...injectKeys, String(src));
      factory.apply(null, [exports, module, requireFn].concat(injectVals));
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
    const enc = fileMap[path + ":encoding"];
    const src = fileMap[path];
    if (src == null || enc === "base64" || enc === "webview-uri") {
      return;
    }
    try {
      const g = buildGlobalsForModule();
      const keys = Object.keys(g);
      const vals = keys.map(function (k) {
        return g[k];
      });
      new Function(...keys, String(src)).apply(null, vals);
    } catch (e) {
      logErr("loadScript " + path + ": " + e.message);
    }
  }

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

    const globals = buildGlobalsForModule();

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
    interpreterBootMs = Date.now();
    resetSessionFs();
    spriteBatchActive = false;
    spriteBatchQueue = [];
    let sfxi;
    for (sfxi = 0; sfxi < sfxSlots.length; sfxi++) {
      sfxSlots[sfxi] = null;
    }
    for (const ck in m3gWebviewCache) {
      if (Object.prototype.hasOwnProperty.call(m3gWebviewCache, ck)) {
        delete m3gWebviewCache[ck];
      }
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
      prefetchM3gWebviewBinaries(function () {
        startBootSequence(bootCfg);
      });
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
