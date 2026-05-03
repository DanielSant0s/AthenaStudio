#!/usr/bin/env node
/**
 * Verify that types/athenastudio-j2me.d.ts mentions each native from targets/j2me-api.json.
 * Heuristic + small manual map for naming mismatches (e.g. Screen.Layer.ctor → ScreenLayer).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");
const API_PATH = path.join(EXT_ROOT, "targets", "j2me-api.json");
const DTS_PATH = path.join(EXT_ROOT, "types", "athenastudio-j2me.d.ts");

/** @type {Record<string, (dts: string) => boolean>} */
const SPECIAL = {
  "Screen.Layer.ctor": (dts) =>
    /\binterface\s+ScreenLayer\b/.test(dts) && /\bcreateLayer\s*\(/.test(dts),
  "Color.new": (dts) => /declare\s+const\s+Color\b/.test(dts) && /new\s*\(/.test(dts),
  "Sound.Stream": (dts) =>
    /declare\s+namespace\s+Sound\b/.test(dts) && /\bStream\s*\(\s*path\s*:\s*string\s*\)/.test(dts),
  "Sound.Sfx": (dts) =>
    /declare\s+namespace\s+Sound\b/.test(dts) && /\bSfx\s*\(\s*path\s*:\s*string\s*\)/.test(dts),
  "Sound.Stream.play": (dts) => /interface\s+SoundStream\b[\s\S]*?\bplay\s*\(/.test(dts),
  "Sound.Stream.pause": (dts) => /interface\s+SoundStream\b[\s\S]*?\bpause\s*\(/.test(dts),
  "Sound.Stream.playing": (dts) => /interface\s+SoundStream\b[\s\S]*?\bplaying\s*\(/.test(dts),
  "Sound.Stream.rewind": (dts) => /interface\s+SoundStream\b[\s\S]*?\brewind\s*\(/.test(dts),
  "Sound.Stream.free": (dts) => /interface\s+SoundStream\b[\s\S]*?\bfree\s*\(/.test(dts),
  "Sound.Sfx.play": (dts) => /interface\s+SoundSfx\b[\s\S]*?\bplay\s*\(/.test(dts),
  "Sound.Sfx.free": (dts) => /interface\s+SoundSfx\b[\s\S]*?\bfree\s*\(/.test(dts),
  "Sound.Sfx.playing": (dts) => /interface\s+SoundSfx\b[\s\S]*?\bplaying\s*\(/.test(dts),
  "os.Thread.start": (dts) => /namespace\s+Thread\b[\s\S]*?function\s+start\s*</.test(dts),
  "os.Pool.ctor": (dts) =>
    (/\bdeclare\s+const\s+Pool\b/.test(dts) || /\bdeclare\s+class\s+Pool\b/.test(dts)) &&
    /\binterface\s+AthenaPool\b/.test(dts),
  "os.AtomicInt": (dts) => /namespace\s+os\b[\s\S]*?\bclass\s+AtomicInt\b/.test(dts),
  "os.Mutex": (dts) => /namespace\s+os\b[\s\S]*?\bclass\s+Mutex\b/.test(dts),
  "os.Semaphore": (dts) => /namespace\s+os\b[\s\S]*?\bclass\s+Semaphore\b/.test(dts),
  "ZIP_list": (dts) => /interface\s+AthenaZipObject\b[\s\S]*?\blist\s*\(/.test(dts),
  "ZIP_get": (dts) => /interface\s+AthenaZipObject\b[\s\S]*?\bget\s*\(/.test(dts),
};

function covered(native, dts) {
  if (SPECIAL[native]) {
    return SPECIAL[native](dts);
  }
  const parts = native.split(".");
  const last = parts[parts.length - 1];

  if (last === "ctor") {
    const parent = parts[parts.length - 2];
    return new RegExp(`\\bclass\\s+${parent}\\b`).test(dts);
  }

  if (parts.length === 1) {
    const name = parts[0];
    return (
      new RegExp(`\\bclass\\s+${name}\\b`).test(dts) ||
      new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(dts) ||
      new RegExp(`declare\\s+const\\s+${name}\\b`).test(dts)
    );
  }

  if (new RegExp(`\\bfunction\\s+${last}\\s*[<(]`).test(dts)) {
    return true;
  }
  if (new RegExp(`\\bclass\\s+${last}\\b`).test(dts)) {
    return true;
  }
  if (new RegExp(`\\b${last}\\s*\\(`).test(dts)) {
    return true;
  }
  return false;
}

if (!fs.existsSync(API_PATH)) {
  console.error("[check-dts-coverage] Missing", API_PATH);
  console.error("Run: npm run sync-j2me-api");
  process.exit(1);
}

const api = JSON.parse(fs.readFileSync(API_PATH, "utf8"));
const natives = api.natives;
if (!Array.isArray(natives)) {
  console.error("[check-dts-coverage] Invalid j2me-api.json (no natives array)");
  process.exit(1);
}

const dts = fs.readFileSync(DTS_PATH, "utf8");
const missing = natives.filter((n) => !covered(n, dts));

if (missing.length) {
  console.error("[check-dts-coverage] Natives not matched in athenastudio-j2me.d.ts:");
  for (const m of missing) {
    console.error("  -", m);
  }
  console.error(`[check-dts-coverage] Total: ${missing.length} / ${natives.length}`);
  process.exit(1);
}

console.log("[check-dts-coverage] OK — all", natives.length, "natives covered by heuristics.");
