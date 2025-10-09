# Swift Package Helper VS Code Command

This lightweight workspace extension exposes a `Swift: Generate Package.swift from Xcode Project` command. Run it from the command palette (⇧⌘P) to read the active `.xcodeproj` and scaffold a `Package.swift` in the workspace root.

### Capability

- Detects the first `.xcodeproj` in the workspace (or lets you pick when multiple exist).
- Extracts the Swift tools version, platform deployment targets, targets, and product metadata from the project file.
- Creates or updates `Package.swift` with matching platforms, products, and targets.

### Usage

1. Open this workspace folder in VS Code.
2. Press `F5` to launch the included **Swift Package Helper** debug configuration (opens a separate Extension Development Host window using the bundled `.vscode/SchoolPortal-dev.code-workspace`).
3. The dev-host window already loads that workspace; just open the command palette and search for **Swift: Generate Package.swift from Xcode Project**.
4. Confirm overwriting when prompted if `Package.swift` already exists.

If you prefer the terminal, run:

```bash
code --extensionDevelopmentPath ./vscode/SwiftPackageHelper \
     --user-data-dir .vscode/.devhost-data \
     --new-window .vscode/SchoolPortal-dev.code-workspace
```

This mirrors the debug launch: it opens a fresh profile so VS Code keeps the dev-host window separate from your primary editor.
