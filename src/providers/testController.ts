import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import type { BuildTaskConfig } from '../types/interfaces';
import { parseNativeTargets, isTestTarget } from '../parsers/targets';
import { determineTargetPath } from '../utils/path';

interface TestTargetInfo {
    name: string;
    absolutePath: string;
}

interface FailureDetail {
    message: string;
    filePath: string;
    line: number;
}

export class XCTestController implements vscode.Disposable {
    private controller: vscode.TestController;
    private testTargets: TestTargetInfo[] = [];

    constructor(
        private workspaceState: vscode.Memento,
        private rootPath: string
    ) {
        this.controller = vscode.tests.createTestController('vsxcode-xctest', 'Xcode Tests');

        this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => this.runHandler(request, token),
            true
        );

        this.controller.createRunProfile(
            'Run with Coverage',
            vscode.TestRunProfileKind.Coverage,
            (request, token) => this.runHandler(request, token, { coverage: true }),
            true
        );

        this.controller.resolveHandler = async (item) => {
            if (!item) {
                await this.discoverTests();
            }
        };

        this.controller.refreshHandler = async () => {
            this.controller.items.replace([]);
            await this.discoverTests();
        };
    }

    refresh(): void {
        this.testTargets = [];
        this.controller.items.replace([]);
        this.discoverTests();
    }

    dispose(): void {
        this.controller.dispose();
    }

    // ── Test discovery ───────────────────────────────────────────

    private async discoverTests(): Promise<void> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) { return; }

        this.testTargets = this.loadTestTargets(config);

        for (const target of this.testTargets) {
            this.scanDirectory(target.name, target.absolutePath);
        }
    }

    private scanDirectory(targetName: string, dirPath: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                this.scanDirectory(targetName, fullPath);
            } else if (entry.name.endsWith('.swift')) {
                this.parseTestFile(targetName, fullPath);
            }
        }
    }

    private parseTestFile(targetName: string, filePath: string): void {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            return;
        }

        const uri = vscode.Uri.file(filePath);
        const classRegex = /(?:(?:public|internal|open)\s+)?(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase/g;
        let classMatch: RegExpExecArray | null;
        const classPositions: { className: string; startIndex: number }[] = [];

        while ((classMatch = classRegex.exec(content)) !== null) {
            classPositions.push({ className: classMatch[1], startIndex: classMatch.index });
        }

        for (let i = 0; i < classPositions.length; i++) {
            const { className, startIndex } = classPositions[i];
            const classLine = content.substring(0, startIndex).split('\n').length - 1;

            const classItem = this.controller.createTestItem(
                `${targetName}/${className}`, className, uri
            );
            classItem.range = new vscode.Range(classLine, 0, classLine, 0);
            this.controller.items.add(classItem);

            const endIndex = i + 1 < classPositions.length
                ? classPositions[i + 1].startIndex
                : content.length;
            const classBody = content.slice(startIndex, endIndex);
            const methodRegex = /func\s+(test\w+)\s*\(\s*\)/g;
            let methodMatch: RegExpExecArray | null;

            while ((methodMatch = methodRegex.exec(classBody)) !== null) {
                const methodOffset = startIndex + methodMatch.index;
                const methodLine = content.substring(0, methodOffset).split('\n').length - 1;

                const methodItem = this.controller.createTestItem(
                    `${targetName}/${className}/${methodMatch[1]}`,
                    `${methodMatch[1]}()`,
                    uri
                );
                methodItem.range = new vscode.Range(methodLine, 0, methodLine, 0);
                classItem.children.add(methodItem);
            }
        }
    }

    // ── Test execution ───────────────────────────────────────────

    private async runHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        options?: { coverage?: boolean }
    ): Promise<void> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) {
            vscode.window.showErrorMessage('No build configuration. Configure via the VSXcode sidebar.');
            return;
        }

        const run = this.controller.createTestRun(request);
        const itemsToRun = request.include || this.getAllTopLevelItems();

        for (const item of itemsToRun) {
            this.enqueueAll(run, item);
        }

        const includeFilters = itemsToRun.map(item => item.id);
        const excludeFilters = request.exclude
            ? request.exclude.map(item => item.id)
            : [];

        const leafItems = this.collectLeafItems(itemsToRun);
        const commandLine = this.buildCommand(config, includeFilters, excludeFilters, options);
        const reportedItems = await this.executeAndParse(run, commandLine, token);

        // Mark enqueued items that never received results as skipped
        for (const item of leafItems) {
            if (!reportedItems.has(item.id)) {
                run.skipped(item);
            }
        }

        run.end();
    }

    private buildCommand(
        config: BuildTaskConfig,
        include: string[],
        exclude: string[],
        options?: { coverage?: boolean }
    ): string {
        const derivedData = `$HOME/Library/Developer/VSCode/DerivedData/${config.schemeName}`;
        const udid = config.simulatorUdid || config.simulatorDevice;
        const sdk = config.isPhysicalDevice ? 'iphoneos' : 'iphonesimulator';
        const parts = [
            'xcodebuild',
            `-project "${config.projectFile}"`,
            `-scheme "${config.schemeName}"`,
            '-configuration Debug',
            `-sdk ${sdk}`,
            `-destination "id=${udid}"`,
            `-derivedDataPath "${derivedData}"`,
        ];
        if (config.isPhysicalDevice) {
            parts.push('-allowProvisioningUpdates');
        }
        if (options?.coverage) {
            parts.push('-enableCodeCoverage YES');
        }
        for (const filter of include) {
            parts.push(`-only-testing:"${filter}"`);
        }
        for (const filter of exclude) {
            parts.push(`-skip-testing:"${filter}"`);
        }
        parts.push('test 2>&1');
        return parts.join(' ');
    }

    private executeAndParse(
        run: vscode.TestRun,
        commandLine: string,
        token: vscode.CancellationToken
    ): Promise<Set<string>> {
        return new Promise<Set<string>>((resolve) => {
            const proc = cp.spawn('/bin/zsh', ['-c', commandLine], {
                cwd: this.rootPath,
                env: process.env,
            });

            const cancelListener = token.onCancellationRequested(() => {
                try { proc.kill('SIGTERM'); } catch { /* already exited */ }
            });

            const failureDetails = new Map<string, FailureDetail[]>();
            const reportedItems = new Set<string>();
            let currentTestItem: vscode.TestItem | undefined;
            let buffer = '';

            const handleData = (data: Buffer) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    currentTestItem = this.parseLine(run, line, failureDetails, reportedItems, currentTestItem);
                }
            };

            proc.stdout?.on('data', handleData);
            proc.stderr?.on('data', handleData);

            const done = () => {
                cancelListener.dispose();
                if (buffer.length > 0) {
                    this.parseLine(run, buffer, failureDetails, reportedItems, currentTestItem);
                }
                resolve(reportedItems);
            };

            proc.on('close', done);
            proc.on('error', done);
        });
    }

    // ── Output parsing ───────────────────────────────────────────

    private parseLine(
        run: vscode.TestRun,
        line: string,
        failureDetails: Map<string, FailureDetail[]>,
        reportedItems: Set<string>,
        currentTestItem: vscode.TestItem | undefined
    ): vscode.TestItem | undefined {
        // xcodebuild uses Objective-C runtime names: -[ModuleName.ClassName methodName]
        // The module prefix (e.g. "PetsTests.PetsTests") must be handled by findTestItem.
        const output = line + '\r\n';

        // Test Case '-[Module.Class method]' started.
        const startMatch = /Test Case '-\[([\w.]+)\s+(\w+)\]' started\./.exec(line);
        if (startMatch) {
            const item = this.findTestItem(startMatch[1], startMatch[2]);
            if (item) {
                run.started(item);
                run.appendOutput(output, undefined, item);
                reportedItems.add(item.id);
                return item;
            }
            run.appendOutput(output);
            return currentTestItem;
        }

        // Test Case '-[Module.Class method]' passed (X.XXX seconds).
        const passMatch = /Test Case '-\[([\w.]+)\s+(\w+)\]' passed \((\d+\.\d+) seconds\)/.exec(line);
        if (passMatch) {
            const item = this.findTestItem(passMatch[1], passMatch[2]);
            if (item) {
                run.appendOutput(output, undefined, item);
                run.passed(item, parseFloat(passMatch[3]) * 1000);
            } else {
                run.appendOutput(output);
            }
            return undefined;
        }

        // Test Case '-[Module.Class method]' failed (X.XXX seconds).
        const failMatch = /Test Case '-\[([\w.]+)\s+(\w+)\]' failed \((\d+\.\d+) seconds\)/.exec(line);
        if (failMatch) {
            const item = this.findTestItem(failMatch[1], failMatch[2]);
            if (item) {
                run.appendOutput(output, undefined, item);
                const key = `${failMatch[1]}/${failMatch[2]}`;
                const details = failureDetails.get(key);
                const duration = parseFloat(failMatch[3]) * 1000;
                if (details && details.length > 0) {
                    const messages = details.map(d => {
                        const msg = new vscode.TestMessage(d.message);
                        msg.location = new vscode.Location(
                            vscode.Uri.file(d.filePath),
                            new vscode.Position(d.line - 1, 0)
                        );
                        return msg;
                    });
                    run.failed(item, messages, duration);
                } else {
                    run.failed(item, new vscode.TestMessage('Test failed'), duration);
                }
            } else {
                run.appendOutput(output);
            }
            return undefined;
        }

        // Assertion failure: /path/file.swift:42: error: -[Module.Class method] : message
        const assertMatch = /^(.+):(\d+): error: -\[([\w.]+)\s+(\w+)\]\s*:\s*(.+)$/.exec(line);
        if (assertMatch) {
            const key = `${assertMatch[3]}/${assertMatch[4]}`;
            if (!failureDetails.has(key)) {
                failureDetails.set(key, []);
            }
            failureDetails.get(key)!.push({
                message: assertMatch[5].trim(),
                filePath: assertMatch[1],
                line: parseInt(assertMatch[2], 10),
            });
        }

        // Non-test output: associate with currently running test (if any)
        run.appendOutput(output, undefined, currentTestItem);
        return currentTestItem;
    }

    // ── Helpers ──────────────────────────────────────────────────

    private findTestItem(qualifiedClassName: string, methodName: string): vscode.TestItem | undefined {
        // xcodebuild outputs "ModuleName.ClassName" — extract both parts
        const parts = qualifiedClassName.split('.');
        const className = parts.length > 1 ? parts[parts.length - 1] : qualifiedClassName;
        const moduleName = parts.length > 1 ? parts[0] : undefined;

        for (const [, classItem] of this.controller.items) {
            if (classItem.label !== className) { continue; }
            // Disambiguate by module name (matches target name in the item ID)
            if (moduleName && !classItem.id.startsWith(`${moduleName}/`)) { continue; }
            for (const [, methodItem] of classItem.children) {
                if (methodItem.id.endsWith(`/${methodName}`)) {
                    return methodItem;
                }
            }
        }
        return undefined;
    }

    private getAllTopLevelItems(): vscode.TestItem[] {
        const items: vscode.TestItem[] = [];
        for (const [, item] of this.controller.items) {
            items.push(item);
        }
        return items;
    }

    private collectLeafItems(items: readonly vscode.TestItem[]): vscode.TestItem[] {
        const leaves: vscode.TestItem[] = [];
        const walk = (item: vscode.TestItem) => {
            if (item.children.size === 0) {
                leaves.push(item);
            }
            for (const [, child] of item.children) {
                walk(child);
            }
        };
        for (const item of items) { walk(item); }
        return leaves;
    }

    private enqueueAll(run: vscode.TestRun, item: vscode.TestItem): void {
        if (item.children.size === 0) {
            run.enqueued(item);
        }
        for (const [, child] of item.children) {
            this.enqueueAll(run, child);
        }
    }

    private loadTestTargets(config: BuildTaskConfig): TestTargetInfo[] {
        try {
            const pbxprojPath = path.join(this.rootPath, config.projectFile, 'project.pbxproj');
            const pbxContents = fs.readFileSync(pbxprojPath, 'utf8');
            const nativeTargets = parseNativeTargets(pbxContents);
            return nativeTargets
                .filter(t => isTestTarget(t.productType))
                .map(t => ({
                    name: t.name,
                    absolutePath: path.join(
                        this.rootPath,
                        determineTargetPath(this.rootPath, t.name, true, t.productName)
                    )
                }));
        } catch {
            return [];
        }
    }
}
