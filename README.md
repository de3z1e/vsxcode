# VSXcode

> Formerly called Swift Package Helper.

Lightweight Xcode project integration for VS Code — IntelliSense, build tasks, and full debugging with breakpoints and console output on both simulators and physical devices, with a single dependency: the [Swift extension](https://marketplace.visualstudio.com/items?itemName=swiftlang.swift-vscode). Automatically generates `Package.swift` for full SourceKit-LSP support and configures build tasks that let you build, run, and debug iOS apps directly from VS Code.

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

### Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| ⌘R | No active debug session | Build, install, and launch with debugger attached |
| ⌘R | During debug session | Stop current session and restart |

### Dependencies

- [Swift for VS Code](https://marketplace.visualstudio.com/items?itemName=swiftlang.swift-vscode) — automatically installed as a dependency. Provides SourceKit-LSP support and includes LLDB DAP for debugging.

### Installation

- Install from the VS Code Marketplace (search for `VSXcode`).
- Install the bundled package directly: `code --install-extension vsxcode-3.1.0.vsix`.
- VS Code UI alternative: **Extensions → … → Install from VSIX…** and pick the packaged file.

#### Build from source

```bash
npm install              # install dev dependencies
npm run package          # runs tsc build and produces vsxcode-<version>.vsix
code --install-extension vsxcode-3.1.0.vsix
```
