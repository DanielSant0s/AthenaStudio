#!/usr/bin/env node
/**
 * Extract NativeFunctionListEntry("...") names from Athena2ME.java.
 * Usage: node scripts/extract-natives.mjs [path/to/Athena2ME.java]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Default: sibling Athena2ME app — athenastudio/../src/Athena2ME.java */
const defaultJava = path.resolve(__dirname, "..", "..", "src", "Athena2ME.java");
const javaPath = path.resolve(process.argv[2] || defaultJava);

if (!fs.existsSync(javaPath)) {
  console.error("File not found:", javaPath);
  process.exit(1);
}

const text = fs.readFileSync(javaPath, "utf8");
const re = /NativeFunctionListEntry\s*\(\s*"([^"]+)"/g;
const set = new Set();
let m;
while ((m = re.exec(text)) !== null) {
  set.add(m[1]);
}
const arr = [...set].sort();
const outJson = path.join(__dirname, "..", "natives-extracted.json");
fs.writeFileSync(outJson, JSON.stringify(arr, null, 2) + "\n", "utf8");
console.log("Total:", arr.length);
console.log("Written:", outJson);
console.log(arr.join("\n"));
