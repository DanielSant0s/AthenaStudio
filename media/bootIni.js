/**
 * Parses /boot.ini like BootIniConfig.java (splash slides, tick, boot handoff, es6).
 * Exposes window.__ATHENA_BOOT_INI__.parse(text).
 */
(function (global) {
  var HANDOFF_IMMEDIATE = 0;
  var HANDOFF_AFTER_SLIDE = 1;

  function trim(s) {
    var a = 0;
    var b = s.length;
    while (a < b && s.charAt(a) <= " ") {
      a++;
    }
    while (b > a && s.charAt(b - 1) <= " ") {
      b--;
    }
    return s.substring(a, b);
  }

  function lc(s) {
    var n = s.length;
    var out = "";
    for (var i = 0; i < n; i++) {
      var c = s.charAt(i);
      if (c >= "A" && c <= "Z") {
        c = String.fromCharCode(c.charCodeAt(0) + 32);
      }
      out += c;
    }
    return out;
  }

  function parseInt10(s, def) {
    if (s == null || s.length === 0) {
      return def;
    }
    try {
      return parseInt(trim(s), 10);
    } catch (e) {
      return def;
    }
  }

  function parseColor(s, defRgb) {
    if (s == null || s.length === 0) {
      return defRgb;
    }
    var x = trim(s);
    if (x.charAt(0) === "#") {
      x = x.substring(1);
    }
    try {
      if (x.length === 6) {
        return parseInt(x, 16);
      }
      if (x.length === 8) {
        return parseInt(x, 16) & 0xffffff;
      }
    } catch (e) {}
    return defRgb;
  }

  function parseTextAlign(s, def) {
    if (s == null) {
      return def;
    }
    var u = lc(trim(s));
    if (u === "center" || u === "centre" || u === "middle") {
      return 1;
    }
    if (u === "right") {
      return 2;
    }
    if (u === "left") {
      return 0;
    }
    return def;
  }

  function fontSizeFromString(s) {
    var u = lc(s);
    if (u === "small") {
      return 8;
    }
    if (u === "large") {
      return 16;
    }
    return 0;
  }

  function parseDigitsInt(key, start) {
    var n = key.length - start;
    if (n <= 0) {
      return -1;
    }
    for (var i = 0; i < n; i++) {
      var c = key.charAt(start + i);
      if (c < "0" || c > "9") {
        return -1;
      }
    }
    try {
      return parseInt(key.substring(start), 10);
    } catch (e) {
      return -1;
    }
  }

  function maxIndexForPrefixGroup(sec, prefixes) {
    var m = -1;
    for (var k in sec) {
      if (!Object.prototype.hasOwnProperty.call(sec, k)) {
        continue;
      }
      for (var p = 0; p < prefixes.length; p++) {
        var pre = prefixes[p];
        if (k.length > pre.length && k.indexOf(pre) === 0) {
          var idx = parseDigitsInt(k, pre.length);
          if (idx >= 0 && idx > m) {
            m = idx;
          }
        }
      }
    }
    return m;
  }

  function applySlideKeys(sl, sec) {
    sl.backgroundRgb = parseColor(sec.background, sl.backgroundRgb);
    sl.holdMs = Math.max(0, parseInt10(sec.holdms, sl.holdMs));

    var legX = parseInt10(sec.textx, 0);
    var legY = parseInt10(sec.texty, 0);
    var legColor = parseColor(sec.textcolor, 0xffffff);
    var legFont = 0;
    if (sec.textsize != null) {
      legFont = fontSizeFromString(sec.textsize);
    }
    var legAlign = parseTextAlign(sec.textalign, 0);
    var legIX = parseInt10(sec.imagex, 0);
    var legIY = parseInt10(sec.imagey, 0);
    var legIXs = sec.imagex != null ? trim(sec.imagex) : null;
    var legIYs = sec.imagey != null ? trim(sec.imagey) : null;

    var maxT = maxIndexForPrefixGroup(sec, ["text.", "textx.", "texty.", "textsize.", "textcolor."]);
    if (maxT < 0) {
      var one = {
        text: "",
        x: legX,
        y: legY,
        xSpec: null,
        ySpec: null,
        align: legAlign,
        fontSize: legFont,
        colorRgb: legColor,
      };
      var t0 = sec.text;
      if (t0 != null) {
        one.text = t0;
      }
      var txs = sec.textx;
      if (txs != null) {
        one.xSpec = trim(txs);
        one.x = parseInt10(txs, legX);
      }
      var tys = sec.texty;
      if (tys != null) {
        one.ySpec = trim(tys);
        one.y = parseInt10(tys, legY);
      }
      sl.textItems = [one];
    } else {
      var arr = [];
      for (var i = 0; i <= maxT; i++) {
        var item = {
          text: "",
          x: legX,
          y: legY,
          xSpec: null,
          ySpec: null,
          align: legAlign,
          fontSize: legFont,
          colorRgb: legColor,
        };
        var ti = sec["text." + i];
        if (ti == null && i === 0) {
          ti = sec.text;
        }
        if (ti != null) {
          item.text = ti;
        }
        var xis = sec["textx." + i];
        if (xis != null) {
          item.xSpec = trim(xis);
          item.x = parseInt10(xis, legX);
        } else {
          item.x = legX;
        }
        var yis = sec["texty." + i];
        if (yis != null) {
          item.ySpec = trim(yis);
          item.y = parseInt10(yis, legY);
        } else {
          item.y = legY;
        }
        var tsi = sec["textsize." + i];
        if (tsi != null) {
          item.fontSize = fontSizeFromString(tsi);
        } else {
          item.fontSize = legFont;
        }
        var tci = sec["textcolor." + i];
        if (tci != null) {
          item.colorRgb = parseColor(tci, legColor);
        } else {
          item.colorRgb = legColor;
        }
        var tai = sec["textalign." + i];
        if (tai != null) {
          item.align = parseTextAlign(tai, legAlign);
        } else {
          item.align = legAlign;
        }
        arr.push(item);
      }
      sl.textItems = arr;
    }

    var maxI = maxIndexForPrefixGroup(sec, ["image.", "imagex.", "imagey."]);
    if (maxI < 0) {
      var im = { path: "", x: legIX, y: legIY, xSpec: legIXs, ySpec: legIYs };
      var ip = sec.image;
      if (ip != null) {
        im.path = trim(ip);
      }
      sl.imageItems = [im];
    } else {
      var iarr = [];
      for (var j = 0; j <= maxI; j++) {
        var im2 = { path: "", x: legIX, y: legIY, xSpec: null, ySpec: null };
        var pj = sec["image." + j];
        if (pj == null && j === 0) {
          pj = sec.image;
        }
        if (pj != null) {
          im2.path = trim(pj);
        }
        var ixs = sec["imagex." + j];
        if (ixs != null) {
          im2.xSpec = trim(ixs);
          im2.x = parseInt10(ixs, legIX);
        } else {
          im2.x = legIX;
        }
        var iys = sec["imagey." + j];
        if (iys != null) {
          im2.ySpec = trim(iys);
          im2.y = parseInt10(iys, legIY);
        } else {
          im2.y = legIY;
        }
        iarr.push(im2);
      }
      sl.imageItems = iarr;
    }
  }

  function parseIni(text) {
    var sections = {};
    var cur = "";
    var len = text.length;
    var i = 0;
    while (i < len) {
      var lineEnd = text.indexOf("\n", i);
      if (lineEnd < 0) {
        lineEnd = len;
      }
      var line = text.substring(i, lineEnd);
      if (line.length > 0 && line.charAt(line.length - 1) === "\r") {
        line = line.substring(0, line.length - 1);
      }
      i = lineEnd + 1;

      line = trim(line);
      if (line.length === 0) {
        continue;
      }
      if (line.charAt(0) === "#") {
        continue;
      }
      if (line.charAt(0) === "[") {
        var end = line.indexOf("]");
        if (end > 1) {
          cur = lc(line.substring(1, end));
        }
        continue;
      }
      var eq = line.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      var key = trim(line.substring(0, eq));
      var val = trim(line.substring(eq + 1));
      if (key.length === 0) {
        continue;
      }
      if (!sections[cur]) {
        sections[cur] = {};
      }
      sections[cur][lc(key)] = val;
    }

    var tick = 50;
    var tickSec = sections.tick;
    if (tickSec) {
      tick = parseInt10(tickSec.ms, 50);
    }

    var handoff = HANDOFF_AFTER_SLIDE;
    var es6 = true;
    var bootSec = sections.boot;
    if (bootSec) {
      var h = bootSec.handoff;
      if (h != null) {
        if (lc(trim(h)) === "immediate") {
          handoff = HANDOFF_IMMEDIATE;
        } else {
          handoff = HANDOFF_AFTER_SLIDE;
        }
      }
      var es6s = bootSec.es6;
      if (es6s != null) {
        var u = lc(trim(es6s));
        if (u === "0" || u === "false" || u === "no" || u === "off" || u === "legacy") {
          es6 = false;
        } else {
          es6 = true;
        }
      }
    }

    var maxIdx = -1;
    for (var sn in sections) {
      if (!Object.prototype.hasOwnProperty.call(sections, sn)) {
        continue;
      }
      if (sn.indexOf("splash.") === 0) {
        try {
          var idx2 = parseInt(sn.substring("splash.".length), 10);
          if (!isNaN(idx2) && idx2 > maxIdx) {
            maxIdx = idx2;
          }
        } catch (e2) {}
      }
    }

    var count = maxIdx + 1;
    if (bootSec) {
      var declared = parseInt10(bootSec.slides, -1);
      if (declared >= 0) {
        count = declared;
      }
    }

    if (count <= 0) {
      return { tickMs: tick, handoffPolicy: handoff, es6: es6, slides: [] };
    }

    var slides = [];
    for (var k = 0; k < count; k++) {
      var slide = {
        backgroundRgb: 0x000000,
        textItems: [],
        imageItems: [],
        holdMs: 800,
      };
      var sec2 = sections["splash." + k];
      if (sec2) {
        applySlideKeys(slide, sec2);
      }
      slides.push(slide);
    }
    return { tickMs: tick, handoffPolicy: handoff, es6: es6, slides: slides };
  }

  function stripBom(text) {
    if (
      text.length >= 3 &&
      text.charCodeAt(0) === 0xfeff
    ) {
      return text.substring(1);
    }
    if (
      text.length >= 3 &&
      text.charCodeAt(0) === 0xef &&
      text.charCodeAt(1) === 0xbb &&
      text.charCodeAt(2) === 0xbf
    ) {
      return text.substring(3);
    }
    return text;
  }

  function parseBootIni(text) {
    if (text == null || typeof text !== "string") {
      return { tickMs: 50, handoffPolicy: HANDOFF_AFTER_SLIDE, es6: true, slides: [] };
    }
    try {
      return parseIni(stripBom(text));
    } catch (e) {
      return { tickMs: 50, handoffPolicy: HANDOFF_AFTER_SLIDE, es6: true, slides: [] };
    }
  }

  function hex6Rgb(rgb) {
    var n = (rgb != null ? rgb : 0) & 0xffffff;
    var x = n.toString(16);
    while (x.length < 6) {
      x = "0" + x;
    }
    return "#" + x;
  }

  function alignKey(a) {
    if (a === 1) {
      return "center";
    }
    if (a === 2) {
      return "right";
    }
    return "left";
  }

  function sizeKey(fs) {
    if (fs === 8) {
      return "SMALL";
    }
    if (fs === 16) {
      return "LARGE";
    }
    return "MEDIUM";
  }

  function coordLine(spec, num) {
    if (spec != null && String(spec).length > 0) {
      return String(spec);
    }
    return String(num != null ? num : 0);
  }

  /** Round-trip from parseBootIni() result to boot.ini text (indexed keys, lowercase). */
  function serializeBootIni(cfg) {
    var lines = [];
    lines.push("# boot.ini — AthenaStudio (visual editor)");
    lines.push("");
    lines.push("[tick]");
    lines.push("ms=" + (cfg.tickMs > 0 ? cfg.tickMs : 50));
    lines.push("");
    lines.push("[boot]");
    var slides = cfg.slides || [];
    var n = slides.length;
    lines.push("slides=" + n);
    lines.push(
      "handoff=" + (cfg.handoffPolicy === HANDOFF_IMMEDIATE ? "immediate" : "after_slide")
    );
    lines.push("es6=" + (cfg.es6 === false ? "false" : "true"));
    lines.push("");
    var si, sl, ti, ii, t, im, tx, ty, ix, iy;
    for (si = 0; si < n; si++) {
      sl = slides[si];
      if (!sl) {
        sl = {
          backgroundRgb: 0,
          holdMs: 800,
          textItems: [],
          imageItems: [],
        };
      }
      lines.push("[splash." + si + "]");
      lines.push("background=" + hex6Rgb(sl.backgroundRgb));
      lines.push("holdms=" + (sl.holdMs != null ? sl.holdMs : 800));
      if (sl.textItems) {
        for (ti = 0; ti < sl.textItems.length; ti++) {
          t = sl.textItems[ti];
          if (!t) {
            continue;
          }
          lines.push("text." + ti + "=" + (t.text != null ? t.text : ""));
          tx = coordLine(t.xSpec, t.x);
          ty = coordLine(t.ySpec, t.y);
          lines.push("textx." + ti + "=" + tx);
          lines.push("texty." + ti + "=" + ty);
          lines.push("textsize." + ti + "=" + sizeKey(t.fontSize));
          lines.push("textcolor." + ti + "=" + hex6Rgb(t.colorRgb));
          lines.push("textalign." + ti + "=" + alignKey(t.align));
        }
      }
      if (sl.imageItems) {
        for (ii = 0; ii < sl.imageItems.length; ii++) {
          im = sl.imageItems[ii];
          if (!im) {
            continue;
          }
          lines.push("image." + ii + "=" + (im.path != null ? im.path : ""));
          ix = coordLine(im.xSpec, im.x);
          iy = coordLine(im.ySpec, im.y);
          lines.push("imagex." + ii + "=" + ix);
          lines.push("imagey." + ii + "=" + iy);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  global.__ATHENA_BOOT_INI__ = {
    parse: parseBootIni,
    serialize: serializeBootIni,
    HANDOFF_IMMEDIATE: HANDOFF_IMMEDIATE,
    HANDOFF_AFTER_SLIDE: HANDOFF_AFTER_SLIDE,
  };
})(typeof window !== "undefined" ? window : this);
