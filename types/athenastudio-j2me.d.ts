// AthenaStudio — global types for Athena2ME (J2ME / MIDP) scripts. See Athena2ME README.

/** @see Color.new */
type AthenaColorArgb = number;

interface AthenaSystemInfo {
  microedition.platform: string | null;
  microedition.configuration: string | null;
  microedition.profiles: string | null;
  microedition.locale?: string | null;
  microedition.encoding?: string | null;
}

interface AthenaMemoryStats {
  heapTotal: number;
  heapFree: number;
  heapUsed: number;
}

interface AthenaPerfStats {
  framesRendered: number;
  msPadDispatch: number;
  msJsCallback: number;
  msScreenUpdate: number;
  heapUsedHint: number;
}

interface AthenaFStat {
  size?: number;
  isDirectory?: number;
  lastModified?: number;
  error?: string;
}

interface AthenaStorageStats {
  total?: number;
  free?: number;
  error?: string;
}

interface AthenaBluetoothCaps {
  jsr82: number;
  available: number;
  powered?: number;
  name?: string;
  address?: string;
  error: string;
}

interface AthenaBtDevice {
  address: string;
  friendlyName: string;
  majorDeviceClass: number;
}

interface HttpResponse {
  responseCode: number;
  error: string;
  contentLength: number;
  body: Uint8Array;
}

interface DownloadResult {
  responseCode: number;
  error: string;
  contentLength: number;
  fileUrl: string;
}

interface ScreenLayer {
  width: number;
  height: number;
}

interface TextSize {
  width: number;
  height: number;
}

declare namespace os {
  const platform: "j2me";
  const O_RDONLY: number;
  const O_WRONLY: number;
  const O_RDWR: number;
  const O_NDELAY: number;
  const O_APPEND: number;
  const O_CREAT: number;
  const O_TRUNC: number;
  const O_EXCL: number;
  const SEEK_SET: number;
  const SEEK_CUR: number;
  const SEEK_END: number;

  function setExitHandler(handler: () => void): void;
  function open(path: string, flags: number): number;
  function close(fd: number): void;
  function seek(fd: number, offset: number, whence: number): number;
  function read(fd: number, maxBytes?: number): Uint8Array;
  function write(fd: number, data: Uint8Array | string): number;
  function fstat(fd: number): AthenaFStat;
  function sleep(ms: number): void;
  function flushPromises(): void;
  function startFrameLoop(fn: () => void, fps: number): void;
  function stopFrameLoop(): void;
  function getSystemInfo(): AthenaSystemInfo;
  function getMemoryStats(optRunGc?: boolean): AthenaMemoryStats;
  function getPerfStats(): AthenaPerfStats;
  function trimPools(): void;
  function getStorageStats(fileUrl: string): AthenaStorageStats;
  function getProperty(key: string): string | null;
  function bluetoothGetCapabilities(): AthenaBluetoothCaps;
  function bluetoothInquiry(timeoutMs: number): Promise<AthenaBtDevice[]>;
  function currentTimeMillis(): number;
  function uptimeMillis(): number;
  function gc(): void;
  function threadYield(): void;
  function spawn<T>(fn: () => T): Promise<T>;
  function pool(ctor: new (...args: unknown[]) => unknown, size: number): AthenaPool | null;

  class Mutex {
    lock(): void;
    tryLock(): number;
    unlock(): void;
  }
  class Semaphore {
    constructor(initial: number, max: number);
    acquire(): void;
    tryAcquire(): number;
    release(): void;
    availablePermits(): number;
  }
  class AtomicInt {
    constructor(initial?: number);
    get(): number;
    set(n: number): void;
    addAndGet(delta: number): number;
  }
  namespace Thread {
    function start<T>(fn: () => T): Promise<T>;
  }

  function vibrate(durationMs: number): void;

  namespace camera {
    function takeSnapshot(options?: {
      width?: number;
      height?: number;
      encoding?: string;
    }): Promise<Uint8Array>;
  }
}

interface AthenaPool {
  acquire(...args: unknown[]): unknown | null;
  release(obj: unknown): void;
  free(): number;
  capacity(): number;
  inUse(): number;
}

declare class Pool implements AthenaPool {
  acquire(...args: unknown[]): unknown | null;
  release(obj: unknown): void;
  free(): number;
  capacity(): number;
  inUse(): number;
}

declare namespace Screen {
  const width: number;
  const height: number;
  function clear(color?: AthenaColorArgb): void;
  function update(): void;
  function beginBatch(): void;
  function flushBatch(): void;
  function endBatch(): void;
  function setAutoBatch(on: boolean): void;
  function createLayer(w: number, h: number): ScreenLayer | null;
  function setLayer(layer: ScreenLayer | null): void;
  function clearLayer(layer: ScreenLayer, color?: AthenaColorArgb): void;
  function drawLayer(layer: ScreenLayer, x: number, y: number): void;
  function freeLayer(layer: ScreenLayer): void;
}

declare namespace Draw {
  function line(x1: number, y1: number, x2: number, y2: number, color: AthenaColorArgb): void;
  function triangle(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    color: AthenaColorArgb
  ): void;
  function rect(x: number, y: number, w: number, h: number, color: AthenaColorArgb): void;
  /** Interleaved Int32Array: default stride 5 with x,y,w,h,color (indices 0..4). */
  function rects(
    packed: Int32Array,
    count: number,
    stride?: number,
    xOff?: number,
    yOff?: number,
    wOff?: number,
    hOff?: number,
    colorOff?: number
  ): void;
}

declare class Image {
  constructor(path: string);
  width: number;
  height: number;
  startx: number;
  starty: number;
  endx: number;
  endy: number;
  draw(x: number, y: number): void;
  free(): void;
}

declare class Font {
  static FACE_MONOSPACE: number;
  static FACE_PROPORTIONAL: number;
  static FACE_SYSTEM: number;
  static STYLE_PLAIN: number;
  static STYLE_BOLD: number;
  static STYLE_ITALIC: number;
  static STYLE_UNDERLINED: number;
  static SIZE_SMALL: number;
  static SIZE_MEDIUM: number;
  static SIZE_LARGE: number;
  static ALIGN_TOP: number;
  static ALIGN_BOTTOM: number;
  static ALIGN_VCENTER: number;
  static ALIGN_LEFT: number;
  static ALIGN_RIGHT: number;
  static ALIGN_HCENTER: number;
  static ALIGN_NONE: number;
  static ALIGN_CENTER: number;

  constructor(faceOrDefault: string | number, style?: number, size?: number);
  color: AthenaColorArgb;
  align: number;
  print(text: string, x: number, y: number): void;
  getTextSize(text: string): TextSize;
  free(): void;
}

declare namespace FontAlign {
  const TOP: number;
  const BOTTOM: number;
  const VCENTER: number;
  const LEFT: number;
  const RIGHT: number;
  const HCENTER: number;
  const NONE: number;
  const CENTER: number;
}

/** ARGB color; in scripts: Color.new(r, g, b, a?) */
declare const Color: {
  new(r: number, g: number, b: number, a?: number): AthenaColorArgb;
};

declare namespace Pad {
  const UP: number;
  const DOWN: number;
  const LEFT: number;
  const RIGHT: number;
  const FIRE: number;
  const GAME_A: number;
  const GAME_B: number;
  const GAME_C: number;
  const GAME_D: number;
  const PRESSED: number;
  const JUST_PRESSED: number;
  const NON_PRESSED: number;
  function update(): void;
  function addListener(mask: number, kind: number, callback: () => void): number;
  function clearListener(id: number): void;
  function pressed(mask: number): boolean;
  function justPressed(mask: number): boolean;
}

declare namespace Keyboard {
  function get(): number;
  const KEY_NUM0: number;
  const KEY_NUM1: number;
  const KEY_NUM2: number;
  const KEY_NUM3: number;
  const KEY_NUM4: number;
  const KEY_NUM5: number;
  const KEY_NUM6: number;
  const KEY_NUM7: number;
  const KEY_NUM8: number;
  const KEY_NUM9: number;
  const KEY_STAR: number;
  const KEY_POUND: number;
}

declare class Request {
  keepalive: number;
  useragent: string;
  userpwd: string;
  headers: string[];
  responseCode: number;
  error: string;
  contentLength: number;
  constructor();
  get(url: string): Promise<HttpResponse>;
  post(url: string, data: string | Uint8Array): Promise<HttpResponse>;
  download(url: string, fileUrl: string): Promise<DownloadResult>;
}

declare class Socket {
  static AF_INET: number;
  static SOCK_STREAM: number;
  static SOCK_DGRAM: number;
  static SOCK_RAW: number;
  constructor(family: number, type: number);
  connect(host: string, port: number): void;
  bind(host: string, port: number): void;
  listen(): void;
  accept(): Socket;
  send(data: Uint8Array): number;
  recv(maxBytes: number): Uint8Array;
  close(): void;
}

declare class WebSocket {
  error: string;
  constructor(url: string);
  send(data: Uint8Array): void;
  recv(): Uint8Array;
  close(): void;
}

declare class BTSocket {
  constructor();
  connect(url: string): Promise<BTSocket>;
  send(data: Uint8Array): number;
  recv(maxBytes: number): Uint8Array;
  close(): void;
}

declare class Timer {
  constructor();
  get(): number;
  set(value: number): void;
  pause(): void;
  resume(): void;
  reset(): void;
  playing(): number;
  free(): void;
}

declare namespace Sound {
  function setVolume(volume: number): void;
  function findChannel(): number | undefined;
  function Stream(path: string): SoundStream;
  function Sfx(path: string): SoundSfx;
}

interface SoundStream {
  position: number;
  length: number;
  loop: number;
  play(): void;
  pause(): void;
  rewind(): void;
  playing(): number;
  free(): void;
}

interface SoundSfx {
  volume: number;
  pan: number;
  pitch: number;
  play(channel?: number): number | undefined;
  playing(channel: number): number;
  free(): void;
}

declare function require(path: string): unknown;
declare function loadScript(path: string): void;

declare namespace console {
  function log(...args: unknown[]): void;
}

/** AthenaStudio simulator: sessionStorage-backed key/value (not browser localStorage). */
declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

declare namespace LZ4 {
  function compress(srcBuffer: Uint8Array): Uint8Array;
  function decompress(srcBuffer: Uint8Array, uncompressedSize: number): Uint8Array;
}

declare namespace DEFLATE {
  function inflate(srcBuffer: Uint8Array, uncompressedSize?: number): Uint8Array;
}

interface AthenaZipObject {
  list(): string[];
  get(name: string): Uint8Array | null;
}

declare namespace ZIP {
  function open(buffer: Uint8Array): AthenaZipObject | null;
}

declare namespace Render3D {
  function getBackend(): string;
  function getCapabilities(): {
    backend: string;
    m3gPresent: number;
    maxTriangles: number;
    depthBufferOption: number;
  };
  function setTextureFilter(mode: string): void;
  function setTextureWrap(mode: string): void;
  function setBackend(mode: string): string | null;
  function init(): void;
  function setPerspective(fov: number, near: number, far: number): void;
  function setBackground(r: number, g: number, b: number): void;
  function setCamera(x: number, y: number, z: number): void;
  function setLookAt(
    ex: number,
    ey: number,
    ez: number,
    tx: number,
    ty: number,
    tz: number,
    ux: number,
    uy: number,
    uz: number
  ): void;
  function setMaxTriangles(n: number): void;
  function setBackfaceCulling(on: boolean): void;
  function setGlobalLight(dx: number, dy: number, dz: number): void;
  function setMaterialAmbient(r: number, g: number, b: number): void;
  function setMaterialDiffuse(r: number, g: number, b: number): void;
  function setTexture(path: string): void;
  function setTexCoords(uvs: ArrayLike<number> | Float32Array): void;
  function setDepthBuffer(on: boolean): void;
  function setTriangleStripMesh(
    positions: ArrayLike<number> | Float32Array,
    stripLens: ArrayLike<number> | Int32Array,
    normals?: ArrayLike<number> | Float32Array
  ): void;
  function setIndexedMesh(
    positions: ArrayLike<number> | Float32Array,
    indices: ArrayLike<number> | Int32Array,
    normals?: ArrayLike<number> | Float32Array
  ): void;
  function pushObjectMatrix(): void;
  function popObjectMatrix(): void;
  function clearMesh(): void;
  function setMeshRotation(degrees: number): void;
  function setObjectMatrix(matrix16: ArrayLike<number> | Float32Array): void;
  function setObjectMatrixIdentity(): void;
  function load(path: string): string | null;
  function getSceneInfo(): string;
  function worldAnimate(timeMs: number): void;
  function m3gNodeTranslate(userId: number, dx: number, dy: number, dz: number): string | null;
  function m3gNodeSetTranslation(userId: number, x: number, y: number, z: number): string | null;
  function m3gNodeGetTranslation(userId: number): number[] | null;
  function m3gNodeSetOrientation(
    userId: number,
    angleDeg: number,
    ax: number,
    ay: number,
    az: number
  ): string | null;
  function m3gAnimSetActiveInterval(userId: number, startMs: number, endMs: number): string | null;
  function m3gAnimSetPosition(userId: number, sequence: number, timeMs: number): string | null;
  function m3gAnimSetSpeed(userId: number, speed: number): string | null;
  function m3gKeyframeDurationTrack0(userId: number): number;
  function begin(): void;
  function render(): void;
  function end(): void;
}
