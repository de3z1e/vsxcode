# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

- `npm run compile` — Build TypeScript from `src/` to `out/`
- `npm run watch` — Rebuild on file changes
- `npm run package` — Package as `.vsix` for distribution
- `npm install && npm run package && code --install-extension *.vsix` — Full build-from-source install

No test framework or linter is configured.

## Architecture

VS Code extension that parses Xcode `.xcodeproj` files and generates `Package.swift` and build task configurations. Requires macOS with Xcode installed.

**Entry point**: `src/extension.ts` — Orchestrator that registers three commands:
- `swiftPackageHelper.createFromXcodeproj` — Generate Package.swift (Debug config)
- `swiftPackageHelper.createFromXcodeprojWithOptions` — Generate Package.swift (QuickPick config selection)
- `swiftPackageHelper.generateBuildTasks` — Generate `tasks.json`/`launch.json` for simulator builds

**Data flow**: Read `project.pbxproj` (ASCII plist) → regex-based parsing into structured data → formatted Swift/JSON output → diff view → user confirmation → write file.

### Module Roles

- **`parsers/`** — Each parser extracts one PBX section type from the pbxproj text using regex. `base.ts` provides shared utilities (`extractObjectBody`, `parsePackageRequirement`, `parseListValue`).
- **`generators/`** — Transform parsed data into output strings. `packageSwift.ts` is the main builder; others handle subsections (swift settings, linker settings, resources, build tasks).
- **`utils/`** — Shell-dependent helpers: Swift version detection via `xcrun`, simulator listing via `xcrun simctl`, target path resolution.
- **`types/`** — All interfaces in `interfaces.ts`; constants (platform mappings, implicit frameworks, version maps) in `constants.ts`.

### Key Patterns

- Build settings support inheritance chains (Debug/Release configs merge with project-level defaults via `mergeWithInherited`)
- Auto-sync: FileSystemWatcher on `*.pbxproj` triggers regeneration prompt
- Diff view shown before overwriting existing files
- No runtime dependencies — only VS Code API and Node.js built-ins
