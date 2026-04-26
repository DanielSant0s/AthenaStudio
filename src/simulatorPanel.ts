import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { readJ2meApiManifest, slimManifestForWebview } from "./j2meApiManifest";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function readTargetPresets(context: vscode.ExtensionContext): {
  id: string;
  width: number;
  height: number;
  label: string;
}[] {
  try {
    const p = context.asAbsolutePath(path.join("targets", "j2me.json"));
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      screenPresets?: { id: string; width: number; height: number; label?: string }[];
    };
    return (raw.screenPresets ?? []).map((s) => ({
      id: s.id,
      width: s.width,
      height: s.height,
      label: s.label ?? `${s.width}×${s.height}`,
    }));
  } catch {
    return [{ id: "240x320", width: 240, height: 320, label: "240×320" }];
  }
}

type SimulatorWebviewShow = vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean };

function getSimulatorShowTarget(): SimulatorWebviewShow {
  const conf = vscode.workspace.getConfiguration("athenastudio");
  const preserveEditor = conf.get<boolean>("simulatorBesidePreserveEditorFocus", true);
  return { viewColumn: vscode.ViewColumn.Beside, preserveFocus: preserveEditor };
}

const SIMULATOR_UI_STATE_KEY = "athenastudio.simulatorUi";

export type SimulatorPanelUiState = {
  mainTab: "runner" | "boot";
  splashIdx: number;
};

function collectResFiles(resDir: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!fs.existsSync(resDir)) {
    return map;
  }
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else {
        const rel = path.relative(resDir, abs).replace(/\\/g, "/");
        const jarPath = "/" + rel;
        const ext = path.extname(e.name).toLowerCase();
        if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif") {
          map[jarPath] = fs.readFileSync(abs).toString("base64");
          map[jarPath + ":encoding"] = "base64";
        } else {
          map[jarPath] = fs.readFileSync(abs, "utf8");
        }
      }
    }
  };
  walk(resDir);
  return map;
}

export class SimulatorPanel {
  public static readonly viewType = "athenastudioSimulator";

  public static currentPanel: SimulatorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private bootDocSubscription: vscode.Disposable | undefined;
  private bootIniDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private resHotReloadWatchers: vscode.Disposable | undefined;
  private resHotReloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Suppress echo loop: visual panel write → disk → onDidChangeTextDocument → bootIniChanged → re-render steals focus. */
  private bootIniEchoSuppressNorm: string | undefined;
  private bootIniEchoSuppressUntilMs = 0;
  /** Webview tab: live boot.ini sync only while `boot`. */
  private simulatorUiTab: "runner" | "boot" = "runner";
  private _disposed = false;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    const saved = this.readSimulatorUiState();
    this.simulatorUiTab = saved.mainTab;

    this.panel.onDidDispose(() => this.disposeInternal(true), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: {
        type: string;
        message?: string;
        tab?: string;
        text?: string;
        openEditor?: boolean;
        idx?: number;
      }) => {
        if (msg.type === "log" && msg.message) {
          console.log("[AthenaStudio sim]", msg.message);
        }
        if (msg.type === "simulatorReload") {
          void this.update();
          return;
        }
        if (msg.type === "saveBootIni" && typeof msg.text === "string") {
          void this.saveBootIni(msg.text);
        }
        if (msg.type === "bootSplashIdx" && typeof msg.idx === "number") {
          this.persistSimulatorUi({ splashIdx: msg.idx });
        }
        if (msg.type === "simulatorTab") {
          const t = msg.tab;
          if (t === "runner" || t === "boot") {
            this.simulatorUiTab = t;
            this.persistSimulatorUi({ mainTab: t });
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (t === "runner" && folder) {
              void SimulatorPanel.closeBootIniEditorIfOpen(folder);
            }
            const openEditor = msg.openEditor !== false;
            if (t === "boot" && openEditor && folder) {
              void SimulatorPanel.openBootIniDocument(folder);
            }
          }
        }
      },
      null,
      this.disposables
    );

    void this.update();
  }

  private readSimulatorUiState(): SimulatorPanelUiState {
    const raw = this.context.workspaceState.get<{ mainTab?: string; splashIdx?: number }>(
      SIMULATOR_UI_STATE_KEY,
      {}
    );
    return {
      mainTab: raw.mainTab === "boot" ? "boot" : "runner",
      splashIdx: typeof raw.splashIdx === "number" && raw.splashIdx >= 0 ? raw.splashIdx : 0,
    };
  }

  private persistSimulatorUi(patch: Partial<SimulatorPanelUiState>): void {
    const cur = this.readSimulatorUiState();
    const next: SimulatorPanelUiState = {
      mainTab: patch.mainTab ?? cur.mainTab,
      splashIdx: typeof patch.splashIdx === "number" ? patch.splashIdx : cur.splashIdx,
    };
    void this.context.workspaceState.update(SIMULATOR_UI_STATE_KEY, next);
  }

  /** Called by VS Code after a window reload while the panel is still considered open. */
  public static reviveWebviewPanel(
    webviewPanel: vscode.WebviewPanel,
    context: vscode.ExtensionContext
  ): void {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(context.extensionPath)],
    };
    SimulatorPanel.currentPanel = new SimulatorPanel(webviewPanel, context);
  }

  /**
   * Column where boot.ini should open: with the text editors, not beside the simulator webview.
   * Typical layout is [code | … | simulator]; we prefer the column immediately left of the sim.
   */
  private static resolveBootIniViewColumn(bootUri: vscode.Uri): vscode.ViewColumn | undefined {
    const simCol = SimulatorPanel.currentPanel?.panel.viewColumn;
    if (simCol !== undefined && simCol > vscode.ViewColumn.One) {
      return (simCol - 1) as vscode.ViewColumn;
    }
    const bootKey = path.normalize(bootUri.fsPath).toLowerCase();
    for (const te of vscode.window.visibleTextEditors) {
      if (te.document.uri.scheme !== "file" || te.viewColumn === undefined) {
        continue;
      }
      if (path.normalize(te.document.uri.fsPath).toLowerCase() === bootKey) {
        continue;
      }
      return te.viewColumn;
    }
    for (const te of vscode.window.visibleTextEditors) {
      if (te.document.uri.scheme === "file" && te.viewColumn !== undefined) {
        return te.viewColumn;
      }
    }
    return undefined;
  }

  /** Open res/boot.ini in the editor group with your code, not stacked next to the simulator. */
  private static async openBootIniDocument(folder: vscode.WorkspaceFolder): Promise<void> {
    const conf = vscode.workspace.getConfiguration("athenastudio", folder.uri);
    const resDir = path.join(folder.uri.fsPath, conf.get<string>("resFolder", "res"));
    const bootPath = path.join(resDir, "boot.ini");
    const bootUri = vscode.Uri.file(bootPath);
    try {
      if (!fs.existsSync(bootPath)) {
        if (!fs.existsSync(resDir)) {
          fs.mkdirSync(resDir, { recursive: true });
        }
        fs.writeFileSync(
          bootPath,
          "# boot.ini — AthenaStudio (live preview in simulator while you edit)\n\n",
          "utf8"
        );
      }
      const doc = await vscode.workspace.openTextDocument(bootUri);
      const viewColumn = SimulatorPanel.resolveBootIniViewColumn(bootUri);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: false,
        ...(viewColumn !== undefined ? { viewColumn } : {}),
      });
    } catch {
      /* optional file */
    }
  }

  /** Close editor tabs for this project's `res/boot.ini` when leaving the Boot tab in the simulator. */
  private static async closeBootIniEditorIfOpen(folder: vscode.WorkspaceFolder): Promise<void> {
    const conf = vscode.workspace.getConfiguration("athenastudio", folder.uri);
    const resDir = path.join(folder.uri.fsPath, conf.get<string>("resFolder", "res"));
    const bootKey = path.normalize(path.join(resDir, "boot.ini")).toLowerCase();
    const toClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && path.normalize(input.uri.fsPath).toLowerCase() === bootKey) {
          toClose.push(tab);
        }
      }
    }
    for (const tab of toClose) {
      try {
        await vscode.window.tabGroups.close(tab);
      } catch {
        /* ignore */
      }
    }
  }

  public static createOrShow(context: vscode.ExtensionContext): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage("AthenaStudio: open a workspace folder first.");
      return;
    }

    const showTarget = getSimulatorShowTarget();

    if (SimulatorPanel.currentPanel) {
      const targetCol = typeof showTarget === "number" ? showTarget : showTarget.viewColumn;
      const preserve = typeof showTarget === "object" && showTarget.preserveFocus === true;
      SimulatorPanel.currentPanel.panel.reveal(targetCol, preserve);
      void SimulatorPanel.currentPanel.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SimulatorPanel.viewType,
      "AthenaStudio",
      showTarget,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(context.extensionPath)],
      }
    );

    const targetCol = typeof showTarget === "number" ? showTarget : showTarget.viewColumn;
    const preserve = typeof showTarget === "object" && showTarget.preserveFocus === true;
    try {
      panel.reveal(targetCol, preserve);
    } catch {
      /* ignore */
    }

    SimulatorPanel.currentPanel = new SimulatorPanel(panel, context);
  }

  private async update(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.panel.webview.html = "<p>Open a workspace folder first.</p>";
      return;
    }

    const simUi = this.readSimulatorUiState();
    this.simulatorUiTab = simUi.mainTab;

    const conf = vscode.workspace.getConfiguration("athenastudio");
    const resDir = path.join(folder.uri.fsPath, conf.get<string>("resFolder", "res"));
    const presetId = conf.get<string>("screenPresetId", "240x320");
    let width = conf.get<number>("screenWidth", 240);
    let height = conf.get<number>("screenHeight", 320);

    const presets = readTargetPresets(this.context);
    const preset = presets.find((p) => p.id === presetId);
    if (preset && presetId !== "custom") {
      width = preset.width;
      height = preset.height;
    }

    let selectedPresetId: string;
    if (presetId === "custom") {
      selectedPresetId = "custom";
    } else if (preset) {
      selectedPresetId = preset.id;
    } else {
      const bySize = presets.find((p) => p.id !== "custom" && p.width === width && p.height === height);
      selectedPresetId = bySize?.id ?? presets[0]?.id ?? "240x320";
    }

    const presetOptionsHtml = presets
      .map((p) => {
        const ow = p.id === "custom" ? width : p.width;
        const oh = p.id === "custom" ? height : p.height;
        const selected = p.id === selectedPresetId;
        const label = `${p.label} (${ow}×${oh})`;
        return `<option value="${escapeHtml(p.id)}" data-w="${ow}" data-h="${oh}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("\n");

    const fileMap = collectResFiles(resDir);
    const mainKey = "/main.js";
    const mainPathFs = path.join(resDir, "main.js");
    let mainJs = fileMap[mainKey] ?? "";
    if (!mainJs && fs.existsSync(mainPathFs)) {
      mainJs = fs.readFileSync(mainPathFs, "utf8");
    }

    const bootKey = "/boot.ini";
    const bootPathFs = path.join(resDir, "boot.ini");
    let bootIni = fileMap[bootKey] ?? "";
    if (!bootIni && fs.existsSync(bootPathFs)) {
      bootIni = fs.readFileSync(bootPathFs, "utf8");
    }

    const mediaDir = path.join(this.context.extensionPath, "media");
    const bootIniUri = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, "bootIni.js")));
    const runtimeUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaDir, "simulator.js"))
    );

    const nonce = String(Date.now());

    const j2meApi = readJ2meApiManifest(this.context.extensionPath);
    const apiStatus =
      j2meApi != null
        ? ` · J2ME API manifest: ${j2meApi.nativeCount} natives`
        : " · J2ME API manifest: (missing — reinstall extension)";
    const statusHint =
      mainJs.length === 0
        ? "res/main.js was not found in this workspace. In the [Extension Development Host] window, use File → Open Folder… and open your game project (e.g. Athena2ME with res/main.js)." +
            apiStatus
        : `main.js: ${mainJs.length} characters · res: ${resDir.replace(/\\/g, "/")}${apiStatus}`;

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${this.panel.webview.cspSource} blob: 'unsafe-eval'; style-src 'unsafe-inline'; img-src ${this.panel.webview.cspSource} blob: data:;" />
  <style>
    * { box-sizing: border-box; }
    html {
      -webkit-text-size-adjust: 100%;
      height: 100%;
    }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0;
      height: 100%;
      min-height: 100vh;
      min-height: 100dvh;
      background: linear-gradient(160deg, #1a1d24 0%, #12141a 50%, #0d0f14 100%);
      color: #c8cdd6;
      font-size: clamp(12px, 2.5vw, 13px);
      line-height: 1.45;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .app {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      max-width: min(960px, 100%);
      margin: 0 auto;
      padding: clamp(8px, 2vw, 14px) clamp(8px, 2.5vw, 16px);
      display: flex;
      flex-direction: column;
      gap: clamp(6px, 1.2vh, 10px);
      overflow: hidden;
    }
    .app.boot-tab-active .log-panels {
      display: none;
    }
    .sim-tabs {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding-bottom: 0;
      margin-bottom: 2px;
    }
    .sim-tab {
      padding: 8px 16px;
      border: none;
      border-radius: 8px 8px 0 0;
      background: rgba(255,255,255,0.05);
      color: #8b93a3;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .sim-tab:hover {
      color: #c8cdd6;
      background: rgba(255,255,255,0.08);
    }
    .sim-tab.active {
      color: #e8eaef;
      background: rgba(91,140,255,0.18);
      box-shadow: 0 -1px 0 0 rgba(91,140,255,0.5) inset;
    }
    .tab-panel {
      display: none;
      flex-direction: column;
      gap: clamp(6px, 1.2vh, 10px);
      flex-shrink: 0;
    }
    .tab-panel.active {
      display: flex;
    }
    .boot-tab-hint {
      font-size: 12px;
      color: #8b93a3;
      line-height: 1.45;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.2);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .boot-tab-hint code {
      font-size: 11px;
      color: #9eb8ff;
    }
    .boot-visual-wrap {
      margin-top: 6px;
      max-height: min(42vh, 380px);
      overflow-x: hidden;
      overflow-y: auto;
      padding: 6px 4px 12px;
      flex-shrink: 0;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(0,0,0,0.18);
    }
    .boot-visual-global {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
    }
    .boot-visual-global label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #8b93a3;
    }
    .boot-visual-global input[type="number"],
    .boot-visual-global select {
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.12);
      background: #252830;
      color: #e8eaef;
      font-size: 12px;
    }
    .boot-splash-tabs {
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.07);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .boot-splash-tab {
      padding: 6px 12px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      background: rgba(255,255,255,0.05);
      color: #8b93a3;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .boot-splash-tab:hover {
      color: #c8cdd6;
      background: rgba(255,255,255,0.08);
    }
    .boot-splash-tab.active {
      color: #e8eaef;
      background: rgba(91,140,255,0.22);
      border-color: rgba(91,140,255,0.35);
    }
    .boot-splash-tab.boot-splash-add {
      border-style: dashed;
      opacity: 0.95;
    }
    .boot-slide-form {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .boot-field-group {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.07);
      background: rgba(0,0,0,0.15);
    }
    .boot-field-group h4 {
      margin: 0 0 10px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #6b7280;
    }
    .boot-field-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      margin-bottom: 8px;
    }
    .boot-field-row:last-child {
      margin-bottom: 0;
    }
    .boot-field-row label {
      font-size: 11px;
      color: #8b93a3;
      min-width: 4.5em;
    }
    .boot-slide-form input[type="text"],
    .boot-slide-form input[type="number"],
    .boot-slide-form select,
    .boot-slide-form textarea {
      flex: 1 1 120px;
      min-width: 0;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.12);
      background: #1e2128;
      color: #e8eaef;
      font-size: 12px;
      font-family: inherit;
    }
    .boot-slide-form textarea {
      min-height: 52px;
      width: 100%;
      resize: vertical;
    }
    .boot-slide-form input[type="color"] {
      width: 36px;
      height: 28px;
      padding: 0;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px;
      cursor: pointer;
    }
    .boot-text-card,
    .boot-img-card {
      padding: 10px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .boot-text-card:last-child,
    .boot-img-card:last-child {
      margin-bottom: 0;
    }
    .boot-mini-btn {
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.15);
      background: #2c3140;
      color: #c8cdd6;
      cursor: pointer;
      font-family: inherit;
    }
    .boot-mini-btn:hover {
      filter: brightness(1.08);
    }
    .boot-mini-btn.danger {
      border-color: rgba(240,100,100,0.35);
      color: #e8a0a0;
    }
    .toolbar-card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 16px;
      padding: clamp(8px, 2vw, 12px) clamp(10px, 2.5vw, 14px);
      flex-shrink: 0;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.35);
    }
    .toolbar-card .resolution-field {
      flex: 1 1 220px;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 8px;
    }
    .toolbar-card label { font-size: 12px; color: #8b93a3; margin-right: 0; white-space: nowrap; }
    #resolution-select {
      flex: 1 1 200px;
      min-width: 0;
      width: 100%;
      max-width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: #252830;
      color: #e8eaef;
      font-size: 13px;
      cursor: pointer;
    }
    #resolution-select:focus {
      outline: none;
      border-color: #5b8cff;
      box-shadow: 0 0 0 2px rgba(91,140,255,0.25);
    }
    #run {
      padding: 8px 18px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(180deg, #4d7cff 0%, #3d66e8 100%);
      color: #fff;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(61,102,232,0.4);
    }
    #run:hover { filter: brightness(1.08); }
    #run:active { transform: translateY(1px); }
    .screen-meta {
      font-size: 12px;
      color: #8b93a3;
      flex: 1 1 100%;
      line-height: 1.4;
    }
    @media (min-width: 640px) {
      .screen-meta { flex: 0 1 auto; }
    }
    #screen-badge {
      display: inline-block;
      margin-left: 6px;
      padding: 2px 8px;
      border-radius: 6px;
      background: rgba(91,140,255,0.15);
      color: #9eb8ff;
      font-variant-numeric: tabular-nums;
    }
    #sim-status {
      font-size: 11px;
      flex-shrink: 0;
      line-height: 1.4;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid transparent;
      max-height: 3.2em;
      overflow: hidden;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    #sim-status.warn { color: #f0c14a; background: rgba(240,193,74,0.08); border-color: rgba(240,193,74,0.2); }
    #sim-status.ok { color: #7dcea0; background: rgba(125,206,160,0.08); border-color: rgba(125,206,160,0.15); }
    .controls-hint {
      font-size: 11px;
      color: #8b93a3;
      flex-shrink: 0;
      line-height: 1.35;
    }
    .controls-hint kbd {
      display: inline-block;
      padding: 2px 7px;
      margin: 0 2px;
      border-radius: 4px;
      background: #2a2f3a;
      border: 1px solid rgba(255,255,255,0.08);
      font-size: 11px;
      font-family: ui-monospace, monospace;
    }
    .stage-wrap {
      flex: 1 1 0;
      min-height: 0;
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: stretch;
      padding: clamp(6px, 1.5vw, 14px);
      background: rgba(0,0,0,0.25);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .device-frame {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      width: 100%;
      max-height: 100%;
      padding: clamp(6px, 1.8vw, 12px);
      background: linear-gradient(145deg, #2c3038 0%, #1f2329 100%);
      border-radius: clamp(10px, 2.5vw, 14px);
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow:
        0 0 0 1px rgba(0,0,0,0.5) inset,
        0 12px 32px rgba(0,0,0,0.4);
      display: flex;
      align-items: stretch;
      justify-content: stretch;
    }
    #viewport {
      background: #0a0a0c;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      width: 100%;
      max-width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      overflow: hidden;
      box-shadow: 0 0 0 2px #0d0d10;
      line-height: 0;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    #c {
      display: block;
      flex: 0 1 auto;
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      vertical-align: top;
    }
    .log-panels {
      flex: 0 0 auto;
      height: 140px;
      min-height: 140px;
      max-height: 140px;
      overflow: hidden;
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: minmax(0, 1fr);
      gap: 8px;
    }
    @media (max-width: 520px) {
      .log-panels {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
        height: 220px;
        min-height: 220px;
        max-height: 220px;
      }
    }
    .panel {
      margin-bottom: 0;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
    }
    .panel-header {
      flex-shrink: 0;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #8b93a3;
      background: rgba(0,0,0,0.2);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .panel-body {
      margin: 0;
      padding: 8px 10px;
      flex: 1 1 0;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 12px;
      line-height: 1.4;
    }
    #console-out { color: #a8d4a8; min-height: 0; }
    #errors { color: #f09090; min-height: 0; }
    #console-out:empty::before { content: "(no output yet)"; color: #5c6370; }
    #errors:empty::before { content: "(no errors)"; color: #5c6370; }
    @media (max-width: 520px) {
      .toolbar-card { flex-direction: column; align-items: stretch; }
      #run { width: 100%; }
      .controls-hint { font-size: 11px; }
    }
  </style>
</head>
<body>
  <div class="app" id="sim-app-root">
    <div class="sim-tabs" role="tablist">
      <button type="button" class="sim-tab active" data-tab="runner" role="tab" aria-selected="true">Runner</button>
      <button type="button" class="sim-tab" data-tab="boot" role="tab" aria-selected="false">Boot</button>
    </div>
    <div id="tab-runner" class="tab-panel active" role="tabpanel">
      <div class="toolbar-card">
        <div class="resolution-field">
          <label for="resolution-select">Resolution</label>
          <select id="resolution-select">${presetOptionsHtml}</select>
        </div>
        <button type="button" id="run" title="Reload res/ from disk and run again">Reload</button>
      </div>
      <div id="sim-status" class="${mainJs.length === 0 ? "warn" : "ok"}">${escapeHtml(statusHint)}</div>
      <div class="controls-hint"><strong>Controls:</strong> arrows · <kbd>Space</kbd> or <kbd>Enter</kbd> = FIRE · <kbd>Z</kbd> / <kbd>X</kbd> = A / B · <strong>Reload</strong> reloads <code>res</code> from disk (same as saving <code>.js</code>/<code>.ts</code> under <code>res</code>) · <strong>Splash:</strong> <strong>Boot</strong> tab.</div>
    </div>
    <div id="tab-boot" class="tab-panel" role="tabpanel">
      <div class="boot-tab-hint"><strong>Boot splash</strong> — the visual editor below writes <code>res/boot.ini</code> live; the canvas shows the <strong>selected</strong> splash. Macros (<code>%W2%</code>, etc.) can be entered in the X/Y fields. On the <strong>Runner</strong> tab, <strong>Reload</strong> reloads the project from disk and runs boot + game.</div>
      <div id="boot-visual-root" class="boot-visual-wrap"></div>
    </div>
    <div class="stage-wrap">
      <div class="device-frame">
        <div id="viewport"><canvas id="c" width="${width}" height="${height}"></canvas></div>
      </div>
    </div>
    <div class="log-panels">
      <div class="panel">
        <div class="panel-header">Console</div>
        <pre id="console-out" class="panel-body"></pre>
      </div>
      <div class="panel">
        <div class="panel-header">Errors</div>
        <pre id="errors" class="panel-body"></pre>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    try {
      window.__ATHENA_VSCODE_API__ = acquireVsCodeApi();
    } catch (e) {
      window.__ATHENA_VSCODE_API__ = null;
    }
  </script>
  <script nonce="${nonce}">
    window.__ATHENA_SIM_INIT__ = ${JSON.stringify({
      width,
      height,
      mainJs,
      bootIni,
      fileMap,
      j2meApi: j2meApi ? slimManifestForWebview(j2meApi) : null,
      uiRestore: {
        mainTab: simUi.mainTab,
        splashIdx: simUi.splashIdx,
      },
    })};
  </script>
  <script nonce="${nonce}" src="${bootIniUri}"></script>
  <script nonce="${nonce}" src="${runtimeUri}"></script>
</body>
</html>`;

    this.syncBootIniWatcher(resDir);
    this.syncResHotReloadWatcher(folder, resDir);
  }

  /** Reload the webview when .js/.ts files under `res` change (debounced). */
  private syncResHotReloadWatcher(folder: vscode.WorkspaceFolder, resDirFs: string): void {
    this.resHotReloadWatchers?.dispose();
    this.resHotReloadWatchers = undefined;
    let resRel = path.relative(folder.uri.fsPath, resDirFs).replace(/\\/g, "/");
    if (!resRel || resRel.startsWith("..")) {
      resRel = "res";
    }
    const scheduleReload = (): void => {
      if (this.resHotReloadDebounceTimer !== undefined) {
        clearTimeout(this.resHotReloadDebounceTimer);
      }
      this.resHotReloadDebounceTimer = setTimeout(() => {
        this.resHotReloadDebounceTimer = undefined;
        void this.update();
      }, 380);
    };
    const wJs = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${resRel}/**/*.js`)
    );
    const wTs = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${resRel}/**/*.ts`)
    );
    wJs.onDidChange(scheduleReload);
    wJs.onDidCreate(scheduleReload);
    wJs.onDidDelete(scheduleReload);
    wTs.onDidChange(scheduleReload);
    wTs.onDidCreate(scheduleReload);
    wTs.onDidDelete(scheduleReload);
    this.resHotReloadWatchers = vscode.Disposable.from(wJs, wTs);
  }

  private static normBootIniText(s: string): string {
    return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  private async saveBootIni(text: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const conf = vscode.workspace.getConfiguration("athenastudio", folder.uri);
    const resDir = path.join(folder.uri.fsPath, conf.get<string>("resFolder", "res"));
    try {
      if (!fs.existsSync(resDir)) {
        fs.mkdirSync(resDir, { recursive: true });
      }
      const bootPath = path.join(resDir, "boot.ini");
      fs.writeFileSync(bootPath, text, "utf8");
      this.bootIniEchoSuppressNorm = SimulatorPanel.normBootIniText(text);
      this.bootIniEchoSuppressUntilMs = Date.now() + 5000;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage("AthenaStudio: could not write boot.ini — " + msg);
    }
  }

  /** Push boot.ini edits from the VS Code editor into the webview (debounced). */
  private syncBootIniWatcher(resDirFs: string): void {
    const bootAbs = path.normalize(path.join(resDirFs, "boot.ini"));
    this.bootDocSubscription?.dispose();
    this.bootDocSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") {
        return;
      }
      if (path.normalize(e.document.uri.fsPath) !== bootAbs) {
        return;
      }
      if (this.bootIniDebounceTimer !== undefined) {
        clearTimeout(this.bootIniDebounceTimer);
      }
      this.bootIniDebounceTimer = setTimeout(() => {
        this.bootIniDebounceTimer = undefined;
        let text = "";
        for (const td of vscode.workspace.textDocuments) {
          if (
            td.uri.scheme === "file" &&
            !td.isClosed &&
            path.normalize(td.uri.fsPath) === bootAbs
          ) {
            text = td.getText();
            break;
          }
        }
        if (this.simulatorUiTab !== "boot") {
          return;
        }
        const norm = SimulatorPanel.normBootIniText(text);
        if (
          Date.now() < this.bootIniEchoSuppressUntilMs &&
          this.bootIniEchoSuppressNorm !== undefined &&
          norm === this.bootIniEchoSuppressNorm
        ) {
          return;
        }
        void this.panel.webview.postMessage({ type: "bootIniChanged", text });
      }, 180);
    });
  }

  public dispose(): void {
    this.disposeInternal(false);
  }

  /**
   * @param fromPanelCallback — true when VS Code/Cursor is already closing the webview; do not call `panel.dispose()` again.
   */
  private disposeInternal(fromPanelCallback: boolean): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    SimulatorPanel.currentPanel = undefined;
    this.bootDocSubscription?.dispose();
    this.bootDocSubscription = undefined;
    if (this.bootIniDebounceTimer !== undefined) {
      clearTimeout(this.bootIniDebounceTimer);
      this.bootIniDebounceTimer = undefined;
    }
    this.resHotReloadWatchers?.dispose();
    this.resHotReloadWatchers = undefined;
    if (this.resHotReloadDebounceTimer !== undefined) {
      clearTimeout(this.resHotReloadDebounceTimer);
      this.resHotReloadDebounceTimer = undefined;
    }
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
    if (!fromPanelCallback) {
      try {
        this.panel.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}
