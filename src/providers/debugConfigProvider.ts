import * as vscode from 'vscode';
import type { BuildTaskConfig } from '../types/interfaces';

export class XcodeDebugConfigProvider implements vscode.DebugConfigurationProvider {
    constructor(private workspaceState: vscode.Memento) {}

    provideDebugConfigurations(
        _folder: vscode.WorkspaceFolder | undefined,
        _token?: vscode.CancellationToken
    ): vscode.DebugConfiguration[] {
        return [];
    }

    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // User pressed F5 with no launch.json — delegate to buildAndRun
        if (!debugConfiguration.type && !debugConfiguration.request) {
            const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) {
                vscode.window.showErrorMessage(
                    'No build configuration found. Run "Swift: Configure Build Tasks" first.',
                    'Configure'
                ).then((action) => {
                    if (action === 'Configure') {
                        vscode.commands.executeCommand('vsxcode.generateBuildTasks');
                    }
                });
                return undefined;
            }
            // Trigger the unified build-and-run flow for both simulator and device
            vscode.commands.executeCommand('vsxcode.sidebar.buildAndRun');
            return undefined;
        }

        return debugConfiguration;
    }
}
