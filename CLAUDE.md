# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

- `npm run compile` — Build TypeScript from `src/` to `out/`
- `npm run watch` — Rebuild on file changes
- `npm run package` — Package as `.vsix` for distribution
- `npm run release` — Publish the current version to the Marketplace and tag it. Refuses, listing every
  reason, unless the branch is a clean `main` that matches `origin/main` and `v<version>` exists neither
  locally nor on origin; then runs `npx vsce publish` (which compiles first through `vscode:prepublish`),
  creates the annotated tag `v<version>` at that commit and pushes it. `npm run release -- --dry-run` runs
  the checks and prints the commands without running them.
- `npm run test:flag-parity` — Build a fixture Xcode project with `xcodebuild`, generate a
  `Package.swift` from the same pbxproj, build that with SwiftPM, and diff the
  semantics-affecting flags the two toolchains pass to the Swift compiler. **Re-run after
  every Xcode upgrade**: the flag table in `src/types/swiftSettingFlags.ts` is transcribed
  from Xcode's `Swift.xcspec` and rots when Apple changes it. Requires a full Xcode; runs
  entirely in a temp directory.
- `npm run test:pbxproj` — Run every exported pbxproj parser, plus a fixed set of pbxproj writer
  edits, over the fixtures in `scripts/fixtures/pbxproj/` and diff the results against the
  reviewed goldens in `scripts/fixtures/pbxproj/goldens/`. Each fixture must pass `plutil -lint`
  with and without its comments, every entry must reproduce the commented golden when the comments
  are stripped (the script's `COMMENT_FREE` table lists the entry families and must cover every one
  recorded), and every writer edit's output must lint. `npm run test:pbxproj -- --update` rewrites
  the goldens — review that diff. Setting `VSXCODE_PBXPROJ_CORPUS=<file listing project.pbxproj
  paths>` and `VSXCODE_PBXPROJ_CORPUS_GOLDENS=<directory outside the repo>` also runs the parsers
  and four writer edits over local projects, printing counts and list indexes only; those goldens
  hold private project data, so the script refuses a directory inside the repository.
- `npm run test:xcproj` — Check that VSXcode's JSON5 reader (`src/parsers/xcprojText.ts`) reads Xcode 27.2's JSON
  project file (`project.xcproj`) the way Xcode's own reader does. It runs over the fixtures in
  `scripts/fixtures/xcproj/` (each pbxproj fixture converted by `xcodebuild -convert-project xcproj` and
  stored as Xcode wrote it, plus `json5-syntax`, a hand-written project in the JSON5 syntax Xcode accepts)
  and over a table of syntax cases embedded in a valid project. Every case must get the verdict
  `xcprojformatter` (Xcode's own reader) gives, live, and every accepted value must match plutil's, except
  where plutil differs from Xcode: a duplicated key, where Xcode keeps the first and plutil the last, and
  `Infinity`/`NaN`, which only Xcode accepts. Every node's offsets must re-read to its value. Then the lowering
  into the project index (`src/parsers/xcprojIndex.ts`): for every valid fixture, including `features` (every
  construct the lowering handles, in `xcprojformatter`'s canonical form), what VSXcode reads from the index must
  equal what it reads from Xcode's own `xcodebuild -convert-project pbxproj` of the file on a temp copy (offline;
  result bundles kept in the temp folder); every `invalid-*` fixture, one fault each, must be refused by Xcode and
  by the reader, for the reason its header names; `json5-syntax` must lower exactly as its canonical form does; and
  every parser's output must match the reviewed goldens in `scripts/fixtures/xcproj/goldens/`. The JSON writer's
  cases (each operation, the sync's sequences, path edge cases, membership forms, declines undoing only their
  change, new handles, a hand-written CRLF project, 300 adds into a 5,000-file project within 5 s) must each read
  back with the expected change, keep every other id, be left unchanged by `xcprojformatter` and convert. So must the
  Core Data cases (add, refresh, move, remove, declines) and the build-setting cases, whose values are read back from
  Xcode's own conversion of the output, each differing from the input only inside its edited spans. Last, the
  definition file (`src/utils/projectFile.ts`): which of `project.pbxproj` and `project.xcproj` a bundle resolves to
  (both, neither, backups beside it ignored); `writeProjectFile` writing only into the file that was read and never
  creating one (a switched, doubled, missing or vanishing file gives false and changes nothing, a shorter text truncates);
  and whether a JSON project needs a newer Xcode than the selected one.
  `npm run test:xcproj -- --update` rewrites the goldens — review that diff. Requires Xcode 27.2 or later;
  **re-run after every Xcode upgrade**.
- `npm run test:file-sync` — Run the compiled Swift and Core Data sync watchers in plain Node, with
  `vscode` stubbed, against the Xcode-format project in `scripts/fixtures/file-sync/`, then against Xcode's
  JSON conversion of it (`scripts/fixtures/xcproj/FixtureApp.xcproj.txt`). Each scenario lays the project and
  `sources.json` out in a temp directory, applies real file operations, fires the watcher events VS Code
  would deliver (creates before deletes), and reads the result through `plutil`: the entries a scenario
  names must change as stated, and every other Swift file reference and Core Data model must stay
  unchanged, ids included. The JSON run reads its result through Xcode itself (`xcodebuild -convert-project
  pbxproj` on a copy beside the project, then the same `plutil` read), so a result Xcode can't open fails;
  Xcode's conversion draws new ids for file elements, so that run compares by resolved path, targets and
  settings, and translates the entry ids a scenario's result names. JSON-only scenarios cover declined
  edits: the rest of a batch lands, and a repair's adds and removals and a Core Data add or move count only
  what landed. The JSON run needs Xcode 27.2 or later.
- `npm run test:swiftpm-project` — Run the compiled extension's `activate()` in plain Node against a
  stubbed `vscode`, on temp workspaces, to check the SwiftPM-generated project prompt. A project with
  SwiftPM's `OBJ_n` ids gets a modal choice before VSXcode changes anything: **Use VSXcode fully**
  backs up the files VSXcode would change and turns everything on; **Keep it a SwiftPM package**
  leaves the workspace untouched and is remembered; dismissing asks again on the next open. The Generate
  command offers the same choice, and an ordinary project behaves as before, including one created deeper in
  the tree after the folder opens; a SwiftPM-generated project in the JSON format lists and backs up
  `project.xcproj`. The same harness checks the extension's handling of the project file: a setting command
  writes only a changed text, which `xcprojformatter` leaves as it is; a bundle id formula (Xcode 27.2's new-project
  default) opens in the edit box as written, with the resolved id noted in its prompt; a project file appearing in a package
  checkout, or the workspace project's own file saved atomically, changes nothing; a second definition file in
  the bundle is reported once, in Xcode's words, after a 1 s re-check; and the switch to the JSON file refreshes
  once. Requires a full Xcode, since activation runs `xcodebuild -list` and lists simulators, and Xcode 27.2 or
  later for the JSON cases.
- `npm run test:sidebar` — Run the compiled sidebar provider in plain Node against a stubbed `vscode`, on a temp copy of
  the JSON SyncApp fixture: two Swift version changes, each followed by the refresh the project-file watcher makes, with
  chosen `xcodebuild -list` calls delayed so two loads overlap and the older finishes last (and the controls: the newer
  last, no overlap). The Swift Language Version row must end on the value the file holds and never go blank, a written
  value must show at once without a load, a command during a reload must wait for that load rather than start one, and no
  load may run more than one first-launch check; with no Xcode identity, a first-launch pass must not be shared. Requires a
  full Xcode.
- `npm run test:toolchain` — Run the compiled toolchain helpers in plain Node under every Xcode found among
  `/Applications/Xcode.app` and `/Applications/Xcode_26.app` (override with a colon-separated
  `VSXCODE_XCODE_APPS`), selecting each through `DEVELOPER_DIR`: the detected version, the simulator UI it
  picks (Device Hub from Xcode 27, Simulator.app before) and the reveal snippet's shape; devicectl device-list
  parsing over placeholder documents in both JSON shapes; and the supported-language-mode probe under both
  compiler wordings, live and recorded; and `xcodebuild -prepareDeviceSupport` live under each Xcode (the
  capability is reported, an unknown device is rejected once its search times out, an abort kills xcodebuild).
  Requires a full Xcode. **Re-run after every Xcode upgrade** together with `test:flag-parity`.
- `npm run test:debug-stops` — Run the compiled lldb-dap stop classifier (`src/utils/debugStops.ts`) over stop
  bodies recorded from real sessions: the device-launch artifacts it must resume (SIGSTOP, negative-id internal
  breakpoints, a no-reason initial-attach stop) and the user stops it must never resume (breakpoint, step, a pause
  that lldb-dap reports exactly like the launch SIGSTOP, crashes, anything unrecognized), plus the pending-request
  transitions. Needs no Xcode.
- `npm run test:device-support` — Run the compiled device-symbols lookup (`src/utils/deviceSupport.ts`) over
  temp folders in both layouts Xcode uses under `~/Library/Developer/Xcode/iOS DeviceSupport` (flat up to
  Xcode 26, per-architecture from Xcode 27), the partial states a copy leaves behind, and every device folder
  in this Mac's real tree; and the `xcodebuild -prepareDeviceSupport` output parser over transcripts recorded
  from Xcode 27.0 and 26.6, whole and cut mid-line. Needs no Xcode.
- `npm run test:agent-guide` — Run the compiled agent guide link builder (`src/utils/agentGuide.ts`) over the
  repository URL forms `package.json` may use; check that this repository's `package.json` links
  `docs/AGENT_README.md` at `v<version>` and that the guide exists at that path; and check the copied prompt
  stays on one line, naming the selected project and scheme only when there is a selection. Needs no Xcode.
- `npm run test:sourcekit-lsp` — Run the compiled SourceKit-LSP argument builder (`src/utils/sourceKitLSP.ts`): the
  simulator list must stay what earlier versions wrote, the device list must name the iPhoneOS platform, and a
  stored value must compare equal only to the same list. Merging into `swift.buildArguments` must strip every block
  VSXcode wrote (any destination, Xcode or deployment version) and nothing else, keep the user's own arguments in
  order, carry the user setting over while the workspace has no value, and leave a value that isn't a list of
  strings alone. Under every Xcode found among `/Applications/Xcode.app` and `/Applications/Xcode_26.app` (override
  with a colon-separated `VSXCODE_XCODE_APPS`), every path in both lists must exist, and probes type-checked with
  `swiftc`, the lists after a host `-target` as SwiftPM passes them, must reach the `#else` of
  `#if targetEnvironment(simulator)` under the device list only and resolve `import XCTest` under both with the
  test targets' simulator search paths. Requires a full Xcode. **Re-run after every Xcode upgrade.**

No test framework or linter is configured; the checks are plain Node scripts.

**Version bumps**: When bumping the version number, update it in **all** locations: `package.json`, `README.md`, and any other files that reference the version. Search the repo to ensure nothing is missed. The README's **What's new in x.y.z** section describes only the current release: rewrite its heading and bullets for what changed since the last version, in user-facing terms, on every bump.

**Releases**: Publish only with `npm run release`, never a bare `npx vsce publish`, so every published version is tagged `v<version>` on the commit it was built from.

**Important**: After every code change, always compile, package, and install the extension into VS Code:
```
find . -maxdepth 1 -name "*.vsix" -delete && npm run compile && npm run package && code --install-extension *.vsix --force
```

**Before committing**: Always launch an independent subagent to audit the staged diff before running `git commit`. The subagent should review the changes, read relevant surrounding files for full context, and check for bugs, logic gaps, unintended side effects, and issues beyond just the changed lines. The audit's final step is a PII sweep: this repository is public, so no real names, device names, other project names, private links, or email addresses may appear in code, comments, docs, examples, or commit messages — use generic placeholders (`MyApp`, `"My MacBook Pro"`). Only commit after the audit passes clean.

## Architecture

VS Code extension that parses Xcode `.xcodeproj` files and generates `Package.swift` manifests and build/debug task configurations for iOS simulator development. Requires macOS with Xcode installed. No runtime dependencies — only VS Code API and Node.js built-ins.

**Data flow**: Read `project.pbxproj` (ASCII plist), or Xcode 27.2's JSON `project.xcproj` lowered to the same objects, → structured data through a `plutil`-backed object index (targets, target dependencies, build phases, groups, version groups, build settings, packages, frameworks, resources, folder exceptions and the project-level fields; nothing is read from the file's comments) → formatted Swift/JSON output → diff view → user confirmation → write file. Bidirectional: `.swift` file additions/removals are synced back into the project file by editing entries located by id, with or without comments and section markers.

### Entry Point

`src/extension.ts` — Orchestrator (~1500 lines) that registers all commands, providers, and watchers. Contains two main workflows:

1. **generatePackageSwift** — Parses the project file, builds Package.swift, configures SourceKit-LSP for the selected destination's SDK
2. **configureBuildTasks** — Interactive setup of project/target/scheme/simulator, stores `BuildTaskConfig` to workspace state

Also contains inline helpers: `generateCSettings`, `formatProductType`, `printToSharedPanel`, `cancelActiveRun`, `executeTaskAndWait`.

### Commands

| Command | Description |
|---------|-------------|
| `vsxcode.createFromXcodeproj` | Generate Package.swift (Debug config) |
| `vsxcode.createFromXcodeprojWithOptions` | Generate Package.swift (QuickPick config selection) |
| `vsxcode.generateBuildTasks` | Interactive build task configuration |
| `vsxcode.sidebar.*` | 16 sidebar commands: changeProject, changeTarget, changeScheme, changeBundleId, toggleDevBundleId (+ enableDevBundleId/disableDevBundleId inline wrappers), uninstallStaleAppsOnSimulator, selectSimulator, changeSwiftVersion, changeStrictConcurrency, build, buildAndRun, refresh, cleanDerivedData, copyAgentPrompt |

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
│   ├── base.ts                  — parseListValue (a plist list's items, or a string split as Xcode's editor
│   │                              writes it)
│   ├── buildSettings.ts         — XCBuildConfiguration settings from the project index: typed fields plus every
│   │                              string or list setting in `raw` (keys in code-point order, values as plutil
│   │                              unquotes them), configuration lists, project/target settings, mergeWithInherited
│   ├── projectIndex.ts          — object index of a pbxproj read through plutil, or of a JSON project.xcproj lowered
│   │                              by xcprojIndex.ts (`format` says which; memoized per contents); definition
│   │                              order and text locators (locateObject, locateList, locateDictionary,
│   │                              locateKey) from a one-pass tokenizer over the text; displayName,
│   │                              buildFilesFor, phasesOf, targetOfPhase, phaseFileNames; element paths: parentOf, ownersOf,
│   │                              resolvedPath (Xcode's source trees), baseFolder, groupForFolder,
│   │                              folderSpellings (which path components name which folder); typed value helpers
│   ├── targets.ts               — targets, target dependencies and build phase IDs read from the project index;
│   │                              isTestTarget
│   ├── packages.ts              — XCRemote/XCLocalSwiftPackageReference and product dependencies from the project
│   │                              index; a package's name from its repository URL or relative path
│   ├── frameworks.ts            — PBXFrameworksBuildPhase file names from the project index, framework name extraction
│   ├── resources.ts             — PBXResourcesBuildPhase file names from the project index, resource type
│   │                              classification, scanForUnhandledFiles (filesystem scan for SPM compatibility)
│   ├── groups.ts                — PBXGroup hierarchy from the project index; group folders (buildGroupDirectories,
│   │                              from resolvedPath); name-segment path-to-group matching, which decides which
│   │                              targets sync
│   ├── project.ts               — project-level fields from the index: default localization, highest Swift
│   │                              version, deployment targets; synchronized-folder exclusions by target
│   ├── versionGroups.ts         — XCVersionGroups (.xcdatamodeld bundles) from the project index: children,
│   │                              currentVersion, entry offsets; the section marker text the writers keep
│   ├── xcprojIndex.ts           — lowers a JSON project file into the PBX objects Xcode's own conversion to pbxproj
│   │                              gives: isa names, fields and orders VSXcode reads, stable synthetic ids, each
│   │                              object's JSON pointer; or the reason Xcode would refuse the file; isXcprojText,
│   │                              describeXcprojProblem; the rules the JSON writer shares (elementNaming, childKey,
│   │                              syntheticId, readReference, resolveReference, encodeReference, readPath,
│   │                              formatPath) (no vscode import)
│   └── xcprojText.ts            — position-aware reader for the JSON project file (project.xcproj): Xcode's JSON5
│                                  dialect as xcprojformatter accepts and rejects it, first-wins duplicate keys,
│                                  offsets for every value and key; nodeAt, valueOf, duplicateKeys (no vscode import)
├── generators/
│   ├── packageSwift.ts          — Main Package.swift builder (platforms, products, deps, targets)
│   ├── swiftSettings.ts         — swiftSettings entries from build settings: language mode, .define(),
│   │                              .unsafeFlags(), and the flag-table translation; effectiveSwiftMajor
│   ├── linkerSettings.ts        — .linkedFramework() from linked frameworks
│   ├── resources.ts             — Resource entry formatting (.process/.copy)
│   └── buildTasks.ts            — xcodebuild shell commands (build, build-install, run-and-debug)
├── writers/
│   ├── projectEdit.ts           — the edit operations the syncs and the setting commands use, routed by format to
│   │                              pbxproj.ts or xcproj.ts; beginChange/endChange around one logical change;
│   │                              projectEditText (what to write) and editDeclined; the Core Data writers (null
│   │                              for a JSON decline, its reason to the given log) and updateBuildSetting (a JSON
│   │                              decline returns the input and goes to onDecline) (no vscode import)
│   ├── xcproj.ts                — JSON project file edits as splices in Xcode's printer layout: the same eight
│   │                              operations as pbxproj.ts, references into the file tree re-encoded when a
│   │                              path changes, input ids kept as handles, new handles never an input id; an
│   │                              unsafe edit declines and undoes its whole change; a read-back gate; Core Data
│   │                              models (add, refresh versions, move, remove) and build settings (one plain
│   │                              key when every configuration agrees, else one [config=…] key each) (no vscode
│   │                              import)
│   └── pbxproj.ts               — pbxproj edits located by id through the project index: add/remove
│                                  PBXBuildFile, PBXFileReference, PBXGroup children, PBXSourcesBuildPhase
│                                  entries and XCVersionGroups, in id order within section markers, in a new
│                                  section in isa order, or before `objects` closes; single-line lists by
│                                  token; a session (beginProjectEdit) that batches addSwiftFile,
│                                  removeSwiftFile, renameSwiftFile and rehomeSwiftFile (path, name and the
│                                  comments that show it), setFileReferencePath, setElementPaths (many
│                                  elements' paths in one pass), moveElement and addGroupPath on one read;
│                                  ID generation
├── sync/
│   ├── pbxprojSync.ts           — Shared sync infrastructure: target-directory mapping,
│   │                              on-disk path form (canonicalPath), serialized write queue, Swift batch
│   │                              scheduler with its path and folder filters, per-path debouncer (Core Data),
│   │                              bundle-aware directory walker
│   ├── swiftFileSync.ts         — FileSystemWatchers for *.swift and for folders feeding batches decided by
│   │                              resolved path: folder renames and moves rewriting every path that spells the
│   │                              folder, file renames and moves paired by VS Code's rename event or identity
│   │                              (dev + ino), adds, same-name re-homes, removals, letter-case fixes, group
│   │                              creation; catch-up repair (re-point renamed folders, fix letter case, re-home
│   │                              by unique name, ask before removing gone entries, add by path); edits go
│   │                              through writers/projectEdit.ts, each logical change in inChange, whose
│   │                              bookkeeping, logs and counts follow only when it landed
│   └── dataModelSync.ts         — FileSystemWatcher for *.xcdatamodeld directory bundles,
│                                  reads .xccurrentversion, orchestrates the five project-file
│                                  structures; catch-up reconcile (add + refresh + remove); edits
│                                  go through writers/projectEdit.ts, a JSON decline logged and
│                                  never counted
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
    ├── version.ts               — Swift/macOS version detection via xcrun, version comparison, cleanup(); the
    │                              first-launch check, one passed answer shared for a minute per selected Xcode
    ├── coreDataCodegen.ts       — momc --action generate runner; DerivedSources tree
    │                              (~/Library/Developer/VSCode/DerivedSources/<key>/) with
    │                              workspace keying + marker file; staging-dir swap
    ├── path.ts                  — Target path resolution (Sources/, Tests/, shared conventions)
    ├── projectFile.ts           — Which definition file an .xcodeproj holds (project.pbxproj or project.xcproj, or
    │                              why there is none to use: neither, or both, which Xcode refuses), resolved when
    │                              each job runs; the first bundle in a folder; writeProjectFile, which writes only
    │                              into the file that was read and never creates one (no vscode import)
    ├── swiftPMProject.ts        — SwiftPM-generated project choice: files VSXcode changes, collision-safe
    │                              backups, per-project decision (no vscode import)
    ├── xcodeToolchain.ts        — The selected Xcode (developer dir, version, simulator UI app) and the
    │                              simulator reveal: Device Hub's `devices://` URL handed to the selected
    │                              bundle on Xcode 27+, Simulator.app by path before; cached per developer
    │                              dir + version.plist mtime; whether xcodebuild has -prepareDeviceSupport,
    │                              probed lazily from `xcodebuild -help` (stderr) on the same key (no vscode import)
    ├── bundleId.ts              — Bundle id resolution (Info.plist, the project file), Dev Bundle ID suffix, installed
    │                              simulator apps via simctl; the ids builds produce for a PRODUCT_BUNDLE_IDENTIFIER
    │                              holding build-setting references, from xcodebuild -showBuildSettings -json
    ├── destination.ts           — Destination type, DerivedData paths, xcodebuild -sdk/-destination flags
    ├── debugStops.ts            — lldb-dap `stopped` classification for the attach tracker: launch artifacts
    │                              (SIGSTOP, negative-id breakpoints, no reason) are resumed; breakpoint, step,
    │                              pause (told apart from the launch SIGSTOP by the client's last request),
    │                              exception and unknown stops stay (no vscode import)
    ├── deviceSupport.ts         — Xcode's device-symbols folders (`~/Library/Developer/Xcode/iOS DeviceSupport/
    │                              <productType> <osVersion> (<build>)`): the folder name and the Symbols lookup
    │                              in both layouts, flat (Xcode 26 and earlier) and per-architecture (Xcode 27);
    │                              preparing a missing folder with `xcodebuild -prepareDeviceSupport -destination
    │                              platform=iOS,id=<id>` (spawned detached, abortable, settled on the exit code)
    │                              and the parser of its one-line progress output (no vscode import)
    ├── agentGuide.ts            — The sidebar's agent prompt: the raw GitHub link to `docs/AGENT_README.md` at
    │                              the installed version's tag `v<version>`, and the one-line prompt around it
    │                              that names the selected project and scheme (no vscode import)
    ├── sourceKitLSP.ts          — SourceKit-LSP arguments for an iOS destination: the iPhoneSimulator or iPhoneOS
    │                              SDK, triple and search paths; the workspace `swift.buildArguments` that carries
    │                              them ahead of the user's own; whether a stored value already matches (no vscode
    │                              import)
    └── simulator.ts             — Simulators via xcrun simctl; physical devices via devicectl, read from the
                                   JSON v5 `properties` dictionary (Xcode 27) or the older top-level keys,
                                   simulators excluded; simulator app process discovery
```

### Key Patterns

- **JSON project files (`project.xcproj`, Xcode 27.2+)**: `readProject` reads them too, so every parser handles either format unchanged. A text that parses as Xcode's JSON5 (`xcprojText.ts`) into an object with a `files` list is lowered by `xcprojIndex.ts`; anything else takes the plutil path as before (`isXcprojText` is the one test, and the pbxproj writers refuse JSON text: `beginProjectEdit` gives null, `updateBuildSetting` the text unchanged). The Swift sync edits either format through `writers/projectEdit.ts`: JSON edits are splices in Xcode's printer layout (`xcprojformatter` leaves them unchanged), references into the file tree are re-encoded when a path they walk changes, and an edit that can't be made safely (an object with a repeated key, a reference that would name nothing or two elements, no membership form Xcode reads) declines and undoes its whole logical change, which the sync wraps in `inChange` so its bookkeeping and counts follow only a landed change. The Core Data sync and the setting commands edit JSON too: a model's versions print across lines as Xcode writes them, a declined model edit returns `null` with its reason logged (a refresh that landed before a declined move is kept), and a setting is written as one plain key when every configuration agrees, else one `[config=…]` key per configuration, a declined one shown to the user as a warning. Discovery, activation and the watchers find either file through `utils/projectFile.ts`, which resolves a bundle's definition file when each job runs. A bundle holding both is refused, as Xcode refuses it, and reported once per bundle per session in Xcode's words, after a 1 s re-check, since Xcode's own format switch writes the new file before deleting the old. Every project-file write goes through `writeProjectFile`, which writes only into the file that was read and never creates one, so a job that read the old format just before a switch writes nothing, logs why and counts nothing done. Creating or deleting the workspace project's definition file refreshes only when the bundle's resolution changes (a switch, or a second file); an atomic save resolves as before and does no more than it did. A JSON project with a selected Xcode older than 27 gets one warning per session, at activation or on the switch. The setting commands run on the sync's write queue and write only a changed text. The lowering rebuilds the PBX objects Xcode's own `-convert-project pbxproj` gives, checked against it by `npm run test:xcproj`: a list setting joined with spaces as Xcode holds it, then split into words for the settings Xcode writes as lists (VSXcode reads `HEADER_SEARCH_PATHS` and `GCC_PREPROCESSOR_DEFINITIONS` only in list form); `[config=…]` keys lowered per configuration, a key without one winning (between two that meet, Xcode's pick varies from run to run, so the reader takes code-point order); folder exception sets merged per target or phase, emptied ones dropped, ordered by target; `..` in a reference climbing to the parent; target, phase and package names matched as canonically equivalent strings, element names exactly; build tool plugins as `plugin:<name>`; an empty `Products` group outside the tree for each project reference. Explicit ids are kept; every other object gets the first 24 hex digits of a SHA-1 of its place (kind, parent's key, lower-cased path or name, ordinal), so ids survive re-reads, edits elsewhere and letter-case fixes, while renaming or moving an element renews its subtree's ids. Objects are ordered by isa, then id, as Xcode writes a pbxproj, so Package.swift's package order follows the ids, not the `packages` array. A file Xcode would refuse (unknown capabilities, missing keys, wrong types, malformed paths, references naming nothing or more than one thing, a name twice where Xcode reads a set) reads as `'unparseable'`, and `describeXcprojProblem` says why; parts VSXcode doesn't read aren't checked, and duplicate explicit ids aren't refused. Known differences from Xcode: exception names are kept as the file lists them, where Xcode drops the ones it judges no phase of the target would take (by file type) and names not written decomposed, and sorts the rest in Finder order, so a dropped name still becomes a Package.swift `exclude`; and `lastKnownFileType`, which Xcode reads from the disk during the conversion, is never synthesized, so a folder reference without an explicit `folder` type isn't a folder to `folderSpellings`
- **Build settings inheritance**: Debug/Release configs merge with project-level defaults via `mergeWithInherited`, respecting `$(inherited)`. Settings are read from the project index, so a configuration's other keys (a `baseConfigurationReference` on an `.xcconfig`-backed one, say) don't matter, but the `.xcconfig` file's own contents are never read. `raw` holds plist lists as lists; the generator presents a list to a scalar row as `(a, b)`, which no row value matches
- **Swift settings translation**: the target's Swift build settings become `swiftSettings` so SourceKit-LSP typechecks under the same language semantics `xcodebuild` uses — before this, settings like `SWIFT_DEFAULT_ACTOR_ISOLATION` were dropped and the editor reported errors on code that built clean. The mapping in `types/swiftSettingFlags.ts` is transcribed from Xcode's own `Swift.xcspec` (the file the build system evaluates), not from documentation: it is the only source that gets the divergent feature spellings right (`SWIFT_UPCOMING_FEATURE_IMPORT_OBJC_FORWARD_DECLS` → `ImportObjcForwardDeclarations`) and that records which settings Xcode consults only below language mode 6. Defaults are transcribed **already resolved** — the spec writes them as `$(…)` expressions, and `SWIFT_STRICT_CONCURRENCY`'s would otherwise fall through its `<<otherwise>>` branch and hand every Swift 5 target a `StrictConcurrency` it never asked for. `SWIFT_APPROACHABLE_CONCURRENCY` has no flags of its own; it supplies the default for five upcoming features, three of which are suppressed at language mode 6. First-class `SwiftSetting` factories are used when the emitted `swift-tools-version` allows them (`.defaultIsolation` and `.strictMemorySafety` need 6.2), else the raw flag goes through `.unsafeFlags`. Scalar settings resolve target-then-project — including `SWIFT_VERSION`, so a project that hoists it to the project configuration still gets the right language mode and the right version gate; only the gate falls back to the toolchain version, never the language mode, which must not declare a version the project never named. Settings with no mapping are logged rather than silently dropped. After an Xcode upgrade, run `npm run test:flag-parity` and refresh the table by re-reading `Swift.xcspec` (`plutil -convert json`, `Options` of `com.apple.xcode.tools.swift.compiler`); the file header records the path
- **Resource classification**: Files classified as `.process` (compilable: xcassets, storyboard, xib, strings, xcdatamodeld) or `.copy` (everything else)
- **Filesystem scanning**: After project-file parsing, `scanForUnhandledFiles` walks target directories to auto-exclude Xcode-specific files (Info.plist, .entitlements, .pch) and auto-include bundle-like resource directories (.xcdatamodeld, .xcassets, .lproj, etc.) that SPM can't auto-categorize
- **Auto-sync (project file → Package.swift)**: FileSystemWatchers on `*.pbxproj` and `*.xcproj` trigger silent Package.swift regeneration
- **Auto-sync (Swift files → project file)**: FileSystemWatcher on `*.swift` collects create/delete events into batches — 300 ms after the last event, at most 2 s after the first, with skip folders, dot-folders and `.xcodeproj` internals dropped before timing — and each batch reads the project file once and writes it once on the shared write queue, deciding each path from disk rather than the event kind. Files match project entries by resolved on-disk path (`resolvedPath`, compared through `realpathSync.native`), never by name. A renamed or moved file keeps its entry — ids, every build file, per-file settings — with its `path`, a `name` that repeated the old file name and the comments that show its name updated, and its group child moved when the folder changed. VS Code's `onDidRenameFiles` pairs in-editor renames exactly, at once. Other renames pair by file identity (`dev` + `ino`, which a rename keeps and a replace or a new file doesn't): the watcher records it for each registered file while the file exists — when it starts, after each batch that writes (parsing the written text once more for it), and 300 ms after the project file changes — and takes it again when a create or change reports a registered path, since an atomic save replaces the inode. A gone registered file pairs with a new path of the same identity in its batch, or with one found in a known place when the create comes a batch later. Pairs follow the file anywhere under the workspace except filtered folders and synchronized roots, never onto a registered path or across hard links. Folders too: a `**/*` watcher feeds folder-level events (a folder rename or move arrives as one delete and one create of the folder, with nothing for its contents) into the same batches, filtered before any `stat` and kept only for created folders and deleted folders the project spells. A folder pair — VS Code's rename event, or a created folder with a gone spelled folder's identity — rewrites every element whose own `path` spells the folder (`folderSpellings`): in place for a rename, by the component's position rather than its text; for a move, elements resolving to the folder move under the new parent's group (created if missing), paths passing through it are recomputed relative to their base folder, and descendants whose paths climb out of it with `..` are recomputed so they keep resolving where they did. Everything under the folder — files, subgroups, Core Data models — follows without edits. Folder pairs are decided and written first, then the batch's Swift paths run on a fresh pass over the written text, so a rename and a create inside the renamed folder in one batch land in the renamed group. A new file in a target folder gets its 4 entries (PBXBuildFile, PBXFileReference, PBXGroup child, PBXSourcesBuildPhase entry) in the group `groupForFolder` picks, with missing groups created under the deepest ancestor folder that has one. A deleted file's entries go with all its build files, unless an unregistered file with the same name sits in a known place (a mapped target folder, or a group's own folder); failing a pair, a created file whose name matches exactly one registered entry with a missing file re-homes that entry, keeping its ids, build files and settings. A letter-case rename within a reference's own `path` updates it. Which targets sync is unchanged: those whose folder `resolveGroupForPath` finds a group for.
- **Auto-sync (Core Data models → project file)**: FileSystemWatcher on `*.xcdatamodeld` treats the bundle as one unit (the directory, not the files inside) and updates 5 structures: PBXBuildFile, a `wrapper.xcdatamodel` PBXFileReference per version, PBXGroup child, PBXSourcesBuildPhase entry (momc compiles models — Sources, not Resources), and the XCVersionGroup, whose section markers, in files that use them, are created on the first model and dropped with the last. `children`/`currentVersion` come from the bundle's `.xccurrentversion`, falling back to the sole version; a bundle whose versions drift from what the project file records is re-registered, since a `currentVersion` pointing at a missing version is the same momc failure as no entry at all. Both events run the same routine and decide from disk rather than the event kind, so a rename or atomic replace settles correctly. Shares the swift sync's write queue, with its own per-path 300 ms debounce.
- **Core Data codegen (SourceKit-LSP)**: models with class/category codegen get their NSManagedObject subclasses generated only by Xcode's build, so the SwiftPM-based LSP build can't resolve them. `generatePackageSwift` runs momc per target with a data model into `~/Library/Developer/VSCode/DerivedSources/<workspaceKey>/<Target>/` and folds the files into the module via an `.unsafeFlags` entry interpolating a `coreDataGenerated` preamble variable (`Context.environment["HOME"]` — documented PackageDescription API). SwiftPM folding positional source paths from unsafeFlags is undocumented behavior, accepted deliberately: the repository, the model file, and the project file stay untouched, so the Xcode build/archive pipeline can never be affected — the failure mode is LSP squiggles, never builds. momc failure → manifest emitted without flags. Regen triggers: activation, project-file changes, bundle create/delete, model-contents edits (`**/*.xcdatamodeld/**` watcher — entity edits never touch the project file), the manual Sync Files command, and Clean DerivedData (wipe + immediate regen). Manifest generation is serialized per workspace; codegen runs are serialized module-wide and land via staging-dir rename so the LSP never observes a half-populated directory. Each output dir carries a `manifest.json` recording what was emitted, and every generation pass garbage-collects stale outputs — a deleted/renamed input or disabled codegen removes its derived files (legacy all-`.swift` dirs included), an emptied tree is removed marker and all, and anything not recognizable as extension output is left in place and logged.
- **Reconcile**: `vsxcode.syncProjectFiles` (and activation) catches up on changes the watchers missed, in order, whether or not a target folder is mapped: a group whose folder is gone is re-pointed to the one sibling folder holding files with all its direct children's names (gone folders are taken in path order and a sibling is taken once per run, so a second gone folder it also satisfies has its files re-homed one by one instead); letter-case drift in file paths and group spellings is fixed; an entry whose file is gone is re-homed when exactly one unregistered Swift file anywhere in the workspace (outside skip folders and synchronized roots) has its name, and left when several files match or when several missing entries share the name; the entries still gone are put to the user in a non-modal notification with **Remove** (re-checked on the write queue, so a file restored meanwhile keeps its entry) and **Keep** (remembered per entry in workspace state, so activation doesn't ask again; Sync Files always asks; the memory drops entries that stop being gone); then each unregistered file in a target folder is added, creating missing groups, unless a still-missing same-target entry has its name. The sync module never shows UI: the prompt and the memory are injected from `extension.ts`. Core Data models are also removed when the bundle is gone from disk, since a stale XCVersionGroup fails the build with momc's "No current version for model". Removal requires the model to be absent both at its resolved path and by name, so an unresolvable group tree is never read as a deletion.
- **Auto-configure**: On activation, auto-detects first project/target/simulator and stores `BuildTaskConfig` to workspace state
- **SwiftPM-generated projects**: a project whose object ids use SwiftPM's `OBJ_n` form (`swift package generate-xcodeproj`) sits beside the package's own Package.swift, so VSXcode asks before managing it. Before anything that writes, a modal dialog lists each file VSXcode would change — Package.swift, the workspace settings file (`.vscode/settings.json` or the open `.code-workspace`), `.vscode/.swift-format`, the project's definition file (`project.pbxproj` or `project.xcproj`) — with the backup each would get. **Use VSXcode fully** copies each existing file to `<file>_backup` (then `_backup-2` and so on; an existing backup is never overwritten) and turns everything on. **Keep it a SwiftPM package** changes nothing — no Package.swift, settings, file sync, build tasks, swift-format profile or terminal skip list — and is remembered per project file under the workspace-state key `swiftPMProjectChoices`. Dismissing does nothing and asks again on the next open. The Generate commands offer the choice again, after their project pick. The decision logic is in `utils/swiftPMProject.ts`, which doesn't import `vscode`; `setupFullExtension` holds every automatic write until the workspace is managed. A silent regeneration checks that when its run starts, not when it is queued, and Keep from a Generate command applies inside the dialog callback, so a regeneration queued while the dialog was open never writes. Using VSXcode fully from a Generate command generates again once the workspace is managed, as activation does, so a project change saved while the dialog was open still reaches Package.swift
- **Task chaining**: build-install completion triggers run-and-debug; debug session end kills debugserver
- **Physical device support**: Build → device symbols → install via devicectl → poll device ready → launch console → attach lldb-dap. The attach hands lldb the Symbols folder Xcode extracts from the device's shared cache (`utils/deviceSupport.ts` finds it in both the flat layout of Xcode 26 and earlier and Xcode 27's per-architecture layout). When it is missing, the run refreshes the device record from devicectl (an iOS update spells a new folder) and, if the selected Xcode's xcodebuild has `-prepareDeviceSupport` (Xcode 26.6 and 27 do), runs it with `-destination platform=iOS,id=<CoreDevice id>` under a cancellable "Preparing debug symbols" notification before the install — always device mode, since the download mode answered "not available" for every build tried and then hung, and always with a destination, since without one xcodebuild takes the first device it finds. The preparation is one job per folder shared by every run that needs it: a run only waits on it, so a re-run after a build fix joins the copy instead of killing it; Cancel or a failure warns once and the run attaches without symbols. Xcodes without the flag keep the "Open Xcode" prompt. Device listing reads devicectl's JSON version 5 `properties` dictionary when `info.jsonVersion` is 5 or later (Xcode 27's CoreDevice, which every installed Xcode's devicectl uses and which also lists simulators with `reality: "simulated"`) and the deprecated top-level keys otherwise; both branches share one inclusion rule, and simulators stay sourced from simctl
- **Xcode version gating**: `utils/xcodeToolchain.ts` describes the selected Xcode once per developer directory (re-detected when `xcode-select -p` or the bundle's `version.plist` changes) and the simulator UI choice branches on its version; the other Xcode 27 differences key on their own signals (devicectl's `info.jsonVersion`, the compiler note's wording). Xcode 27 removed Simulator.app, so from major 27 the simulator is revealed by handing Device Hub's `devices://device/open?id=<udid>` URL to the selected bundle (`open -a <DeviceHub.app> <url>`, falling back to opening the bundle), and before that by opening `Simulator.app` under the developer directory — never `open -a Simulator`, which LaunchServices resolves to whichever Xcode registered last. The supported-language-mode probe accepts both compiler wordings (`-swift-version` up to Swift 6.3, `-language-mode` from 6.4). Older Xcodes keep their previous behaviour on every path
- **SourceKit-LSP**: the destination's SDK arguments reach SourceKit-LSP through the workspace's `swift.buildArguments`, whose `-Xswiftc` pairs the Swift extension passes to the server, so the editor type-checks the side of `#if targetEnvironment(simulator)` that the build compiles: a simulator gets a block with the iPhoneSimulator SDK and `arm64-apple-ios<deployment>-simulator`, a physical device the iPhoneOS SDK and `arm64-apple-ios<deployment>`, and My Mac (or a project with no iOS platform) none, so SwiftPM's host SDK applies (`utils/sourceKitLSP.ts`). SwiftPM passes its host `-target` first and these after it; the later one wins. The block goes first and the user's own entries follow in their order. It is recognized by its shape (any destination, Xcode or deployment version), so only it is ever replaced, and while the workspace has no value the user setting is carried over, since a workspace value replaces it. Earlier versions used `swift.sourcekit-lsp.serverArguments` instead: every change to it raised the Swift extension's "requires the language server be restarted" prompt (2.16.7), and the extension's next release (vscode-swift `2b0ad5c`, #2369) makes it machine-scoped, so VS Code ignores workspace values and refuses to write them. The block is moved out of it while VS Code still shows the value; once that release hides it, the stale key stays, ignored. SourceKit-LSP reads its arguments only at launch, so a change is followed by `swift.restartLSPServer` (not awaited); an unchanged value (another simulator, another device) is neither rewritten nor restarted. The Swift extension also applies `swift.buildArguments` to its own `swift build`/`swift test`/debug builds, which reach only the generated package unless `swift.searchSubfoldersForPackages` is on. The generated test targets keep their simulator XCTest search paths whatever the destination: `import XCTest` resolves for the device triple with them first. Rejected, measured on Xcode 27.0 (Swift 6.4) with Swift extension 2.16.7 and its `main`: `swift.swiftSDK` with a Darwin triple (SwiftPM builds `arm64-apple-ios` for macOS under `swiftbuild` and against the macOS SDK under `native`), and `.sourcekit-lsp/config.json` (the Swift extension prompts on every change to it, and SourceKit-LSP asks the user to trust the workspace)
- **swift-format**: Auto-detects binary, discovers workspace/project config files, format-on-save via DocumentFormattingEditProvider, webview UI for rule configuration in sidebar
- **XCTest integration**: Discovers test targets from the project file, runs via xcodebuild, parses results (xcresulttool), xccov code coverage
- **Diff view**: Shows current vs generated Package.swift before overwriting
- **Agent guide link**: the Xcode Build view's **Copy Prompt for AI Agent** title button (✨) copies a one-line prompt any AI agent can act on. It links `docs/AGENT_README.md` as raw GitHub content at the tag `v<version>` of the installed extension, with the version and repository read from `context.extension.packageJSON` when clicked. It also names the selected project and scheme, which live in workspace state where an agent can't see them. It writes nothing to the workspace. The link works only for versions published with `npm run release`, which creates the tag
- **Activation**: `workspaceContains:**/*.pbxproj`, `workspaceContains:**/project.xcproj` and `onDebug`
- **Sidebar data**: `refresh()` drops the data and the tree's next `getChildren` loads it again, so a refresh during a load
  runs two loads at once. Every refresh, every load and every written setting bumps a generation, and a load publishes only
  while it is still the latest: one that read the project file before the last change, finishing last, would otherwise paint the older values over
  the newer ones. The tree and the setting commands get the data through `ensureProjectData`, which waits for the newest
  load (or starts one) instead of starting another or finding nothing, so a click during a reload waits for it. A setting
  command that wrote the file shows the value at once (`applyWrittenSetting`, about 20 ms from the pick); the reload the
  file change starts then confirms it. One that wrote nothing (the file already holds the value) reloads the data itself,
  since no watcher event will, in place, so the current values stay until the new ones arrive. A load costs about 0.7 s,
  nearly all xcodebuild: `-list`, and `-showBuildSettings` alongside it when a bundle id is a formula; one first-launch
  check serves the whole load. Pinned by `npm run test:sidebar`

### Package.swift Features

Swift settings (.define, .unsafeFlags, .swiftLanguageMode), linked frameworks (.linkedFramework), resources (.process/.copy), header search paths (.headerSearchPath), target dependencies (.target(name:)), excluded files, Swift package dependencies (remote + local), deployment targets, default localization, multi-configuration support (Debug/Release).

### Build & Debug Features

Custom `xcode-build` task type with build/build-install/run-and-debug/test subtasks, lldb-dap debug attachment, simulator boot + app install via xcrun simctl with the simulator revealed in Device Hub (Xcode 27+) or Simulator.app (earlier), physical device support via devicectl, DerivedData isolation per scheme, Cmd+R and Cmd+Shift+B keybindings, sidebar UI for configuration management, XCTest controller with code coverage.
