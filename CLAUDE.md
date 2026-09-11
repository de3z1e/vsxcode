# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

- `npm run compile` — Build TypeScript from `src/` to `out/`
- `npm run watch` — Rebuild on file changes
- `npm run package` — Package as `.vsix` for distribution
- `npm run test:flag-parity` — Build a fixture Xcode project with `xcodebuild`, generate a
  `Package.swift` from the same pbxproj, build that with SwiftPM, and diff the
  semantics-affecting flags the two toolchains pass to the Swift compiler. **Re-run after
  every Xcode upgrade**: the flag table in `src/types/swiftSettingFlags.ts` is transcribed
  from Xcode's `Swift.xcspec` and rots when Apple changes it. Requires a full Xcode; runs
  entirely in a temp directory.
- `npm run test:pbxproj` — Run every exported pbxproj parser, plus a fixed set of pbxproj writer
  edits, over the fixtures in `scripts/fixtures/pbxproj/` and diff the results against the
  reviewed goldens in `scripts/fixtures/pbxproj/goldens/`. Each fixture must pass `plutil -lint`
  with and without its comments, and entries in the script's `COMMENT_FREE` table must reproduce
  the commented golden when the comments are stripped. `npm run test:pbxproj -- --update` rewrites
  the goldens — review that diff. Setting `VSXCODE_PBXPROJ_CORPUS=<file listing project.pbxproj
  paths>` and `VSXCODE_PBXPROJ_CORPUS_GOLDENS=<directory outside the repo>` also runs the parsers
  and two writer edits over local projects, printing counts and list indexes only; those goldens
  hold private project data, so the script refuses a directory inside the repository.
- `npm run test:file-sync` — Run the compiled Swift and Core Data sync watchers in plain Node, with
  `vscode` stubbed, against the Xcode-format project in `scripts/fixtures/file-sync/`. Each scenario
  lays the project and `sources.json` out in a temp directory, applies real file operations, fires
  the watcher events VS Code would deliver (creates before deletes), and reads the result through
  `plutil`: the entries a scenario names must change as stated, and every other Swift file reference
  and Core Data model must stay unchanged, ids included.
- `npm run test:swiftpm-project` — Run the compiled extension's `activate()` in plain Node against a
  stubbed `vscode`, on temp workspaces, to check the SwiftPM-generated project prompt. A project with
  SwiftPM's `OBJ_n` ids gets a modal choice before VSXcode changes anything: **Use VSXcode fully**
  backs up the files VSXcode would change and turns everything on; **Keep it a SwiftPM package**
  leaves the workspace untouched and is remembered; dismissing asks again on the next open. The Generate
  command offers the same choice, and an ordinary project behaves as before, including one created deeper in
  the tree after the folder opens. Requires a full Xcode, since activation runs `xcodebuild -list` and lists
  simulators.

No test framework or linter is configured; the checks are plain Node scripts.

**Version bumps**: When bumping the version number, update it in **all** locations: `package.json`, `README.md`, and any other files that reference the version. Search the repo to ensure nothing is missed.

**Important**: After every code change, always compile, package, and install the extension into VS Code:
```
find . -maxdepth 1 -name "*.vsix" -delete && npm run compile && npm run package && code --install-extension *.vsix --force
```

**Before committing**: Always launch an independent subagent to audit the staged diff before running `git commit`. The subagent should review the changes, read relevant surrounding files for full context, and check for bugs, logic gaps, unintended side effects, and issues beyond just the changed lines. The audit's final step is a PII sweep: this repository is public, so no real names, device names, other project names, private links, or email addresses may appear in code, comments, docs, examples, or commit messages — use generic placeholders (`MyApp`, `"My MacBook Pro"`). Only commit after the audit passes clean.

## Architecture

VS Code extension that parses Xcode `.xcodeproj` files and generates `Package.swift` manifests and build/debug task configurations for iOS simulator development. Requires macOS with Xcode installed. No runtime dependencies — only VS Code API and Node.js built-ins.

**Data flow**: Read `project.pbxproj` (ASCII plist) → structured data (targets, target dependencies, build phases, groups and version groups through a `plutil`-backed object index; everything else through regex-based parsers) → formatted Swift/JSON output → diff view → user confirmation → write file. Bidirectional: `.swift` file additions/removals are synced back into `project.pbxproj` via string manipulation.

### Entry Point

`src/extension.ts` — Orchestrator (~1500 lines) that registers all commands, providers, and watchers. Contains two main workflows:

1. **generatePackageSwift** — Parses pbxproj, builds Package.swift, configures SourceKit-LSP for iOS simulator SDK
2. **configureBuildTasks** — Interactive setup of project/target/scheme/simulator, stores `BuildTaskConfig` to workspace state

Also contains inline helpers: `generateCSettings`, `formatProductType`, `printToSharedPanel`, `cancelActiveRun`, `executeTaskAndWait`.

### Commands

| Command | Description |
|---------|-------------|
| `vsxcode.createFromXcodeproj` | Generate Package.swift (Debug config) |
| `vsxcode.createFromXcodeprojWithOptions` | Generate Package.swift (QuickPick config selection) |
| `vsxcode.generateBuildTasks` | Interactive build task configuration |
| `vsxcode.sidebar.*` | 15 sidebar commands: changeProject, changeTarget, changeScheme, changeBundleId, toggleDevBundleId (+ enableDevBundleId/disableDevBundleId inline wrappers), uninstallStaleAppsOnSimulator, selectSimulator, changeSwiftVersion, changeStrictConcurrency, build, buildAndRun, refresh, cleanDerivedData |

### Module Map

```
src/
├── extension.ts                 — Main orchestrator, command registration, workflows
├── types/
│   ├── interfaces.ts            — All TS interfaces (NativeTarget, BuildSettings, TargetOutput, BuildTaskConfig, etc.)
│   ├── constants.ts             — Platform mappings, IMPLICIT_FRAMEWORKS, SWIFT_VERSION_MAP,
│   │                              resource extensions, SPM source/exclude/resource constants
│   └── swiftSettingFlags.ts     — Xcode build setting → compiler flag table transcribed from
│                                  Swift.xcspec; per-row value map, resolved default, language-mode
│                                  gate, approachable-concurrency umbrella flag, ignore list
├── parsers/
│   ├── base.ts                  — extractObjectBody (brace-matching), parsePackageRequirement, parseListValue
│   ├── buildSettings.ts         — XCBuildConfiguration parsing, mergeWithInherited, project/target settings,
│   │                              raw KEY=value capture for settings the typed fields don't name
│   ├── projectIndex.ts          — plutil-backed object index (JSON graph, memoized per contents); definition
│   │                              order and entry offsets (locateObject) from a one-pass tokenizer over the
│   │                              text; typed value helpers
│   ├── targets.ts               — targets, target dependencies and build phase IDs read from the project index;
│   │                              isTestTarget
│   ├── packages.ts              — XCRemoteSwiftPackageReference + XCLocalSwiftPackageReference + product deps
│   ├── frameworks.ts            — PBXFrameworksBuildPhase parsing, framework name extraction
│   ├── resources.ts             — PBXResourcesBuildPhase parsing, resource type classification,
│   │                              scanForUnhandledFiles (filesystem scan for SPM compatibility)
│   ├── groups.ts                — PBXGroup hierarchy from the project index, path-to-group resolution
│   ├── project.ts               — project-level fields: default localization, deployment targets,
│   │                              synchronized-folder exclusions
│   └── versionGroups.ts         — XCVersionGroups (.xcdatamodeld bundles) from the project index: children,
│                                  currentVersion, entry offsets; section bounds
├── generators/
│   ├── packageSwift.ts          — Main Package.swift builder (platforms, products, deps, targets)
│   ├── swiftSettings.ts         — swiftSettings entries from build settings: language mode, .define(),
│   │                              .unsafeFlags(), and the flag-table translation; effectiveSwiftMajor
│   ├── linkerSettings.ts        — .linkedFramework() from linked frameworks
│   ├── resources.ts             — Resource entry formatting (.process/.copy)
│   └── buildTasks.ts            — xcodebuild shell commands (build, build-install, run-and-debug)
├── writers/
│   └── pbxproj.ts               — pbxproj modification: add/remove PBXBuildFile, PBXFileReference,
│                                  PBXGroup children, PBXSourcesBuildPhase entries, XCVersionGroup
│                                  entries and section; ID generation
├── sync/
│   ├── pbxprojSync.ts           — Shared sync infrastructure: target-directory mapping, group
│   │                              resolution, pbxproj path lookup, serialized write queue,
│   │                              per-path debouncer, bundle-aware directory walker
│   ├── swiftFileSync.ts         — FileSystemWatcher for *.swift, orchestrates pbxproj updates
│   │                              on file create/delete; catch-up reconcile (add-only)
│   └── dataModelSync.ts         — FileSystemWatcher for *.xcdatamodeld directory bundles,
│                                  reads .xccurrentversion, orchestrates the five pbxproj
│                                  structures; catch-up reconcile (add + refresh + remove)
├── providers/
│   ├── taskProvider.ts          — vscode.TaskProvider for xcode-build task type (4 subtasks)
│   ├── debugConfigProvider.ts   — vscode.DebugConfigurationProvider for lldb-dap attach configs
│   ├── sidebarProvider.ts       — vscode.TreeDataProvider for sidebar UI + autoConfigureBuildTasks
│   ├── swiftFormatProvider.ts   — DocumentFormattingEditProvider for swift-format (format-on-save,
│   │                              binary detection, config file management, lint mode)
│   ├── codeQualityWebviewProvider.ts — WebviewViewProvider for Code Format sidebar panel
│   │                              (swift-format config UI, rule toggles, Homebrew install)
│   └── testController.ts        — vscode.TestController for XCTest discovery, execution,
│                                  result parsing, and xccov code coverage integration
└── utils/
    ├── version.ts               — Swift/macOS version detection via xcrun, version comparison, cleanup()
    ├── coreDataCodegen.ts       — momc --action generate runner; DerivedSources tree
    │                              (~/Library/Developer/VSCode/DerivedSources/<key>/) with
    │                              workspace keying + marker file; staging-dir swap
    ├── path.ts                  — Target path resolution (Sources/, Tests/, shared conventions)
    ├── swiftPMProject.ts        — SwiftPM-generated project choice: files VSXcode changes, collision-safe
    │                              backups, per-project decision (no vscode import)
    └── simulator.ts             — iOS simulator enumeration via xcrun simctl
```

### Key Patterns

- **Build settings inheritance**: Debug/Release configs merge with project-level defaults via `mergeWithInherited`, respecting `$(inherited)`. Configurations backed by an `.xcconfig` carry a `baseConfigurationReference` between `isa` and `buildSettings`; the config regex spans it, but the `.xcconfig` file's own contents are never read
- **Swift settings translation**: the target's Swift build settings become `swiftSettings` so SourceKit-LSP typechecks under the same language semantics `xcodebuild` uses — before this, settings like `SWIFT_DEFAULT_ACTOR_ISOLATION` were dropped and the editor reported errors on code that built clean. The mapping in `types/swiftSettingFlags.ts` is transcribed from Xcode's own `Swift.xcspec` (the file the build system evaluates), not from documentation: it is the only source that gets the divergent feature spellings right (`SWIFT_UPCOMING_FEATURE_IMPORT_OBJC_FORWARD_DECLS` → `ImportObjcForwardDeclarations`) and that records which settings Xcode consults only below language mode 6. Defaults are transcribed **already resolved** — the spec writes them as `$(…)` expressions, and `SWIFT_STRICT_CONCURRENCY`'s would otherwise fall through its `<<otherwise>>` branch and hand every Swift 5 target a `StrictConcurrency` it never asked for. `SWIFT_APPROACHABLE_CONCURRENCY` has no flags of its own; it supplies the default for five upcoming features, three of which are suppressed at language mode 6. First-class `SwiftSetting` factories are used when the emitted `swift-tools-version` allows them (`.defaultIsolation` and `.strictMemorySafety` need 6.2), else the raw flag goes through `.unsafeFlags`. Scalar settings resolve target-then-project — including `SWIFT_VERSION`, so a project that hoists it to the project configuration still gets the right language mode and the right version gate; only the gate falls back to the toolchain version, never the language mode, which must not declare a version the project never named. Settings with no mapping are logged rather than silently dropped. After an Xcode upgrade, run `npm run test:flag-parity` and refresh the table by re-reading `Swift.xcspec` (`plutil -convert json`, `Options` of `com.apple.xcode.tools.swift.compiler`); the file header records the path
- **Resource classification**: Files classified as `.process` (compilable: xcassets, storyboard, xib, strings, xcdatamodeld) or `.copy` (everything else)
- **Filesystem scanning**: After pbxproj parsing, `scanForUnhandledFiles` walks target directories to auto-exclude Xcode-specific files (Info.plist, .entitlements, .pch) and auto-include bundle-like resource directories (.xcdatamodeld, .xcassets, .lproj, etc.) that SPM can't auto-categorize
- **Auto-sync (pbxproj → Package.swift)**: FileSystemWatcher on `*.pbxproj` triggers silent Package.swift regeneration
- **Auto-sync (Swift files → pbxproj)**: FileSystemWatcher on `*.swift` detects file create/delete in target directories and updates pbxproj (4 entries: PBXBuildFile, PBXFileReference, PBXGroup, PBXSourcesBuildPhase). Handles subdirectories via PBXGroup tree resolution. Debounced (300ms) with write serialization. Runs only when every object id has Xcode's 24-character hex form (`usesXcodeObjectIds`), the only form the writers match, so projects with other ids, such as SwiftPM-generated ones, are left alone.
- **Auto-sync (Core Data models → pbxproj)**: FileSystemWatcher on `*.xcdatamodeld` treats the bundle as one unit (the directory, not the files inside) and updates 5 structures: PBXBuildFile, a `wrapper.xcdatamodel` PBXFileReference per version, PBXGroup child, PBXSourcesBuildPhase entry (momc compiles models — Sources, not Resources), and the XCVersionGroup, whose section markers are created on the first model and dropped with the last. `children`/`currentVersion` come from the bundle's `.xccurrentversion`, falling back to the sole version; a bundle whose versions drift from what pbxproj records is re-registered, since a `currentVersion` pointing at a missing version is the same momc failure as no entry at all. Both events run the same routine and decide from disk rather than the event kind, so a rename or atomic replace settles correctly. Shares the swift sync's debounce and write queue, and the same object-id check.
- **Core Data codegen (SourceKit-LSP)**: models with class/category codegen get their NSManagedObject subclasses generated only by Xcode's build, so the SwiftPM-based LSP build can't resolve them. `generatePackageSwift` runs momc per target with a data model into `~/Library/Developer/VSCode/DerivedSources/<workspaceKey>/<Target>/` and folds the files into the module via an `.unsafeFlags` entry interpolating a `coreDataGenerated` preamble variable (`Context.environment["HOME"]` — documented PackageDescription API). SwiftPM folding positional source paths from unsafeFlags is undocumented behavior, accepted deliberately: the repository, the model file, and pbxproj stay untouched, so the Xcode build/archive pipeline can never be affected — the failure mode is LSP squiggles, never builds. momc failure → manifest emitted without flags. Regen triggers: activation, pbxproj changes, bundle create/delete, model-contents edits (`**/*.xcdatamodeld/**` watcher — entity edits never touch pbxproj), the manual Sync Files command, and Clean DerivedData (wipe + immediate regen). Manifest generation is serialized per workspace; codegen runs are serialized module-wide and land via staging-dir rename so the LSP never observes a half-populated directory. Each output dir carries a `manifest.json` recording what was emitted, and every generation pass garbage-collects stale outputs — a deleted/renamed input or disabled codegen removes its derived files (legacy all-`.swift` dirs included), an emptied tree is removed marker and all, and anything not recognizable as extension output is left in place and logged.
- **Reconcile**: `vsxcode.syncProjectFiles` (and activation) catches up on changes the watchers missed. Swift files are add-only; Core Data models are also removed when the bundle is gone from disk, since a stale XCVersionGroup fails the build with momc's "No current version for model". Removal requires the model to be absent both at its resolved path and by name, so an unresolvable group tree is never read as a deletion.
- **Auto-configure**: On activation, auto-detects first project/target/simulator and stores `BuildTaskConfig` to workspace state
- **SwiftPM-generated projects**: a project whose object ids use SwiftPM's `OBJ_n` form (`swift package generate-xcodeproj`) sits beside the package's own Package.swift, so VSXcode asks before managing it. Before anything that writes, a modal dialog lists each file VSXcode would change — Package.swift, the workspace settings file (`.vscode/settings.json` or the open `.code-workspace`), `.vscode/.swift-format`, `project.pbxproj` — with the backup each would get. **Use VSXcode fully** copies each existing file to `<file>_backup` (then `_backup-2` and so on; an existing backup is never overwritten) and turns everything on. **Keep it a SwiftPM package** changes nothing — no Package.swift, settings, file sync, build tasks, swift-format profile or terminal skip list — and is remembered per project file under the workspace-state key `swiftPMProjectChoices`. Dismissing does nothing and asks again on the next open. The Generate commands offer the choice again, after their project pick. The decision logic is in `utils/swiftPMProject.ts`, which doesn't import `vscode`; `setupFullExtension` holds every automatic write until the workspace is managed. A silent regeneration checks that when its run starts, not when it is queued, and Keep from a Generate command applies inside the dialog callback, so a regeneration queued while the dialog was open never writes. Using VSXcode fully from a Generate command generates again once the workspace is managed, as activation does, so a project change saved while the dialog was open still reaches Package.swift
- **Task chaining**: build-install completion triggers run-and-debug; debug session end kills debugserver
- **Physical device support**: Build → install via devicectl → poll device ready → launch console → attach lldb-dap
- **SourceKit-LSP**: Auto-configures `swift.sourcekit-lsp.serverArguments` with iOS simulator SDK paths for intellisense
- **swift-format**: Auto-detects binary, discovers workspace/project config files, format-on-save via DocumentFormattingEditProvider, webview UI for rule configuration in sidebar
- **XCTest integration**: Discovers test targets from pbxproj, runs via xcodebuild, parses results (xcresulttool), xccov code coverage
- **Diff view**: Shows current vs generated Package.swift before overwriting
- **Activation**: `workspaceContains:**/*.pbxproj` and `onDebug`

### Package.swift Features

Swift settings (.define, .unsafeFlags, .swiftLanguageMode), linked frameworks (.linkedFramework), resources (.process/.copy), header search paths (.headerSearchPath), target dependencies (.target(name:)), excluded files, Swift package dependencies (remote + local), deployment targets, default localization, multi-configuration support (Debug/Release).

### Build & Debug Features

Custom `xcode-build` task type with build/build-install/run-and-debug/test subtasks, lldb-dap debug attachment, simulator boot + app install via xcrun simctl, physical device support via devicectl, DerivedData isolation per scheme, Cmd+R and Cmd+Shift+B keybindings, sidebar UI for configuration management, XCTest controller with code coverage.
