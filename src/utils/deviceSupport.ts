import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { DEVICE_ID_PATTERN } from './xcodeToolchain';

// ── Device support folders ───────────────────────────────
//
// Xcode 26 and earlier finish a device's folder flat — `.finalized`, `Info.plist` and `Symbols/` at
// its root — while Xcode 27 nests the same three under an architecture folder and accepts either.
// `.copying_lock` stays behind in finished folders of both layouts and marks nothing; only
// `.finalized` beside `Symbols/` does.

/** The fields Xcode's folder name is built from; `PhysicalDevice` satisfies it. */
export interface DeviceSupportKey {
    productType: string;
    osVersion: string;
    osBuildVersion: string;
}

export const DEVICE_SUPPORT_ROOT = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport');

/** The architecture Xcode 27 extracts for current iPhones; tried before any other subfolder. */
const PREFERRED_ARCHITECTURE = 'arm64e';

/** `iPhone18,2 27.0 (24A437)`; undefined when a field is missing, since the name would match nothing. */
export function deviceSupportFolderName(device: DeviceSupportKey): string | undefined {
    if (!device.productType || !device.osVersion || !device.osBuildVersion) {
        return undefined;
    }
    return `${device.productType} ${device.osVersion} (${device.osBuildVersion})`;
}

/** A finished extraction: `.finalized` beside a `Symbols` directory. */
async function isFinalized(dir: string): Promise<boolean> {
    try {
        await fsp.access(path.join(dir, '.finalized'));
        return (await fsp.stat(path.join(dir, 'Symbols'))).isDirectory();
    } catch {
        return false;
    }
}

/** Architecture folders first (`arm64e` ahead of the rest, then by name); dot folders and `Symbols` are never candidates. */
function architectureFolders(entries: Dirent[]): string[] {
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Symbols')
        .map((entry) => entry.name)
        .sort((a, b) => {
            if (a === PREFERRED_ARCHITECTURE) { return -1; }
            if (b === PREFERRED_ARCHITECTURE) { return 1; }
            return a.localeCompare(b);
        });
}

/**
 * The `Symbols` folder to hand lldb for `device`, or undefined when no extraction has finished.
 * Xcode 27's per-architecture layout is tried first, then the flat layout of Xcode 26 and earlier.
 */
export async function findDeviceSymbols(device: DeviceSupportKey, root: string = DEVICE_SUPPORT_ROOT): Promise<string | undefined> {
    const name = deviceSupportFolderName(device);
    if (!name) {
        return undefined;
    }
    const folder = path.join(root, name);
    let entries: Dirent[];
    try {
        entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
        return undefined;
    }
    for (const architecture of architectureFolders(entries)) {
        const dir = path.join(folder, architecture);
        if (await isFinalized(dir)) {
            return path.join(dir, 'Symbols');
        }
    }
    if (await isFinalized(folder)) {
        return path.join(folder, 'Symbols');
    }
    return undefined;
}

// ── Preparing symbols with xcodebuild ────────────────────
//
// `xcodebuild -prepareDeviceSupport -destination platform=iOS,id=<id>` copies the shared cache off
// the device and extracts it into the folder above (Xcode 26.6 and 27.0 list the option). The
// destination is mandatory: without one xcodebuild takes the first device it finds and ignores its
// platform and version options. The download mode (`-platform … -osVersion … -buildVersion …`) is
// never used: Apple's servers answered "not available" for every iOS build tried, and xcodebuild
// then hung. Progress is written as `[name] Copying ....45%` and `[name] Extracting …80%…98%`,
// appended to one line without newlines, so the whole output is re-read on every chunk rather than
// parsed as a stream.

export type PreparePhase = 'searching' | 'copying' | 'extracting' | 'finished';

export interface PrepareProgress {
    /** From `Located <name> <udid>`. */
    deviceName?: string;
    phase: PreparePhase;
    /** The last complete percentage on the current phase's line; 0 before the first. */
    percent: number;
    /** From `Existing Device Support '<path>'`; Xcode 26.6 omits the closing quote. */
    existingSymbolsPath?: string;
    /** The failure xcodebuild named, when it named one. */
    failure?: string;
}

/** Reads xcodebuild's output so far; the result depends only on the text, never on how it arrived. */
export function parsePrepareOutput(output: string): PrepareProgress {
    const progress: PrepareProgress = { phase: 'searching', percent: 0 };
    const located = /^Located (.+) \S+\s*$/m.exec(output);
    if (located) {
        progress.deviceName = located[1];
    }
    let lastPhaseLine: RegExpExecArray | null = null;
    // Non-greedy so a device name holding `]` still parses: the bracket before the keyword is the closing one.
    const phaseLines = /^\[.*?\] (Copying|Extracting|Finished)\b(.*)$/gm;
    for (let match = phaseLines.exec(output); match; match = phaseLines.exec(output)) {
        lastPhaseLine = match;
    }
    if (lastPhaseLine) {
        progress.phase = lastPhaseLine[1].toLowerCase() as PreparePhase;
        const percents = lastPhaseLine[2].match(/(\d{1,3})%/g);
        if (percents) {
            progress.percent = Number(percents[percents.length - 1].slice(0, -1));
        }
    }
    const existing = /^Existing Device Support '(.+?)'?\s*$/m.exec(output);
    if (existing) {
        progress.existingSymbolsPath = existing[1];
    }
    const cachingFailed = /^Symbol caching failed: (.*)$/m.exec(output);
    if (cachingFailed) {
        progress.failure = cachingFailed[1].trim();
    } else if (/^No matches found\s*$/m.test(output)) {
        progress.failure = 'No matches found';
    }
    return progress;
}

export interface PrepareOptions {
    /** Aborting kills xcodebuild and rejects with `PrepareAbortedError`. */
    signal?: AbortSignal;
    onProgress?: (progress: PrepareProgress) => void;
    /** Seconds xcodebuild searches for the device before giving up; a UDID search over a Wi-Fi tunnel took 10 s. */
    searchTimeoutSeconds?: number;
}

export interface PrepareResult {
    /** `existing` when xcodebuild found a finished folder and copied nothing. */
    outcome: 'prepared' | 'existing';
}

export class PrepareAbortedError extends Error {
    constructor() {
        super('device support preparation was cancelled');
        this.name = 'PrepareAbortedError';
    }
}

const DEFAULT_SEARCH_TIMEOUT_SECONDS = 30;
const KILL_GRACE_MS = 500;

/** SIGTERM to the process group, SIGKILL shortly after; xcodebuild runs detached so the group is its own. */
function killProcessGroup(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) {
        return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }, KILL_GRACE_MS).unref();
}

/**
 * Prepares the device's symbols folder with `xcodebuild -prepareDeviceSupport`. Settles on the
 * exit code, never on the text: exit 0 resolves, anything else rejects with the failure xcodebuild
 * named or else its last output line. There is no overall timeout — a copy over Wi-Fi legitimately
 * takes minutes — so the caller's signal is the way out of a stalled one. A process left behind by
 * a window reload finishes on its own, which is harmless.
 */
export function prepareDeviceSupport(deviceId: string, options: PrepareOptions = {}): Promise<PrepareResult> {
    return new Promise<PrepareResult>((resolve, reject) => {
        if (!DEVICE_ID_PATTERN.test(deviceId)) {
            reject(new Error(`malformed device identifier "${deviceId}"`));
            return;
        }
        if (options.signal?.aborted) {
            reject(new PrepareAbortedError());
            return;
        }
        const searchTimeout = options.searchTimeoutSeconds ?? DEFAULT_SEARCH_TIMEOUT_SECONDS;
        const child = spawn(
            'xcodebuild',
            ['-prepareDeviceSupport', '-destination', `platform=iOS,id=${deviceId}`, '-destination-timeout', String(searchTimeout)],
            { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
        );
        let output = '';
        let settled = false;
        let aborted = false;
        const onAbort = () => {
            aborted = true;
            killProcessGroup(child);
        };
        const settle = (finish: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            options.signal?.removeEventListener('abort', onAbort);
            finish();
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        // One decoder per stream keeps a multi-byte character split across chunks intact (device names are user text).
        const onData = (decoder: StringDecoder) => (chunk: Buffer) => {
            output += decoder.write(chunk);
            options.onProgress?.(parsePrepareOutput(output));
        };
        child.stdout?.on('data', onData(new StringDecoder('utf8')));
        child.stderr?.on('data', onData(new StringDecoder('utf8')));
        child.on('error', (error) => settle(() => reject(error)));
        child.on('close', (code, signalName) => settle(() => {
            if (aborted) {
                reject(new PrepareAbortedError());
                return;
            }
            const progress = parsePrepareOutput(output);
            if (code === 0) {
                resolve({ outcome: progress.existingSymbolsPath ? 'existing' : 'prepared' });
                return;
            }
            const lastLine = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).pop();
            reject(new Error(progress.failure ?? lastLine ?? `xcodebuild exited with ${code ?? signalName}`));
        }));
    });
}
