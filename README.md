# Swift Package Helper VS Code Command

This lightweight workspace extension exposes a `Swift: Generate Package.swift from Xcode Project` command. Run it from the command palette (⇧⌘P) to read the active `.xcodeproj` and scaffold a `Package.swift` in the workspace root. It fills the gap when you want to work in VS Code, and take advantage of its autocomplete, inline refactoring, or AI tools, while still targeting an existing Xcode project. With a generated `Package.swift`, every build target, package dependency, and framework import (UIKit, SwiftUI, etc.) resolves correctly so VS Code can offer full IntelliSense support.

### Capability

- Detects the first `.xcodeproj` in the workspace (or lets you pick when multiple exist).
- Extracts the Swift tools version, platform deployment targets, targets, and product metadata from the project file.
- Creates or updates `Package.swift` with matching platforms, products, and targets.

### Installation

- Install from the VS Code Marketplace (search for `Swift Package Helper`).
- Install the bundled package directly: `code --install-extension swift-package-helper-0.0.7.vsix`.
- VS Code UI alternative: **Extensions → … → Install from VSIX…** and pick the packaged file.

#### Build from source

```bash
npm install              # install dev dependencies
npm run package          # runs tsc build and produces swift-package-helper-<version>.vsix
code --install-extension swift-package-helper-0.0.7.vsix
```

The `vsce package` step writes the new `.vsix` file to the project root. Update the filename in the final command if the version number changes.

### Usage

1. Open the folder that contains your `.xcodeproj` in VS Code.
2. Launch the command palette (⇧⌘P) and run **Swift: Generate Package.swift from Xcode Project**.
3. Select the project if prompted when multiple `.xcodeproj` files are present.
4. Confirm overwriting when prompted; `Package.swift` is created or refreshed with the project’s settings.

The command uses Xcode’s project metadata, so run it on macOS with Xcode installed for best results.
