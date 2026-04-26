import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const TYPES_REL = path.join(".athenastudio", "athenastudio-j2me.d.ts");
const API_REL = path.join(".athenastudio", "j2me-api.json");

export async function ensureTypesInWorkspace(
  context: vscode.ExtensionContext,
  forceShowMessage = false
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    if (forceShowMessage) {
      vscode.window.showWarningMessage("AthenaStudio: open a workspace folder first.");
    }
    return;
  }

  const wsRoot = folder.uri.fsPath;
  const destDir = path.join(wsRoot, ".athenastudio");
  const destFile = path.join(wsRoot, TYPES_REL);
  const srcFile = context.asAbsolutePath(path.join("types", "athenastudio-j2me.d.ts"));

  if (!fs.existsSync(srcFile)) {
    vscode.window.showErrorMessage("AthenaStudio: type definitions missing from the extension package.");
    return;
  }

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const body = fs.readFileSync(srcFile, "utf8");
  fs.writeFileSync(destFile, body, "utf8");

  const apiSrc = context.asAbsolutePath(path.join("targets", "j2me-api.json"));
  if (fs.existsSync(apiSrc)) {
    fs.writeFileSync(path.join(wsRoot, API_REL), fs.readFileSync(apiSrc, "utf8"), "utf8");
  }

  await mergeJsconfig(wsRoot, TYPES_REL.replace(/\\/g, "/"));

  if (forceShowMessage) {
    vscode.window.showInformationMessage(`AthenaStudio: installed ${TYPES_REL} and ${API_REL}.`);
  }
}

async function mergeJsconfig(wsRoot: string, typesRef: string): Promise<void> {
  const jsPath = path.join(wsRoot, "jsconfig.json");
  const includeEntry = typesRef;
  const includeRes = "res/**/*.js";

  let cfg: { compilerOptions?: Record<string, unknown>; include?: string[] } = {};
  if (fs.existsSync(jsPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(jsPath, "utf8")) as typeof cfg;
    } catch {
      cfg = {};
    }
  }

  cfg.compilerOptions = {
    checkJs: false,
    noEmit: true,
    ...cfg.compilerOptions,
  };

  const inc = new Set<string>(cfg.include ?? []);
  inc.add(includeEntry);
  inc.add(includeRes);
  cfg.include = Array.from(inc);

  fs.writeFileSync(jsPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
