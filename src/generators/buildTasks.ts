import type { BuildTaskConfig } from '../types/interfaces';

// sed filter to colorize xcodebuild output (red errors, yellow warnings)
const COLORIZE_BUILD = [
    'sed',
    `-e 's/\\(.*error:.*\\)/\\x1b[31m\\1\\x1b[0m/'`,
    `-e 's/\\(.*ERROR:.*\\)/\\x1b[31m\\1\\x1b[0m/'`,
    `-e 's/\\(.*warning:.*\\)/\\x1b[33m\\1\\x1b[0m/'`,
    `-e 's/\\(.*WARNING:.*\\)/\\x1b[33m\\1\\x1b[0m/'`,
    `-e 's/\\(.*BUILD FAILED.*\\)/\\x1b[31m\\1\\x1b[0m/'`,
    `-e 's/\\(.*failures)\\)/\\x1b[31m\\1\\x1b[0m/'`,
].join(' ');

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
        `build 2>&1 | ${COLORIZE_BUILD}`,
    ].join(' ');
}

export function buildInstallCommandLine(config: BuildTaskConfig): string {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;

    if (config.isPhysicalDevice) {
        const appPath = `${derivedData}/Build/Products/Debug-iphoneos/${config.productName}.app`;
        const devId = devicectlId(config);
        return [
            ...xcodebuildArgs(config),
            `build 2>&1 | ${COLORIZE_BUILD}`,
            `&& xcrun devicectl device install app --device "${devId}" "${appPath}"`,
            `&& xcrun devicectl device process launch --device "${devId}" "${config.bundleIdentifier}"`,
        ].join(' ');
    }

    const udid = config.simulatorUdid || config.simulatorDevice;
    const appPath = `${derivedData}/Build/Products/Debug-iphonesimulator/${config.productName}.app`;
    return [
        ...xcodebuildArgs(config),
        `build 2>&1 | ${COLORIZE_BUILD}`,
        `&& { xcrun simctl boot "${udid}" 2>/dev/null || true`,
        `; xcrun simctl terminate booted "${config.bundleIdentifier}" 2>/dev/null || true`,
        `; xcrun simctl install booted "${appPath}"`,
        '; open -a Simulator; }',
    ].join(' ');
}

// perl filter that prepends a locale-formatted timestamp ([2:26:21 PM]) to each line
const TIMESTAMP_LINES = `perl -pe 'BEGIN { $| = 1 } use POSIX qw(strftime); my $t = strftime("%l:%M:%S %p", localtime); $t =~ s/^\\s+//; $_ = "[" . $t . "] " . $_'`;

export function runAndDebugCommandLine(config: BuildTaskConfig): string {
    if (config.isPhysicalDevice) {
        const devId = devicectlId(config);
        return `xcrun devicectl device process launch --device "${devId}" --console "${config.bundleIdentifier}" 2>&1 | ${TIMESTAMP_LINES}`;
    }
    return `xcrun simctl launch --console-pty --wait-for-debugger booted "${config.bundleIdentifier}" 2>&1 | ${TIMESTAMP_LINES}`;
}
