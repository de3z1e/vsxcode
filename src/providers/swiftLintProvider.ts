import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { SwiftLintConfig, SwiftLintRule } from '../types/interfaces';

const execFile = promisify(execFileCallback);

interface SwiftLintViolation {
    character: number | null;
    file: string;
    line: number;
    reason: string;
    rule_id: string;
    severity: 'Warning' | 'Error';
    type: string;
}

const DEFAULT_CONFIG: SwiftLintConfig = {
    enabled: true,
    path: '',
    severity: 'normal',
    fixOnSave: false,
    disabledRules: [],
    optInRules: [],
    excludedPaths: [],
    ruleConfigs: {},
};

// ── Rule config fetching ─────────────────────────────────────────

export interface RuleDefaultConfig {
    description: string;
    config: Record<string, string>;
}

export async function fetchRuleDefaultConfig(
    binaryPath: string,
    ruleId: string,
): Promise<RuleDefaultConfig> {
    let stdout: string;
    try {
        const result = await execFile(
            binaryPath,
            ['rules', '--default-config', ruleId],
            { encoding: 'utf8', timeout: 5000 },
        );
        stdout = result.stdout;
    } catch {
        return { description: '', config: {} };
    }

    const lines = stdout.split('\n');
    // First line: "Rule Name (rule_id): Description text"
    const descMatch = /^.+\):\s*(.+)$/.exec(lines[0] || '');
    const description = descMatch ? descMatch[1].trim() : '';

    const config: Record<string, string> = {};
    let inConfig = false;
    for (const line of lines) {
        if (line.includes('Configuration (YAML):')) {
            inConfig = true;
            continue;
        }
        if (!inConfig) { continue; }
        if (line.trimStart().startsWith('Triggering') || line.trimStart().startsWith('Non Triggering')) {
            break;
        }
        const match = /^ {4}(\w[\w_]*):\s*(.+)$/.exec(line);
        if (match) {
            config[match[1]] = match[2].trim();
        }
    }
    return { description, config };
}

// ── Binary detection ─────────────────────────────────────────────

export async function findSwiftLintBinary(customPath: string): Promise<string | null> {
    if (customPath) {
        try {
            await fs.promises.access(customPath, fs.constants.X_OK);
            return customPath;
        } catch {
            return null;
        }
    }

    const candidates = [
        '/opt/homebrew/bin/swiftlint',
        '/usr/local/bin/swiftlint',
    ];
    for (const candidate of candidates) {
        try {
            await fs.promises.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* try next */ }
    }

    try {
        const { stdout } = await execFile('which', ['swiftlint'], { encoding: 'utf8' });
        const resolved = stdout.trim();
        if (resolved) { return resolved; }
    } catch { /* not in PATH */ }

    return null;
}

async function getSwiftLintVersion(binaryPath: string): Promise<string | null> {
    try {
        const { stdout } = await execFile(binaryPath, ['version'], { encoding: 'utf8', timeout: 5000 });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

// ── Rule parsing ─────────────────────────────────────────────────

async function parseSwiftLintRules(binaryPath: string): Promise<SwiftLintRule[]> {
    let stdout: string;
    try {
        const result = await execFile(binaryPath, ['rules'], { encoding: 'utf8', timeout: 10000 });
        stdout = result.stdout;
    } catch {
        return [];
    }

    const rules: SwiftLintRule[] = [];
    for (const line of stdout.split('\n')) {
        const match = /^\|\s*([a-z_]+)\s*\|\s*(yes|no)\s*\|\s*(yes|no)\s*\|\s*(yes|no)\s*\|\s*(\w+)\s*\|\s*(yes|no)\s*/.exec(line);
        if (match) {
            rules.push({
                identifier: match[1],
                optIn: match[2] === 'yes',
                correctable: match[3] === 'yes',
                enabledByDefault: match[4] === 'yes',
                kind: match[5],
                analyzer: match[6] === 'yes',
            });
        }
    }
    return rules;
}

// ── Diagnostic parsing ───────────────────────────────────────────

function parseSwiftLintOutput(json: string): vscode.Diagnostic[] {
    const violations: SwiftLintViolation[] = JSON.parse(json);
    return violations.map((v) => {
        const line = Math.max(0, v.line - 1);
        const char = Math.max(0, (v.character || 1) - 1);
        const range = new vscode.Range(line, char, line, Number.MAX_SAFE_INTEGER);
        const severity = v.severity === 'Error'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning;
        const diagnostic = new vscode.Diagnostic(range, v.reason, severity);
        diagnostic.source = 'SwiftLint';
        diagnostic.code = v.rule_id;
        return diagnostic;
    });
}

// ── Provider ─────────────────────────────────────────────────────

export class SwiftLintProvider implements vscode.Disposable {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private resolvedPath: string | null = null;
    private resolvedVersion: string | null = null;
    private _pathResolved = false;
    private fixingFiles = new Set<string>();
    private cachedRules: SwiftLintRule[] | null = null;

    constructor(
        private workspaceState: vscode.Memento,
        private readonly log: (message: string) => void = () => {},
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('swiftlint');

        this.disposables.push(
            this.diagnosticCollection,
            vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
            vscode.workspace.onDidOpenTextDocument((doc) => this.lintDocument(doc)),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.diagnosticCollection.delete(doc.uri);
            }),
        );
    }

    // ── Config access ────────────────────────────────────────

    getConfig(): SwiftLintConfig {
        const stored = this.workspaceState.get<Partial<SwiftLintConfig>>('swiftLintConfig');
        if (!stored) { return { ...DEFAULT_CONFIG }; }
        return {
            ...DEFAULT_CONFIG,
            ...stored,
            disabledRules: stored.disabledRules || [],
            optInRules: stored.optInRules || [],
            excludedPaths: stored.excludedPaths || [],
            ruleConfigs: stored.ruleConfigs || {},
        };
    }

    async updateConfig(patch: Partial<SwiftLintConfig>): Promise<void> {
        const current = this.getConfig();
        await this.workspaceState.update('swiftLintConfig', { ...current, ...patch });

        if ('path' in patch) {
            this._pathResolved = false;
        }

        // Write config file when rule/exclusion/ruleConfig settings change
        if ('disabledRules' in patch || 'optInRules' in patch || 'excludedPaths' in patch || 'ruleConfigs' in patch) {
            await this.writeConfigFile();
        }

        if (!this.getConfig().enabled) {
            this.diagnosticCollection.clear();
        } else {
            this.lintOpenDocuments();
        }
    }

    // ── Path & version resolution ────────────────────────────

    async resolvePathAndVersion(): Promise<void> {
        const config = this.getConfig();
        this.log('[swiftlint] resolving binary path...');
        this.resolvedPath = await findSwiftLintBinary(config.path);
        this.resolvedVersion = this.resolvedPath ? await getSwiftLintVersion(this.resolvedPath) : null;

        if (this.resolvedPath) {
            this.log(`[swiftlint] found: ${this.resolvedPath} (v${this.resolvedVersion})`);
            this.cachedRules = await parseSwiftLintRules(this.resolvedPath);
            const analyzerCount = this.cachedRules.filter((r) => r.analyzer).length;
            this.log(`[swiftlint] loaded ${this.cachedRules.length - analyzerCount} rules (${analyzerCount} analyzer rules excluded)`);
        } else {
            this.log('[swiftlint] binary not found');
        }

        this._pathResolved = true;
    }

    getResolvedPath(): string | null { return this.resolvedPath; }
    getResolvedVersion(): string | null { return this.resolvedVersion; }
    isPathResolved(): boolean { return this._pathResolved; }

    // ── Rules access ─────────────────────────────────────────

    getRules(): SwiftLintRule[] | null { return this.cachedRules; }

    getEnabledRuleCount(): number {
        if (!this.cachedRules) { return 0; }
        const config = this.getConfig();
        let count = 0;
        for (const rule of this.cachedRules) {
            if (rule.analyzer) { continue; }
            const isDefault = !rule.optIn;
            const isDisabled = config.disabledRules.includes(rule.identifier);
            const isOptedIn = config.optInRules.includes(rule.identifier);
            if ((isDefault && !isDisabled) || isOptedIn) { count++; }
        }
        return count;
    }

    getTotalRuleCount(): number {
        if (!this.cachedRules) { return 0; }
        return this.cachedRules.filter((r) => !r.analyzer).length;
    }

    // ── Config file generation ───────────────────────────────

    hasConfigOverrides(): boolean {
        const config = this.getConfig();
        return config.disabledRules.length > 0
            || config.optInRules.length > 0
            || config.excludedPaths.length > 0
            || Object.keys(config.ruleConfigs).length > 0;
    }

    private getConfigFilePath(): string {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return path.join(rootPath, '.vscode', '.swiftlint.yml');
    }

    async writeConfigFile(): Promise<void> {
        if (!this.hasConfigOverrides()) { return; }

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return; }

        const vscodeDir = path.join(rootPath, '.vscode');
        await fs.promises.mkdir(vscodeDir, { recursive: true });

        const config = this.getConfig();
        const lines: string[] = ['# Managed by VSXcode — changes will be overwritten'];

        if (config.disabledRules.length > 0) {
            lines.push('', 'disabled_rules:');
            for (const rule of config.disabledRules) {
                lines.push(`  - ${rule}`);
            }
        }

        if (config.optInRules.length > 0) {
            lines.push('', 'opt_in_rules:');
            for (const rule of config.optInRules) {
                lines.push(`  - ${rule}`);
            }
        }

        if (config.excludedPaths.length > 0) {
            lines.push('', 'excluded:');
            for (const p of config.excludedPaths) {
                lines.push(`  - ${p}`);
            }
        }

        const ruleEntries = Object.entries(config.ruleConfigs);
        if (ruleEntries.length > 0) {
            for (const [ruleId, params] of ruleEntries) {
                lines.push('', `${ruleId}:`);
                for (const [key, value] of Object.entries(params)) {
                    lines.push(`  ${key}: ${value}`);
                }
            }
        }

        lines.push('');
        await fs.promises.writeFile(this.getConfigFilePath(), lines.join('\n'));
    }

    // ── Linting ──────────────────────────────────────────────

    private async onDocumentSaved(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'swift') { return; }
        if (document.uri.scheme !== 'file') { return; }

        const filePath = document.uri.fsPath;
        if (this.fixingFiles.has(filePath)) { return; }

        const config = this.getConfig();
        if (!config.enabled) { return; }

        if (!this._pathResolved) {
            await this.resolvePathAndVersion();
        }
        if (!this.resolvedPath) { return; }

        if (config.fixOnSave) {
            await this.fixDocument(document);
        }

        await this.lintDocument(document);
    }

    private async fixDocument(document: vscode.TextDocument): Promise<void> {
        if (!this.resolvedPath) { return; }

        const filePath = document.uri.fsPath;
        const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
            || path.dirname(filePath);

        const args = ['lint', '--fix', '--quiet'];
        if (this.hasConfigOverrides()) {
            args.push('--config', this.getConfigFilePath());
        }
        args.push(filePath);

        this.fixingFiles.add(filePath);
        try {
            await execFile(this.resolvedPath, args, { encoding: 'utf8', cwd, timeout: 30000 });
        } catch { /* fix errors are non-fatal */ }

        await new Promise((r) => setTimeout(r, 100));
        this.fixingFiles.delete(filePath);
    }

    async lintDocument(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'swift') { return; }
        if (document.uri.scheme !== 'file') { return; }

        const config = this.getConfig();
        if (!config.enabled) {
            this.diagnosticCollection.delete(document.uri);
            return;
        }

        if (!this._pathResolved) {
            await this.resolvePathAndVersion();
        }
        if (!this.resolvedPath) { return; }

        const filePath = document.uri.fsPath;
        const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
            || path.dirname(filePath);

        const args = ['lint', '--reporter', 'json', '--quiet'];
        if (config.severity === 'strict') { args.push('--strict'); }
        if (config.severity === 'lenient') { args.push('--lenient'); }
        if (this.hasConfigOverrides()) {
            args.push('--config', this.getConfigFilePath());
        }
        args.push(filePath);

        try {
            let stdout: string;
            try {
                const result = await execFile(this.resolvedPath, args, { encoding: 'utf8', cwd, timeout: 30000 });
                stdout = result.stdout;
            } catch (error: unknown) {
                const execError = error as { stdout?: string };
                if (execError.stdout) {
                    stdout = execError.stdout;
                } else {
                    throw error;
                }
            }

            const diagnostics = stdout.trim() ? parseSwiftLintOutput(stdout) : [];
            this.diagnosticCollection.set(document.uri, diagnostics);
        } catch {
            this.diagnosticCollection.delete(document.uri);
        }
    }

    lintOpenDocuments(): void {
        for (const doc of vscode.workspace.textDocuments) {
            this.lintDocument(doc);
        }
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}
