import * as vscode from 'vscode';
import type { BuildTaskConfig } from '../types/interfaces';
import { buildCommandLine, buildInstallCommandLine, runAndDebugCommandLine } from '../generators/buildTasks';

export const TASK_TYPE = 'xcode-build';
const TASK_SOURCE = 'xcode';

export class XcodeBuildTaskProvider implements vscode.TaskProvider {
    constructor(private workspaceState: vscode.Memento) {}

    provideTasks(_token: vscode.CancellationToken): vscode.Task[] {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) {
            return [];
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return [];
        }
        return [
            this.createBuildTask(config, folder),
            this.createBuildInstallTask(config, folder),
            this.createRunAndDebugTask(config, folder),
        ];
    }

    resolveTask(task: vscode.Task, _token: vscode.CancellationToken): vscode.Task | undefined {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) {
            return undefined;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return undefined;
        }
        const taskName = task.definition.task as string;
        switch (taskName) {
            case 'build':
                return this.createBuildTask(config, folder);
            case 'build-install':
                return this.createBuildInstallTask(config, folder);
            case 'run-and-debug':
                return this.createRunAndDebugTask(config, folder);
            default:
                return undefined;
        }
    }

    private createBuildTask(config: BuildTaskConfig, folder: vscode.WorkspaceFolder): vscode.Task {
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'build' },
            folder, 'build', TASK_SOURCE,
            new vscode.ShellExecution(buildCommandLine(config)),
            '$swiftc'
        );
        task.group = vscode.TaskGroup.Build;
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
        };
        return task;
    }

    private createBuildInstallTask(config: BuildTaskConfig, folder: vscode.WorkspaceFolder): vscode.Task {
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'build-install' },
            folder, 'build-install', TASK_SOURCE,
            new vscode.ShellExecution(buildInstallCommandLine(config)),
            '$swiftc'
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
        };
        return task;
    }

    private createRunAndDebugTask(config: BuildTaskConfig, folder: vscode.WorkspaceFolder): vscode.Task {
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'run-and-debug' },
            folder, 'run-and-debug', TASK_SOURCE,
            new vscode.ShellExecution(runAndDebugCommandLine(config)),
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
        };
        return task;
    }
}
