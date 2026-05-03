# AthenaStudio

**AthenaStudio** is a [Visual Studio Code](https://code.visualstudio.com/) extension for [**Athena2ME**](https://github.com/DanielSant0s/Athena2ME) — a JavaScript runtime on J2ME / MIDP. It gives you editor tooling, a **browser-based simulator** for rapid iteration, and **JAR / JAD export** so you can package what you build in `res/` into a deployable MIDlet.

---

## Table of contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Getting started](#getting-started)
5. [Commands](#commands)
6. [Settings](#settings)
7. [Simulator](#simulator)
8. [Type definitions & IntelliSense](#type-definitions--intellisense)
9. [Snippets](#snippets)
10. [Export (JAR / JAD)](#export-jar--jad)
11. [Project layout](#project-layout)
12. [Development](#development)
13. [License](#license)

---

## Features

| Area | What you get |
|------|----------------|
| **Simulator** | Webview panel with **Runner** (game + boot splash from `boot.ini`) and **Boot** (visual `boot.ini` editor + live canvas preview). |
| **Hot reload** | Changes under `res/` (e.g. `.js` / `.ts` sources that map into the bundle) can trigger a debounced simulator refresh; **Reload** matches the full update path. |
| **Export** | Pack `res/` into a template Athena2ME JAR, refresh JAD metadata, write to `dist/` or `build/`. |
| **Types** | Ships `athenastudio-j2me.d.ts` and can merge it into workspace `jsconfig.json` for globals such as `Screen`, `Draw`, `Pad`, `os`, etc. |
| **Snippets** | JavaScript snippets for common Athena2ME patterns (frame loop, `require`, `Request`, `Pad` listener). |
| **Targets** | `targets/j2me.json` defines screen presets for the simulator (and future tooling). |

---

## Screenshots  

### Simulator + Hot-reload
<img width="1607" height="947" alt="athenastudio_1" src="https://github.com/user-attachments/assets/a26fd83f-8f87-4e32-aabc-33d0988f56d0" />  

### Snippets
<img width="1365" height="392" alt="athenastudio_4" src="https://github.com/user-attachments/assets/652c0436-ee1f-42fa-9d96-8d235bb86cec" />  

### Intellisense
<img width="1022" height="177" alt="athenastudio_3" src="https://github.com/user-attachments/assets/ccf87110-ef5d-4ba3-be91-ec2b3839c4bb" />  

### Boot editor
<img width="1606" height="942" alt="athenastudio_2" src="https://github.com/user-attachments/assets/64776820-c64a-4d31-8c28-8f36cac7ee44" />  

---

## Requirements

- **VS Code** (or a compatible editor such as **Cursor**) **≥ 1.85.0**
- An **Athena2ME-style workspace**: at minimum a folder with `res/main.js` (and usually `res/boot.ini`, assets, optional `lib/` modules)

---

## Installation

### From a `.vsix` (if you package the extension)

1. Run **Extensions: Install from VSIX…** and select the packaged file.
2. Reload the window if prompted.

### Development (run from source)

See [Development](#development).

---

## Getting started

1. **Open a folder** that contains your game project (e.g. the Athena2ME app root with `res/main.js`).
2. On first open, the extension copies J2ME type definitions into **`.athenastudio/athenastudio-j2me.d.ts`** and updates **`jsconfig.json`** when possible.
3. Use the **status bar**:
   - **Panel** — open the J2ME simulator webview (opens beside the active editor by default; see `athenastudio.simulatorBesidePreserveEditorFocus`).
   - **Export** — build `project.jar` / `project.jad` into **`build/`** (command: *Export JAR to workspace build/*).
4. Edit `res/main.js`; use **Reload** in the simulator to pick up disk changes.

---

## Commands

All commands use the **AthenaStudio** category unless noted.

| Command ID | Title (palette) | Purpose |
|------------|-----------------|--------|
| `athenastudio.openSimulator` | **Open J2ME Simulator** | Create or focus the simulator webview panel. |
| `athenastudio.exportJar` | **Export JAR (use outputDir setting)** | Prompt for basename; write `.jar` / `.jad` under configured **`athenastudio.outputDir`** (default `dist/`). |
| `athenastudio.exportJarBuild` | **Export JAR to workspace build/** | Same pipeline, fixed output under **`build/`**. |
| `athenastudio.selectScreenPreset` | **AthenaStudio: Select Screen Preset** | Pick a preset from `targets/j2me.json` and update workspace `screenPresetId` / dimensions. |
| `athenastudio.installTypes` | **AthenaStudio: Install J2ME Types into Workspace** | Copy `athenastudio-j2me.d.ts` and **`j2me-api.json`** into `.athenastudio/`; refresh `jsconfig.json` merge. |
| `athenastudio.browseJ2meApi` | **AthenaStudio: Browse J2ME Native API List** | Searchable list of native ids from `targets/j2me-api.json`; copies selection to clipboard. |

**Editor integration:** *Open J2ME Simulator* and *Export JAR to workspace build/* appear in the editor title bar and explorer context menu when `main.js` is the active resource.

---

## Settings

| Key | Default | Description |
|-----|---------|-------------|
| `athenastudio.resFolder` | `res` | Resource root (`main.js`, `boot.ini`, images, `lib/…`). Files map to JAR paths: `res/foo` → `/foo`. |
| `athenastudio.outputDir` | `dist` | Output folder for *Export JAR (use outputDir setting)*. |
| `athenastudio.outputJarBasename` | `project` | Default basename for the export prompt (`<name>.jar` / `<name>.jad`). |
| `athenastudio.templateJar` | *(empty)* | Local template `.jar` path (absolute or workspace-relative). If set and valid, **overrides** download URL. |
| `athenastudio.templateJad` | *(empty)* | Local template `.jad`; must exist when set. |
| `athenastudio.templateJarDownloadUrl` | *(empty)* | HTTPS URL for template JAR when `templateJar` is empty; cached under `templateCacheDir`. |
| `athenastudio.templateJadDownloadUrl` | *(empty)* | HTTPS URL for template JAD when needed. |
| `athenastudio.templateCacheDir` | `.athenastudio/template` | Workspace-relative cache for downloaded templates. |
| `athenastudio.screenPresetId` | `240x320` | Preset id from `targets/j2me.json` (or `custom`). |
| `athenastudio.screenWidth` / `screenHeight` | `240` / `320` | Used when preset is `custom`. |
| `athenastudio.simulatorBesidePreserveEditorFocus` | `true` | When opening the simulator, keep focus in the text editor (useful while editing `boot.ini`). |

---

## Simulator

### Runner tab

- Runs your **`res/main.js`** in a stubbed environment that mirrors core Athena2ME globals (`Screen`, `Draw`, `Pad`, `Keyboard`, `Color`, `Font`, `Image`, `os`, `Request`, sockets, `Timer`, `Sound`, `require`, etc.).
- The webview receives **`init.j2meApi`** (from `targets/j2me-api.json`): the canonical list of native binding names. DevTools can use **`window.__ATHENA_J2ME_NATIVES__`** (string array) for tooling; the status strip shows the native count.
- **Boot splash** is driven by **`res/boot.ini`** (parsed to match device behaviour).
- **Reload** re-reads the workspace `res/` tree and restarts the boot + main flow.

### Boot tab

- **Visual editor** for splash slides, tick rate, handoff, and related fields; changes are written to **`res/boot.ini`** (with debouncing / echo suppression so editor focus is preserved).
- Opening the **Boot** tab can open `boot.ini` in the text editor; switching back to **Runner** may close that tab if it was opened from the simulator (extension behaviour).

### Panel lifecycle

- The simulator uses a **webview panel serializer**: after a window reload, VS Code can restore the panel without losing the extension’s internal wiring.
- **`deactivate`** intentionally does **not** dispose the panel so serialization can complete correctly.

### Content Security Policy

- The webview HTML sets a strict **CSP** (scripts with nonce + `webview.cspSource`). Local scripts live under `media/` and are exposed via `asWebviewUri`.

---

## Type definitions & IntelliSense

On activation (with a workspace folder):

1. The extension writes **`.athenastudio/athenastudio-j2me.d.ts`** (copy of `types/athenastudio-j2me.d.ts` from the package) and **`.athenastudio/j2me-api.json`** (copy of `targets/j2me-api.json`) when present.
2. It merges **`jsconfig.json`** at the workspace root to:
   - reference that `.d.ts`
   - include **`res/**/*.js`** when missing

Run **Install J2ME Types into Workspace** to repeat this manually and see a confirmation message.

---

## Snippets

Contributed for **`language: javascript`** from `snippets/j2me.json`, including:

- Frame loop with `os.startFrameLoop` / `Screen.clear`
- `require` for JAR-root modules
- `Request.get` Promise example
- `Pad.addListener` (`JUST_PRESSED`)

---

## Export (JAR / JAD)

1. **Template** — A base Athena2ME JAR (and optional JAD) from local paths or downloaded URLs (see settings).
2. **Packaging** — The extension replaces embedded `res` entries with files from your workspace `resFolder`, injects updated `main.js` / `boot.ini` / assets, and adjusts JAD size fields.
3. **Outputs** — Either **`dist/`** (configurable) or **`build/`** depending on the command.

Ensure `templateJar` points to a valid file or configure a reachable **`templateJarDownloadUrl`**.

---

## Project layout

Typical Athena2ME app (sibling of this folder in the repo):

```text
res/
  main.js          # Entry script (required for simulator discovery)
  boot.ini         # Boot splash config
  lib/             # Optional CommonJS modules (require("/lib/..."))
.athenastudio/     # Created by the extension (types, template cache)
build/             # Output of “Export JAR to workspace build/”
dist/              # Output of “Export JAR (use outputDir setting)”
jsconfig.json      # Optional; extension merges types + include
```

### This repository folder (`athenastudio/`)

```text
athenastudio/
  src/              # TypeScript extension sources
  dist/             # Compiled JS (extension entry: dist/extension.js)
  media/            # Webview assets (simulator.js, bootIni.js, vendor/*)
  types/            # athenastudio-j2me.d.ts (shipped + copied to workspace)
  targets/          # j2me.json (presets) + j2me-api.json (native list from Athena2ME.java)
  snippets/         # j2me.json snippets
  scripts/          # sync-j2me-api, check-dts-coverage, extract-natives
  package.json
  README.md         # This file
```

---

## J2ME API manifest (sync from Athena2ME)

AthenaStudio keeps a **machine-readable list of JS native bindings** in [`targets/j2me-api.json`](targets/j2me-api.json). It is generated from `NativeFunctionListEntry("…")` strings in **`Athena2ME.java`** so the extension (and CI) can stay aligned with the runtime **without hand-maintaining that list**.

`targets/j2me.json` references the manifest via `"nativeManifest": "j2me-api.json"`.

### Regenerating the manifest

From the `athenastudio` folder, with a checkout of **Athena2ME** available:

| Method | Command / env |
|--------|----------------|
| **Sibling layout** (default) | `npm run sync-j2me-api` — looks for `../src/Athena2ME.java` relative to `athenastudio/`. |
| **Separate clone** | Set `ATHENA2ME_ROOT` to the Athena2ME repo root, then `npm run sync-j2me-api`. |
| **Explicit path** | `node scripts/sync-j2me-api.mjs C:\path\to\Athena2ME` or `…\Athena2ME.java`. |

If `Athena2ME.java` is **not** found (e.g. extension-only repo), the script **exits 0** and **does not overwrite** `j2me-api.json`, so `vscode:prepublish` / installs keep working. **Commit** an up-to-date `j2me-api.json` whenever you release against a new runtime.

### Verifying TypeScript coverage

Hand-written [`types/athenastudio-j2me.d.ts`](types/athenastudio-j2me.d.ts) should reflect those natives. Run:

```bash
npm run verify-api
```

This runs **`sync-j2me-api`** then **`check-dts-coverage`** (heuristic checks + a small map for odd names like `Screen.Layer.ctor`). Use it in CI before publishing when Java is available.

### Legacy one-off extract

```bash
npm run extract-natives
```

Writes **`natives-extracted.json`** (gitignored) — prefer **`targets/j2me-api.json`** for anything that should ship with the extension.

---

## Development

### Prerequisites

- Node.js (LTS recommended)
- VS Code

### Build

```bash
cd athenastudio
npm install
npm run compile
```

### Watch mode

```bash
npm run watch
```

### Run the extension

1. Open the **`athenastudio`** folder in VS Code.
2. **Run and Debug** → **Launch Extension** (see `.vscode/launch.json`).
3. In the **[Extension Development Host]** window, **File → Open Folder…** and open an Athena2ME project (with `res/main.js`), not only the extension repo — otherwise the simulator will not find game files.

### GitHub Actions (split-repo layout)

Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

- On **push** / **pull_request**: checks out **Athena2ME** (public repo `DanielSant0s/Athena2ME` by default), runs **`sync-j2me-api`**, **`check-dts-coverage`**, and **`compile`**.
- Override the runtime repo or ref with **Variables** `ATHENA2ME_GITHUB_REPOSITORY` and `ATHENA2ME_REF`. For a **private** Athena2ME fork, set **Secret** `ATHENA2ME_CHECKOUT_TOKEN` (read access).
- **Tag `v*`** (push): builds a **VSIX** and attaches it to the GitHub Release (via `softprops/action-gh-release`).

The workflow updates `targets/j2me-api.json` **during the job** (not necessarily committed); the packaged VSIX always contains the manifest synced from the pinned Athena2ME ref.

### Packaging

Use **`vsce package`** (or your CI) after `npm run compile`. The published extension ships **`dist/`**, **`media/`**, **`targets/`** (including `j2me-api.json`), and **`types/`** (see `.vscodeignore` — TypeScript sources under `src/` are not bundled into the VSIX).

For **local** releases aligned with a new Athena2ME version, run **`npm run verify-api`** with the Java checkout available, then commit the updated `j2me-api.json` and any `.d.ts` fixes if you want the repo snapshot to match.

---

## License

**MIT** — see `package.json` (`license` field).

---

## See also

- **Athena2ME** main project README (parent repo): runtime capabilities, `boot.ini` format, and device deployment.
- **Issues / contributions:** use the upstream Athena2ME / AthenaStudio project trackers as applicable.
