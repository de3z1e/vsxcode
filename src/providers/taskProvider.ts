import * as vscode from 'vscode';
import * as cp from 'child_process';
import type { BuildTaskConfig } from '../types/interfaces';
import { buildCommandLine, buildInstallCommandLine, runAndDebugCommandLine } from '../generators/buildTasks';

export const TASK_TYPE = 'xcode-build';
const TASK_SOURCE = 'xcode';

// Colorize xcodebuild output: red errors, yellow warnings, green success
const BUILD_COLORS: [RegExp, string][] = [
    [/^(.*error:.*)$/gm, '\x1b[31m$1\x1b[0m'],
    [/^(.*ERROR:.*)$/gm, '\x1b[31m$1\x1b[0m'],
    [/^(.*warning:.*)$/gm, '\x1b[33m$1\x1b[0m'],
    [/^(.*WARNING:.*)$/gm, '\x1b[33m$1\x1b[0m'],
    [/^(.*BUILD FAILED.*)$/gm, '\x1b[31m$1\x1b[0m'],
    [/^(.*BUILD SUCCEEDED.*)$/gm, '\x1b[32m$1\x1b[0m'],
    [/^(.*failures\).*)$/gm, '\x1b[31m$1\x1b[0m'],
];

function colorizeBuildOutput(text: string): string {
    for (const [pattern, replacement] of BUILD_COLORS) {
        text = text.replace(pattern, replacement);
    }
    return text;
}

interface TaskTerminalOptions {
    colorize?: boolean;
    messages?: { success: string; failure: (code: number) => string };
}

class TaskTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    private process?: cp.ChildProcess;

    constructor(
        private commandLine: string,
        private cwd: string,
        private options?: TaskTerminalOptions,
    ) {}

    open(): void {
        this.process = cp.spawn('/bin/zsh', ['-c', this.commandLine], {
            cwd: this.cwd,
            env: process.env,
            detached: true,
        });

        let hasOutput = false;
        const handleData = (data: Buffer) => {
            if (!hasOutput && this.options?.messages) {
                hasOutput = true;
                this.writeEmitter.fire(`\x1b[32m${this.options.messages.success}\x1b[0m\r\n\r\n`);
            }
            let text = data.toString().replace(/\r?\n/g, '\r\n');
            if (this.options?.colorize) {
                text = colorizeBuildOutput(text);
            }
            this.writeEmitter.fire(text);
        };

        this.process.stdout?.on('data', handleData);
        this.process.stderr?.on('data', handleData);

        this.process.on('close', (code, signal) => {
            const exitCode = signal === 'SIGTERM' ? 0 : (code ?? 1);
            if (!hasOutput && exitCode !== 0 && this.options?.messages) {
                this.writeEmitter.fire(`\r\n\x1b[31m${this.options.messages.failure(exitCode)}\x1b[0m\r\n`);
            }
            this.closeEmitter.fire(exitCode);
        });
    }

    killProcess(): void {
        if (this.process?.pid) {
            try { process.kill(-this.process.pid); } catch { /* already exited */ }
        }
    }

    close(): void {
        this.killProcess();
    }
}

export class XcodeBuildTaskProvider implements vscode.TaskProvider {
    private activeConsoleTerminal?: TaskTerminal;

    constructor(private workspaceState: vscode.Memento) {}

    /** Kill the Run and Debug process (task completes, terminal stays open). */
    killConsoleProcess(): void {
        this.activeConsoleTerminal?.killProcess();
    }

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
            new vscode.CustomExecution(async () => new TaskTerminal(buildCommandLine(config), cwd, { colorize: true })),
            '$swiftc'
        );
        task.group = vscode.TaskGroup.Build;
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
            clear: true
        };
        return task;
    }

    private createBuildInstallTask(config: BuildTaskConfig, folder: vscode.WorkspaceFolder): vscode.Task {
        const cwd = folder.uri.fsPath;
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'build-install' },
            folder, 'Build and Install', TASK_SOURCE,
            new vscode.CustomExecution(async () => new TaskTerminal(buildInstallCommandLine(config), cwd, { colorize: true })),
            '$swiftc'
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear: true,
        };
        return task;
    }

    private createRunAndDebugTask(config: BuildTaskConfig, folder: vscode.WorkspaceFolder): vscode.Task {
        const cwd = folder.uri.fsPath;
        const task = new vscode.Task(
            { type: TASK_TYPE, task: 'run-and-debug' },
            folder, 'Run and Debug', TASK_SOURCE,
            new vscode.CustomExecution(async () => {
                const terminal = new TaskTerminal(runAndDebugCommandLine(config), cwd, {
                    messages: {
                        success: 'App launched successfully.',
                        failure: (code) => `Failed to launch app (exit code ${code}).`,
                    },
                });
                this.activeConsoleTerminal = terminal;
                return terminal;
            }),
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
        };
        return task;
    }
}
