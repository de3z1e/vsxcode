import type { BuildTaskConfig } from '../types/interfaces';

function xcodebuildArgs(config: BuildTaskConfig): string[] {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;
    const udid = config.simulatorUdid || config.simulatorDevice;
    const sdk = config.isPhysicalDevice ? 'iphoneos' : 'iphonesimulator';
    const args = [
        'set -eo pipefail; xcodebuild',
        `-project "${config.projectFile}"`,
        `-scheme "${config.schemeName}"`,
        '-configuration Debug',
        `-sdk ${sdk}`,
        `-destination "id=${udid}"`,
        `-derivedDataPath "${derivedData}"`,
    ];
    if (config.isPhysicalDevice) {
        args.push('-allowProvisioningUpdates');
    }
    return args;
}

// For physical devices, devicectl uses CoreDevice identifier (not hardware UDID)
function devicectlId(config: BuildTaskConfig): string {
    return config.deviceIdentifier || config.simulatorUdid || config.simulatorDevice;
}

export function buildCommandLine(config: BuildTaskConfig): string {
    return [
        ...xcodebuildArgs(config),
        'build 2>&1',
    ].join(' ');
}

export function buildForTestingCommandLine(config: BuildTaskConfig): string {
    return [
        ...xcodebuildArgs(config),
        `build-for-testing -only-testing:"${config.targetName}" 2>&1`,
    ].join(' ');
}

// Resolve CFBundleIdentifier from the just-built Info.plist at runtime;
// pbxproj edits to PRODUCT_BUNDLE_IDENTIFIER take effect on the next build,
// so reading the cached config value would terminate/install/launch the
// previous bundle id and silently run stale code. `set -eo pipefail` (set
// by xcodebuildArgs for build tasks) aborts on plutil failure; for tasks
// that don't run xcodebuild first, callers prepend `set -e;`.
const BUNDLE_ID_FROM_INFOPLIST = (appPath: string): string =>
    `BID=$(plutil -extract CFBundleIdentifier raw -o - "${appPath}/Info.plist")`;

const ASSERT_BID = `if [ -z "$BID" ]; then echo "ERROR: failed to read CFBundleIdentifier from Info.plist" >&2; exit 1; fi`;

export function buildInstallCommandLine(config: BuildTaskConfig): string {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;

    if (config.isPhysicalDevice) {
        const appPath = `${derivedData}/Build/Products/Debug-iphoneos/${config.productName}.app`;
        const devId = devicectlId(config);
        return [
            ...xcodebuildArgs(config),
            'build 2>&1',
            `&& ${BUNDLE_ID_FROM_INFOPLIST(appPath)}`,
            `&& xcrun devicectl device install app --device "${devId}" "${appPath}"`,
            `&& xcrun devicectl device process launch --device "${devId}" "$BID"`,
        ].join(' ');
    }

    const udid = config.simulatorUdid || config.simulatorDevice;
    const appPath = `${derivedData}/Build/Products/Debug-iphonesimulator/${config.productName}.app`;
    return [
        ...xcodebuildArgs(config),
        'build 2>&1',
        `&& ${BUNDLE_ID_FROM_INFOPLIST(appPath)}`,
        `&& { xcrun simctl boot "${udid}" 2>/dev/null || true`,
        `; xcrun simctl terminate "${udid}" "$BID" 2>/dev/null || true`,
        `; xcrun simctl install "${udid}" "${appPath}"`,
        '; open -a Simulator; }',
    ].join(' ');
}

// perl filter that prepends a locale-formatted timestamp ([2:26:21 PM]) to each line
const TIMESTAMP_LINES = `perl -pe 'BEGIN { $| = 1 } use POSIX qw(strftime); my $t = strftime("%l:%M:%S %p", localtime); $t =~ s/^\\s+//; $_ = "[" . $t . "] " . $_'`;

export function runAndDebugCommandLine(config: BuildTaskConfig): string {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;
    if (config.isPhysicalDevice) {
        const appPath = `${derivedData}/Build/Products/Debug-iphoneos/${config.productName}.app`;
        const devId = devicectlId(config);
        return `set -e; ${BUNDLE_ID_FROM_INFOPLIST(appPath)}; ${ASSERT_BID}; xcrun devicectl device process launch --device "${devId}" --console "$BID" 2>&1 | ${TIMESTAMP_LINES}`;
    }
    const udid = config.simulatorUdid || config.simulatorDevice;
    const appPath = `${derivedData}/Build/Products/Debug-iphonesimulator/${config.productName}.app`;
    return `set -e; ${BUNDLE_ID_FROM_INFOPLIST(appPath)}; ${ASSERT_BID}; xcrun simctl launch --console-pty --wait-for-debugger "${udid}" "$BID" 2>&1 | ${TIMESTAMP_LINES}`;
}

export function testCommandLine(config: BuildTaskConfig): string {
    const args = [...xcodebuildArgs(config), `test -only-testing:"${config.targetName}" 2>&1`];
    if (!config.isPhysicalDevice) {
        const udid = config.simulatorUdid || config.simulatorDevice;
        args.unshift(`xcrun simctl boot "${udid}" 2>/dev/null || true; open -a Simulator;`);
    }
    return args.join(' ');
}

export function debugConsoleCommandLine(config: BuildTaskConfig): string {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;
    const appPath = `${derivedData}/Build/Products/Debug-iphoneos/${config.productName}.app`;
    const devId = devicectlId(config);
    return `set -e; ${BUNDLE_ID_FROM_INFOPLIST(appPath)}; ${ASSERT_BID}; xcrun devicectl device process launch --device "${devId}" --console --start-stopped --terminate-existing "$BID" 2>&1 | ${TIMESTAMP_LINES}`;
}
