import * as vscode from "vscode";
import { readJ2meApiManifest } from "./j2meApiManifest";

/**
 * Quick-pick over natives from `targets/j2me-api.json`; copying the selection is optional.
 */
export async function browseJ2meNativeApi(context: vscode.ExtensionContext): Promise<void> {
  const m = readJ2meApiManifest(context.extensionPath);
  if (!m) {
    vscode.window.showErrorMessage("AthenaStudio: targets/j2me-api.json missing from the extension package.");
    return;
  }

  const items: vscode.QuickPickItem[] = m.natives.map((name) => {
    const dot = name.indexOf(".");
    const prefix = dot === -1 ? name : name.slice(0, dot);
    return {
      label: name,
      description: prefix,
    };
  });

  const gen = m.generatedAt ? ` · ${m.generatedAt}` : "";
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${m.nativeCount} J2ME natives${gen} — pick to copy name`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (picked?.label) {
    await vscode.env.clipboard.writeText(picked.label);
    vscode.window.showInformationMessage(`AthenaStudio: copied “${picked.label}” to clipboard.`);
  }
}
