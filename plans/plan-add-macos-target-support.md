# Plan: Add macOS ("My Mac") build / run / debug support

## Context

The extension today builds, runs, and debugs iOS apps on **simulators** and **physical iOS devices**. Every destination decision in the pipeline branches on a single boolean — `BuildTaskConfig.isPhysicalDevice` — which hardcodes the build SDK (`iphoneos`/`iphonesimulator`), the `-destination` string, the DerivedData product subdirectory, the launch mechanism (`xcrun simctl` / `xcrun devicectl`), and the lldb-dap attach commands.

There is no way to target the host Mac. This plan adds **"My Mac"** as a first-class destination so a macOS app (AppKit or SwiftUI-for-Mac) can be built and debugged directly from VS Code.

The platform *foundations* already exist — `PLATFORM_KEYS`/`PLATFORM_DECLARATIONS` include macOS (`src/types/constants.ts`), `parseDeploymentTargets` already reads `MACOSX_DEPLOYMENT_TARGET`, `ensureMacOSPlatform` already adds macOS to the Package.swift platform list, and Package.swift generation is platform-agnostic. The gap is entirely in the **build/run/debug orchestration**, which assumes iOS.

The macOS flow is fundamentally **simpler** than iOS: a macOS build produces `Build/Products/Debug/<Product>.app` (no SDK suffix), there is no simulator to boot and no install step. The native way to run+debug is: build, then start a single lldb-dap **`request:'launch'`** session pointing at the Mach-O inside the bundle. lldb owns the process, streams stdout/stderr to the Debug Console, and terminates it when the session ends — so no console task, no `simctl`/`devicectl`, no `--waitfor` attach race, and none of the `--start-stopped` SIGSTOP artifacts.

**Scope decisions (confirmed with user):**
- **Native macOS only.** Mac Catalyst (`-destination 'platform=macOS,variant=Mac Catalyst'`) is explicitly out of scope — a clean follow-up.
- **SourceKit-LSP follows the destination.** When "My Mac" is selected, intellisense is reconfigured to index against the macOS SDK (so AppKit / `#if os(macOS)` code resolves correctly in dual iOS+macOS projects).

## Approach

Replace the binary `isPhysicalDevice` discriminator with a derived **3-way `DestinationType`** (`'simulator' | 'device' | 'mac'`), centralize the mapping in one new util, and add a third orchestrator `buildAndDebugMac` alongside the two existing ones. Existing stored configs (which only have `isPhysicalDevice`) keep working via a back-compat derive — zero migration.

---

## 1. Types — `src/types/interfaces.ts`

- Add `export type DestinationType = 'simulator' | 'device' | 'mac';`
- Add `destinationType?: DestinationType;` to `BuildTaskConfig` (interfaces.ts:143-152). Keep `isPhysicalDevice` for back-compat. For mac: `simulatorDevice: 'My Mac'`, `simulatorUdid: ''`, `deviceIdentifier: ''`, `destinationType: 'mac'`.
- Add to `BuildSettings` (interfaces.ts:90-101): `supportedPlatforms?`, `sdkRoot?`, `macosxDeploymentTarget?` (raw strings, for macOS-capability detection).

## 2. New shared util — `src/utils/destination.ts`

The single source of truth for the 3-way mapping (consolidation per CLAUDE.md). Exports:

- `getDestinationType(config): DestinationType` — returns `config.destinationType` if present, else derives `config.isPhysicalDevice ? 'device' : 'simulator'` (back-compat for stored configs).
- `productDirForDestination(dest): string` — `device → 'Debug-iphoneos'`, `simulator → 'Debug-iphonesimulator'`, `mac → 'Debug'`. **Exhaustive `switch` with no `default`** (per CLAUDE.md, so a new case fails compilation).
- `xcodebuildDestinationFlags(config): string[]` — the `-sdk`/`-destination` tokens:
  - `mac`: `["-destination 'platform=macOS'", '-allowProvisioningUpdates']` — **destination-only, no `-sdk`** (avoids `-sdk`/`-destination` conflict).
  - `device`/`simulator`: `-sdk iphoneos|iphonesimulator` + `-destination "id=<udid>"` (+ `-allowProvisioningUpdates` for device) — current behavior verbatim.
- `builtAppPath(config): string` — DerivedData path using `productDirForDestination`. Replaces the three hardcoded app-path constructions in extension.ts (1340, 1458, 1775).

## 3. Capability parsing — `src/parsers/buildSettings.ts`

- In the per-config settings parse (~line 67, beside `PRODUCT_NAME`), capture `SUPPORTED_PLATFORMS`, `SDKROOT`, `MACOSX_DEPLOYMENT_TARGET` into the new `BuildSettings` fields (reuse the existing `cleanup()` to strip quotes).
- Add `export function platformsSupported(target, project): { ios: boolean; mac: boolean }` — checks **target settings first, then project-level** (these keys are usually inherited from the project). `mac` true if `SUPPORTED_PLATFORMS` contains `macosx`, or `SDKROOT == macosx`, or `MACOSX_DEPLOYMENT_TARGET` set. When no signals exist at all, default to `{ ios: true }` to preserve today's behavior.

## 4. "My Mac" destination — `src/utils/simulator.ts`

- Add `MacDestination { name: string; arch: string }` and `getMyMacDestination(): Promise<MacDestination | null>` — darwin-guarded, `scutil --get ComputerName` + `uname -m`, graceful fallback to `{ name: 'My Mac', arch: 'arm64' }`. Mirrors the existing `detectMacOSVersion` pattern. Arch is display-only (not persisted; Debug builds native-arch via `ONLY_ACTIVE_ARCH=YES`).

## 5. Build commands — `src/generators/buildTasks.ts`

- `xcodebuildArgs` (3-20): replace the inline `sdk`/`-destination` lines with `...xcodebuildDestinationFlags(config)`. This alone makes the **Build** task work for macOS (the only build path the mac flow needs). Resulting mac command:
  ```
  set -eo pipefail; xcodebuild -project "<p>.xcodeproj" -scheme "<s>" -configuration Debug \
    -destination 'platform=macOS' -allowProvisioningUpdates \
    -derivedDataPath "$HOME/Library/Developer/VSCode/DerivedData/<s>" build 2>&1
  → $HOME/Library/Developer/VSCode/DerivedData/<s>/Build/Products/Debug/<Product>.app
  ```
- `testCommandLine` (95-102): gate the `simctl boot` prepend on `getDestinationType(config) === 'simulator'`.
- `buildInstallCommandLine`/`runAndDebugCommandLine`/`debugConsoleCommandLine` are **never reached for mac** (dispatch routes mac to `buildAndDebugMac`). Optionally swap their `isPhysicalDevice` checks to `getDestinationType(...) === 'device'` and hardcoded product dirs to `productDirForDestination(...)` for uniformity — no behavior change required.

## 6. macOS orchestrator + dispatch + cleanup — `src/extension.ts`

**New `buildAndDebugMac(config)`** (add beside the two existing orchestrators, ~after 1424):
1. `cancelActiveRun()`; capture `runId`.
2. Run the **Build** task via `executeTaskAndWait` (shared panel, same as the others); bail on non-zero exit or stale `runId`.
3. `appPath = builtAppPath(config)`. Read `CFBundleExecutable` from **`<appPath>/Contents/Info.plist`** (note: macOS bundles store Info.plist under `Contents/`, unlike iOS) via the existing `readInfoPlistExecutable` (`bundleId.ts:41`), default to `config.productName`. `program = <appPath>/Contents/MacOS/<executableName>`.
4. Start a single debug session and set `activeDebugSession` (do **not** set `consoleExecution` — there is no console task):
   ```ts
   { type: 'lldb-dap', request: 'launch', name: `Debug ${config.productName}`,
     program, args: [], env: {}, cwd: folder.uri.fsPath, stopOnEntry: false }
   ```
   Report success/failure via `printToSharedPanel`.

**Dispatch** (1637-1641): replace the if/else with an exhaustive `switch (getDestinationType(config))` → `device`/`mac`/`simulator` (no `default`).

**dyld auto-continue tracker** (1703-1757): early-return `undefined` when `session.configuration.request === 'launch'`. The tracker exists only to skip `--start-stopped`/attach artifacts; scoping it to attach guarantees it can never swallow a real stop in the mac launch session.

**Cleanup `onDidTerminateDebugSession`** (1761-1796): compute `dest = getDestinationType(config)`. For `mac`, log and `return` early (lldb-dap already killed the process; avoids running `simctl terminate` and clobbering a stale console terminal). Keep the existing `simctl terminate` block for `simulator` (re-gate from `!isPhysicalDevice` to `dest === 'simulator'`).

**`onDidStartDebugSession`** (1798-1801): use `getDestinationType` for the log label.

## 7. Destination pickers + sidebar

**`selectSimulator` command** (extension.ts:1119-1193): extend `DevicePick` with `destinationType`. Add a **"My Mac"** section at the top, gated on capability (`sidebarProvider.getProjectData()?.macSupportByTarget[config.targetName]`) via `getMyMacDestination()` (description = `<ComputerName> · <arch>`). On accept, write `destinationType` + `isPhysicalDevice: destinationType === 'device'` through `updateConfig`. Per memory, new config rows stay above Device selection — this is a new *option within* Device selection, so ordering is unaffected.

**`configureBuildTasks`** (extension.ts:532-601): mirror the picker — compute `caps` for the selected target, add the My Mac section, relax the "No available iOS devices" throw (536) to also pass when `caps.mac`, and persist `destinationType`.

**`sidebarProvider.ts`**: `formatDeviceLabel` (221-232) returns `'My Mac'` for the mac branch. Add `macSupportByTarget: Record<string, boolean>` to `ProjectData`, populated in the existing per-target loop in `loadProjectData` (258-277) via `platformsSupported(targetSettings, projectSettings)` (settings already fetched there). `autoConfigureBuildTasks` (381-468): when no simulators exist (or target isn't iOS-capable) but `caps.mac`, fall back to a `'My Mac'` config instead of returning `false` — so a macOS-only project auto-configures correctly.

## 8. SourceKit-LSP follows the destination — `src/extension.ts`

Extract the inline LSP block (386-414) into `configureSourceKitLSP(dest: DestinationType, platforms)`:
- `dest === 'mac'`: clear `swift.sourcekit-lsp.serverArguments` (set to `undefined`, Workspace target) so SwiftPM indexes against the **host macOS SDK**. `ensureMacOSPlatform` already guarantees macOS is in the package's platform list, so indexing resolves. (The extension already fully owns this setting, so clearing is consistent.)
- `device`/`simulator`: existing iPhoneSimulator SDK args + `arm64-apple-ios<ver>-simulator` triple (current behavior); if no iOS platform present, clear (defaults to host macOS).

Call sites:
- `generatePackageSwift` (~386): call `configureSourceKitLSP(config ? getDestinationType(config) : 'simulator', platforms)` using the current `buildTaskConfig`.
- After a destination change in `selectSimulator` / `configureBuildTasks`: re-run `configureSourceKitLSP(newDest, platforms)` so intellisense switches immediately on toggle.

## 9. Tests — `src/providers/testController.ts`

- `buildXcodebuildBase` (330-347): replace the `iphoneos|iphonesimulator` branch with `...xcodebuildDestinationFlags(config)` (mac → `-destination 'platform=macOS'`). `xcodebuild test` runs natively on macOS.
- `buildCommand` (376-378): gate the `simctl boot` prepend on `getDestinationType(config) === 'simulator'`.
- Test debug attach (300-309): skip the `process attach --name --waitfor` path for `mac` (run tests + coverage without attach; mac XCTest-debugging-via-attach is a minor follow-up).

## 10. `package.json`

No functional changes — "My Mac" flows through the existing `vsxcode.sidebar.selectSimulator` ("Select Device") command and the existing **Build** task; `Cmd+R`/`Cmd+Shift+B` route through the new 3-way dispatch. Only **bump the version** (package.json, README.md, and any other references — search the repo) per CLAUDE.md.

---

## Risks / notes

- **Code signing / debuggability:** Debug builds inject `com.apple.security.get-task-allow=YES` and normally leave Hardened Runtime off, so lldb can launch the binary. A target that force-enables Hardened Runtime + Library Validation without get-task-allow would block debugging. `-allowProvisioningUpdates` is included for mac to satisfy profile-backed entitlements (iCloud, App Groups); it's a no-op for "Sign to Run Locally."
- **Sandboxed apps** still run sandboxed under lldb; `cwd` sets the process working dir but file access stays container-scoped. Run/debug itself works.
- **`-sdk` vs `-destination`:** mac passes `-destination 'platform=macOS'` and omits `-sdk` (the only safe combo with the shared arg builder).
- **Capability false-negatives:** `SUPPORTED_PLATFORMS`/`SDKROOT` are often project-level → `platformsSupported` checks target-then-project; unknown-signal targets default to iOS to preserve current behavior.
- **Backward-compat:** stored configs lack `destinationType`; `getDestinationType` falls back to `isPhysicalDevice` — no migration. New writes always set `destinationType`.

## Verification (end-to-end)

After implementing, per CLAUDE.md: `find . -maxdepth 1 -name "*.vsix" -delete && npm run compile && npm run package && code --install-extension *.vsix --force`. Then, with a sample macOS (AppKit/SwiftUI-Mac) `.xcodeproj` open:

1. **Auto-config:** a mac-only project's sidebar Device row shows **My Mac**; a dual-platform project defaults to a simulator and shows **My Mac** at the top of **Select Device** (and it's absent for a pure-iOS target).
2. **Build (`Cmd+Shift+B`):** terminal runs `xcodebuild … -destination 'platform=macOS' … build` and produces `…/Build/Products/Debug/<Product>.app` (no SDK suffix).
3. **Run+debug (`Cmd+R`/F5):** one `lldb-dap` `request:'launch'` session starts with `program = …/<Product>.app/Contents/MacOS/<CFBundleExecutable>`; the app window opens; stdout/stderr stream to the **Debug Console**.
4. **Breakpoints:** a breakpoint in `applicationDidFinishLaunching` / `ContentView` init / a button handler **hits**, with call stack + variables; step/continue work; the dyld tracker does **not** auto-continue past it (disabled for launch sessions).
5. **LSP:** on a dual iOS+macOS project, selecting **My Mac** clears the iOS LSP override → AppKit / `#if os(macOS)` code resolves without false errors; switching back to a simulator restores iOS intellisense.
6. **Teardown:** stopping the session exits the app process; `[debug-end] mac launch session ended` logs; no `simctl terminate` runs.
7. **Regression:** re-select an iPhone simulator and a physical device — both still build (`-sdk … -destination "id=…"`), install, attach, hit breakpoints, and clean up exactly as before.

## Critical files

- `src/utils/destination.ts` *(new)* — 3-way destination mapping
- `src/types/interfaces.ts` — `DestinationType`, `BuildTaskConfig`, `BuildSettings`
- `src/generators/buildTasks.ts` — build/test command generation
- `src/extension.ts` — `buildAndDebugMac`, dispatch, pickers, LSP, cleanup, dyld tracker
- `src/providers/sidebarProvider.ts` — label, capability data, auto-config fallback
- `src/parsers/buildSettings.ts` — capability parsing + `platformsSupported`
- `src/utils/simulator.ts` — `getMyMacDestination`
- `src/providers/testController.ts` — test command 3-way
