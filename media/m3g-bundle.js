/**
 * AthenaStudio — JSR-184 M3G file parser + Three.js scene builder (simulator only).
 * Format: https://nikita36078.github.io/J2ME_Docs/docs/jsr184/file-format.html
 */
(function (global) {
  "use strict";

  var OBJ = {
    HEADER: 0,
    ANIMATION_CONTROLLER: 1,
    ANIMATION_TRACK: 2,
    APPEARANCE: 3,
    BACKGROUND: 4,
    CAMERA: 5,
    COMPOSITING_MODE: 6,
    FOG: 7,
    POLYGON_MODE: 8,
    GROUP: 9,
    IMAGE2D: 10,
    TRIANGLE_STRIP_ARRAY: 11,
    LIGHT: 12,
    MATERIAL: 13,
    MESH: 14,
    MORPHING_MESH: 15,
    SKINNED_MESH: 16,
    TEXTURE2D: 17,
    SPRITE: 18,
    KEYFRAME_SEQUENCE: 19,
    VERTEX_ARRAY: 20,
    VERTEX_BUFFER: 21,
    WORLD: 22,
    EXTERNAL_REF: 255,
  };

  /** @enum {number} javax.microedition.m3g.AnimationTrack (JSR-184 constant-values) */
  var PROP = {
    ALPHA: 256,
    AMBIENT_COLOR: 257,
    COLOR: 258,
    CROP: 259,
    DENSITY: 260,
    DIFFUSE_COLOR: 261,
    EMISSIVE_COLOR: 262,
    FAR_DISTANCE: 263,
    FIELD_OF_VIEW: 264,
    INTENSITY: 265,
    MORPH_WEIGHTS: 266,
    NEAR_DISTANCE: 267,
    ORIENTATION: 268,
    PICKABILITY: 269,
    SCALE: 270,
    SHININESS: 271,
    SPECULAR_COLOR: 272,
    SPOT_ANGLE: 273,
    SPOT_EXPONENT: 274,
    TRANSLATION: 275,
    VISIBILITY: 276,
  };

  var IMG_FMT = { ALPHA: 96, LUMINANCE: 97, LUMINANCE_ALPHA: 98, RGB: 99, RGBA: 100 };

  var LIGHT_MODE = { AMBIENT: 128, DIRECTIONAL: 129, OMNI: 130, SPOT: 131 };

  var CAM_PROJ = { GENERIC: 48, PARALLEL: 49, PERSPECTIVE: 50 };

  var FOG_MODE = { EXPONENTIAL: 80, LINEAR: 81 };

  var TEX_WRAP = { CLAMP: 240, REPEAT: 241 };

  /** javax.microedition.m3g.Texture2D filters */
  var TEX_FILTER = { BASE_LEVEL: 208, LINEAR: 209, NEAREST: 210 };

  /** javax.microedition.m3g.PolygonMode (see JSR-184 constant-values.html — not KeyframeSequence/Node). */
  var WINDING = { CCW: 168, CW: 169 };
  var SHADE = { FLAT: 164, SMOOTH: 165 };
  var CULL = { BACK: 160, FRONT: 161, NONE: 162 };

  /** javax.microedition.m3g.Background */
  var BG_EDGE = { BORDER: 32, REPEAT: 33 };

  /** javax.microedition.m3g.KeyframeSequence — interpolation types */
  var KF_INTERP = { LINEAR: 176, SLERP: 177, SPLINE: 178, SQUAD: 179, STEP: 180 };
  /** javax.microedition.m3g.KeyframeSequence — repeat modes (not the same numeric space as interpolation) */
  var KF_REPEAT = { CONSTANT: 192, LOOP: 193 };

  function errMsg(e) {
    return e && e.message ? e.message : String(e);
  }

  function BR(buf, off) {
    this.buf = buf;
    this.o = off | 0;
  }
  BR.prototype.left = function () {
    return this.buf.length - this.o;
  };
  BR.prototype.need = function (n) {
    if (this.left() < n) {
      throw new Error("M3G read past end");
    }
  };
  BR.prototype.u8 = function () {
    this.need(1);
    return this.buf[this.o++];
  };
  BR.prototype.u16 = function () {
    this.need(2);
    return this.buf[this.o++] | (this.buf[this.o++] << 8);
  };
  BR.prototype.i16 = function () {
    var v = this.u16();
    return v > 0x7fff ? v - 0x10000 : v;
  };
  BR.prototype.u32 = function () {
    this.need(4);
    return (
      this.buf[this.o++] |
      (this.buf[this.o++] << 8) |
      (this.buf[this.o++] << 16) |
      (this.buf[this.o++] << 24)
    ) >>> 0;
  };
  BR.prototype.i32 = function () {
    var v = this.u32();
    return v | 0;
  };
  BR.prototype.f32 = function () {
    this.need(4);
    var i = this.u32();
    var dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, i, true);
    return dv.getFloat32(0, true);
  };
  BR.prototype.bool = function () {
    var b = this.u8();
    if (b > 1) {
      throw new Error("M3G invalid boolean");
    }
    return b === 1;
  };
  BR.prototype.ref = function (currentIndex) {
    var r = this.u32();
    if (r === 0) {
      return 0;
    }
    if (r > currentIndex) {
      throw new Error("M3G invalid object ref " + r + " > " + currentIndex);
    }
    return r;
  };
  BR.prototype.refArray = function (currentIndex) {
    var n = this.u32();
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(this.ref(currentIndex));
    }
    return out;
  };
  BR.prototype.stringUtf8 = function () {
    var end = this.o;
    while (end < this.buf.length && this.buf[end] !== 0) {
      end++;
    }
    if (end >= this.buf.length) {
      throw new Error("M3G unterminated string");
    }
    var slice = this.buf.subarray(this.o, end);
    this.o = end + 1;
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(slice);
    }
    var s = "";
    for (var i = 0; i < slice.length; i++) {
      s += String.fromCharCode(slice[i]);
    }
    return s;
  };
  BR.prototype.colorRgb = function () {
    return { r: this.u8(), g: this.u8(), b: this.u8() };
  };
  BR.prototype.colorRgba = function () {
    return { r: this.u8(), g: this.u8(), b: this.u8(), a: this.u8() };
  };
  BR.prototype.vec3 = function () {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  };
  BR.prototype.matrix = function () {
    var m = new Float32Array(16);
    for (var i = 0; i < 16; i++) {
      m[i] = this.f32();
    }
    return m;
  };
  BR.prototype.byteArrayCounted = function () {
    var n = this.u32();
    this.need(n);
    var out = new Uint8Array(n);
    out.set(this.buf.subarray(this.o, this.o + n));
    this.o += n;
    return out;
  };

  function parseObject3D(br, idx) {
    var userID = br.u32();
    var animTracks = br.refArray(idx);
    var userParamCount = br.u32();
    var seen = Object.create(null);
    var userParams = [];
    for (var i = 0; i < userParamCount; i++) {
      var pid = br.u32();
      if (seen[pid]) {
        throw new Error("M3G duplicate user parameter id");
      }
      seen[pid] = true;
      userParams.push({ id: pid, value: br.byteArrayCounted() });
    }
    return { userID: userID, animationTracks: animTracks, userParameters: userParams };
  }

  function parseTransformable(br) {
    var hasComp = br.bool();
    var trans = { x: 0, y: 0, z: 0 };
    var scale = { x: 1, y: 1, z: 1 };
    var oriAng = 0;
    var oriAxis = { x: 0, y: 1, z: 0 };
    var gen = null;
    if (hasComp) {
      trans = br.vec3();
      scale = br.vec3();
      oriAng = br.f32();
      oriAxis = br.vec3();
    }
    var hasGen = br.bool();
    if (hasGen) {
      gen = br.matrix();
    }
    return {
      hasComponentTransform: hasComp,
      translation: trans,
      scale: scale,
      orientationAngle: oriAng,
      orientationAxis: oriAxis,
      hasGeneralTransform: hasGen,
      generalMatrix: gen,
    };
  }

  function parseNode(br, idx) {
    var enableRendering = br.bool();
    var enablePicking = br.bool();
    var alphaFactor = br.u8();
    var scope = br.u32();
    var hasAlignment = br.bool();
    var alignment = null;
    if (hasAlignment) {
      alignment = {
        zTarget: br.u8(),
        yTarget: br.u8(),
        zRef: br.ref(idx),
        yRef: br.ref(idx),
      };
    }
    return {
      enableRendering: enableRendering,
      enablePicking: enablePicking,
      alphaFactor: alphaFactor,
      scope: scope,
      hasAlignment: hasAlignment,
      alignment: alignment,
    };
  }

  function parseKeyframeSequence(br, idx) {
    var interpolation = br.u8();
    var repeatMode = br.u8();
    var encoding = br.u8();
    var duration = br.u32();
    var validFirst = br.u32();
    var validLast = br.u32();
    var compCount = br.u32();
    var kfCount = br.u32();
    var keyframes = [];
    var i;
    var k;
    var bias;
    var scalev;
    var t;
    if (encoding === 0) {
      for (i = 0; i < kfCount; i++) {
        t = br.u32();
        var vec0 = [];
        for (k = 0; k < compCount; k++) {
          vec0.push(br.f32());
        }
        keyframes.push({ time: t, value: vec0 });
      }
    } else if (encoding === 1) {
      bias = [];
      scalev = [];
      for (k = 0; k < compCount; k++) {
        bias.push(br.f32());
      }
      for (k = 0; k < compCount; k++) {
        scalev.push(br.f32());
      }
      for (i = 0; i < kfCount; i++) {
        t = br.u32();
        var vec1 = [];
        for (k = 0; k < compCount; k++) {
          var b = br.u8();
          vec1.push(bias[k] + (b / 255.0) * scalev[k]);
        }
        keyframes.push({ time: t, value: vec1 });
      }
    } else if (encoding === 2) {
      bias = [];
      scalev = [];
      for (k = 0; k < compCount; k++) {
        bias.push(br.f32());
      }
      for (k = 0; k < compCount; k++) {
        scalev.push(br.f32());
      }
      for (i = 0; i < kfCount; i++) {
        t = br.u32();
        var vec2 = [];
        for (k = 0; k < compCount; k++) {
          var w = br.u16();
          vec2.push(bias[k] + (w / 65535.0) * scalev[k]);
        }
        keyframes.push({ time: t, value: vec2 });
      }
    } else {
      throw new Error("M3G KeyframeSequence invalid encoding " + encoding);
    }
    return {
      interpolation: interpolation,
      repeatMode: repeatMode,
      duration: duration,
      validRangeFirst: validFirst,
      validRangeLast: validLast,
      componentCount: compCount,
      keyframes: keyframes,
    };
  }

  function parseVertexArray(br, idx) {
    var componentSize = br.u8();
    var componentCount = br.u8();
    var encoding = br.u8();
    var vertexCount = br.u16();
    var vertices = [];
    var acc = [];
    var v;
    var c;
    for (var vi = 0; vi < vertexCount; vi++) {
      var comps = [];
      for (c = 0; c < componentCount; c++) {
        if (componentSize === 1) {
          var bv = br.u8();
          if (encoding === 0) {
            comps.push(bv);
          } else {
            var ac = acc[c] != null ? acc[c] : 0;
            ac = (ac + bv) & 0xff;
            acc[c] = ac;
            comps.push(ac);
          }
        } else if (componentSize === 2) {
          var sv = br.i16();
          if (encoding === 0) {
            comps.push(sv);
          } else {
            var ac2 = acc[c] != null ? acc[c] : 0;
            ac2 = (ac2 + sv) | 0;
            if (ac2 > 32767) {
              ac2 -= 0x10000;
            }
            if (ac2 < -32768) {
              ac2 += 0x10000;
            }
            acc[c] = ac2;
            comps.push(ac2);
          }
        } else {
          throw new Error("M3G VertexArray bad componentSize");
        }
      }
      vertices.push(comps);
    }
    return {
      componentSize: componentSize,
      componentCount: componentCount,
      encoding: encoding,
      vertexCount: vertexCount,
      vertices: vertices,
    };
  }

  function decodePositions(va, bias, scale) {
    var out = new Float32Array(va.vertexCount * 3);
    var j = 0;
    for (var i = 0; i < va.vertexCount; i++) {
      var row = va.vertices[i];
      for (var c = 0; c < 3; c++) {
        var raw = row[c];
        if (va.componentSize === 1 && raw > 127) {
          raw -= 256;
        } else if (va.componentSize === 2 && raw > 32767) {
          raw -= 65536;
        }
        out[j++] = bias[c] + scale * raw;
      }
    }
    return out;
  }

  function decodeNormals(va) {
    var out = new Float32Array(va.vertexCount * 3);
    var j = 0;
    for (var i = 0; i < va.vertexCount; i++) {
      var row = va.vertices[i];
      if (va.componentSize === 1) {
        for (var c = 0; c < 3; c++) {
          out[j++] = (row[c] / 255.0) * 2 - 1;
        }
      } else {
        for (var c2 = 0; c2 < 3; c2++) {
          out[j++] = row[c2] / 32767.0;
        }
      }
    }
    return out;
  }

  function decodeTexCoords(va, bias, scale) {
    var cc = va.componentCount;
    var out = new Float32Array(va.vertexCount * cc);
    var j = 0;
    for (var i = 0; i < va.vertexCount; i++) {
      var row = va.vertices[i];
      for (var c = 0; c < cc; c++) {
        var raw = row[c];
        if (va.componentSize === 1 && raw > 127) {
          raw -= 256;
        } else if (va.componentSize === 2 && raw > 32767) {
          raw -= 65536;
        }
        var sc = c < 3 ? scale : 1;
        var bi = c < 3 ? bias[c] : 0;
        out[j++] = bi + sc * raw;
      }
    }
    return out;
  }

  function decodeVertexColors(va) {
    if (va.componentCount < 3) {
      return null;
    }
    var out = new Float32Array(va.vertexCount * 3);
    var j = 0;
    var i;
    var row;
    var c;
    var denom = va.componentSize === 1 ? 255.0 : 65535.0;
    for (i = 0; i < va.vertexCount; i++) {
      row = va.vertices[i];
      for (c = 0; c < 3; c++) {
        var raw = row[c];
        out[j++] =
          va.componentSize === 1 ? raw / denom : (raw < 0 ? raw + 65536 : raw) / denom;
      }
    }
    return out;
  }

  function expandTriangleStrips(stripLens, indices) {
    var tris = [];
    var o = 0;
    var s;
    var si;
    for (s = 0; s < stripLens.length; s++) {
      var L = stripLens[s];
      if (L < 3) {
        o += L;
        continue;
      }
      for (si = 2; si < L; si++) {
        var i0 = indices[o + si - 2];
        var i1 = indices[o + si - 1];
        var i2 = indices[o + si];
        if ((si & 1) === 0) {
          tris.push(i0, i1, i2);
        } else {
          tris.push(i1, i0, i2);
        }
      }
      o += L;
    }
    return tris;
  }

  function parseTriangleStripArray(br, idx) {
    var encoding = br.u8();
    var explicit = (encoding & 0x80) !== 0;
    var idxW = encoding & 0x7f;
    var startIndex = 0;
    var indexList = null;
    if (!explicit) {
      if (idxW === 0) {
        startIndex = br.u32();
      } else if (idxW === 1) {
        startIndex = br.u8();
      } else if (idxW === 2) {
        startIndex = br.u16();
      } else {
        throw new Error("M3G TriangleStripArray bad implicit encoding");
      }
    } else {
      var count = br.u32();
      indexList = [];
      var ii;
      if (idxW === 0) {
        for (ii = 0; ii < count; ii++) {
          indexList.push(br.u32());
        }
      } else if (idxW === 1) {
        for (ii = 0; ii < count; ii++) {
          indexList.push(br.u8());
        }
      } else if (idxW === 2) {
        for (ii = 0; ii < count; ii++) {
          indexList.push(br.u16());
        }
      } else {
        throw new Error("M3G TriangleStripArray bad explicit encoding");
      }
    }
    var stripCount = br.u32();
    var stripLens = [];
    var j;
    for (j = 0; j < stripCount; j++) {
      stripLens.push(br.u32());
    }
    var flatIndices;
    if (!explicit) {
      var total = 0;
      for (j = 0; j < stripLens.length; j++) {
        total += stripLens[j];
      }
      flatIndices = [];
      for (j = 0; j < total; j++) {
        flatIndices.push(startIndex + j);
      }
    } else {
      flatIndices = indexList;
    }
    return { stripLengths: stripLens, flatIndices: flatIndices };
  }

  function parseImage2D(br, idx) {
    var format = br.u8();
    var isMutable = br.bool();
    var width = br.u32();
    var height = br.u32();
    var palette = new Uint8Array(0);
    var pixels = new Uint8Array(0);
    if (!isMutable) {
      palette = br.byteArrayCounted();
      pixels = br.byteArrayCounted();
    }
    return {
      type: OBJ.IMAGE2D,
      format: format,
      isMutable: isMutable,
      width: width,
      height: height,
      palette: palette,
      pixels: pixels,
    };
  }

  function dispatchParse(type, data, br, objIndex) {
    var o = { objectType: type };
    var base;
    if (type === OBJ.HEADER) {
      var verA = br.u8();
      var verB = br.u8();
      o.version = [verA, verB];
      o.hasExternalReferences = br.bool();
      o.totalFileSize = br.u32();
      o.approximateContentSize = br.u32();
      o.authoringField = br.stringUtf8();
      return o;
    }
    if (type === OBJ.EXTERNAL_REF) {
      o.uri = br.stringUtf8();
      return o;
    }

    base = parseObject3D(br, objIndex);
    Object.assign(o, base);

    function needTransformable() {
      var t = parseTransformable(br);
      Object.assign(o, t);
    }
    function needNode() {
      needTransformable();
      Object.assign(o, parseNode(br, objIndex));
    }

    switch (type) {
      case OBJ.ANIMATION_CONTROLLER:
        o.speed = br.f32();
        o.weight = br.f32();
        o.activeIntervalStart = br.i32();
        o.activeIntervalEnd = br.i32();
        o.referenceSequenceTime = br.f32();
        o.referenceWorldTime = br.i32();
        break;
      case OBJ.ANIMATION_TRACK:
        o.keyframeSequenceRef = br.ref(objIndex);
        o.animationControllerRef = br.ref(objIndex);
        o.propertyID = br.u32();
        break;
      case OBJ.APPEARANCE:
        o.layer = br.u8();
        o.compositingModeRef = br.ref(objIndex);
        o.fogRef = br.ref(objIndex);
        o.polygonModeRef = br.ref(objIndex);
        o.materialRef = br.ref(objIndex);
        o.textureRefs = br.refArray(objIndex);
        break;
      case OBJ.BACKGROUND:
        o.backgroundColor = br.colorRgba();
        o.backgroundImageRef = br.ref(objIndex);
        o.backgroundImageModeX = br.u8();
        o.backgroundImageModeY = br.u8();
        o.cropX = br.i32();
        o.cropY = br.i32();
        o.cropWidth = br.i32();
        o.cropHeight = br.i32();
        o.depthClearEnabled = br.bool();
        o.colorClearEnabled = br.bool();
        break;
      case OBJ.CAMERA:
        needNode();
        o.projectionType = br.u8();
        if (o.projectionType === CAM_PROJ.GENERIC) {
          o.projectionMatrix = br.matrix();
        } else {
          o.fovy = br.f32();
          o.aspectRatio = br.f32();
          o.near = br.f32();
          o.far = br.f32();
        }
        break;
      case OBJ.COMPOSITING_MODE:
        o.depthTestEnabled = br.bool();
        o.depthWriteEnabled = br.bool();
        o.colorWriteEnabled = br.bool();
        o.alphaWriteEnabled = br.bool();
        o.blending = br.u8();
        o.alphaThreshold = br.u8();
        o.depthOffsetFactor = br.f32();
        o.depthOffsetUnits = br.f32();
        break;
      case OBJ.FOG:
        o.fogColor = br.colorRgb();
        o.fogMode = br.u8();
        if (o.fogMode === FOG_MODE.EXPONENTIAL) {
          o.fogDensity = br.f32();
        } else if (o.fogMode === FOG_MODE.LINEAR) {
          o.fogNear = br.f32();
          o.fogFar = br.f32();
        }
        break;
      case OBJ.POLYGON_MODE:
        o.culling = br.u8();
        o.shading = br.u8();
        o.winding = br.u8();
        o.twoSidedLightingEnabled = br.bool();
        o.localCameraLightingEnabled = br.bool();
        o.perspectiveCorrectionEnabled = br.bool();
        break;
      case OBJ.GROUP: {
        needNode();
        o.childRefs = br.refArray(objIndex);
        break;
      }
      case OBJ.IMAGE2D: {
        Object.assign(o, parseImage2D(br, objIndex));
        break;
      }
      case OBJ.TRIANGLE_STRIP_ARRAY: {
        Object.assign(o, parseTriangleStripArray(br, objIndex));
        break;
      }
      case OBJ.LIGHT:
        needNode();
        o.attenuationConstant = br.f32();
        o.attenuationLinear = br.f32();
        o.attenuationQuadratic = br.f32();
        o.lightColor = br.colorRgb();
        o.lightMode = br.u8();
        o.intensity = br.f32();
        o.spotAngle = br.f32();
        o.spotExponent = br.f32();
        break;
      case OBJ.MATERIAL:
        o.ambientColor = br.colorRgb();
        o.diffuseColor = br.colorRgba();
        o.emissiveColor = br.colorRgb();
        o.specularColor = br.colorRgb();
        o.shininess = br.f32();
        o.vertexColorTrackingEnabled = br.bool();
        break;
      case OBJ.MESH:
      case OBJ.MORPHING_MESH:
      case OBJ.SKINNED_MESH: {
        needNode();
        o.vertexBufferRef = br.ref(objIndex);
        var smc = br.u32();
        o.submeshes = [];
        var sm;
        for (sm = 0; sm < smc; sm++) {
          o.submeshes.push({
            indexBufferRef: br.ref(objIndex),
            appearanceRef: br.ref(objIndex),
          });
        }
        if (type === OBJ.MORPHING_MESH) {
          var mtc = br.u32();
          o.morphTargets = [];
          var mt;
          for (mt = 0; mt < mtc; mt++) {
            o.morphTargets.push({ bufferRef: br.ref(objIndex), weight: br.f32() });
          }
        } else if (type === OBJ.SKINNED_MESH) {
          o.skeletonRef = br.ref(objIndex);
          var trc = br.u32();
          o.skinTransforms = [];
          var tr;
          for (tr = 0; tr < trc; tr++) {
            o.skinTransforms.push({
              nodeRef: br.ref(objIndex),
              firstVertex: br.u32(),
              vertexCount: br.u32(),
              weight: br.i32(),
            });
          }
        }
        break;
      }
      case OBJ.TEXTURE2D:
        needTransformable();
        o.imageRef = br.ref(objIndex);
        o.blendColor = br.colorRgb();
        o.blending = br.u8();
        o.wrappingS = br.u8();
        o.wrappingT = br.u8();
        o.levelFilter = br.u8();
        o.imageFilter = br.u8();
        break;
      case OBJ.SPRITE:
        needNode();
        o.spriteImageRef = br.ref(objIndex);
        o.spriteAppearanceRef = br.ref(objIndex);
        o.isScaled = br.bool();
        o.spriteCropX = br.i32();
        o.spriteCropY = br.i32();
        o.spriteCropW = br.i32();
        o.spriteCropH = br.i32();
        break;
      case OBJ.KEYFRAME_SEQUENCE:
        Object.assign(o, parseKeyframeSequence(br, objIndex));
        o.userID = base.userID;
        o.animationTracks = base.animationTracks;
        o.userParameters = base.userParameters;
        break;
      case OBJ.VERTEX_ARRAY:
        Object.assign(o, parseVertexArray(br, objIndex));
        break;
      case OBJ.VERTEX_BUFFER:
        o.defaultColor = br.colorRgba();
        o.positionsRef = br.ref(objIndex);
        o.positionBias = [br.f32(), br.f32(), br.f32()];
        o.positionScale = br.f32();
        o.normalsRef = br.ref(objIndex);
        o.colorsRef = br.ref(objIndex);
        var tcc = br.u32();
        o.texcoordRefs = [];
        o.texCoordBias = [];
        o.texCoordScale = [];
        var ti;
        for (ti = 0; ti < tcc; ti++) {
          o.texcoordRefs.push(br.ref(objIndex));
          o.texCoordBias.push([br.f32(), br.f32(), br.f32()]);
          o.texCoordScale.push(br.f32());
        }
        break;
      case OBJ.WORLD: {
        needNode();
        o.childRefs = br.refArray(objIndex);
        o.activeCameraRef = br.ref(objIndex);
        o.backgroundRef = br.ref(objIndex);
        break;
      }
      default:
        throw new Error("M3G unsupported object type " + type);
    }
    return o;
  }

  function inflateObjects(scheme, comp, uncompLen) {
    if (scheme === 0) {
      return comp;
    }
    if (scheme !== 1) {
      throw new Error("M3G bad CompressionScheme " + scheme);
    }
    var f = global.fflate;
    if (!f) {
      throw new Error("M3G zlib: fflate not loaded");
    }
    var opts = uncompLen > 0 ? { out: new Uint8Array(uncompLen) } : undefined;
    var out;
    var firstErr = null;
    if (typeof f.unzlibSync === "function") {
      try {
        out = opts ? f.unzlibSync(comp, opts) : f.unzlibSync(comp);
      } catch (e) {
        firstErr = e;
      }
    }
    if (out == null && typeof f.inflateSync === "function") {
      try {
        out = opts ? f.inflateSync(comp, opts) : f.inflateSync(comp);
      } catch (e) {
        if (!firstErr) firstErr = e;
      }
    }
    if (out == null && typeof f.decompressSync === "function") {
      try {
        out = opts ? f.decompressSync(comp, opts) : f.decompressSync(comp);
      } catch (e) {
        if (!firstErr) firstErr = e;
      }
    }
    if (out == null) {
      throw firstErr || new Error("M3G zlib decode failed");
    }
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  function parseObjectsBlob(blob, startIndex) {
    var objects = [null];
    var br = new BR(blob, 0);
    var objIndex = startIndex;
    while (br.left() > 0) {
      objIndex++;
      var objectType = br.u8();
      var length = br.u32();
      br.need(length);
      var dataSlice = br.buf.subarray(br.o, br.o + length);
      br.o += length;
      var sub = new BR(dataSlice, 0);
      var parsed;
      try {
        parsed = dispatchParse(objectType, dataSlice, sub, objIndex);
      } catch (e) {
        return { error: errMsg(e), objects: objects, nextIndex: objIndex };
      }
      if (sub.left() !== 0) {
        return {
          error: "M3G extra bytes in object " + objectType + " (" + sub.left() + " left)",
          objects: objects,
          nextIndex: objIndex,
        };
      }
      parsed.objectType = objectType;
      parsed._index = objIndex;
      objects[objIndex] = parsed;
    }
    return { error: null, objects: objects, nextIndex: objIndex };
  }

  function parseFile(buffer) {
    if (!(buffer instanceof Uint8Array) || buffer.length < 12) {
      return { ok: false, error: "M3G: invalid buffer" };
    }
    var sig = [
      0xab, 0x4a, 0x53, 0x52, 0x31, 0x38, 0x34, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ];
    var i;
    for (i = 0; i < 12; i++) {
      if (buffer[i] !== sig[i]) {
        return { ok: false, error: "M3G: bad file signature" };
      }
    }
    var pos = 12;
    var merged = [null];
    var nextIdx = 0;
    try {
      while (pos < buffer.length) {
        if (pos + 13 > buffer.length) {
          return { ok: false, error: "M3G: truncated section" };
        }
        var scheme = buffer[pos];
        var dv = new DataView(buffer.buffer, buffer.byteOffset + pos + 1);
        var totalLen = dv.getUint32(0, true);
        var uncomp = dv.getUint32(4, true);
        if (totalLen < 13) {
          return { ok: false, error: "M3G: bad section length" };
        }
        var objBytesLen = totalLen - 13;
        if (pos + totalLen > buffer.length) {
          return { ok: false, error: "M3G: section past EOF" };
        }
        var compSlice = buffer.subarray(pos + 9, pos + 9 + objBytesLen);
        var chk = new DataView(buffer.buffer, buffer.byteOffset + pos + 9 + objBytesLen).getUint32(0, true);
        void chk;
        var rawObjects = inflateObjects(scheme, compSlice, uncomp);
        var chunk = parseObjectsBlob(rawObjects, nextIdx);
        if (chunk.error) {
          return { ok: false, error: chunk.error, partial: chunk.objects };
        }
        for (i = 1; i < chunk.objects.length; i++) {
          if (chunk.objects[i]) {
            merged[i] = chunk.objects[i];
          }
        }
        nextIdx = chunk.nextIndex;
        pos += totalLen;
      }
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    var roots = [];
    var referenced = Object.create(null);
    function markRef(r) {
      if (r > 0) {
        referenced[r] = true;
      }
    }
    function walkObj(ob) {
      if (!ob) {
        return;
      }
      var k;
      var arr;
      if (ob.animationTracks) {
        arr = ob.animationTracks;
        for (k = 0; k < arr.length; k++) {
          markRef(arr[k]);
        }
      }
      switch (ob.objectType) {
        case OBJ.APPEARANCE:
          markRef(ob.compositingModeRef);
          markRef(ob.fogRef);
          markRef(ob.polygonModeRef);
          markRef(ob.materialRef);
          if (ob.textureRefs) {
            for (k = 0; k < ob.textureRefs.length; k++) {
              markRef(ob.textureRefs[k]);
            }
          }
          break;
        case OBJ.BACKGROUND:
          markRef(ob.backgroundImageRef);
          break;
        case OBJ.ANIMATION_TRACK:
          markRef(ob.keyframeSequenceRef);
          markRef(ob.animationControllerRef);
          break;
        case OBJ.MESH:
        case OBJ.MORPHING_MESH:
        case OBJ.SKINNED_MESH:
          markRef(ob.vertexBufferRef);
          if (ob.submeshes) {
            for (k = 0; k < ob.submeshes.length; k++) {
              markRef(ob.submeshes[k].indexBufferRef);
              markRef(ob.submeshes[k].appearanceRef);
            }
          }
          if (ob.morphTargets) {
            for (k = 0; k < ob.morphTargets.length; k++) {
              markRef(ob.morphTargets[k].bufferRef);
            }
          }
          if (ob.skeletonRef) {
            markRef(ob.skeletonRef);
          }
          if (ob.skinTransforms) {
            for (k = 0; k < ob.skinTransforms.length; k++) {
              markRef(ob.skinTransforms[k].nodeRef);
            }
          }
          break;
        case OBJ.VERTEX_BUFFER:
          markRef(ob.positionsRef);
          markRef(ob.normalsRef);
          markRef(ob.colorsRef);
          if (ob.texcoordRefs) {
            for (k = 0; k < ob.texcoordRefs.length; k++) {
              markRef(ob.texcoordRefs[k]);
            }
          }
          break;
        case OBJ.TEXTURE2D:
          markRef(ob.imageRef);
          break;
        case OBJ.SPRITE:
          markRef(ob.spriteImageRef);
          markRef(ob.spriteAppearanceRef);
          break;
        case OBJ.WORLD:
          markRef(ob.activeCameraRef);
          markRef(ob.backgroundRef);
        /* fallthrough */
        case OBJ.GROUP:
          if (ob.childRefs) {
            for (k = 0; k < ob.childRefs.length; k++) {
              markRef(ob.childRefs[k]);
            }
          }
          break;
        case OBJ.CAMERA:
        case OBJ.LIGHT:
          if (ob.alignment) {
            markRef(ob.alignment.zRef);
            markRef(ob.alignment.yRef);
          }
          break;
        default:
          break;
      }
    }
    for (i = 1; i < merged.length; i++) {
      walkObj(merged[i]);
    }
    for (i = 1; i < merged.length; i++) {
      if (merged[i] && !referenced[i]) {
        roots.push(i);
      }
    }
    return { ok: true, objects: merged, roots: roots };
  }

  function image2DToDataTexture(imgObj, THREE) {
    var w = imgObj.width | 0;
    var h = imgObj.height | 0;
    var fmt = imgObj.format;
    var px = imgObj.pixels;
    var pal = imgObj.palette;
    var rgba = new Uint8Array(w * h * 4);
    var x;
    var y;
    var o;
    function setPx(dy, dx, r, g, b, a) {
      // JSR-184 image origin is top-left; OpenGL/three.js textures are bottom-left → flip Y here.
      var fy = h - 1 - dy;
      var oo = (fy * w + dx) * 4;
      rgba[oo] = r;
      rgba[oo + 1] = g;
      rgba[oo + 2] = b;
      rgba[oo + 3] = a;
    }
    var paletted = pal && pal.length > 0;
    var palStride = 0;
    if (paletted) {
      if (fmt === IMG_FMT.RGB || fmt === IMG_FMT.LUMINANCE) {
        palStride = 3;
      } else if (fmt === IMG_FMT.RGBA || fmt === IMG_FMT.LUMINANCE_ALPHA) {
        palStride = 4;
      } else if (fmt === IMG_FMT.ALPHA) {
        palStride = 1;
      } else {
        // Unknown format with palette → guess from sizes
        palStride = Math.max(1, Math.floor(pal.length / 256));
      }
    }
    function paletteSample(idx, isAlphaOnly) {
      var off = (idx & 0xff) * palStride;
      if (palStride === 4) {
        return [pal[off], pal[off + 1], pal[off + 2], pal[off + 3]];
      }
      if (palStride === 3) {
        return [pal[off], pal[off + 1], pal[off + 2], 255];
      }
      if (palStride === 1) {
        if (isAlphaOnly) {
          return [255, 255, 255, pal[off]];
        }
        return [pal[off], pal[off], pal[off], 255];
      }
      return [255, 255, 255, 255];
    }
    if (paletted) {
      var isAlpha = fmt === IMG_FMT.ALPHA;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var idx = px[y * w + x];
          var c = paletteSample(idx, isAlpha);
          setPx(y, x, c[0], c[1], c[2], c[3]);
        }
      }
    } else if (fmt === IMG_FMT.RGBA) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var s0 = (y * w + x) * 4;
          setPx(y, x, px[s0], px[s0 + 1], px[s0 + 2], px[s0 + 3]);
        }
      }
    } else if (fmt === IMG_FMT.RGB) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var s1 = (y * w + x) * 3;
          setPx(y, x, px[s1], px[s1 + 1], px[s1 + 2], 255);
        }
      }
    } else if (fmt === IMG_FMT.LUMINANCE) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var lum = px[y * w + x];
          setPx(y, x, lum, lum, lum, 255);
        }
      }
    } else if (fmt === IMG_FMT.ALPHA) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          setPx(y, x, 255, 255, 255, px[y * w + x]);
        }
      }
    } else if (fmt === IMG_FMT.LUMINANCE_ALPHA) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var s2 = (y * w + x) * 2;
          setPx(y, x, px[s2], px[s2], px[s2], px[s2 + 1]);
        }
      }
    } else {
      for (o = 0; o < rgba.length; o += 4) {
        rgba[o] = 200;
        rgba[o + 1] = 100;
        rgba[o + 2] = 200;
        rgba[o + 3] = 255;
      }
    }
    var tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
    tex.needsUpdate = true;
    if (THREE.SRGBColorSpace != null) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    return tex;
  }

  /** Apply Texture2D levelFilter / imageFilter + mild anisotropy (helps ground at grazing angles). */
  function applyM3GTexture2DSampling(tex, t2, THREE) {
    var iw = tex.image.width | 0;
    var ih = tex.image.height | 0;
    function isPow2(v) {
      return v > 0 && (v & (v - 1)) === 0;
    }
    var pot = isPow2(iw) && isPow2(ih);
    var magF = t2.imageFilter === TEX_FILTER.NEAREST ? THREE.NearestFilter : THREE.LinearFilter;
    tex.magFilter = magF;
    var lev = t2.levelFilter != null ? t2.levelFilter : TEX_FILTER.LINEAR;
    if (lev === TEX_FILTER.BASE_LEVEL) {
      tex.generateMipmaps = false;
      tex.minFilter = magF;
    } else if (lev === TEX_FILTER.NEAREST) {
      tex.generateMipmaps = pot;
      tex.minFilter = pot ? THREE.NearestMipMapNearestFilter : THREE.NearestFilter;
    } else {
      tex.generateMipmaps = pot;
      tex.minFilter = pot ? THREE.LinearMipMapLinearFilter : THREE.LinearFilter;
    }
    tex.anisotropy = 8;
  }

  /**
   * Approximate M3G FUNC_MODULATE across texture units: tex0×tex1×… in RGBA.
   * Assumes same texcoords on all units (common for modulate detail + base).
   */
  function multiplyTwoDataTextures(tA, tB, THREE) {
    var ia = tA.image;
    var ib = tB.image;
    var wa = ia.width | 0;
    var ha = ia.height | 0;
    var wb = ib.width | 0;
    var hb = ib.height | 0;
    var w = wa;
    var h = ha;
    var da = ia.data;
    var db = ib.data;
    var out = new Uint8Array(w * h * 4);
    var x;
    var y;
    var oa;
    var ob;
    var bx;
    var by;
    for (y = 0; y < h; y++) {
      by = hb > 1 ? ((y * (hb - 1)) / Math.max(1, h - 1)) | 0 : 0;
      if (by >= hb) {
        by = hb - 1;
      }
      for (x = 0; x < w; x++) {
        bx = wb > 1 ? ((x * (wb - 1)) / Math.max(1, w - 1)) | 0 : 0;
        if (bx >= wb) {
          bx = wb - 1;
        }
        var iax = (y * wa + x) * 4;
        oa = (y * w + x) * 4;
        ob = (by * wb + bx) * 4;
        out[oa] = Math.min(255, ((da[iax] * db[ob]) / 255) | 0);
        out[oa + 1] = Math.min(255, ((da[iax + 1] * db[ob + 1]) / 255) | 0);
        out[oa + 2] = Math.min(255, ((da[iax + 2] * db[ob + 2]) / 255) | 0);
        out[oa + 3] = Math.min(255, ((da[iax + 3] * db[ob + 3]) / 255) | 0);
      }
    }
    var tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
    tex.needsUpdate = true;
    if (THREE.SRGBColorSpace != null) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    return tex;
  }

  function multiplyDataTextureChain(texList, THREE) {
    if (!texList || texList.length === 0) {
      return null;
    }
    if (texList.length === 1) {
      return texList[0];
    }
    var acc = texList[0];
    var u;
    for (u = 1; u < texList.length; u++) {
      acc = multiplyTwoDataTextures(acc, texList[u], THREE);
    }
    return acc;
  }

  /** Top-left row-major RGBA (M3G / screen space). For background crop, not GL flip. */
  function image2DToTopLeftRGBA(imgObj) {
    var w = imgObj.width | 0;
    var h = imgObj.height | 0;
    var fmt = imgObj.format;
    var px = imgObj.pixels;
    var pal = imgObj.palette;
    var rgba = new Uint8Array(w * h * 4);
    var x;
    var y;
    function setTl(ty, tx, r, g, b, a) {
      var oo = (ty * w + tx) * 4;
      rgba[oo] = r;
      rgba[oo + 1] = g;
      rgba[oo + 2] = b;
      rgba[oo + 3] = a;
    }
    var paletted = pal && pal.length > 0;
    var palStride = 0;
    if (paletted) {
      if (fmt === IMG_FMT.RGB || fmt === IMG_FMT.LUMINANCE) {
        palStride = 3;
      } else if (fmt === IMG_FMT.RGBA || fmt === IMG_FMT.LUMINANCE_ALPHA) {
        palStride = 4;
      } else if (fmt === IMG_FMT.ALPHA) {
        palStride = 1;
      } else {
        palStride = Math.max(1, Math.floor(pal.length / 256));
      }
    }
    function paletteSample(idx, isAlphaOnly) {
      var off = (idx & 0xff) * palStride;
      if (palStride === 4) {
        return [pal[off], pal[off + 1], pal[off + 2], pal[off + 3]];
      }
      if (palStride === 3) {
        return [pal[off], pal[off + 1], pal[off + 2], 255];
      }
      if (palStride === 1) {
        if (isAlphaOnly) {
          return [255, 255, 255, pal[off]];
        }
        return [pal[off], pal[off], pal[off], 255];
      }
      return [255, 255, 255, 255];
    }
    if (paletted) {
      var isAlpha = fmt === IMG_FMT.ALPHA;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var idx = px[y * w + x];
          var c = paletteSample(idx, isAlpha);
          setTl(y, x, c[0], c[1], c[2], c[3]);
        }
      }
    } else if (fmt === IMG_FMT.RGBA) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var s0 = (y * w + x) * 4;
          setTl(y, x, px[s0], px[s0 + 1], px[s0 + 2], px[s0 + 3]);
        }
      }
    } else if (fmt === IMG_FMT.RGB) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var s1 = (y * w + x) * 3;
          setTl(y, x, px[s1], px[s1 + 1], px[s1 + 2], 255);
        }
      }
    } else if (fmt === IMG_FMT.LUMINANCE) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var lum = px[y * w + x];
          setTl(y, x, lum, lum, lum, 255);
        }
      }
    } else if (fmt === IMG_FMT.ALPHA) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          setTl(y, x, 255, 255, 255, px[y * w + x]);
        }
      }
    } else if (fmt === IMG_FMT.LUMINANCE_ALPHA) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var s2 = (y * w + x) * 2;
          setTl(y, x, px[s2], px[s2], px[s2], px[s2 + 1]);
        }
      }
    } else {
      for (var o = 0; o < rgba.length; o += 4) {
        rgba[o] = 200;
        rgba[o + 1] = 100;
        rgba[o + 2] = 200;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  function resolveBgCoord(s, dim, mode) {
    if (dim <= 0) {
      return -1;
    }
    if (mode === BG_EDGE.REPEAT) {
      var m = s % dim;
      if (m < 0) {
        m += dim;
      }
      return m;
    }
    if (s >= 0 && s < dim) {
      return s;
    }
    return -1;
  }

  /**
   * Background crop → DataTexture (fills viewport in Three like M3G clear).
   * @returns {THREE.DataTexture|null}
   */
  function m3gBackgroundToDataTexture(bg, imgObj, THREE) {
    if (!bg || !imgObj || imgObj.objectType !== OBJ.IMAGE2D) {
      return null;
    }
    var iw = imgObj.width | 0;
    var ih = imgObj.height | 0;
    var cropW = bg.cropWidth | 0;
    var cropH = bg.cropHeight | 0;
    if (cropW <= 0 || cropH <= 0 || iw < 1 || ih < 1) {
      return null;
    }
    var bga = bg.backgroundColor || { r: 0, g: 0, b: 0, a: 255 };
    var br = bga.r | 0;
    var bgc = bga.g | 0;
    var bb = bga.b | 0;
    var modeX = bg.backgroundImageModeX;
    var modeY = bg.backgroundImageModeY;
    var cropX = bg.cropX | 0;
    var cropY = bg.cropY | 0;
    var src = image2DToTopLeftRGBA(imgObj);
    var out = new Uint8Array(cropW * cropH * 4);
    var dx;
    var dy;
    for (dy = 0; dy < cropH; dy++) {
      for (dx = 0; dx < cropW; dx++) {
        var sx = cropX + dx;
        var sy = cropY + dy;
        var ix = resolveBgCoord(sx, iw, modeX);
        var iy = resolveBgCoord(sy, ih, modeY);
        var oy = cropH - 1 - dy;
        var oo = (oy * cropW + dx) * 4;
        if (ix < 0 || iy < 0) {
          out[oo] = br;
          out[oo + 1] = bgc;
          out[oo + 2] = bb;
          out[oo + 3] = 255;
        } else {
          var si = (iy * iw + ix) * 4;
          out[oo] = src[si];
          out[oo + 1] = src[si + 1];
          out[oo + 2] = src[si + 2];
          out[oo + 3] = src[si + 3];
        }
      }
    }
    var tex = new THREE.DataTexture(out, cropW, cropH, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    if (THREE.SRGBColorSpace != null) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    return tex;
  }

  function applyTransformableToTHREE(ob, THREE, node) {
    if (ob.hasGeneralTransform && ob.generalMatrix) {
      var m = new THREE.Matrix4();
      m.fromArray(ob.generalMatrix);
      m.transpose();
      m.decompose(node.position, node.quaternion, node.scale);
      node.matrixAutoUpdate = true;
      return;
    }
    node.matrixAutoUpdate = true;
    if (ob.hasComponentTransform) {
      node.position.set(ob.translation.x, ob.translation.y, ob.translation.z);
      node.scale.set(ob.scale.x, ob.scale.y, ob.scale.z);
      var ax = ob.orientationAxis.x;
      var ay = ob.orientationAxis.y;
      var az = ob.orientationAxis.z;
      var len = Math.sqrt(ax * ax + ay * ay + az * az);
      if (len > 1e-6) {
        node.quaternion.setFromAxisAngle(
          new THREE.Vector3(ax / len, ay / len, az / len),
          (ob.orientationAngle * Math.PI) / 180
        );
      } else {
        node.quaternion.identity();
      }
    } else {
      node.position.set(0, 0, 0);
      node.scale.set(1, 1, 1);
      node.quaternion.identity();
    }
  }

  function wrapMode(THREE, b) {
    if (b === TEX_WRAP.CLAMP) {
      return THREE.ClampToEdgeWrapping;
    }
    return THREE.RepeatWrapping;
  }

  function buildThreeScene(ir, THREE, helpers) {
    if (!ir || !ir.ok) {
      return { error: "bad IR" };
    }
    var objects = ir.objects;
    var textureCache = Object.create(null);
    var modulateCache = Object.create(null);
    var threeByIndex = [];

    function m3gAttenToThreePoint(pl, ob) {
      var c = ob.attenuationConstant != null ? ob.attenuationConstant : 1;
      var l = ob.attenuationLinear != null ? ob.attenuationLinear : 0;
      var q = ob.attenuationQuadratic != null ? ob.attenuationQuadratic : 0;
      pl.decay = 0;
      pl.distance = 0;
      if (l === 0 && q === 0) {
        if (c > 0) {
          pl.intensity /= c;
        }
      } else {
        pl.decay = 2;
        if (c > 0) {
          pl.intensity /= c;
        }
      }
    }

    function m3gAttenToThreeSpot(spot, ob) {
      m3gAttenToThreePoint(spot, ob);
    }

    function getTex2D(ref) {
      if (!ref || !objects[ref]) {
        return null;
      }
      if (textureCache[ref]) {
        return textureCache[ref];
      }
      var t2 = objects[ref];
      if (t2.objectType !== OBJ.TEXTURE2D) {
        return null;
      }
      var imgRef = t2.imageRef;
      var img = imgRef ? objects[imgRef] : null;
      if (!img || img.objectType !== OBJ.IMAGE2D) {
        return null;
      }
      var tex = image2DToDataTexture(img, THREE);
      tex.wrapS = wrapMode(THREE, t2.wrappingS);
      tex.wrapT = wrapMode(THREE, t2.wrappingT);
      applyM3GTexture2DSampling(tex, t2, THREE);
      textureCache[ref] = tex;
      return tex;
    }

    /**
     * M3G "front" may be CW; Three FrontSide treats CCW as front, BackSide treats CW as front.
     * Adjust side instead of rewriting index buffers (preserves author normals + texture shading).
     */
    function m3gPolygonSide(pm) {
      if (!pm || pm.objectType !== OBJ.POLYGON_MODE) {
        return THREE.DoubleSide;
      }
      if (pm.twoSidedLightingEnabled) {
        return THREE.DoubleSide;
      }
      var cul = pm.culling;
      var m3gFrontIsCw = pm.winding === WINDING.CW;
      if (cul === CULL.NONE) {
        return THREE.DoubleSide;
      }
      if (cul === CULL.BACK) {
        return m3gFrontIsCw ? THREE.BackSide : THREE.FrontSide;
      }
      if (cul === CULL.FRONT) {
        return m3gFrontIsCw ? THREE.FrontSide : THREE.BackSide;
      }
      return THREE.DoubleSide;
    }

    function pickAppearanceTextureSlot(texRefs) {
      if (!texRefs || !texRefs.length) {
        return 0;
      }
      var ti;
      for (ti = 0; ti < texRefs.length; ti++) {
        if (texRefs[ti] && getTex2D(texRefs[ti])) {
          return ti;
        }
      }
      for (ti = 0; ti < texRefs.length; ti++) {
        if (texRefs[ti]) {
          return ti;
        }
      }
      return 0;
    }

    function buildAppearance(matRef, texRefs, polyMode, texSlot) {
      void texSlot;
      var pm = polyMode && polyMode.objectType === OBJ.POLYGON_MODE ? polyMode : null;
      var sideVal = m3gPolygonSide(pm);
      var flat = pm && pm.shading === SHADE.FLAT;
      var mat = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        side: sideVal,
        flatShading: flat,
      });
      if (objects[matRef] && objects[matRef].objectType === OBJ.MATERIAL) {
        var M = objects[matRef];
        var d = M.diffuseColor;
        mat.color.setRGB(d.r / 255, d.g / 255, d.b / 255);
        if (d.a < 255) {
          mat.transparent = true;
          mat.opacity = d.a / 255;
        }
        var ec = M.emissiveColor;
        mat.emissive.setRGB(ec.r / 255, ec.g / 255, ec.b / 255);
        var dc = M.specularColor;
        mat.specular.setRGB(dc.r / 255, dc.g / 255, dc.b / 255);
        mat.shininess = Math.min(M.shininess, 100);
      }
      if (texRefs && texRefs.length > 0) {
        var chainPairs = [];
        var tij;
        for (tij = 0; tij < texRefs.length; tij++) {
          if (texRefs[tij]) {
            var gtx = getTex2D(texRefs[tij]);
            if (gtx) {
              chainPairs.push({ tex: gtx, ref: texRefs[tij] });
            }
          }
        }
        if (chainPairs.length === 1) {
          mat.map = chainPairs[0].tex;
        } else if (chainPairs.length > 1) {
          var mkey = chainPairs.map(function (p) {
            return String(p.ref);
          }).join("+");
          var combCached = modulateCache[mkey];
          if (combCached) {
            mat.map = combCached;
          } else {
            var tchain = chainPairs.map(function (p) {
              return p.tex;
            });
            var comb = multiplyDataTextureChain(tchain, THREE);
            var t2First = objects[chainPairs[0].ref];
            if (t2First && t2First.objectType === OBJ.TEXTURE2D) {
              applyM3GTexture2DSampling(comb, t2First, THREE);
            }
            modulateCache[mkey] = comb;
            mat.map = comb;
          }
        }
        if (!mat.map) {
          var ti = pickAppearanceTextureSlot(texRefs);
          if (texRefs[ti]) {
            var trF = getTex2D(texRefs[ti]);
            if (trF) {
              mat.map = trF;
            }
          }
        }
      }
      if (mat.map) {
        mat.color.setRGB(1, 1, 1);
      }
      return mat;
    }

    function geometryFromMesh(meshObj, preferredTexUnit) {
      var vbRef = meshObj.vertexBufferRef;
      var vb = objects[vbRef];
      if (!vb || vb.objectType !== OBJ.VERTEX_BUFFER) {
        return null;
      }
      var posVA = objects[vb.positionsRef];
      if (!posVA || posVA.objectType !== OBJ.VERTEX_ARRAY) {
        return null;
      }
      var pos = decodePositions(posVA, vb.positionBias, vb.positionScale);
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      if (vb.normalsRef && objects[vb.normalsRef]) {
        var nVA = objects[vb.normalsRef];
        var nrm = decodeNormals(nVA);
        geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      } else {
        geo.computeVertexNormals();
      }
      
      if (vb.colorsRef && objects[vb.colorsRef]) {
        var cVA = objects[vb.colorsRef];
        if (cVA.objectType === OBJ.VERTEX_ARRAY) {
          var cols = decodeVertexColors(cVA);
          if (cols) {
            geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
          }
        }
      }
      if (vb.texcoordRefs && vb.texcoordRefs.length) {
        var pu = preferredTexUnit | 0;
        var uvOrder = [];
        if (pu >= 0 && pu < vb.texcoordRefs.length) {
          uvOrder.push(pu);
        }
        var ti;
        for (ti = 0; ti < vb.texcoordRefs.length; ti++) {
          if (ti !== pu) {
            uvOrder.push(ti);
          }
        }
        var oi;
        for (oi = 0; oi < uvOrder.length; oi++) {
          ti = uvOrder[oi];
          var trI = vb.texcoordRefs[ti];
          if (!trI || !objects[trI]) {
            continue;
          }
          var tVA = objects[trI];
          if (tVA.objectType !== OBJ.VERTEX_ARRAY) {
            continue;
          }
          var bias = vb.texCoordBias && vb.texCoordBias[ti] ? vb.texCoordBias[ti] : [0, 0, 0];
          var scaleV = vb.texCoordScale && vb.texCoordScale[ti] != null ? vb.texCoordScale[ti] : 1;
          var tc = decodeTexCoords(tVA, bias, scaleV);
          var dims = tVA.componentCount < 2 ? 2 : tVA.componentCount;
          geo.setAttribute("uv", new THREE.BufferAttribute(tc, dims));
          break;
        }
      }
      return { geometry: geo, vertexBuffer: vb };
    }

    function buildNodeSub(obIdx) {
      var ob = objects[obIdx];
      if (!ob) {
        return null;
      }
      var t = ob.objectType;
      if (t === OBJ.GROUP || t === OBJ.WORLD) {
        var g = new THREE.Group();
        applyTransformableToTHREE(ob, THREE, g);
        g.visible = ob.enableRendering !== false;
        g.userData.m3gIndex = obIdx;
        g.userData.userID = ob.userID;
        threeByIndex[obIdx] = g;
        var ch = ob.childRefs || [];
        var ci;
        for (ci = 0; ci < ch.length; ci++) {
          var c = buildNodeSub(ch[ci]);
          if (c) {
            g.add(c);
          }
        }
        return g;
      }
      if (t === OBJ.MESH || t === OBJ.MORPHING_MESH || t === OBJ.SKINNED_MESH) {
        var wg = new THREE.Group();
        applyTransformableToTHREE(ob, THREE, wg);
        wg.visible = ob.enableRendering !== false;
        wg.userData.m3gIndex = obIdx;
        wg.userData.userID = ob.userID;
        threeByIndex[obIdx] = wg;
        var vbQuick = objects[ob.vertexBufferRef];
        if (!vbQuick || vbQuick.objectType !== OBJ.VERTEX_BUFFER) {
          return wg;
        }
        var sm;
        for (sm = 0; sm < ob.submeshes.length; sm++) {
          var sub = ob.submeshes[sm];
          var ibuf = objects[sub.indexBufferRef];
          if (!ibuf || ibuf.objectType !== OBJ.TRIANGLE_STRIP_ARRAY) {
            continue;
          }
          var ap = objects[sub.appearanceRef];
          var matRef = 0;
          var texRefs = [];
          var polyModeObj = null;
          if (ap && ap.objectType === OBJ.APPEARANCE) {
            matRef = ap.materialRef;
            texRefs = ap.textureRefs || [];
            if (ap.polygonModeRef && objects[ap.polygonModeRef]) {
              polyModeObj = objects[ap.polygonModeRef];
            }
          }
          var texSlot = pickAppearanceTextureSlot(texRefs);
          var pack = geometryFromMesh(ob, texSlot);
          if (!pack) {
            continue;
          }
          var baseGeo = pack.geometry;
          var tris = expandTriangleStrips(ibuf.stripLengths, ibuf.flatIndices);
          var ix = new Uint32Array(tris.length);
          var ii;
          for (ii = 0; ii < tris.length; ii++) {
            ix[ii] = tris[ii];
          }
          var geom = baseGeo.clone();
          if (THREE.Uint32BufferAttribute != null) {
            geom.setIndex(new THREE.Uint32BufferAttribute(ix, 1));
          } else {
            geom.setIndex(new THREE.BufferAttribute(ix, 1));
          }
          var mate = buildAppearance(matRef, texRefs, polyModeObj, texSlot);
          if (pack.geometry && pack.geometry.attributes && pack.geometry.attributes.color) {
            var mOb = objects[matRef];
            if (
              mOb &&
              mOb.objectType === OBJ.MATERIAL &&
              mOb.vertexColorTrackingEnabled
            ) {
              mate.vertexColors = true;
            }
          }
          if (!mate.vertexColors && geom.getAttribute("color")) {
            geom.deleteAttribute("color");
          }
          geom.computeBoundingBox();
          geom.computeBoundingSphere();
          var mesh = new THREE.Mesh(geom, mate);
          mesh.frustumCulled = false;
          mesh.userData.m3gSubmesh = sm;
          wg.add(mesh);
        }
        return wg;
      }
      if (t === OBJ.CAMERA) {
        var cam;
        if (ob.projectionType === CAM_PROJ.PERSPECTIVE) {
          var fovDeg = ob.fovy;
          cam = new THREE.PerspectiveCamera(fovDeg, ob.aspectRatio || 1, ob.near, ob.far);
        } else if (ob.projectionType === CAM_PROJ.PARALLEL) {
          var ph = ob.fovy > 0 ? ob.fovy : 2;
          var paspect = ob.aspectRatio || 1;
          var pw = ph * paspect;
          cam = new THREE.OrthographicCamera(
            -pw / 2,
            pw / 2,
            ph / 2,
            -ph / 2,
            ob.near,
            ob.far
          );
        } else if (ob.projectionType === CAM_PROJ.GENERIC && ob.projectionMatrix) {
          cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
          cam.projectionMatrix.fromArray(ob.projectionMatrix);
          cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
          cam.userData.m3gPreserveProjection = true;
        } else {
          cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
        }
        var cg = new THREE.Group();
        applyTransformableToTHREE(ob, THREE, cg);
        cg.visible = ob.enableRendering !== false;
        cg.add(cam);
        cg.userData.m3gIndex = obIdx;
        cg.userData.userID = ob.userID;
        cg.userData.threeCamera = cam;
        threeByIndex[obIdx] = cg;
        return cg;
      }
      if (t === OBJ.LIGHT) {
        var lg = new THREE.Group();
        applyTransformableToTHREE(ob, THREE, lg);
        lg.visible = ob.enableRendering !== false;
        lg.userData.m3gIndex = obIdx;
        lg.userData.userID = ob.userID;
        threeByIndex[obIdx] = lg;
        var L = ob.lightMode;
        var col = ob.lightColor;
        var c = new THREE.Color(col.r / 255, col.g / 255, col.b / 255);
        if (L === LIGHT_MODE.AMBIENT) {
          var al = new THREE.AmbientLight(0xffffff, Math.max(0, ob.intensity));
          al.color.copy(c);
          lg.add(al);
        } else if (L === LIGHT_MODE.DIRECTIONAL) {
          var dlight = new THREE.DirectionalLight(0xffffff, Math.max(0, ob.intensity));
          dlight.color.copy(c);
          dlight.position.set(0, 0, 0);
          dlight.target.position.set(0, 0, -1);
          lg.add(dlight);
          lg.add(dlight.target);
        } else if (L === LIGHT_MODE.SPOT) {
          var ang = (ob.spotAngle * Math.PI) / 180;
          var spot = new THREE.SpotLight(
            0xffffff,
            Math.max(0, ob.intensity),
            200,
            ang,
            1 / (ob.spotExponent + 1),
            0
          );
          spot.color.copy(c);
          spot.position.set(0, 0, 0);
          spot.target.position.set(0, 0, -1);
          spot.distance = 0;
          m3gAttenToThreeSpot(spot, ob);
          lg.add(spot);
          lg.add(spot.target);
        } else {
          var pl = new THREE.PointLight(0xffffff, Math.max(0, ob.intensity), 0, 0);
          pl.color.copy(c);
          m3gAttenToThreePoint(pl, ob);
          lg.add(pl);
        }
        return lg;
      }
      if (t === OBJ.SPRITE) {
        var sg = new THREE.Group();
        applyTransformableToTHREE(ob, THREE, sg);
        sg.visible = ob.enableRendering !== false;
        sg.userData.m3gIndex = obIdx;
        sg.userData.userID = ob.userID;
        threeByIndex[obIdx] = sg;
        return sg;
      }
      return null;
    }

    var worldIdx = 0;
    var w;
    for (w = 1; w < objects.length; w++) {
      if (objects[w] && objects[w].objectType === OBJ.WORLD) {
        worldIdx = w;
      }
    }
    var scene = new THREE.Scene();
    var rootGroup;
    if (worldIdx) {
      rootGroup = buildNodeSub(worldIdx);
    } else if (ir.roots.length) {
      rootGroup = new THREE.Group();
      for (w = 0; w < ir.roots.length; w++) {
        var br2 = buildNodeSub(ir.roots[w]);
        if (br2) {
          rootGroup.add(br2);
        }
      }
    } else {
      rootGroup = new THREE.Group();
    }
    if (rootGroup) {
      scene.add(rootGroup);
    }
    var sceneHasLight = false;
    scene.traverse(function (n) {
      if (n && n.isLight) {
        sceneHasLight = true;
      }
    });
    if (!sceneHasLight) {
      scene.add(new THREE.AmbientLight(0xffffff, 0.72));
      var fillDir = new THREE.DirectionalLight(0xffffff, 1.05);
      fillDir.position.set(0.5, 1, 0.5);
      scene.add(fillDir);
    }
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    var activeCamTHREE = null;
    var worldOb = worldIdx ? objects[worldIdx] : null;
    if (worldOb && worldOb.backgroundRef && objects[worldOb.backgroundRef]) {
      var bg = objects[worldOb.backgroundRef];
      if (bg.objectType === OBJ.BACKGROUND) {
        var bga = bg.backgroundColor;
        var bgCol = bga
          ? new THREE.Color(bga.r / 255, bga.g / 255, bga.b / 255)
          : new THREE.Color(0, 0, 0);
        var bgImg = null;
        if (bg.backgroundImageRef && objects[bg.backgroundImageRef]) {
          bgImg = objects[bg.backgroundImageRef];
        }
        var bgTex = bgImg ? m3gBackgroundToDataTexture(bg, bgImg, THREE) : null;
        scene.background = bgTex || bgCol;
      }
    }
    if (worldOb && worldOb.activeCameraRef) {
      var cnode = threeByIndex[worldOb.activeCameraRef];
      if (cnode && cnode.userData.threeCamera) {
        activeCamTHREE = cnode.userData.threeCamera;
      }
    }
    if (!activeCamTHREE) {
      activeCamTHREE = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
      activeCamTHREE.position.set(0, 0, 10);
    }
    var userMap = Object.create(null);
    for (w = 1; w < threeByIndex.length; w++) {
      var nodeWrap = threeByIndex[w];
      if (nodeWrap && nodeWrap.userData && nodeWrap.userData.userID != null) {
        userMap[nodeWrap.userData.userID] = nodeWrap;
      }
    }
    return {
      scene: scene,
      root: rootGroup,
      camera: activeCamTHREE,
      threeByIndex: threeByIndex,
      userIdToObject: userMap,
      ir: ir,
    };
  }

  /** Keyframes in [validRangeFirst .. validRangeLast] (inclusive indices), per JSR-184. */
  function effectiveKeyframes(seq) {
    var kf = seq.keyframes;
    if (!kf || kf.length === 0) {
      return kf;
    }
    var a = seq.validRangeFirst | 0;
    var b = seq.validRangeLast | 0;
    if (b < a || a >= kf.length) {
      return kf;
    }
    a = Math.max(0, Math.min(a, kf.length - 1));
    b = Math.max(a, Math.min(b, kf.length - 1));
    if (a === 0 && b === kf.length - 1) {
      return kf;
    }
    return kf.slice(a, b + 1);
  }

  function clampTimeToKeyframe(seq, t) {
    var tf = +t;
    var rp = seq.repeatMode;
    if (rp === KF_REPEAT.LOOP) {
      var d = seq.duration | 0;
      if (d < 1) {
        d = 1;
      }
      var m = tf % d;
      if (m < 0) {
        m += d;
      }
      return m;
    }
    /** CONSTANT: sequence time is unrestricted (no clamp to duration). */
    return tf;
  }

  /** Cubic Hermite (JSR-184 SPLINE matrix H), s in [0,1). */
  function hermiteScalar(p0, p1, m0, m1, s) {
    var s2 = s * s;
    var s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (-2 * s3 + 3 * s2) * p1 + (s3 - 2 * s2 + s) * m0 + (s3 - s2) * m1;
  }

  /** F-{j} and F+{j} from JSR-184 KeyframeSequence SPLINE (timing scale). */
  function splineFMinus(kf, j, n) {
    if (j <= 0 || j >= n - 1) {
      return 0;
    }
    var den = kf[j + 1].time - kf[j - 1].time;
    if (!(den > 0)) {
      return 0;
    }
    return (2 * (kf[j + 1].time - kf[j].time)) / den;
  }
  function splineFPlus(kf, j, n) {
    if (j <= 0 || j >= n - 1) {
      return 0;
    }
    var den = kf[j + 1].time - kf[j - 1].time;
    if (!(den > 0)) {
      return 0;
    }
    return (2 * (kf[j].time - kf[j - 1].time)) / den;
  }

  function splineCenterTangentScalar(kf, j, c, n) {
    var jm = j > 0 ? j - 1 : 0;
    var jp = j < n - 1 ? j + 1 : n - 1;
    return (kf[jp].value[c] - kf[jm].value[c]) * 0.5;
  }

  function sampleSplineVector(kf, segI, s, compCount) {
    var n = kf.length;
    var out = [];
    var c;
    var m0;
    var m1;
    for (c = 0; c < compCount; c++) {
      var Tseg = splineCenterTangentScalar(kf, segI, c, n);
      var Tseg1 = splineCenterTangentScalar(kf, segI + 1, c, n);
      m0 = splineFMinus(kf, segI, n) * Tseg;
      m1 = splineFPlus(kf, segI + 1, n) * Tseg1;
      out.push(hermiteScalar(kf[segI].value[c], kf[segI + 1].value[c], m0, m1, s));
    }
    return out;
  }

  /** Unit quaternion log → tangent as THREE.Vector3 (angle * axis). */
  function quatLogVec(THREE, q) {
    var u = q.clone().normalize();
    var w = u.w;
    if (w > 1) {
      w = 1;
    }
    if (w < -1) {
      w = -1;
    }
    var v = new THREE.Vector3(u.x, u.y, u.z);
    var len = v.length();
    if (len < 1e-10) {
      return new THREE.Vector3(0, 0, 0);
    }
    var a = Math.acos(w);
    var scale = a / len;
    return v.multiplyScalar(scale);
  }

  /** exp(pure vector) → unit quaternion. */
  function quatExpVec(THREE, v) {
    var angle = v.length();
    if (angle < 1e-10) {
      return new THREE.Quaternion(0, 0, 0, 1);
    }
    var half = angle * 0.5;
    var sinh = Math.sin(half) / angle;
    return new THREE.Quaternion(v.x * sinh, v.y * sinh, v.z * sinh, Math.cos(half));
  }

  /** Shoemake/Dam "squad" inner quaternion at keyframe idx (between q_{idx-1}, q_idx, q_{idx+1}). */
  function squadIntermediateAt(THREE, kf, idx, n) {
    var qim1 = new THREE.Quaternion().fromArray(kf[idx > 0 ? idx - 1 : idx].value);
    var qi = new THREE.Quaternion().fromArray(kf[idx].value);
    var qip1 = new THREE.Quaternion().fromArray(kf[idx < n - 1 ? idx + 1 : idx].value);
    qim1.normalize();
    qi.normalize();
    qip1.normalize();
    var inv = qi.clone().invert();
    var relP = inv.clone().multiply(qip1);
    var relM = inv.clone().multiply(qim1);
    var v1 = quatLogVec(THREE, relP);
    var v2 = quatLogVec(THREE, relM);
    var acc = v1.clone().add(v2).multiplyScalar(-0.25);
    return qi.clone().multiply(quatExpVec(THREE, acc));
  }

  /** SQUAD segment kf[segI] → kf[segI+1], s in [0,1). */
  function sampleSquadQuat(THREE, kf, segI, s, n) {
    var q0 = new THREE.Quaternion().fromArray(kf[segI].value);
    var q1 = new THREE.Quaternion().fromArray(kf[segI + 1].value);
    q0.normalize();
    q1.normalize();
    var s0 = squadIntermediateAt(THREE, kf, segI, n);
    var s1 = squadIntermediateAt(THREE, kf, segI + 1, n);
    var h = 2 * s * (1 - s);
    var w0 = new THREE.Quaternion().copy(q0).slerp(q1, s);
    var w1 = new THREE.Quaternion().copy(s0).slerp(s1, s);
    var out = new THREE.Quaternion().copy(w0).slerp(w1, h);
    return [out.x, out.y, out.z, out.w];
  }

  function sampleKeyframe(seq, t, THREE, propertyID) {
    var kf = effectiveKeyframes(seq);
    if (!kf || kf.length === 0) {
      return null;
    }
    t = clampTimeToKeyframe(seq, t);
    var t0 = kf[0].time;
    if (t <= t0) {
      return kf[0].value.slice();
    }
    var last = kf[kf.length - 1];
    var tEnd = last.time;
    if (t >= tEnd) {
      return last.value.slice();
    }
    var i;
    for (i = 0; i < kf.length - 1; i++) {
      if (t < kf[i + 1].time) {
        break;
      }
    }
    var a = kf[i];
    var b = kf[Math.min(i + 1, kf.length - 1)];
    if (seq.interpolation === KF_INTERP.STEP) {
      return a.value.slice();
    }
    if (a === b) {
      return a.value.slice();
    }
    var span = b.time - a.time;
    var f = span > 0 ? (t - a.time) / span : 0;
    var nK = kf.length;
    var interp = seq.interpolation;
    if (
      THREE &&
      propertyID === PROP.ORIENTATION &&
      a.value.length >= 4 &&
      b.value.length >= 4
    ) {
      if (interp === KF_INTERP.SLERP) {
        var qa = new THREE.Quaternion(a.value[0], a.value[1], a.value[2], a.value[3]);
        var qb = new THREE.Quaternion(b.value[0], b.value[1], b.value[2], b.value[3]);
        var qo = new THREE.Quaternion().copy(qa).slerp(qb, f);
        return [qo.x, qo.y, qo.z, qo.w];
      }
      if (interp === KF_INTERP.SQUAD || interp === KF_INTERP.SPLINE) {
        return sampleSquadQuat(THREE, kf, i, f, nK);
      }
    }
    if (interp === KF_INTERP.SPLINE && nK >= 2) {
      var cc = a.value.length;
      if (cc > 0) {
        return sampleSplineVector(kf, i, f, cc);
      }
    }
    var out = [];
    var c;
    for (c = 0; c < a.value.length; c++) {
      out.push(a.value[c] + (b.value[c] - a.value[c]) * f);
    }
    return out;
  }

  /** Sequence time ts from world time tw: ts = tsref + speed * (tw - twref) (JSR-184; same time units, usually ms). */
  function controllerSequenceTime(ctrl, worldMs) {
    var w = +worldMs;
    var twref = ctrl.referenceWorldTime | 0;
    var sp = ctrl.speed != null ? ctrl.speed : 1;
    return ctrl.referenceSequenceTime + (w - twref) * sp;
  }

  function stepAnimations(ir, ctx, worldTimeMs) {
    if (!ir || !ir.ok || !ctx) {
      return;
    }
    var objects = ir.objects;
    var THREE = ctx.THREE;
    if (!THREE) {
      return;
    }
    var overrides = ctx.animOverrides || Object.create(null);
    var oi;
    for (oi = 1; oi < objects.length; oi++) {
      var ob = objects[oi];
      if (!ob || !ob.animationTracks || !ob.animationTracks.length) {
        continue;
      }
      var node3 = ctx.threeByIndex[oi];
      if (!node3) {
        continue;
      }
      var ti;
      for (ti = 0; ti < ob.animationTracks.length; ti++) {
        var trIdx = ob.animationTracks[ti];
        var tr = objects[trIdx];
        if (!tr || tr.objectType !== OBJ.ANIMATION_TRACK) {
          continue;
        }
        var kfs = objects[tr.keyframeSequenceRef];
        var ctrl = objects[tr.animationControllerRef];
        if (!kfs || kfs.objectType !== OBJ.KEYFRAME_SEQUENCE || !ctrl || ctrl.objectType !== OBJ.ANIMATION_CONTROLLER) {
          continue;
        }
        var uid = ctrl.userID;
        var ovv = overrides[uid];
        var c0 = ctrl;
        if (ovv) {
          if (ovv.speed != null) {
            c0 = Object.assign({}, ctrl, { speed: ovv.speed });
          }
        }
        var wtm = +worldTimeMs;
        if (ovv && ovv.activeStart != null && ovv.activeEnd != null) {
          if (wtm < ovv.activeStart || wtm >= ovv.activeEnd) {
            continue;
          }
        } else if (c0.activeIntervalEnd > c0.activeIntervalStart) {
          /** Active for start <= worldTime < end (end exclusive, JSR-184). */
          if (wtm < c0.activeIntervalStart || wtm >= c0.activeIntervalEnd) {
            continue;
          }
        }
        var seqT0 =
          ovv && ovv.positionMs != null ? +ovv.positionMs : controllerSequenceTime(c0, wtm);
        var sample = sampleKeyframe(kfs, seqT0, THREE, tr.propertyID);
        if (!sample) {
          continue;
        }
        var pid = tr.propertyID;
        if (pid === PROP.TRANSLATION && sample.length >= 3) {
          if (!node3.userData.basePos) {
            node3.userData.basePos = node3.position.clone();
          }
          node3.position.set(sample[0], sample[1], sample[2]);
        } else if (pid === PROP.SCALE && sample.length >= 3) {
          node3.scale.set(sample[0], sample[1], sample[2]);
        } else if (pid === PROP.ORIENTATION && sample.length >= 4) {
          node3.quaternion.set(sample[0], sample[1], sample[2], sample[3]);
        } else if (pid === PROP.ALPHA && sample.length >= 1) {
          node3.traverse(function (ch) {
            if (ch.material) {
              ch.material.transparent = true;
              ch.material.opacity = sample[0];
            }
          });
        }
      }
    }
  }

  function keyframeDuration(ir, userId) {
    if (!ir || !ir.ok) {
      return -1;
    }
    var objects = ir.objects;
    var oi;
    for (oi = 1; oi < objects.length; oi++) {
      var ob = objects[oi];
      if (!ob || ob.objectType !== OBJ.ANIMATION_CONTROLLER || ob.userID !== userId) {
        continue;
      }
      var ai;
      for (ai = 1; ai < objects.length; ai++) {
        var tr = objects[ai];
        if (!tr || tr.objectType !== OBJ.ANIMATION_TRACK || tr.animationControllerRef !== oi) {
          continue;
        }
        var ks = objects[tr.keyframeSequenceRef];
        if (ks && ks.objectType === OBJ.KEYFRAME_SEQUENCE) {
          return ks.duration | 0;
        }
      }
    }
    return -1;
  }

  global.AthenaM3G = {
    parseFile: parseFile,
    buildThreeScene: buildThreeScene,
    stepAnimations: stepAnimations,
    keyframeDurationTrack0: keyframeDuration,
    OBJ: OBJ,
    PROP: PROP,
  };
})(typeof self !== "undefined" ? self : window);
