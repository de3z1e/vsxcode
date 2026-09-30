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
export function sameServerArguments(stored: unknown, next: readonly string[] | undefined): boolean {
    if (stored === undefined || next === undefined) {
        return stored === next;
    }
    return Array.isArray(stored)
        && stored.length === next.length
        && stored.every((argument, index) => argument === next[index]);
}
