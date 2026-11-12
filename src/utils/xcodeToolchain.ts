import { execFile as execFileCallback, execFileSync } from 'child_process';
import type { ExecFileOptionsWithStringEncoding } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFile = promisify(execFileCallback) as (
    file: string,
    args?: ReadonlyArray<string>,
    options?: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

// ── The selected Xcode ───────────────────────────────────
//
// `xcode-select -p` honors DEVELOPER_DIR, so it names the Xcode a build would actually use.

export interface XcodeVersion {
    major: number;
    minor: number;
}

/** The app that shows a simulator's screen. */
export type SimulatorUI =
    /** Xcode 27 and later: `Contents/Applications/DeviceHub.app`, which also claims the `devices:` URL scheme. */
    | { kind: 'deviceHub'; appPath: string }
    /** Xcode 26 and earlier: `Contents/Developer/Applications/Simulator.app`. */
    | { kind: 'simulatorApp'; appPath: string };

export interface XcodeToolchain {
    /** `xcode-select -p`; empty when no Xcode is selected. */
    developerDir: string;
    /** The `.app` bundle owning `developerDir`, or null when the directory isn't inside one. */
    appPath: string | null;
    /** From the first line of `xcodebuild -version`, or null when it can't be read. */
    version: XcodeVersion | null;
    simulatorUI: SimulatorUI | null;
}

/**
 * Whether a JSON project file (`project.xcproj`, Xcode 27.2's format) needs a newer Xcode than the selected one: Xcode 27
 * opens it, earlier ones can't. False for an unknown version, which gives no grounds to warn.
 */
export function needsNewerXcodeForJSON(toolchain: Pick<XcodeToolchain, 'version'>): boolean {
    return toolchain.version !== null && toolchain.version.major < 27;
}

const DEVELOPER_SUFFIX = `${path.sep}Contents${path.sep}Developer`;
/** Xcode 27 replaced Simulator.app with Device Hub. */
const DEVICE_HUB_MIN_MAJOR = 27;
/** CoreSimulator and CoreDevice identifiers are hex and dashes; anything else never reaches a shell or a destination specifier. */
export const DEVICE_ID_PATTERN = /^[0-9A-Fa-f-]+$/;
const VERSION_TIMEOUT_MS = 15000;

/** "Xcode 27.0\nBuild version 27A266a" → { major: 27, minor: 0 }. */
export function parseXcodeVersion(output: string): XcodeVersion | null {
    const match = /^Xcode\s+(\d+)(?:\.(\d+))?/m.exec(output);
    if (!match) {
        return null;
    }
    return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

/** `/Applications/Xcode.app/Contents/Developer` → `/Applications/Xcode.app`. */
export function xcodeAppPath(developerDir: string): string | null {
    return developerDir.endsWith(DEVELOPER_SUFFIX)
        ? developerDir.slice(0, -DEVELOPER_SUFFIX.length)
        : null;
}

/** Version decides, existence guards: an Xcode 27 without DeviceHub.app still falls back to Simulator.app. */
export function resolveSimulatorUI(
    developerDir: string,
    version: XcodeVersion | null,
    exists: (candidate: string) => boolean = fs.existsSync
): SimulatorUI | null {
    const appPath = xcodeAppPath(developerDir);
    if (version && version.major >= DEVICE_HUB_MIN_MAJOR && appPath) {
        const deviceHub = path.join(appPath, 'Contents', 'Applications', 'DeviceHub.app');
        if (exists(deviceHub)) {
            return { kind: 'deviceHub', appPath: deviceHub };
        }
    }
    if (developerDir) {
        const simulatorApp = path.join(developerDir, 'Applications', 'Simulator.app');
        if (exists(simulatorApp)) {
            return { kind: 'simulatorApp', appPath: simulatorApp };
        }
    }
    return null;
}

function describe(developerDir: string, versionOutput: string): XcodeToolchain {
    const version = parseXcodeVersion(versionOutput);
    return {
        developerDir,
        appPath: xcodeAppPath(developerDir),
        version,
        simulatorUI: resolveSimulatorUI(developerDir, version)
    };
}

/**
 * What the cache is keyed on: the developer directory plus the modification time of the
 * bundle's version file, so replacing Xcode.app in place (an upgrade at the same path) is
 * noticed as readily as an `xcode-select` switch.
 */
function cacheKey(developerDir: string): string {
    const appPath = xcodeAppPath(developerDir);
    const stamp = appPath ? path.join(appPath, 'Contents', 'version.plist') : developerDir;
    let mtime = 0;
    try {
        mtime = fs.statSync(stamp).mtimeMs;
    } catch {
        // Missing file: the key still changes when the directory does.
    }
    return `${developerDir}\n${mtime}`;
}

/** The selected Xcode's identity for caches (developer directory and version file, as `cacheKey`); empty when none is selected. */
export async function selectedXcodeKey(): Promise<string> {
    try {
        const developerDir = (await execFile('xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000 })).stdout.trim();
        return developerDir ? cacheKey(developerDir) : '';
    } catch {
        return '';
    }
}

let cached: { key: string; toolchain: XcodeToolchain } | null = null;

/** Detects the selected Xcode and primes the cache `currentXcodeToolchain` serves. */
export async function detectXcodeToolchain(): Promise<XcodeToolchain> {
    let developerDir = '';
    try {
        developerDir = (await execFile('xcode-select', ['-p'], { encoding: 'utf8' })).stdout.trim();
    } catch {
        // No Xcode selected: every field stays empty and the reveal becomes a no-op.
    }
    let versionOutput = '';
    if (developerDir) {
        try {
            versionOutput = (await execFile('xcodebuild', ['-version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS })).stdout;
        } catch {
            // Version stays null; the simulator UI is then decided by what exists on disk.
        }
    }
    cached = { key: cacheKey(developerDir), toolchain: describe(developerDir, versionOutput) };
    return cached.toolchain;
}

/** Re-probes `xcode-select -p` every call so an Xcode switch needs no reload; `xcodebuild -version` re-runs only when the cache key changed. */
export function currentXcodeToolchain(): XcodeToolchain {
    let developerDir = '';
    try {
        developerDir = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    } catch {
        // Nothing selected: every field stays empty and the reveal becomes a no-op.
    }
    const key = cacheKey(developerDir);
    if (cached && cached.key === key) {
        return cached.toolchain;
    }
    let versionOutput = '';
    if (developerDir) {
        try {
            versionOutput = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
        } catch {
            // Version stays null; the simulator UI is then decided by what exists on disk.
        }
    }
    cached = { key, toolchain: describe(developerDir, versionOutput) };
    return cached.toolchain;
}

// ── Preparing device support ─────────────────────────────
//
// `xcodebuild -prepareDeviceSupport` (listed by Xcode 26.6 and 27.0, absent from older Xcodes) is
// probed from `xcodebuild -help`, whose option list goes to stderr. The probe stays off the
// synchronous path: `currentXcodeToolchain` runs from the task providers, where a second xcodebuild
// launch would stall the extension host.

export function supportsPrepareDeviceSupport(helpOutput: string): boolean {
    return /^\s*-prepareDeviceSupport\b/m.test(helpOutput);
}

let prepareSupportCache: { key: string; supported: boolean } | null = null;

/** Whether the selected Xcode's xcodebuild can prepare device support; a failed probe is false and is probed again next call. */
export async function canPrepareDeviceSupport(): Promise<boolean> {
    let developerDir = '';
    try {
        developerDir = (await execFile('xcode-select', ['-p'], { encoding: 'utf8' })).stdout.trim();
    } catch {
        return false;
    }
    const key = cacheKey(developerDir);
    if (prepareSupportCache && prepareSupportCache.key === key) {
        return prepareSupportCache.supported;
    }
    let helpOutput = '';
    try {
        const result = await execFile('xcodebuild', ['-help'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
        helpOutput = result.stdout + result.stderr;
    } catch (error) {
        // An xcodebuild that exits non-zero for -help still printed its options; a timeout or a missing tool printed nothing.
        const failed = error as { stdout?: string; stderr?: string };
        helpOutput = (failed.stdout ?? '') + (failed.stderr ?? '');
        if (!helpOutput.trim()) {
            return false;
        }
    }
    const supported = supportsPrepareDeviceSupport(helpOutput);
    prepareSupportCache = { key, supported };
    return supported;
}

// ── Showing a simulator ──────────────────────────────────

/** Device Hub's own way to bring one device to the front; handed to the selected Xcode's bundle with `open -a <bundle> <url>`. */
function deviceHubURL(udid: string): string {
    return `devices://device/open?id=${udid}`;
}

/** Single-quoted for zsh: the only character that needs care inside single quotes is the quote itself. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Never by name: `open -a Simulator` resolves through LaunchServices to whichever Xcode
 * registered last, not the selected one. `true` when there is nothing to open.
 */
export function revealSimulatorCommand(udid: string, toolchain: XcodeToolchain = currentXcodeToolchain()): string {
    const ui = toolchain.simulatorUI;
    if (!ui || !DEVICE_ID_PATTERN.test(udid)) {
        return 'true';
    }
    switch (ui.kind) {
        case 'deviceHub':
            return `{ open -a ${shellQuote(ui.appPath)} ${shellQuote(deviceHubURL(udid))} 2>/dev/null || open ${shellQuote(ui.appPath)}; }`;
        case 'simulatorApp':
            return `open ${shellQuote(ui.appPath)}`;
    }
}

/** The same action from TypeScript; rejects when there is nothing to open or `open` fails both ways. */
export async function revealSimulator(udid: string, toolchain: XcodeToolchain = currentXcodeToolchain()): Promise<void> {
    const ui = toolchain.simulatorUI;
    if (!ui) {
        throw new Error(`no simulator app found under ${toolchain.developerDir || 'the selected Xcode'}`);
    }
    if (!DEVICE_ID_PATTERN.test(udid)) {
        throw new Error(`malformed simulator identifier "${udid}"`);
    }
    switch (ui.kind) {
        case 'deviceHub':
            try {
                await execFile('open', ['-a', ui.appPath, deviceHubURL(udid)], { encoding: 'utf8' });
            } catch {
                await execFile('open', [ui.appPath], { encoding: 'utf8' });
            }
            return;
        case 'simulatorApp':
            await execFile('open', [ui.appPath], { encoding: 'utf8' });
            return;
    }
}
