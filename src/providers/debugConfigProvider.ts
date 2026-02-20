import * as vscode from 'vscode';
import type { BuildTaskConfig } from '../types/interfaces';

export class XcodeDebugConfigProvider implements vscode.DebugConfigurationProvider {
    constructor(private workspaceState: vscode.Memento) {}

    provideDebugConfigurations(
        _folder: vscode.WorkspaceFolder | undefined,
        _token?: vscode.CancellationToken
    ): vscode.DebugConfiguration[] {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) {
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
            return this.makeDebugConfig(config);
        }

        return debugConfiguration;
    }

    private makeDebugConfig(config: BuildTaskConfig): vscode.DebugConfiguration {
        return {
            type: 'lldb-dap',
            request: 'attach',
            name: `Debug ${config.productName}`,
            preLaunchTask: 'xcode: build-install',
            attachCommands: [
                `process attach --name ${config.productName} --waitfor`
            ]
        };
    }
}
