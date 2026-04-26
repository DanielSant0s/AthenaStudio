import * as fs from "fs";
import * as path from "path";

/** Shape of `targets/j2me-api.json` shipped with the extension. */
export type J2meApiManifest = {
  schemaVersion: number;
  target: string;
  source?: {
    kind: string;
    relativeFile?: string;
    resolvedHint?: string;
  };
  generatedAt?: string;
  nativeCount: number;
  natives: string[];
  nativesByPrefix?: Record<string, number>;
};

/**
 * Load the J2ME native manifest from the extension package (`targets/j2me-api.json`).
 * Used by the simulator webview, workspace sync, and the API browser command.
 */
export function readJ2meApiManifest(extensionRoot: string): J2meApiManifest | null {
  const p = path.join(extensionRoot, "targets", "j2me-api.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as J2meApiManifest;
    if (!Array.isArray(raw.natives) || typeof raw.nativeCount !== "number") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** Payload embedded in the simulator webview (keeps HTML size reasonable). */
export function slimManifestForWebview(m: J2meApiManifest): Record<string, unknown> {
  return {
    schemaVersion: m.schemaVersion,
    target: m.target,
    generatedAt: m.generatedAt,
    nativeCount: m.nativeCount,
    natives: m.natives,
    nativesByPrefix: m.nativesByPrefix,
  };
}
