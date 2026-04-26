import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { exportAthenaJar, exportJarToWorkspaceBuild } from "./exportJar";
import { ensureTypesInWorkspace } from "./installTypes";
import { browseJ2meNativeApi } from "./browseJ2meApi";
import { SimulatorPanel } from "./simulatorPanel";

function loadPresets(context: vscode.ExtensionContext): {
  id: string;
  label: string;
  width: number;
  height: number;
}[] {
  try {
    const p = context.asAbsolutePath(path.join("targets", "j2me.json"));
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
      screenPresets?: { id: string; width: number; height: number; label?: string }[];
    };
    return (j.screenPresets ?? []).map((s) => ({
      id: s.id,
      width: s.width,
      height: s.height,
      label: s.label ?? `${s.width}×${s.height}`,
    }));
  } catch {
    return [];
  }
}

async function selectScreenPreset(context: vscode.ExtensionContext): Promise<void> {
  const presets = loadPresets(context);
  if (presets.length === 0) {
    vscode.window.showWarningMessage("AthenaStudio: no presets found in targets/j2me.json.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    presets.map((p) => ({
      label: p.label,
      description: p.id,
      preset: p,
    })),
    { placeHolder: "J2ME screen preset" }
  );
  if (!pick) {
    return;
  }
  const conf = vscode.workspace.getConfiguration("athenastudio");
  await conf.update("screenPresetId", pick.preset.id, vscode.ConfigurationTarget.Workspace);
  await conf.update("screenWidth", pick.preset.width, vscode.ConfigurationTarget.Workspace);
  await conf.update("screenHeight", pick.preset.height, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`AthenaStudio: preset ${pick.preset.label} (${pick.preset.id}).`);
}

function createStudioStatusBar(context: vscode.ExtensionContext): void {
  const simItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  simItem.command = "athenastudio.openSimulator";
  simItem.text = "$(device-mobile) Panel";
  simItem.tooltip = "AthenaStudio: open J2ME simulator beside the editor";
  context.subscriptions.push(simItem);

  const exportItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  exportItem.command = "athenastudio.exportJarBuild";
  exportItem.text = "$(package) Export";
  exportItem.tooltip =
    "AthenaStudio: build project.jar / .jad into build/ (uses templateJar or templateJarDownloadUrl)";
  context.subscriptions.push(exportItem);

  const refresh = (): void => {
    const open = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    if (open) {
      simItem.show();
      exportItem.show();
    } else {
      simItem.hide();
      exportItem.hide();
    }
  };
  refresh();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refresh));
}

export function activate(context: vscode.ExtensionContext): void {
  void ensureTypesInWorkspace(context, false);
  createStudioStatusBar(context);

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SimulatorPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel, _state) {
        SimulatorPanel.reviveWebviewPanel(webviewPanel, context);
      },
    }),
    vscode.commands.registerCommand("athenastudio.exportJar", () => exportAthenaJar(context)),
    vscode.commands.registerCommand("athenastudio.exportJarBuild", () => exportJarToWorkspaceBuild(context)),
    vscode.commands.registerCommand("athenastudio.openSimulator", () =>
      SimulatorPanel.createOrShow(context)
    ),
    vscode.commands.registerCommand("athenastudio.selectScreenPreset", () =>
      selectScreenPreset(context)
    ),
    vscode.commands.registerCommand("athenastudio.installTypes", () =>
      ensureTypesInWorkspace(context, true)
    ),
    vscode.commands.registerCommand("athenastudio.browseJ2meApi", () => browseJ2meNativeApi(context))
  );
}

export function deactivate(): void {
  // Do not dispose the panel here: VS Code serializes the webview and reopens it after a window reload.
}
