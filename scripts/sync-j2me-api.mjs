#!/usr/bin/env node
/**
 * Sync J2ME native API manifest from Athena2ME Java sources.
 *
 * Resolution order for Athena2ME.java:
 * 1. ATHENA2ME_ROOT env → <root>/src/Athena2ME.java
 * 2. First CLI arg: path to Athena2ME.java, OR repo root (directory containing src/Athena2ME.java)
 * 3. Default: ../src/Athena2ME.java relative to athenastudio/ (sibling Athena2ME app root)
 *
 * Output: targets/j2me-api.json (committed; used by tooling and future extension features)
 *
 * When Java is missing (extension-only checkout), exits 0 without overwriting the manifest.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");
const OUT_JSON = path.join(EXT_ROOT, "targets", "j2me-api.json");
const SCHEMA_VERSION = 1;

function resolveJavaPath() {
  const envRoot = process.env.ATHENA2ME_ROOT?.trim();
  if (envRoot) {
    return path.join(envRoot, "src", "Athena2ME.java");
  }
  const arg = process.argv[2]?.trim();
  if (arg) {
    const abs = path.resolve(arg);
    if (fs.existsSync(abs)) {
      if (abs.endsWith(".java")) {
        return abs;
      }
      if (fs.statSync(abs).isDirectory()) {
        return path.join(abs, "src", "Athena2ME.java");
      }
    }
  }
  return path.resolve(EXT_ROOT, "..", "src", "Athena2ME.java");
}

function extractNatives(text) {
  const re = /NativeFunctionListEntry\s*\(\s*"([^"]+)"/g;
  const set = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    set.add(m[1]);
  }
  return [...set].sort();
}

function byPrefix(natives) {
  const map = Object.create(null);
  for (const n of natives) {
    const p = n.includes(".") ? n.slice(0, n.indexOf(".")) : n;
    map[p] = (map[p] ?? 0) + 1;
  }
  return map;
}

const javaPath = resolveJavaPath();

if (!fs.existsSync(javaPath)) {
  console.warn("[sync-j2me-api] Athena2ME.java not found:");
  console.warn("  ", javaPath);
  console.warn("[sync-j2me-api] Set ATHENA2ME_ROOT or pass repo root / path to Athena2ME.java.");
  console.warn("[sync-j2me-api] Leaving targets/j2me-api.json unchanged.");
  process.exit(0);
}

const text = fs.readFileSync(javaPath, "utf8");
const natives = extractNatives(text);
const rel = path.relative(EXT_ROOT, javaPath).replace(/\\/g, "/");
const payload = {
  schemaVersion: SCHEMA_VERSION,
  target: "j2me",
  source: {
    kind: "athena2me-java",
    relativeFile: !rel.startsWith(".") ? rel : undefined,
    resolvedHint: rel.startsWith(".") ? "outside extension tree — set ATHENA2ME_ROOT or pass repo path as argv" : undefined,
  },
  generatedAt: new Date().toISOString(),
  nativeCount: natives.length,
  natives,
  nativesByPrefix: byPrefix(natives),
};

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log("[sync-j2me-api] Wrote", path.relative(process.cwd(), OUT_JSON));
console.log("[sync-j2me-api] Native count:", natives.length);
console.log("[sync-j2me-api] Source:", javaPath);
