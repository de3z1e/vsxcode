# VSXcode — Agent README

> **Audience check.** This file is for AI agents working **inside user Swift projects** where the VSXcode extension is installed. If you are developing the VSXcode extension itself (i.e. you are inside the VSXcode source repository), **ignore this file** and read `CLAUDE.md` instead — that has the codebase guidance you need.

You are working in a workspace where the **VSXcode** VS Code extension is installed (publisher `de3z1e`, extension ID `de3z1e.vsxcode`). This document tells you what the extension does automatically and how to use its capabilities instead of duplicating work via raw shell commands.

**This file is a manual reference.** The user will point you at it when they want you to leverage the extension. It is not a prompt-injection vector and the extension does not auto-load it.

---

## What the extension already does — do NOT duplicate

The extension activates on `workspaceContains:**/*.pbxproj`, `workspaceContains:**/project.xcproj` or `onDebug`. An Xcode project keeps its structure in one definition file inside the `.xcodeproj` bundle: `project.pbxproj`, or `project.xcproj` for a project in Xcode 27.2's JSON format (Xcode 27 or later opens it). Everything below applies to either; "the project file" means whichever one the bundle holds. Once active in a workspace that contains an Xcode project, the following happen automatically. **If you find yourself about to do any of these manually, stop — the extension already handles it.**

> **Exception — SwiftPM-generated projects.** If the project was made by `swift package generate-xcodeproj` (object ids like `OBJ_12`), none of the automatic writes below start until the user answers VSXcode's prompt. If they chose **Keep it a SwiftPM package**, nothing below happens in that workspace (no Package.swift generation, settings or project-file sync), and `Package.swift` is the package's own manifest: edit it as normal. If they chose **Use VSXcode fully**, VSXcode first backed up the files it changes beside the originals (`Package.swift_backup`, `.vscode/settings.json_backup`, `.vscode/.swift-format_backup`, `project.pbxproj_backup` or `project.xcproj_backup`, with `-2`, `-3`… for later backups), and everything below applies. In such a workspace, a `Package.swift` without the "Managed by VSXcode" header is the package's own manifest.

### Package.swift generation
- **What**: A `Package.swift` file in the workspace root, generated from the project file (`<project>.xcodeproj/project.pbxproj` or `project.xcproj`). The generated file contains a "Managed by VSXcode — changes will be overwritten" header.
- **Trigger**: First-time generation on activation, then re-generation whenever the project file changes (a `FileSystemWatcher` fires).
- **Don't manually edit `Package.swift`.** Edits will be silently overwritten on the next project-file change. If you need to change something Package.swift exposes (platform deployment targets, swift settings, dependencies), modify the `.xcodeproj` source via Xcode or by editing the project file directly (see [Editing the project file](#editing-the-project-file)) — the extension will regenerate Package.swift to match.
- **Why Package.swift exists at all**: it is a *shadow project* used solely to populate SourceKit-LSP's index store for cross-file intellisense. Actual app builds go through `xcodebuild`. Resources, swift settings, etc. in Package.swift do not affect what ships.

### Project-file sync on Swift file and Core Data model create/delete
- **What**: When the user creates or deletes a `.swift` file inside a target's directory, the extension automatically updates the project file: in `project.pbxproj` it adds/removes the four required entries (`PBXBuildFile`, `PBXFileReference`, `PBXGroup` child entry, `PBXSourcesBuildPhase` entry); in `project.xcproj`, the file's element in its group, with its `target-membership`. Files are matched by their path, never their name: renaming or moving a file or a folder, in the editor or with `git mv` or `mv`, keeps the entries involved (ids, every target membership, per-file settings; a folder's group and everything under it follow), a folder without a group gets one, and deleting one target's file leaves another target's same-named file alone.
- **Core Data models too**: `.xcdatamodeld` bundles are synced as one unit — create/delete updates all five structures (`PBXBuildFile`, a `wrapper.xcdatamodel` `PBXFileReference` per version, `PBXGroup` child, `PBXSourcesBuildPhase` entry, and the `XCVersionGroup`, with section markers where the file uses them), or in `project.xcproj` the model's `version-group` element with its versions, `current-version` and target membership; a move re-homes the group entry in place. `children`/`currentVersion` follow the bundle's `.xccurrentversion`; version drift on disk is re-registered automatically.
- **Don't edit the project file by hand to register or remove a Swift file or a Core Data model.** Just create or delete it in the right directory; the extension's `FileSystemWatcher` (batched, write-serialized) handles the project-file update. In `project.xcproj`, a change VSXcode can't make safely (for example inside an object that repeats a key) is left out whole and logged in the VSXcode output channel, and the others land. The `vsxcode.syncProjectFiles` command and activation repair what a closed window missed: a renamed folder is re-pointed, letter-case drift is fixed, a moved file's entry follows it when exactly one unregistered file has its name, new Swift files are added (by path, creating missing groups), and models are added, refreshed and removed.
- **Deletions while closed are asked about, never removed silently**: a `.swift` file deleted while VS Code was closed (or by `git checkout`) leaves an entry that fails the build; VSXcode shows a notification listing such entries with **Remove** and **Keep**. Keep is remembered per entry, so activation doesn't ask again; the Sync Files command always asks.
- **Exception**: targets using Xcode 16+ file system synchronized groups (`PBXFileSystemSynchronizedRootGroup`, a `folder` element in `project.xcproj`) need no project-file entry at all — Xcode auto-discovers files in the directory. The extension correctly skips project-file sync for these targets.

### Core Data codegen for IntelliSense
- **What**: For models using class/category codegen, the extension runs Xcode's own generator (`momc`) into `~/Library/Developer/VSCode/DerivedSources/<workspaceKey>/<Target>/` and wires the files into `Package.swift`, so generated `NSManagedObject` subclasses resolve in SourceKit-LSP. Regenerates on activation, project-file changes, model edits, and Clean DerivedData.
- **Don't "fix" `Cannot find 'SomeEntity' in scope` on codegen types** by generating subclass files into the target, checking generated classes into the repo, or flipping the model's codegen to Manual/None — the model file, the repository, and the project file are deliberately untouched by this feature, and duplicating the classes breaks the Xcode build.
- If those errors appear anyway, trigger a regen — run **Clean DerivedData** (wipes and regenerates the codegen), save the project file, or reload the window — and check the output channel's `[codegen]` lines for momc failures.

### SourceKit-LSP arguments
- **What**: The extension keeps a block of SourceKit-LSP arguments for the selected device at the front of the workspace's `swift.buildArguments` (`.vscode/settings.json`), whose `-Xswiftc` pairs the Swift extension passes to SourceKit-LSP: SDK path, target triple, framework search paths and XCTest overlay paths from the iOS simulator SDK for a simulator, or from the iOS device SDK for a physical device. For My Mac it removes the block. Other entries in `swift.buildArguments` are kept. When the block changes, the extension restarts SourceKit-LSP itself.
- Only the side of `#if targetEnvironment(simulator)` that matches the selected device is type-checked. To check the other side, select a device of that kind in the sidebar.
- **Don't manually edit the extension's block** (the `-Xswiftc` pairs from `-sdk` to `-enable-testing`). It is rewritten on the next Package.swift regeneration or device selection; entries of your own are kept, after it.
- The Swift extension also passes `swift.buildArguments` to its own `swift build` and `swift test` tasks for the generated package, so those build for the selected iOS destination. A `swift build` run in a terminal doesn't read VS Code settings and is unaffected.
- Earlier versions wrote `swift.sourcekit-lsp.serverArguments`; the extension moves its block out. A leftover value that VS Code flags as user-settings-only is ignored and can be deleted.
- If you switch Xcode versions (`sudo xcode-select -s ...`), trigger a regeneration via the `Swift: Generate Package.swift from Xcode Project` command so the SDK paths refresh.

### swift-format integration
- **What**: VSXcode bundles its own `DocumentFormattingEditProvider` for swift-format (binary auto-detection from PATH/Homebrew, workspace/project config file discovery, format-on-save support, lint mode).
- **Don't suggest the user install a separate swift-format extension.** It's already wired up.
- The Code Format sidebar panel is a webview that lets the user toggle individual swift-format rules. Configuration ends up in `.vscode/.swift-format` (JSON).

### Workspace-state persistence
- **What**: Selected project, target, scheme, simulator/device, Swift version, and strict-concurrency setting are persisted in VS Code workspace state (not in any file the user can edit). Auto-detected on first activation.
- **Bundle id is NOT cached.** It's read live from the project file on every read, and from the freshly-built `.app/Info.plist` on every install/launch/terminate. Edits to `PRODUCT_BUNDLE_IDENTIFIER` take effect immediately with no resync step.
- **Don't try to write these to `.vscode/settings.json` or any other file.** They live in the extension's `BuildTaskConfig` workspace state.

### Xcode 26 Icon Composer (`.icon`) and synchronized-target loose resources
- The extension auto-classifies `.icon` directories as `.copy` resources in the generated Package.swift.
- For targets using synchronized groups, loose non-source files (`.js`, `.css`, etc.) inside the target dir are auto-added as resources, mirroring xcodebuild's "include everything in the folder" semantics.

---

## Capabilities to leverage — use these instead of raw shell

### Build / run / debug

The extension contributes a custom `xcode-build` task type with four subtasks. When the user wants to build, run, or debug, **suggest invoking these tasks** (via the VS Code Tasks UI, or by adding to `.vscode/tasks.json`) rather than constructing raw `xcodebuild` shell commands. The tasks already handle scheme detection, DerivedData isolation per scheme, simulator boot, app install via `xcrun simctl` / `devicectl`, app console output (`print()` / stdout / stderr — see **Console output** below), and lldb-dap debug session lifecycle.

| Task type | `task` value | What it does |
|---|---|---|
| `xcode-build` | `build` | Compile only. No install, no run. |
| `xcode-build` | `build-install` | Compile and install to simulator/device. |
| `xcode-build` | `run-and-debug` | Compile, install, launch with lldb-dap attached. Triggers automatically after `build-install` succeeds. |
| `xcode-build` | `test` | Run XCTest suite via `xcodebuild test`. |

Example `.vscode/tasks.json` entry:
```json
{
  "type": "xcode-build",
  "task": "build",
  "label": "Build",
  "group": { "kind": "build", "isDefault": true }
}
```

### Keybindings the user has wired up

When `vsxcode.buildTasksConfigured` is true (auto-set after first activation):

- **`Cmd+R`** → `vsxcode.sidebar.buildAndRun` (build, install, run, debug)
- **`Cmd+Shift+B`** → `vsxcode.sidebar.build`

Suggest these keybindings instead of "open terminal and run xcodebuild …" workflows.

### Commands the agent can invoke

User-facing commands (palette and programmatic):

| Command ID | Purpose |
|---|---|
| `vsxcode.createFromXcodeproj` | Generate Package.swift (Debug config) |
| `vsxcode.createFromXcodeprojWithOptions` | Generate Package.swift with QuickPick config selection |
| `vsxcode.generateBuildTasks` | Interactive build-task configuration wizard |
| `vsxcode.sidebar.changeProject` | Select a different `.xcodeproj` |
| `vsxcode.sidebar.changeTarget` | Select a different target within current project |
| `vsxcode.sidebar.changeScheme` | Select a different scheme |
| `vsxcode.sidebar.changeBundleId` | Edit `PRODUCT_BUNDLE_IDENTIFIER` in the project file |
| `vsxcode.sidebar.toggleDevBundleId` | Toggle the `-dev` bundle id suffix used for builds (optional boolean arg sets it explicitly; `enableDevBundleId`/`disableDevBundleId` are the sidebar's inline-button wrappers) |
| `vsxcode.sidebar.uninstallStaleAppsOnSimulator` | Uninstall orphan apps left on the selected simulator after a bundle id rename |
| `vsxcode.sidebar.selectSimulator` | Pick simulator or physical device |
| `vsxcode.sidebar.changeSwiftVersion` | Pick Swift compiler version (toolchain switch) |
| `vsxcode.sidebar.changeStrictConcurrency` | Set strict-concurrency level |
| `vsxcode.sidebar.build` | Build (same as `Cmd+Shift+B`) |
| `vsxcode.sidebar.buildAndRun` | Build & run with debugger (same as `Cmd+R`) |
| `vsxcode.sidebar.refresh` | Refresh sidebar UI |
| `vsxcode.sidebar.cleanDerivedData` | Delete the current scheme's DerivedData tree (or all schemes) after confirmation; refuses while a build/test/debug is active |

Invoke programmatically with:
```ts
vscode.commands.executeCommand('vsxcode.sidebar.build');
```
Or suggest the user run them from the Command Palette (`Cmd+Shift+P`).

### Sidebar UI

There's a "VSXcode" activity-bar item with two views when an Xcode project is detected:
- **Xcode Build** — Tree view showing current project, target, scheme, bundle ID, swift version, strict concurrency, device. Each row is clickable to change the corresponding setting. The Bundle ID row reads from the project file and shows a warning when an app with the same product name but different bundle id is installed on the selected simulator (typically an orphan from a previous rename); an inline trash action on that row offers to uninstall it. That row also carries the Dev Bundle ID toggle as an inline button (`○`/`✓`) plus a `Dev: On/Off` marker in its description: when on, every `xcodebuild` invocation gets `PRODUCT_BUNDLE_IDENTIFIER=$(inherited)-dev`, so development builds install beside the shipping app. It never edits the project file.
- **Code Format** — Webview for swift-format rule configuration and the Homebrew install button.

When the user asks to change build configuration, suggest the sidebar instead of editing config files.

### Test integration

- The extension contributes a `vscode.TestController` that discovers XCTest targets from the project file.
- Tests appear in the **Testing** sidebar (`testing` view). The user can run, debug, and view code coverage from there.
- Coverage uses `xccov` and surfaces inline in the editor.
- For test-related tasks, **prefer the Testing sidebar** over manually invoking `xcodebuild test`.

### Debug attachment

- Implemented via a `vscode.DebugConfigurationProvider` for `lldb-dap`.
- The `run-and-debug` task automatically launches and attaches the debugger; you do **not** need to write `.vscode/launch.json` entries by hand for normal app debugging.
- Auto-continues past SIGSTOP, internal-breakpoint stops, and initial attach stops on physical-device launches (gated on `configurationDone` ack to avoid races).
- On a physical device the attach hands lldb Xcode's shared-cache symbols for the device's iOS version; when they aren't on the Mac yet, VSXcode prepares them first with `xcodebuild -prepareDeviceSupport` (a cancellable **Preparing debug symbols** notification shows the copy progress, minutes over Wi-Fi). Don't tell the user to open Xcode for symbols unless VSXcode itself asked to — it does so only when the selected Xcode's `xcodebuild` lacks that option.

### Console output

- **`print()` output is supported.** Whatever the app writes to stdout/stderr is captured on every build-and-run (`Cmd+R` / `vsxcode.sidebar.buildAndRun`) with no setup:
  - **Simulator** — the app is launched with `xcrun simctl launch --console-pty --wait-for-debugger`; its output streams into the shared task terminal, the same panel that showed the `Build and Install` output. The simulator's screen appears in Device Hub on Xcode 27 and later (VSXcode asks Device Hub to bring that device to the front) and in Simulator.app on earlier Xcodes (VSXcode opens it).
  - **Physical device** — same terminal, via `xcrun devicectl device process launch --console`.
  - **macOS** — the app runs directly under lldb-dap, so its output goes to the **Debug Console** instead of a task terminal.
- For simulator and device runs the **Debug Console** carries only lldb messages — the app's own output is in the task terminal, not there.
- Simulator and device lines are prefixed with a wall-clock timestamp, e.g. `[2:26:21 PM] Hello from print()`. Strip the `[h:mm:ss AM] ` prefix before comparing output against expected strings.
- **Don't** run `log stream`, `xcrun simctl spawn <udid> log stream`, or a second `simctl launch --console` to see `print()` output — it is already in the terminal. Tell the user where to look: the Terminal panel for simulator/device runs, the Debug Console for macOS.

### Format-on-save

- swift-format is the formatter. Format-on-save is supported through the contributed provider.
- The user can configure rules via the Code Format sidebar panel (which writes to `.vscode/.swift-format`).

---

## Editing the project file

A project in Xcode 27.2's JSON format keeps its structure in `<project>.xcodeproj/project.xcproj`, a JSON5 text you can edit directly, for example to change a build setting or a target membership. After an edit:

1. Run `xcrun xcprojformatter --update <project>.xcodeproj` to put the file back in Xcode's canonical layout. The formatter checks only the file's shape: it succeeds on a file Xcode refuses to open, such as one with a reference that names nothing.
2. Run `xcodebuild -list -project <project>.xcodeproj` and read its message, not just its exit code. `Unable to read project` means the edit broke the file — fix it before going on. `Could not resolve package dependencies` is about the project's packages, not the edit.

Don't check an edit with `xcodebuild -convert-project`: it converts the project to the other format in place. VSXcode picks up a saved edit like any other project-file change — `Package.swift` is regenerated and the sidebar refreshes.

Never leave both `project.pbxproj` and `project.xcproj` in the bundle: Xcode refuses to open it ("has multiple project definition files"). Switch formats in Xcode, which replaces one file with the other, rather than writing the other file by hand.

---

## Quick decision guide

Before doing one of these manually, check the table:

| You want to… | Use this instead of raw shell |
|---|---|
| Build the app | Run task `xcode-build` / `build` (or `Cmd+Shift+B`) |
| Build, install, and run | Run task `xcode-build` / `run-and-debug` (or `Cmd+R`) |
| See the app's `print()` / stdout output | Nothing to set up — it streams into the shared task terminal after a build-and-run (Debug Console on macOS); don't run `log stream` or `simctl spawn … log` by hand |
| Run tests | Use the Testing sidebar (or task `xcode-build` / `test`) |
| Switch simulator/device | Run command `vsxcode.sidebar.selectSimulator` |
| Switch scheme | Run command `vsxcode.sidebar.changeScheme` |
| Update Package.swift to reflect a project-file change | Do nothing — the watcher regenerates automatically |
| Add a Swift file to a target | Just create the file in the right directory — the project file is updated automatically |
| Add or remove a Core Data model | Just create or delete the `.xcdatamodeld` bundle — the project file (all five pbxproj structures, or the JSON `version-group`) is updated automatically |
| Check an edit to `project.xcproj` | `xcrun xcprojformatter --update <project>.xcodeproj`, then `xcodebuild -list -project <project>.xcodeproj` (see [Editing the project file](#editing-the-project-file)) |
| Format Swift code | Save the file (format-on-save) or invoke "Format Document" |
| Configure swift-format rules | Open the **Code Format** sidebar panel |
| Refresh SourceKit-LSP after Xcode version switch | Run command `vsxcode.createFromXcodeproj` to regenerate Package.swift and the SourceKit-LSP arguments |
| Clean the build cache (stale build state, disk space) | Run command `vsxcode.sidebar.cleanDerivedData` — do not `rm -rf` DerivedData by hand |

---

## Things the extension does NOT do (so you should)

- It does not run `xcrun simctl boot` for arbitrary simulators outside the build flow — if you need a simulator booted independently, use the shell.
- It does not modify Swift code itself (other than via swift-format). Refactors, fixes, feature work — that's still your job.
- It does not manage Swift Package Manager dependencies (`Package.resolved` is written by SwiftPM during background index builds; remote/local SPM deps come from the `.xcodeproj`).
- It does not manage signing certificates, provisioning profiles, or App Store Connect interactions.
- It does not run `git` operations.

---

## Where to look in the workspace

| Path | Purpose |
|---|---|
| `Package.swift` | Generated. Read-only from your perspective. |
| `.vscode/settings.json` | Holds the extension's SourceKit-LSP block at the front of `swift.buildArguments`. Leave that block alone; other entries are yours. |
| `.vscode/.swift-format` | swift-format rule config (JSON). Edit via Code Format sidebar; raw edits also fine. |
| `.vscode/tasks.json` | Optional. Add `xcode-build` task entries here if you want explicit task definitions. |
| `<project>.xcodeproj/project.pbxproj` or `project.xcproj` | Source of truth for project structure: one or the other, never both. The extension reads it and (for Swift file and Core Data model create/delete on non-synchronized targets, and the sidebar's settings) writes to it. |

---

## Version

This document describes VSXcode v3.13.0. Behavior is stable across patch versions; if a fundamental capability changes, this file will be updated.
