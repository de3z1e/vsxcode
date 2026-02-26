import * as vscode from 'vscode';
import * as cp from 'child_process';
import type { BuildTaskConfig } from '../types/interfaces';
import { buildCommandLine, buildInstallCommandLine, runAndDebugCommandLine } from '../generators/buildTasks';

export const TASK_TYPE = 'xcode-build';
const TASK_SOURCE = 'xcode';

class TaskTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    private process?: cp.ChildProcess;

    constructor(
        private commandLine: string,
        private cwd: string,
    ) {}

    open(): void {
        this.process = cp.spawn('/bin/zsh', ['-c', this.commandLine], {
            cwd: this.cwd,
            env: process.env,
            detached: true,
        });

        const handleData = (data: Buffer) => {
            this.writeEmitter.fire(data.toString().replace(/\r?\n/g, '\r\n'));
        };

        this.process.stdout?.on('data', handleData);
        this.process.stderr?.on('data', handleData);

        this.process.on('close', (code) => {
            this.closeEmitter.fire(code ?? 1);
        });
    }

    close(): void {
        if (this.process?.pid) {
            try { process.kill(-this.process.pid); } catch { /* already exited */ }
        }
    }
}

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
        const cwd = folder.uri.fsPath;
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'build' },
            folder, 'Build', TASK_SOURCE,
            new vscode.CustomExecution(async () => new TaskTerminal(buildCommandLine(config), cwd)),
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
        const cwd = folder.uri.fsPath;
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'build-install' },
            folder, 'Build and Install', TASK_SOURCE,
            new vscode.CustomExecution(async () => new TaskTerminal(buildInstallCommandLine(config), cwd)),
            '$swiftc'
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
        };
        return task;
    }

    private createRunAndDebugTask(config: BuildTaskConfig, folder: vscode.WorkspaceFolder): vscode.Task {
        const cwd = folder.uri.fsPath;
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'run-and-debug' },
            folder, 'Run and Debug', TASK_SOURCE,
            new vscode.CustomExecution(async () => new TaskTerminal(runAndDebugCommandLine(config), cwd)),
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
        };
        return task;
    }
}
