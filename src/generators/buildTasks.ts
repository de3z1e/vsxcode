interface BuildTasksOptions {
    projectFile: string;
    schemeName: string;
    productName: string;
    bundleIdentifier: string;
    simulatorDevice: string;
}

export function generateBuildScript(options: BuildTasksOptions): string {
    return `#!/bin/bash
set -e

# Build configuration
PROJECT_FILE="${options.projectFile}"
SCHEME_NAME="${options.schemeName}"
DERIVED_DATA_PATH="$HOME/Library/Developer/VSCode/DerivedData/${options.schemeName}"

# Build for iOS Simulator
xcodebuild \\
    -project "$PROJECT_FILE" \\
    -scheme "$SCHEME_NAME" \\
    -configuration Debug \\
    -sdk iphonesimulator \\
    -derivedDataPath "$DERIVED_DATA_PATH" \\
    build
`;
}

export function generateBuildAndDebugScript(options: BuildTasksOptions): string {
    return `#!/bin/bash
set -e

# Build configuration
PROJECT_FILE="${options.projectFile}"
SCHEME_NAME="${options.schemeName}"
BUNDLE_IDENTIFIER="${options.bundleIdentifier}"
SIMULATOR_DEVICE="${options.simulatorDevice}"
DERIVED_DATA_PATH="$HOME/Library/Developer/VSCode/DerivedData/${options.schemeName}"
APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/${options.productName}.app"

# Build for iOS Simulator
xcodebuild \\
    -project "$PROJECT_FILE" \\
    -scheme "$SCHEME_NAME" \\
    -configuration Debug \\
    -sdk iphonesimulator \\
    -derivedDataPath "$DERIVED_DATA_PATH" \\
    build

# Boot simulator (ignore error if already booted)
xcrun simctl boot "$SIMULATOR_DEVICE" 2>/dev/null || true

# Terminate existing instance (if running)
xcrun simctl terminate booted "$BUNDLE_IDENTIFIER" 2>/dev/null || true

# Install app on simulator
xcrun simctl install booted "$APP_PATH"

# Bring Simulator.app to front
open -a Simulator
`;
}

export function generateConsoleScript(options: BuildTasksOptions): string {
    return `#!/bin/bash

# Launch app and stream stdout/stderr via pty
xcrun simctl launch --console-pty --wait-for-debugger booted "${options.bundleIdentifier}"
`;
}

export function generateTasksJson(): string {
    const tasks = {
        version: '2.0.0',
        tasks: [
            {
                label: 'build',
                type: 'shell',
                command: '.vscode/scripts/build.sh',
                group: {
                    kind: 'build',
                    isDefault: true
                },
                presentation: {
                    reveal: 'always',
                    panel: 'dedicated'
                },
                problemMatcher: ['$swiftc']
            },
            {
                label: 'build-and-debug',
                type: 'shell',
                command: '.vscode/scripts/build-and-debug.sh',
                presentation: {
                    reveal: 'always',
                    panel: 'dedicated'
                },
                problemMatcher: ['$swiftc']
            },
            {
                label: 'app-console',
                type: 'shell',
                command: '.vscode/scripts/console.sh',
                presentation: {
                    reveal: 'always',
                    panel: 'dedicated'
                },
                problemMatcher: []
            },
            {
                label: 'cleanup-debugserver',
                type: 'shell',
                command: 'pkill -f debugserver || true',
                presentation: {
                    reveal: 'silent'
                }
            }
        ]
    };

    return JSON.stringify(tasks, null, 2) + '\n';
}

export function generateLaunchJson(productName: string): string {
    const launch = {
        version: '0.2.0',
        configurations: [
            {
                type: 'lldb',
                request: 'attach',
                name: `Debug ${productName}`,
                program: productName,
                preLaunchTask: 'build-and-debug',
                postDebugTask: 'cleanup-debugserver',
                waitFor: true
            }
        ]
    };

    return JSON.stringify(launch, null, 2) + '\n';
}
