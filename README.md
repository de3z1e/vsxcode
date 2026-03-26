# VSXcode

> Formerly called Swift Package Helper.

Lightweight Xcode project integration for VS Code — IntelliSense, build tasks, full debugging with breakpoints and console output on both simulators and physical devices, and native swift-format code formatting. Single dependency: the [Swift extension](https://marketplace.visualstudio.com/items?itemName=swiftlang.swift-vscode). Automatically generates `Package.swift` for full SourceKit-LSP support and configures build tasks that let you build, run, and debug iOS apps directly from VS Code.

### How It Works

Open a folder containing an `.xcodeproj` and the extension handles the rest:

1. **Auto-generates `Package.swift`** from the Xcode project on activation, with correct target paths, resources, dependencies, and Swift settings.
2. **Auto-configures build tasks** with sensible defaults (target, scheme, device/simulator, bundle ID).
3. **Configures SourceKit-LSP** for iOS simulator target resolution so IntelliSense works for UIKit and other iOS frameworks.
4. **Silently regenerates** `Package.swift` whenever the `.pbxproj` file changes.
5. **Syncs Swift files to the Xcode project** — when `.swift` files are added or removed from a target directory, the `.xcodeproj` is updated automatically (PBXBuildFile, PBXFileReference, PBXGroup, and PBXSourcesBuildPhase entries).

### Sidebar

The extension adds a panel to the Activity Bar with configurable build settings:

- **Project** — select which `.xcodeproj` to use (when multiple exist)
- **Target** — select the build target
- **Scheme** — select the build scheme
- **Bundle ID** — edit the bundle identifier
- **Device** — select from connected physical devices (USB or Wi-Fi) or available iOS simulators

Title bar actions: **Build**, **Build & Run**, and **Refresh**.

### Commands

| Command | Description |
|---------|-------------|
| **Swift: Generate Package.swift from Xcode Project** | Generates `Package.swift` using the Debug configuration with a diff view. |
| **Swift: Generate Package.swift from Xcode Project (with Options)** | Same as above but lets you choose Debug or Release configuration. |
| **Swift: Configure Build Tasks** | Manually configure build target, scheme, device/simulator, and bundle ID. |

### Package.swift Generation

- Detects the first `.xcodeproj` in the workspace (or lets you pick when multiple exist).
- Extracts Swift tools version, platform deployment targets, targets, and product metadata.
- Resolves target source paths on disk, including `productName` directory lookup.
- Resolves resource file paths on disk relative to the target directory.
- Includes per-target swift settings (`.define`, `.unsafeFlags`, `.swiftLanguageMode`), linked system frameworks, resources, header search paths, target dependencies, and excluded files.
- Automatically configures SourceKit-LSP server arguments for iOS simulator target resolution (SDK path, target triple, framework search path).
- Shows a diff view before overwriting when run manually from the command palette.

### Build Tasks

Build tasks are integrated directly into the extension — no shell scripts, `tasks.json`, or `launch.json` files are written to the workspace.

- Uses VS Code's `TaskProvider` API to provide build, build-install, and run-and-debug tasks.
- Full debug support with breakpoints and `print()` console output for both **simulator** and **physical device** builds.
- Simulator debugging uses `simctl launch --console-pty --wait-for-debugger` with LLDB DAP attach.
- Physical device debugging uses `devicectl --console --start-stopped` with LLDB DAP remote-ios attach. Supports USB and Wi-Fi connected devices (requires Xcode 15+). Code signing uses the project's existing settings from Xcode.
- Build configuration is stored in VS Code's workspace state (persists across sessions).
- Build output is colorized: errors in red, warnings in yellow.

### Code Format (swift-format)

A dedicated Code Format panel in the sidebar provides native [swift-format](https://github.com/apple/swift-format) integration — the formatter bundled with Xcode. No extra tools to install.

- **Format on Save** — automatically formats Swift files when saving using `swift-format format`.
- **Lint Mode** — shows swift-format violations as diagnostics in the Problems panel using `swift-format lint`.
- **18 formatting options** — indentation, line length, line breaks, trailing commas, and more. All configurable from the sidebar with true/false dropdowns and number inputs.
- **43 rules** organized into Format Rules (21 auto-fix rules) and Lint Rules (22 report-only rules). Each rule has a toggle, description, default state, and reset button.
- **Per-section controls** — enable/disable all rules in a section with a single toggle. Partial state indicator when some rules are enabled.
- **Global / Local profiles** — Global profile shares formatting options and rules across all projects. Local profile keeps settings per-project. Switch between them with an option to save local changes to global.
- **Config file sync** — settings auto-generate `.vscode/.swift-format`. Manual edits to the config file are synced back to the UI.

### Testing

XCTest integration via the VS Code Testing sidebar — tests are discovered from the Xcode project and run with `xcodebuild`.

- **Run, Debug, and Coverage** profiles in the Testing sidebar, powered by `xcodebuild test`.
- **Test debugging with breakpoints** — the Debug profile builds for testing, attaches LLDB DAP with `--waitfor`, then runs `test-without-building` so the debugger catches the test host at launch.
- **Code coverage** — the Coverage profile enables `xcodebuild -enableCodeCoverage`, then parses the xcresult via `xcrun xccov` to show per-file percentages and per-line green/red gutter annotations.
- **Test results** in the Testing sidebar with pass/fail status, durations, and assertion failure messages with source locations.

### Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| ⌘R | — | Build, install, and launch with debugger attached |
| ⌘⇧B | Build tasks configured | Build (or build-for-testing when a test target is selected) |

### Dependencies

- [Swift for VS Code](https://marketplace.visualstudio.com/items?itemName=swiftlang.swift-vscode) — automatically installed as a dependency. Provides SourceKit-LSP support and includes LLDB DAP for debugging.

### Installation

- Install from the VS Code Marketplace (search for `VSXcode`).
- Install the bundled package directly: `code --install-extension vsxcode-3.4.9.vsix`.
- VS Code UI alternative: **Extensions → … → Install from VSIX…** and pick the packaged file.

#### Build from source

```bash
npm install              # install dev dependencies
npm run package          # runs tsc build and produces vsxcode-<version>.vsix
code --install-extension vsxcode-3.4.9.vsix
```
