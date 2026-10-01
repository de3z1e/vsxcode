// No vscode import: scripts/sourcekit-lsp-check.js loads this in plain Node.

/** The iOS run destinations; My Mac clears the arguments instead, so SwiftPM's host SDK applies. */
export type IOSDestination = 'simulator' | 'device';

/** SwiftPM passes its host `-target` before these arguments, so this triple wins and picks the `targetEnvironment` branch. */
export function sourceKitLSPArguments(destination: IOSDestination, developerDir: string, iosVersion: string): string[] {
    const platform = destination === 'device' ? 'iPhoneOS' : 'iPhoneSimulator';
    const platformDir = `${developerDir}/Platforms/${platform}.platform/Developer`;
    const sdkPath = `${platformDir}/SDKs/${platform}.sdk`;
    const target = destination === 'device' ? `arm64-apple-ios${iosVersion}` : `arm64-apple-ios${iosVersion}-simulator`;
    return [
        '-Xswiftc', '-sdk',
        '-Xswiftc', sdkPath,
        '-Xswiftc', '-target',
        '-Xswiftc', target,
        '-Xswiftc', '-F',
        '-Xswiftc', `${sdkPath}/System/Library/Frameworks`,
        '-Xswiftc', '-F',
        '-Xswiftc', `${platformDir}/Library/Frameworks`,
        '-Xswiftc', '-I',
        '-Xswiftc', `${platformDir}/usr/lib`,
        '-Xswiftc', '-enable-testing'
    ];
}

/** Whether the stored value already is `next`; undefined on either side means no value. */
export function sameArguments(stored: unknown, next: readonly string[] | undefined): boolean {
    if (stored === undefined || next === undefined) {
        return stored === next;
    }
    return Array.isArray(stored)
        && stored.length === next.length
        && stored.every((argument, index) => argument === next[index]);
}

const BLOCK_LENGTH = 22;
const IOS_SDK = /\/Platforms\/iPhone(?:OS|Simulator)\.platform\/Developer\/SDKs\/iPhone(?:OS|Simulator)\.sdk$/;
const IOS_TRIPLE = /^arm64-apple-ios\d+(?:\.\d+)*(?:-simulator)?$/;

/** A block `sourceKitLSPArguments` built for any destination, Xcode or deployment version, starting at `start`. */
function isBlockAt(list: readonly string[], start: number): boolean {
    if (start + BLOCK_LENGTH > list.length) {
        return false;
    }
    for (let index = start; index < start + BLOCK_LENGTH; index += 2) {
        if (list[index] !== '-Xswiftc') {
            return false;
        }
    }
    const value = (pair: number): string => list[start + pair * 2 + 1];
    return value(0) === '-sdk' && IOS_SDK.test(value(1))
        && value(2) === '-target' && IOS_TRIPLE.test(value(3))
        && value(4) === '-F' && value(6) === '-F' && value(8) === '-I'
        && value(10) === '-enable-testing';
}

/** The stored list without the blocks VSXcode wrote; [] for no value, null for a value that isn't a list of strings. */
export function withoutDestinationArguments(stored: unknown): string[] | null {
    if (stored === undefined) {
        return [];
    }
    if (!Array.isArray(stored) || !stored.every((argument) => typeof argument === 'string')) {
        return null;
    }
    const kept: string[] = [];
    for (let index = 0; index < stored.length;) {
        if (isBlockAt(stored, index)) {
            index += BLOCK_LENGTH;
        } else {
            kept.push(stored[index]);
            index += 1;
        }
    }
    return kept;
}

/**
 * The workspace `swift.buildArguments` that puts `block` (none for My Mac) ahead of the user's own arguments: the
 * workspace value's, or the user setting's while the workspace has none, since a workspace value replaces it.
 * Without a block, a workspace value VSXcode wrote a block into becomes undefined when nothing would remain beyond
 * what the user setting says, and any other workspace value is the user's, kept as it is. Null when the workspace
 * value isn't a list of strings, which is the user's to fix.
 */
export function destinationBuildArguments(workspace: unknown, user: unknown, block: readonly string[] | undefined): string[] | undefined | null {
    const userOwn = withoutDestinationArguments(user) ?? [];
    const own = workspace === undefined ? userOwn : withoutDestinationArguments(workspace);
    if (own === null) {
        return null;
    }
    if (block) {
        return [...block, ...own];
    }
    if (workspace === undefined || own.length === (workspace as readonly unknown[]).length) {
        return workspace === undefined ? undefined : own;
    }
    return own.length === 0 || sameArguments(own, userOwn) ? undefined : own;
}
