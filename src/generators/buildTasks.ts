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

export function buildCommandLine(config: BuildTaskConfig): string {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;
    const udid = config.simulatorUdid || config.simulatorDevice;
    return [
        'set -eo pipefail; xcodebuild',
        `-project "${config.projectFile}"`,
        `-scheme "${config.schemeName}"`,
        '-configuration Debug',
        '-sdk iphonesimulator',
        `-destination "id=${udid}"`,
        `-derivedDataPath "${derivedData}"`,
        `build 2>&1 | ${COLORIZE_BUILD}`,
    ].join(' ');
}

export function buildInstallCommandLine(config: BuildTaskConfig): string {
    const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;
    const appPath = `${derivedData}/Build/Products/Debug-iphonesimulator/${config.productName}.app`;
    const udid = config.simulatorUdid || config.simulatorDevice;
    return [
        'set -eo pipefail; xcodebuild',
        `-project "${config.projectFile}"`,
        `-scheme "${config.schemeName}"`,
        '-configuration Debug',
        '-sdk iphonesimulator',
        `-destination "id=${udid}"`,
        `-derivedDataPath "${derivedData}"`,
        `build 2>&1 | ${COLORIZE_BUILD}`,
        `&& { xcrun simctl boot "${udid}" 2>/dev/null || true`,
        `; xcrun simctl terminate booted "${config.bundleIdentifier}" 2>/dev/null || true`,
        `; xcrun simctl install booted "${appPath}"`,
        '; open -a Simulator; }',
    ].join(' ');
}

export function launchAppCommandLine(config: BuildTaskConfig): string {
    return `xcrun simctl launch --console-pty --wait-for-debugger booted "${config.bundleIdentifier}"`;
}
