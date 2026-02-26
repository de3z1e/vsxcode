import * as vscode from 'vscode';
import type { BuildTaskConfig } from '../types/interfaces';

export class XcodeDebugConfigProvider implements vscode.DebugConfigurationProvider {
    constructor(private workspaceState: vscode.Memento, private onDebugRequested?: () => void) {}

    provideDebugConfigurations(
        _folder: vscode.WorkspaceFolder | undefined,
        _token?: vscode.CancellationToken
    ): vscode.DebugConfiguration[] {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config || config.isPhysicalDevice) {
            return [];
        }
        return [this.makeDebugConfig(config)];
    }

    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');

        // User pressed F5 with no launch.json — provide our config
        if (!debugConfiguration.type && !debugConfiguration.request) {
            if (!config) {
                vscode.window.showErrorMessage(
                    'No build configuration found. Run "Swift: Configure Build Tasks" first.',
                    'Configure'
                ).then((action) => {
                    if (action === 'Configure') {
                        vscode.commands.executeCommand('swiftPackageHelper.generateBuildTasks');
                    }
                });
                return undefined;
            }
            if (config.isPhysicalDevice) {
                vscode.window.showInformationMessage(
                    'Use Cmd+R to build and debug on a physical device.'
                );
                return undefined;
            }
            this.onDebugRequested?.();
            return this.makeDebugConfig(config);
        }

        if (debugConfiguration.preLaunchTask === 'xcode: Build and Install') {
            this.onDebugRequested?.();
        }
        return debugConfiguration;
    }

    private makeDebugConfig(config: BuildTaskConfig): vscode.DebugConfiguration {
        return {
            type: 'lldb-dap',
            request: 'attach',
            name: `Debug ${config.productName}`,
            preLaunchTask: 'xcode: Build and Install',
            attachCommands: [
                `process attach --name ${config.productName} --waitfor`
            ]
        };
    }
}
