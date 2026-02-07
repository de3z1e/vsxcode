import * as os from 'os';
import * as path from 'path';

interface BuildTasksOptions {
    projectFile: string;
    schemeName: string;
    productName: string;
    bundleIdentifier: string;
    simulatorDevice: string;
}

export function generateTasksJson(options: BuildTasksOptions): string {
    const derivedDataPath = path.join(
        os.homedir(),
        'Library', 'Developer', 'VSCode', 'DerivedData', options.schemeName
    );
    const appPath = path.join(
        derivedDataPath,
        'Build', 'Products', 'Debug-iphonesimulator', `${options.schemeName}.app`
    );

    const tasks = {
        version: '2.0.0',
        tasks: [
            {
                label: 'build-simulator',
                type: 'shell',
                command: 'xcodebuild',
                args: [
                    '-project',
                    options.projectFile,
                    '-scheme',
                    options.schemeName,
                    '-configuration',
                    'Debug',
                    '-sdk',
                    'iphonesimulator',
                    '-derivedDataPath',
                    derivedDataPath,
                    'build'
                ],
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
                label: 'boot-simulator',
                type: 'shell',
                command: `xcrun simctl boot '${options.simulatorDevice}' || true`,
                presentation: {
                    reveal: 'silent'
                }
            },
            {
                label: 'install-app',
                type: 'shell',
                command: `xcrun simctl install booted ${appPath}`,
                dependsOn: ['build-simulator', 'boot-simulator'],
                presentation: {
                    reveal: 'silent'
                }
            },
            {
                label: 'launch-app',
                type: 'shell',
                command: `xcrun simctl launch booted ${options.bundleIdentifier} && open -a Simulator`,
                dependsOn: ['install-app'],
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
                preLaunchTask: 'launch-app',
                waitFor: true
            }
        ]
    };

    return JSON.stringify(launch, null, 2) + '\n';
}
