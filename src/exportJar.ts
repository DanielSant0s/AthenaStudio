import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** ZIP entry path without leading slash (matches Class.getResourceAsStream("/x") → entry "x"). */
function zipEntryPath(relFromRes: string): string {
  return relFromRes.replace(/\\/g, "/").replace(/^\/+/, "");
}

function walkFiles(dir: string, base: string, out: { rel: string; abs: string }[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isDirectory()) {
      walkFiles(abs, base, out);
    } else if (e.isFile()) {
      out.push({ rel, abs });
    }
  }
}

function updateJadSize(jadText: string, jarSize: number): string {
  const lines = jadText.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (/^MIDlet-Jar-Size\s*:/i.test(line)) {
      found = true;
      return `MIDlet-Jar-Size: ${jarSize}`;
    }
    return line;
  });
  if (!found) {
    next.push(`MIDlet-Jar-Size: ${jarSize}`);
  }
  return next.join("\n");
}

function getAthenaConfig(folder: vscode.WorkspaceFolder): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("athenastudio", folder.uri);
}

/** Ask for output base name; `undefined` if user cancelled. */
async function promptOutputBasename(conf: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  const current = conf.get<string>("outputJarBasename", "project").replace(/\.(jar|jad)$/i, "");
  const input = await vscode.window.showInputBox({
    title: "AthenaStudio — export",
    prompt: "Base name for .jar and .jad (no extension). Edit or confirm, then press Enter.",
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) {
        return "Name cannot be empty.";
      }
      if (/[<>:"/\\|?*\x00-\x1f]/.test(t)) {
        return "Invalid character in file name.";
      }
      if (t === "." || t === "..") {
        return "Invalid name.";
      }
      return undefined;
    },
  });
  if (input === undefined) {
    return undefined;
  }
  return input.trim().replace(/\.(jar|jad)$/i, "");
}

/** Absolute path: if `p` is relative, resolve against workspace root. */
function resolveWorkspacePath(ws: string, p: string): string {
  const t = (p || "").trim();
  if (!t) {
    return "";
  }
  if (path.isAbsolute(t)) {
    return path.normalize(t);
  }
  return path.resolve(ws, t);
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const u = url.trim();
  if (!u.startsWith("https://") && !u.startsWith("http://")) {
    throw new Error("Download URL must start with http:// or https://");
  }
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error("Downloaded file is empty");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

/**
 * Resolves template JAR (and optional JAD).
 * Local paths (templateJar / templateJad) take priority over download URLs — URLs are used only when the corresponding local setting is empty.
 * Relative paths are resolved from the workspace folder root.
 */
export async function resolveTemplateArtifacts(
  ws: string,
  conf: vscode.WorkspaceConfiguration,
  report: (msg: string) => void
): Promise<{ jar: string; jad: string | undefined }> {
  const cacheRel = conf.get<string>("templateCacheDir", ".athenastudio/template").replace(/\\/g, "/");
  const cacheDir = path.join(ws, cacheRel);
  const defaultCachedJar = path.join(cacheDir, "Athena2ME-template.jar");
  const defaultCachedJad = path.join(cacheDir, "Athena2ME-template.jad");

  const jarPathRaw = conf.get<string>("templateJar", "").trim();
  const jarPath = resolveWorkspacePath(ws, jarPathRaw);
  const jarUrl = conf.get<string>("templateJarDownloadUrl", "").trim();

  let jarResolved: string;
  if (jarPath.length > 0) {
    if (!fs.existsSync(jarPath)) {
      throw new Error(
        `Template JAR not found: ${jarPath} (athenastudio.templateJar). Use an absolute path or a path relative to the workspace root, or clear templateJar to use templateJarDownloadUrl.`
      );
    }
    jarResolved = jarPath;
  } else {
    if (!jarUrl) {
      throw new Error(
        "No template JAR: set athenastudio.templateJar (path to .jar, relative to workspace or absolute), or set athenastudio.templateJarDownloadUrl for a remote template."
      );
    }
    if (!fs.existsSync(defaultCachedJar)) {
      report("Downloading template JAR…");
      await downloadToFile(jarUrl, defaultCachedJar);
    }
    jarResolved = defaultCachedJar;
  }

  const jadPathRaw = conf.get<string>("templateJad", "").trim();
  const jadPath = resolveWorkspacePath(ws, jadPathRaw);
  const jadUrl = conf.get<string>("templateJadDownloadUrl", "").trim();

  if (jadPath.length > 0) {
    if (!fs.existsSync(jadPath)) {
      throw new Error(
        `Template JAD not found: ${jadPath} (athenastudio.templateJad). Use an absolute path or relative to the workspace, or clear templateJad to use sibling .jad or templateJadDownloadUrl.`
      );
    }
    return { jar: jarResolved, jad: jadPath };
  }

  const siblingJad = jarResolved.replace(/\.jar$/i, ".jad");
  if (fs.existsSync(siblingJad)) {
    return { jar: jarResolved, jad: siblingJad };
  }

  if (jadUrl) {
    if (!fs.existsSync(defaultCachedJad)) {
      report("Downloading template JAD…");
      await downloadToFile(jadUrl, defaultCachedJad);
    }
    return { jar: jarResolved, jad: defaultCachedJad };
  }

  return { jar: jarResolved, jad: undefined };
}

async function runExport(
  folder: vscode.WorkspaceFolder,
  conf: vscode.WorkspaceConfiguration,
  outDir: string,
  progress: vscode.Progress<{ message?: string }>,
  outputBasename: string
): Promise<void> {
  const ws = folder.uri.fsPath;
  const resFolder = path.join(ws, conf.get<string>("resFolder", "res"));
  const baseName = outputBasename.replace(/\.(jar|jad)$/i, "");

  if (!fs.existsSync(resFolder)) {
    throw new Error(`res folder not found: ${resFolder}`);
  }

  progress.report({ message: "Resolving template…" });
  const { jar: templateJar, jad: templateJadPath } = await resolveTemplateArtifacts(ws, conf, (m) =>
    progress.report({ message: m })
  );

  if (!fs.existsSync(templateJar)) {
    throw new Error(`Template JAR not found: ${templateJar}`);
  }

  progress.report({ message: "Writing JAR…" });

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const jarBytes = fs.readFileSync(templateJar);
  const zip = new AdmZip(jarBytes);

  const files: { rel: string; abs: string }[] = [];
  walkFiles(resFolder, resFolder, files);

  if (files.length === 0) {
    throw new Error("No files under res/");
  }

  for (const f of files) {
    const entry = zipEntryPath(f.rel);
    const data = fs.readFileSync(f.abs);
    try {
      zip.deleteFile(entry);
    } catch {
      /* entry did not exist */
    }
    zip.addFile(entry, data);
  }

  const outJar = path.join(outDir, `${baseName}.jar`);
  zip.writeZip(outJar);

  const stat = fs.statSync(outJar);
  const jarSize = stat.size;

  const outJad = path.join(outDir, `${baseName}.jad`);
  let jadSource: string;
  if (templateJadPath && fs.existsSync(templateJadPath)) {
    jadSource = fs.readFileSync(templateJadPath, "utf8");
  } else {
    jadSource = [
      "MIDlet-Name: Project",
      "MIDlet-Version: 1.0",
      "MIDlet-Vendor: AthenaStudio",
      `MIDlet-Jar-URL: ${baseName}.jar`,
      "MicroEdition-Profile: MIDP-2.0",
      "MicroEdition-Configuration: CLDC-1.1",
      "MIDlet-1: Project, /icon.png, Athena2ME",
    ].join("\n");
  }

  const jadOut = updateJadSize(jadSource, jarSize);
  fs.writeFileSync(outJad, jadOut, "utf8");
}

export async function exportAthenaJar(_context: vscode.ExtensionContext): Promise<void> {
  void _context;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("AthenaStudio: open a workspace folder first.");
    return;
  }

  const conf = getAthenaConfig(folder);
  const baseName = await promptOutputBasename(conf);
  if (baseName === undefined) {
    return;
  }
  const outDir = path.join(folder.uri.fsPath, conf.get<string>("outputDir", "dist"));

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AthenaStudio: exporting JAR…",
        cancellable: false,
      },
      async (progress) => {
        await runExport(folder, conf, outDir, progress, baseName);
        const outJar = path.join(outDir, `${baseName}.jar`);
        const stat = fs.statSync(outJar);
        vscode.window.showInformationMessage(
          `AthenaStudio: exported ${path.basename(outJar)} (${stat.size} bytes) and ${baseName}.jad to ${path.basename(outDir)}/.`
        );
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage("AthenaStudio: export failed — " + msg);
  }
}

/** Export to `<workspace>/build/`, using template path or download URLs from settings. */
export async function exportJarToWorkspaceBuild(_context: vscode.ExtensionContext): Promise<void> {
  void _context;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("AthenaStudio: open a workspace folder first.");
    return;
  }

  const conf = getAthenaConfig(folder);
  const baseName = await promptOutputBasename(conf);
  if (baseName === undefined) {
    return;
  }
  const outDir = path.join(folder.uri.fsPath, "build");

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AthenaStudio: export to build/…",
        cancellable: false,
      },
      async (progress) => {
        await runExport(folder, conf, outDir, progress, baseName);
        const outJar = path.join(outDir, `${baseName}.jar`);
        const stat = fs.statSync(outJar);
        const rel = path.relative(folder.uri.fsPath, outJar).replace(/\\/g, "/");
        vscode.window.showInformationMessage(
          `AthenaStudio: built ${rel} (${stat.size} bytes) and ${baseName}.jad in build/.`
        );
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const open = "Open Settings";
    const picked = await vscode.window.showErrorMessage("AthenaStudio: export to build failed — " + msg, open);
    if (picked === open) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "athenastudio.template");
    }
  }
}
