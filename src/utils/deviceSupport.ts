import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import * as os from 'os';
import * as path from 'path';

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
