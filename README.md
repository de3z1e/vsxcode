# Swift Package Helper VS Code Command

This lightweight workspace extension bridges Xcode projects and VS Code. Run commands from the command palette (⇧⌘P) to generate a `Package.swift` for full IntelliSense support and create build tasks that let you build and run iOS apps on the simulator directly from VS Code.

### Commands

| Command | Description |
|---------|-------------|
| **Swift: Generate Package.swift from Xcode Project** | Generates `Package.swift` from the active `.xcodeproj` using the Debug configuration. |
| **Swift: Generate Package.swift from Xcode Project (with Options)** | Same as above but lets you choose Debug or Release configuration. |
| **Swift: Generate VS Code Build Tasks** | Generates `.vscode/tasks.json` and `launch.json` for building and running on the iOS Simulator. |

### Capability

**Package.swift Generation**

- Detects the first `.xcodeproj` in the workspace (or lets you pick when multiple exist).
- Extracts Swift tools version, platform deployment targets, targets, and product metadata.
- Includes per-target swift settings (`.define`, `.unsafeFlags`, `.swiftLanguageMode`), linked system frameworks, resources, header search paths, target dependencies, and excluded files.
- Shows a diff view before overwriting an existing `Package.swift`.
- Auto-prompts to regenerate when the `.pbxproj` file changes.

**Build Tasks Generation**

- Parses the `.xcodeproj` to extract the target name, scheme, and bundle identifier.
- Queries available iOS simulators and lets you pick one.
- Generates a chained task pipeline: build → boot simulator → install app → launch app.
- Generates an LLDB attach configuration for debugging (F5).
- After generation, use ⇧⌘B to build and F5 to launch on the simulator.

### Installation

- Install from the VS Code Marketplace (search for `Swift Package Helper`).
- Install the bundled package directly: `code --install-extension swift-package-helper-1.0.1.vsix`.
- VS Code UI alternative: **Extensions → … → Install from VSIX…** and pick the packaged file.

#### Build from source

```bash
npm install              # install dev dependencies
npm run package          # runs tsc build and produces swift-package-helper-<version>.vsix
code --install-extension swift-package-helper-1.0.1.vsix
```

The `vsce package` step writes the new `.vsix` file to the project root. Update the filename in the final command if the version number changes.

### Usage

1. Open the folder that contains your `.xcodeproj` in VS Code.
2. Launch the command palette (⇧⌘P) and run **Swift: Generate Package.swift from Xcode Project**.
3. Select the project if prompted when multiple `.xcodeproj` files are present.
4. Confirm overwriting when prompted; `Package.swift` is created or refreshed with the project's settings.
5. Optionally, run **Swift: Generate VS Code Build Tasks** to set up simulator builds and debugging.

The extension uses Xcode's project metadata, so run it on macOS with Xcode installed for best results.
