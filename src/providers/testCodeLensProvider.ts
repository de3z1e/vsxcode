import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { BuildTaskConfig } from '../types/interfaces';
import { parseNativeTargets, isTestTarget } from '../parsers/targets';
import { determineTargetPath } from '../utils/path';

interface TestTargetInfo {
    name: string;
    absolutePath: string;
}

export class TestCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private testTargets: TestTargetInfo[] | null = null;

    constructor(
        private workspaceState: vscode.Memento,
        private rootPath: string
    ) {}

    refresh(): void {
        this.testTargets = null;
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) { return []; }

        const text = document.getText();
        const classRegex = /(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase/g;
        let classMatch: RegExpExecArray | null;
        const classPositions: { className: string; startIndex: number }[] = [];

        while ((classMatch = classRegex.exec(text)) !== null) {
            classPositions.push({ className: classMatch[1], startIndex: classMatch.index });
        }

        if (classPositions.length === 0) { return []; }

        const targetName = this.resolveTestTarget(document.uri.fsPath, config);
        if (!targetName) { return []; }

        const lenses: vscode.CodeLens[] = [];
        const methodRegex = /func\s+(test\w+)\s*\(\s*\)/g;

        for (let i = 0; i < classPositions.length; i++) {
            const { className, startIndex } = classPositions[i];
            const endIndex = i + 1 < classPositions.length
                ? classPositions[i + 1].startIndex
                : text.length;

            const classLine = document.positionAt(startIndex).line;
            lenses.push(new vscode.CodeLens(
                new vscode.Range(classLine, 0, classLine, 0),
                {
                    title: '$(play) Run Tests',
                    command: 'vsxcode.test.run',
                    arguments: [`${targetName}/${className}`]
                }
            ));

            const classBody = text.slice(startIndex, endIndex);
            let methodMatch: RegExpExecArray | null;
            while ((methodMatch = methodRegex.exec(classBody)) !== null) {
                const methodLine = document.positionAt(startIndex + methodMatch.index).line;
                lenses.push(new vscode.CodeLens(
                    new vscode.Range(methodLine, 0, methodLine, 0),
                    {
                        title: '$(play) Run Test',
                        command: 'vsxcode.test.run',
                        arguments: [`${targetName}/${className}/${methodMatch[1]}`]
                    }
                ));
            }
        }

        return lenses;
    }

    private resolveTestTarget(filePath: string, config: BuildTaskConfig): string | null {
        if (!this.testTargets) {
            this.testTargets = this.loadTestTargets(config);
        }

        for (const target of this.testTargets) {
            if (filePath.startsWith(target.absolutePath + path.sep)) {
                return target.name;
            }
        }

        return null;
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
