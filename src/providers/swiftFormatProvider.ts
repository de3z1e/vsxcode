import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { execFile as execFileCallback, spawn } from 'child_process';
import type { SwiftFormatConfig, SwiftFormatRule } from '../types/interfaces';

const execFile = promisify(execFileCallback);

const DEFAULT_CONFIG: SwiftFormatConfig = {
    enabled: true,
    path: '',
    formatOnSave: false,
    lintMode: false,
    disabledRules: [],
    enabledRules: [],
    indentation: 'spaces',
    indentationCount: 4,
    lineLength: 100,
    maximumBlankLines: 1,
    respectsExistingLineBreaks: true,
    lineBreakBeforeControlFlowKeywords: false,
    lineBreakBeforeEachArgument: false,
    lineBreakBeforeEachGenericRequirement: false,
    lineBreakAroundMultilineExpressionChainComponents: false,
    lineBreakBeforeSwitchCaseBody: false,
    lineBreakBetweenDeclarationAttributes: false,
    indentConditionalCompilationBlocks: true,
    indentSwitchCaseLabels: false,
    fileScopedDeclarationPrivacy: 'private',
    multiElementCollectionTrailingCommas: true,
    prioritizeKeepingFunctionOutputTogether: false,
    spacesAroundRangeFormationOperators: false,
    spacesBeforeEndOfLineComments: 2,
    reflowMultilineStringLiterals: 'never',
};

// ── Binary detection ─────────────────────────────────────────────

export async function findSwiftFormatBinary(customPath: string): Promise<string | null> {
    if (customPath) {
        try {
            await fs.promises.access(customPath, fs.constants.X_OK);
            return customPath;
        } catch {
            return null;
        }
    }

    // xcrun (ships with Swift toolchain)
    try {
        const { stdout } = await execFile('xcrun', ['--find', 'swift-format'], { encoding: 'utf8', timeout: 5000 });
        const resolved = stdout.trim();
        if (resolved) {
            await fs.promises.access(resolved, fs.constants.X_OK);
            return resolved;
        }
    } catch { /* not found via xcrun */ }

    const candidates = [
        '/opt/homebrew/bin/swift-format',
        '/usr/local/bin/swift-format',
    ];
    for (const candidate of candidates) {
        try {
            await fs.promises.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* try next */ }
    }

    try {
        const { stdout } = await execFile('which', ['swift-format'], { encoding: 'utf8' });
        const resolved = stdout.trim();
        if (resolved) { return resolved; }
    } catch { /* not in PATH */ }

    return null;
}

async function getSwiftFormatVersion(binaryPath: string): Promise<string | null> {
    try {
        const { stdout } = await execFile(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

// ── Configuration dump parsing ───────────────────────────────────

interface DumpConfig {
    version?: number;
    lineLength?: number;
    indentation?: { spaces?: number; tabs?: number };
    tabWidth?: number;
    maximumBlankLines?: number;
    respectsExistingLineBreaks?: boolean;
    lineBreakBeforeControlFlowKeywords?: boolean;
    lineBreakBeforeEachArgument?: boolean;
    lineBreakBeforeEachGenericRequirement?: boolean;
    lineBreakAroundMultilineExpressionChainComponents?: boolean;
    lineBreakBeforeSwitchCaseBody?: boolean;
    lineBreakBetweenDeclarationAttributes?: boolean;
    indentConditionalCompilationBlocks?: boolean;
    indentSwitchCaseLabels?: boolean;
    fileScopedDeclarationPrivacy?: { accessLevel?: string };
    spacesAroundRangeFormationOperators?: boolean;
    multiElementCollectionTrailingCommas?: boolean;
    prioritizeKeepingFunctionOutputTogether?: boolean;
    reflowMultilineStringLiterals?: string;
    spacesBeforeEndOfLineComments?: number;
    rules?: Record<string, boolean>;
}

async function dumpDefaultConfiguration(binaryPath: string): Promise<DumpConfig | null> {
    try {
        const { stdout } = await execFile(binaryPath, ['dump-configuration'], { encoding: 'utf8', timeout: 5000 });
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

function parseSwiftFormatRules(dumpConfig: DumpConfig): SwiftFormatRule[] {
    const rules: SwiftFormatRule[] = [];
    if (dumpConfig.rules) {
        for (const [id, enabled] of Object.entries(dumpConfig.rules)) {
            rules.push({ identifier: id, enabled, isDefault: enabled });
        }
    }
    return rules.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

// ── Provider ─────────────────────────────────────────────────────

export class SwiftFormatProvider implements vscode.Disposable, vscode.DocumentFormattingEditProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private resolvedPath: string | null = null;
    private resolvedVersion: string | null = null;
    private _pathResolved = false;
    private cachedRules: SwiftFormatRule[] | null = null;
    private defaultDumpConfig: DumpConfig | null = null;
    private _writingConfigFile = false;
    private formattingFiles = new Set<string>();

    private _onDidSyncConfig = new vscode.EventEmitter<void>();
    readonly onDidSyncConfig = this._onDidSyncConfig.event;

    constructor(
        private workspaceState: vscode.Memento,
        private globalState: vscode.Memento,
        private readonly log: (message: string) => void = () => {},
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('swift-format');

        this.disposables.push(
            this.diagnosticCollection,
            this._onDidSyncConfig,
            vscode.workspace.onWillSaveTextDocument((event) => this.onWillSaveDocument(event)),
            vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
            vscode.workspace.onDidOpenTextDocument((doc) => this.lintDocument(doc)),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.diagnosticCollection.delete(doc.uri);
            }),
        );

        // File watcher — always sync to workspace state so local profile stays
        // up to date even when global mode is active (global overlay hides the values)
        const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (rootUri) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(rootUri, '.vscode/.swift-format'),
            );
            watcher.onDidChange(() => this.syncFromConfigFile());
            watcher.onDidCreate(() => this.syncFromConfigFile());
            this.disposables.push(watcher);
        }
    }

    // ── Config access ────────────────────────────────────────

    private static readonly PROFILE_FIELDS: (keyof SwiftFormatConfig)[] = [
        'disabledRules', 'enabledRules',
        'indentation', 'indentationCount', 'lineLength', 'maximumBlankLines',
        'respectsExistingLineBreaks', 'lineBreakBeforeControlFlowKeywords',
        'lineBreakBeforeEachArgument', 'lineBreakBeforeEachGenericRequirement',
        'lineBreakAroundMultilineExpressionChainComponents', 'lineBreakBeforeSwitchCaseBody',
        'lineBreakBetweenDeclarationAttributes',
        'indentConditionalCompilationBlocks', 'indentSwitchCaseLabels',
        'fileScopedDeclarationPrivacy', 'multiElementCollectionTrailingCommas',
        'prioritizeKeepingFunctionOutputTogether', 'spacesAroundRangeFormationOperators',
        'spacesBeforeEndOfLineComments', 'reflowMultilineStringLiterals',
    ];

    getProfileMode(): 'local' | 'global' {
        return this.workspaceState.get<'local' | 'global'>('swiftFormatProfileMode', 'global');
    }

    isProfileModeExplicit(): boolean {
        return this.workspaceState.get('swiftFormatProfileMode') !== undefined;
    }

    async setProfileMode(mode: 'local' | 'global'): Promise<void> {
        const prevMode = this.getProfileMode();
        if (mode === prevMode) { return; }

        if (mode === 'global') {
            if (!this.globalState.get('swiftFormatGlobalProfile')) {
                // Initialize global profile with defaults
                const profile: Partial<SwiftFormatConfig> = {};
                for (const key of SwiftFormatProvider.PROFILE_FIELDS) {
                    (profile as unknown as Record<string, unknown>)[key] = DEFAULT_CONFIG[key];
                }
                await this.globalState.update('swiftFormatGlobalProfile', profile);
                this.log('[swift-format] initialized global profile with defaults');
            }
        }

        // Capture effective config before mode switch (includes global overrides if currently global)
        const effectiveBeforeSwitch = this.getConfig();

        // Store mode early so writeConfigFile sees the new mode
        await this.workspaceState.update('swiftFormatProfileMode', mode);

        // When switching to local without a config file, seed workspace state from the
        // current effective config. When a config file exists, the file watcher already
        // keeps workspace state in sync — no re-import needed.
        if (mode === 'local' && !this.hasConfigFile()) {
            const local: Partial<SwiftFormatConfig> = {};
            for (const key of SwiftFormatProvider.PROFILE_FIELDS) {
                (local as unknown as Record<string, unknown>)[key] = (effectiveBeforeSwitch as unknown as Record<string, unknown>)[key];
            }
            const current = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig') || {};
            await this.workspaceState.update('swiftFormatConfig', { ...current, ...local });
            this.log('[swift-format] copied effective config to local settings');
        }

        this.log(`[swift-format] profile mode: ${mode}`);
        try {
            await this.writeConfigFile();
        } catch {
            this.log('[swift-format] failed to write config file');
        }

        if (this.getConfig().lintMode) {
            this.lintOpenDocuments();
        }
    }

    /** Save current local settings to the global profile */
    async saveLocalToGlobal(): Promise<void> {
        const effective = this.getConfig();
        const profile: Partial<SwiftFormatConfig> = {};
        for (const key of SwiftFormatProvider.PROFILE_FIELDS) {
            (profile as unknown as Record<string, unknown>)[key] = (effective as unknown as Record<string, unknown>)[key];
        }
        await this.globalState.update('swiftFormatGlobalProfile', profile);
        this.log('[swift-format] saved local settings to global profile');
    }

    /** Save global profile settings to the local workspace config */
    async saveGlobalToLocal(): Promise<void> {
        const globalProfile = this.globalState.get<Partial<SwiftFormatConfig>>('swiftFormatGlobalProfile');
        const globalBase: SwiftFormatConfig = { ...DEFAULT_CONFIG, ...globalProfile };
        const local: Partial<SwiftFormatConfig> = {};
        for (const key of SwiftFormatProvider.PROFILE_FIELDS) {
            (local as unknown as Record<string, unknown>)[key] = (globalBase as unknown as Record<string, unknown>)[key];
        }
        const current = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig') || {};
        await this.workspaceState.update('swiftFormatConfig', { ...current, ...local });
        this.log('[swift-format] saved global settings to local profile');
    }

    hasConfigFile(): boolean {
        return fs.existsSync(this.getConfigFilePath());
    }

    getConfig(): SwiftFormatConfig {
        const stored = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig');
        const base: SwiftFormatConfig = {
            ...DEFAULT_CONFIG,
            ...stored,
            disabledRules: stored?.disabledRules || [],
            enabledRules: stored?.enabledRules || [],
        };

        if (this.getProfileMode() === 'global') {
            const global = this.globalState.get<Partial<SwiftFormatConfig>>('swiftFormatGlobalProfile');
            if (global) {
                for (const key of SwiftFormatProvider.PROFILE_FIELDS) {
                    if (key in global) {
                        (base as unknown as Record<string, unknown>)[key] = global[key];
                    }
                }
                base.disabledRules = base.disabledRules || [];
                base.enabledRules = base.enabledRules || [];
            }
        }

        return base;
    }

    async updateConfig(patch: Partial<SwiftFormatConfig>): Promise<void> {
        const localPatch: Partial<SwiftFormatConfig> = {};
        const profilePatch: Partial<SwiftFormatConfig> = {};
        for (const [key, value] of Object.entries(patch)) {
            if (SwiftFormatProvider.PROFILE_FIELDS.includes(key as keyof SwiftFormatConfig)) {
                (profilePatch as Record<string, unknown>)[key] = value;
            } else {
                (localPatch as Record<string, unknown>)[key] = value;
            }
        }

        if (Object.keys(localPatch).length > 0) {
            const current = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig') || {};
            await this.workspaceState.update('swiftFormatConfig', { ...current, ...localPatch });
        }

        if (Object.keys(profilePatch).length > 0) {
            if (this.getProfileMode() === 'global') {
                const current = this.globalState.get<Partial<SwiftFormatConfig>>('swiftFormatGlobalProfile') || {};
                await this.globalState.update('swiftFormatGlobalProfile', { ...current, ...profilePatch });
            } else {
                const current = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig') || {};
                await this.workspaceState.update('swiftFormatConfig', { ...current, ...profilePatch });
            }
        }

        if ('path' in patch) {
            this._pathResolved = false;
        }

        // Write config file when formatting options or rules change
        if (Object.keys(patch).some((k) => SwiftFormatProvider.PROFILE_FIELDS.includes(k as keyof SwiftFormatConfig))) {
            await this.writeConfigFile();
        }

        const updatedConfig = this.getConfig();
        if (!updatedConfig.lintMode) {
            this.diagnosticCollection.clear();
        } else {
            this.lintOpenDocuments();
        }
    }

    // ── Path & version resolution ────────────────────────────

    async resolvePathAndVersion(): Promise<void> {
        const config = this.getConfig();
        this.log('[swift-format] resolving binary path...');
        this.resolvedPath = await findSwiftFormatBinary(config.path);
        this.resolvedVersion = this.resolvedPath ? await getSwiftFormatVersion(this.resolvedPath) : null;

        if (this.resolvedPath) {
            this.log(`[swift-format] found: ${this.resolvedPath} (v${this.resolvedVersion})`);
            this.defaultDumpConfig = await dumpDefaultConfiguration(this.resolvedPath);
            if (this.defaultDumpConfig) {
                this.cachedRules = parseSwiftFormatRules(this.defaultDumpConfig);
                this.log(`[swift-format] loaded ${this.cachedRules.length} rules`);
            }
        } else {
            this.log('[swift-format] binary not found');
        }

        this._pathResolved = true;
    }

    getResolvedPath(): string | null { return this.resolvedPath; }
    getResolvedVersion(): string | null { return this.resolvedVersion; }
    isPathResolved(): boolean { return this._pathResolved; }

    // ── Rules access ─────────────────────────────────────────

    getRules(): SwiftFormatRule[] | null { return this.cachedRules; }

    getEnabledRuleCount(): number {
        if (!this.cachedRules) { return 0; }
        const config = this.getConfig();
        let count = 0;
        for (const rule of this.cachedRules) {
            const isDisabled = config.disabledRules.includes(rule.identifier);
            const isEnabled = config.enabledRules.includes(rule.identifier);
            if ((rule.isDefault && !isDisabled) || isEnabled) { count++; }
        }
        return count;
    }

    getTotalRuleCount(): number {
        return this.cachedRules?.length || 0;
    }

    // ── Config file generation ───────────────────────────────

    hasConfigOverrides(): boolean {
        const config = this.getConfig();
        return config.disabledRules.length > 0
            || config.enabledRules.length > 0
            || config.lineLength !== DEFAULT_CONFIG.lineLength
            || config.indentation !== DEFAULT_CONFIG.indentation
            || config.indentationCount !== DEFAULT_CONFIG.indentationCount
            || config.maximumBlankLines !== DEFAULT_CONFIG.maximumBlankLines
            || config.respectsExistingLineBreaks !== DEFAULT_CONFIG.respectsExistingLineBreaks
            || config.lineBreakBeforeControlFlowKeywords !== DEFAULT_CONFIG.lineBreakBeforeControlFlowKeywords
            || config.lineBreakBeforeEachArgument !== DEFAULT_CONFIG.lineBreakBeforeEachArgument
            || config.lineBreakBeforeEachGenericRequirement !== DEFAULT_CONFIG.lineBreakBeforeEachGenericRequirement
            || config.lineBreakAroundMultilineExpressionChainComponents !== DEFAULT_CONFIG.lineBreakAroundMultilineExpressionChainComponents
            || config.lineBreakBeforeSwitchCaseBody !== DEFAULT_CONFIG.lineBreakBeforeSwitchCaseBody
            || config.indentConditionalCompilationBlocks !== DEFAULT_CONFIG.indentConditionalCompilationBlocks
            || config.indentSwitchCaseLabels !== DEFAULT_CONFIG.indentSwitchCaseLabels
            || config.fileScopedDeclarationPrivacy !== DEFAULT_CONFIG.fileScopedDeclarationPrivacy
            || config.multiElementCollectionTrailingCommas !== DEFAULT_CONFIG.multiElementCollectionTrailingCommas
            || config.lineBreakBetweenDeclarationAttributes !== DEFAULT_CONFIG.lineBreakBetweenDeclarationAttributes
            || config.prioritizeKeepingFunctionOutputTogether !== DEFAULT_CONFIG.prioritizeKeepingFunctionOutputTogether
            || config.spacesAroundRangeFormationOperators !== DEFAULT_CONFIG.spacesAroundRangeFormationOperators
            || config.spacesBeforeEndOfLineComments !== DEFAULT_CONFIG.spacesBeforeEndOfLineComments
            || config.reflowMultilineStringLiterals !== DEFAULT_CONFIG.reflowMultilineStringLiterals;
    }

    private getConfigFilePath(): string {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return path.join(rootPath, '.vscode', '.swift-format');
    }

    /** Build the JSON config string from current settings */
    buildConfigJson(): string {
        const config = this.getConfig();

        const formatConfig: Record<string, unknown> = {
            version: 1,
            lineLength: config.lineLength,
            indentation: config.indentation === 'tabs' ? { tabs: 1 } : { spaces: config.indentationCount },
            tabWidth: 8,
            maximumBlankLines: config.maximumBlankLines,
            respectsExistingLineBreaks: config.respectsExistingLineBreaks,
            lineBreakBeforeControlFlowKeywords: config.lineBreakBeforeControlFlowKeywords,
            lineBreakBeforeEachArgument: config.lineBreakBeforeEachArgument,
            lineBreakBeforeEachGenericRequirement: config.lineBreakBeforeEachGenericRequirement,
            lineBreakAroundMultilineExpressionChainComponents: config.lineBreakAroundMultilineExpressionChainComponents,
            lineBreakBeforeSwitchCaseBody: config.lineBreakBeforeSwitchCaseBody,
            lineBreakBetweenDeclarationAttributes: config.lineBreakBetweenDeclarationAttributes,
            indentConditionalCompilationBlocks: config.indentConditionalCompilationBlocks,
            indentSwitchCaseLabels: config.indentSwitchCaseLabels,
            fileScopedDeclarationPrivacy: { accessLevel: config.fileScopedDeclarationPrivacy },
            multiElementCollectionTrailingCommas: config.multiElementCollectionTrailingCommas,
            prioritizeKeepingFunctionOutputTogether: config.prioritizeKeepingFunctionOutputTogether,
            spacesAroundRangeFormationOperators: config.spacesAroundRangeFormationOperators,
            spacesBeforeEndOfLineComments: config.spacesBeforeEndOfLineComments,
            reflowMultilineStringLiterals: config.reflowMultilineStringLiterals,
        };

        // Build rules from defaults + overrides
        const rules: Record<string, boolean> = {};
        if (this.defaultDumpConfig?.rules) {
            for (const [id, defaultEnabled] of Object.entries(this.defaultDumpConfig.rules)) {
                if (config.disabledRules.includes(id)) {
                    rules[id] = false;
                } else if (config.enabledRules.includes(id)) {
                    rules[id] = true;
                } else {
                    rules[id] = defaultEnabled;
                }
            }
        }
        if (Object.keys(rules).length > 0) {
            formatConfig.rules = rules;
        }

        return JSON.stringify(formatConfig, null, 2);
    }

    /** Get the --configuration argument for swift-format (always inline JSON for consistency) */
    getConfigArgs(): string[] {
        return ['--configuration', this.buildConfigJson()];
    }

    async writeConfigFile(): Promise<void> {
        // Only write config file in local mode
        if (this.getProfileMode() !== 'local') { return; }

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return; }

        const vscodeDir = path.join(rootPath, '.vscode');
        await fs.promises.mkdir(vscodeDir, { recursive: true });

        this._writingConfigFile = true;
        await fs.promises.writeFile(this.getConfigFilePath(), this.buildConfigJson() + '\n');
        setTimeout(() => { this._writingConfigFile = false; }, 500);
    }

    // ── Formatting ───────────────────────────────────────────

    async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        _options: vscode.FormattingOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.TextEdit[]> {
        return this.formatDocument(document);
    }

    private async formatDocument(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
        if (!this._pathResolved) {
            await this.resolvePathAndVersion();
        }
        if (!this.resolvedPath) { return []; }

        const text = document.getText();
        if (!text.trim()) { return []; }

        const args = ['format', ...this.getConfigArgs()];

        try {
            const formatted = await this.execWithStdin(this.resolvedPath, args, text);
            if (!formatted || formatted === text) { return []; }

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(text.length),
            );
            return [vscode.TextEdit.replace(fullRange, formatted)];
        } catch (error) {
            this.log(`[swift-format] format failed: ${error}`);
            return [];
        }
    }

    private execWithStdin(binary: string, args: string[], input: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            const timeout = setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, 30000);
            proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
            proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
            proc.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) { resolve(stdout); }
                else { reject(new Error(stderr || `Process exited with code ${code}`)); }
            });
            proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
            proc.stdin.write(input);
            proc.stdin.end();
        });
    }

    // ── Format on save ───────────────────────────────────────

    private onWillSaveDocument(event: vscode.TextDocumentWillSaveEvent): void {
        if (event.document.languageId !== 'swift') { return; }
        if (event.document.uri.scheme !== 'file') { return; }

        const config = this.getConfig();
        if (!config.formatOnSave) { return; }
        if (!this.resolvedPath) { return; }

        const filePath = event.document.uri.fsPath;
        if (this.formattingFiles.has(filePath)) { return; }

        this.formattingFiles.add(filePath);
        event.waitUntil(
            this.formatDocument(event.document).finally(() => {
                this.formattingFiles.delete(filePath);
            }),
        );
    }

    // ── Linting ──────────────────────────────────────────────

    private async onDocumentSaved(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'swift') { return; }
        if (document.uri.scheme !== 'file') { return; }

        const config = this.getConfig();
        if (!config.lintMode) { return; }

        await this.lintDocument(document);
    }

    async lintDocument(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'swift') { return; }
        if (document.uri.scheme !== 'file') { return; }

        const config = this.getConfig();
        if (!config.lintMode) {
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

        const args = ['lint', ...this.getConfigArgs()];
        args.push(filePath);

        try {
            let stderr: string;
            try {
                const result = await execFile(this.resolvedPath, args, { encoding: 'utf8', cwd, timeout: 30000 });
                stderr = result.stderr;
            } catch (error: unknown) {
                const execError = error as { stderr?: string };
                if (execError.stderr) {
                    stderr = execError.stderr;
                } else {
                    throw error;
                }
            }

            const diagnostics = stderr.trim() ? this.parseLintOutput(stderr, filePath) : [];
            this.diagnosticCollection.set(document.uri, diagnostics);
        } catch {
            this.diagnosticCollection.delete(document.uri);
        }
    }

    private parseLintOutput(output: string, filePath: string): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const fileName = path.basename(filePath);

        for (const line of output.split('\n')) {
            // Format: file.swift:10:3: warning: message [RuleName]
            const match = /^(.+?):(\d+):(\d+):\s*(warning|error):\s*(.+?)(?:\s*\[(\w+)\])?\s*$/.exec(line);
            if (!match) { continue; }

            const [, file, lineStr, colStr, severity, message, ruleName] = match;
            if (!file.endsWith(fileName) && file !== filePath) { continue; }

            const lineNum = Math.max(0, parseInt(lineStr) - 1);
            const colNum = Math.max(0, parseInt(colStr) - 1);
            const range = new vscode.Range(lineNum, colNum, lineNum, Number.MAX_SAFE_INTEGER);

            const diagSeverity = severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning;

            const diagnostic = new vscode.Diagnostic(range, message, diagSeverity);
            diagnostic.source = 'swift-format';
            if (ruleName) { diagnostic.code = ruleName; }
            diagnostics.push(diagnostic);
        }

        return diagnostics;
    }

    lintOpenDocuments(): void {
        for (const doc of vscode.workspace.textDocuments) {
            this.lintDocument(doc);
        }
    }

    // ── Config file sync (external edits) ────────────────────

    async syncFromConfigFile(): Promise<void> {
        if (this._writingConfigFile) { return; }

        try {
            const content = await fs.promises.readFile(this.getConfigFilePath(), 'utf8');
            const parsed = JSON.parse(content) as DumpConfig;

            // Compare against raw workspace state so the sync is 1:1 regardless of profile mode
            const stored = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig');
            const config: SwiftFormatConfig = { ...DEFAULT_CONFIG, ...stored };
            const patch: Partial<SwiftFormatConfig> = {};

            // Sync formatting options
            if (parsed.lineLength !== undefined && parsed.lineLength !== config.lineLength) {
                patch.lineLength = parsed.lineLength;
            }
            if (parsed.indentation) {
                if ('tabs' in parsed.indentation) {
                    if (config.indentation !== 'tabs') { patch.indentation = 'tabs'; }
                } else if ('spaces' in parsed.indentation) {
                    if (config.indentation !== 'spaces') { patch.indentation = 'spaces'; }
                    if (parsed.indentation.spaces !== undefined && parsed.indentation.spaces !== config.indentationCount) {
                        patch.indentationCount = parsed.indentation.spaces;
                    }
                }
            }
            if (parsed.maximumBlankLines !== undefined && parsed.maximumBlankLines !== config.maximumBlankLines) {
                patch.maximumBlankLines = parsed.maximumBlankLines;
            }
            if (parsed.respectsExistingLineBreaks !== undefined && parsed.respectsExistingLineBreaks !== config.respectsExistingLineBreaks) {
                patch.respectsExistingLineBreaks = parsed.respectsExistingLineBreaks;
            }
            if (parsed.lineBreakBeforeControlFlowKeywords !== undefined && parsed.lineBreakBeforeControlFlowKeywords !== config.lineBreakBeforeControlFlowKeywords) {
                patch.lineBreakBeforeControlFlowKeywords = parsed.lineBreakBeforeControlFlowKeywords;
            }
            if (parsed.lineBreakBeforeEachArgument !== undefined && parsed.lineBreakBeforeEachArgument !== config.lineBreakBeforeEachArgument) {
                patch.lineBreakBeforeEachArgument = parsed.lineBreakBeforeEachArgument;
            }
            if (parsed.lineBreakBeforeEachGenericRequirement !== undefined && parsed.lineBreakBeforeEachGenericRequirement !== config.lineBreakBeforeEachGenericRequirement) {
                patch.lineBreakBeforeEachGenericRequirement = parsed.lineBreakBeforeEachGenericRequirement;
            }
            if (parsed.lineBreakAroundMultilineExpressionChainComponents !== undefined && parsed.lineBreakAroundMultilineExpressionChainComponents !== config.lineBreakAroundMultilineExpressionChainComponents) {
                patch.lineBreakAroundMultilineExpressionChainComponents = parsed.lineBreakAroundMultilineExpressionChainComponents;
            }
            if (parsed.lineBreakBeforeSwitchCaseBody !== undefined && parsed.lineBreakBeforeSwitchCaseBody !== config.lineBreakBeforeSwitchCaseBody) {
                patch.lineBreakBeforeSwitchCaseBody = parsed.lineBreakBeforeSwitchCaseBody;
            }
            if (parsed.indentConditionalCompilationBlocks !== undefined && parsed.indentConditionalCompilationBlocks !== config.indentConditionalCompilationBlocks) {
                patch.indentConditionalCompilationBlocks = parsed.indentConditionalCompilationBlocks;
            }
            if (parsed.indentSwitchCaseLabels !== undefined && parsed.indentSwitchCaseLabels !== config.indentSwitchCaseLabels) {
                patch.indentSwitchCaseLabels = parsed.indentSwitchCaseLabels;
            }
            if (parsed.fileScopedDeclarationPrivacy?.accessLevel) {
                const accessLevel = parsed.fileScopedDeclarationPrivacy.accessLevel as 'private' | 'fileprivate';
                if (accessLevel !== config.fileScopedDeclarationPrivacy) {
                    patch.fileScopedDeclarationPrivacy = accessLevel;
                }
            }
            if (parsed.multiElementCollectionTrailingCommas !== undefined && parsed.multiElementCollectionTrailingCommas !== config.multiElementCollectionTrailingCommas) {
                patch.multiElementCollectionTrailingCommas = parsed.multiElementCollectionTrailingCommas;
            }
            if (parsed.lineBreakBetweenDeclarationAttributes !== undefined && parsed.lineBreakBetweenDeclarationAttributes !== config.lineBreakBetweenDeclarationAttributes) {
                patch.lineBreakBetweenDeclarationAttributes = parsed.lineBreakBetweenDeclarationAttributes;
            }
            if (parsed.prioritizeKeepingFunctionOutputTogether !== undefined && parsed.prioritizeKeepingFunctionOutputTogether !== config.prioritizeKeepingFunctionOutputTogether) {
                patch.prioritizeKeepingFunctionOutputTogether = parsed.prioritizeKeepingFunctionOutputTogether;
            }
            if (parsed.spacesAroundRangeFormationOperators !== undefined && parsed.spacesAroundRangeFormationOperators !== config.spacesAroundRangeFormationOperators) {
                patch.spacesAroundRangeFormationOperators = parsed.spacesAroundRangeFormationOperators;
            }
            if (parsed.spacesBeforeEndOfLineComments !== undefined && parsed.spacesBeforeEndOfLineComments !== config.spacesBeforeEndOfLineComments) {
                patch.spacesBeforeEndOfLineComments = parsed.spacesBeforeEndOfLineComments;
            }
            if (parsed.reflowMultilineStringLiterals !== undefined) {
                const reflow = parsed.reflowMultilineStringLiterals as 'never' | 'always';
                if (reflow !== config.reflowMultilineStringLiterals) {
                    patch.reflowMultilineStringLiterals = reflow;
                }
            }

            // Sync rules
            if (parsed.rules && this.cachedRules) {
                const disabledRules: string[] = [];
                const enabledRules: string[] = [];
                for (const rule of this.cachedRules) {
                    const fileEnabled = parsed.rules[rule.identifier];
                    if (fileEnabled === undefined) { continue; }
                    if (rule.isDefault && !fileEnabled) {
                        disabledRules.push(rule.identifier);
                    } else if (!rule.isDefault && fileEnabled) {
                        enabledRules.push(rule.identifier);
                    }
                }
                if (JSON.stringify(disabledRules) !== JSON.stringify(config.disabledRules)) {
                    patch.disabledRules = disabledRules;
                }
                if (JSON.stringify(enabledRules) !== JSON.stringify(config.enabledRules)) {
                    patch.enabledRules = enabledRules;
                }
            }

            if (Object.keys(patch).length === 0) { return; }

            // Always write to workspace (local) state — the config file is a local artifact.
            // In global mode the global overlay in getConfig() hides these values.
            const current = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig') || {};
            await this.workspaceState.update('swiftFormatConfig', { ...current, ...patch });

            this.log('[swift-format] config synced from .swift-format');
            if (this.getConfig().lintMode) {
                this.lintOpenDocuments();
            }
            this._onDidSyncConfig.fire();
        } catch { /* file may not exist or be invalid */ }
    }

    // ── Global profile ────────────────────────────────────────

    hasGlobalProfile(): boolean {
        return !!this.globalState.get('swiftFormatGlobalProfile');
    }

    /** Check if local profile fields differ from the global profile */
    localDiffersFromGlobal(): boolean {
        // Read raw workspace state — not getConfig() which applies global overlay
        const stored = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig');
        const local: SwiftFormatConfig = { ...DEFAULT_CONFIG, ...stored };
        const globalProfile = this.globalState.get<Partial<SwiftFormatConfig>>('swiftFormatGlobalProfile');
        const globalBase: SwiftFormatConfig = { ...DEFAULT_CONFIG, ...globalProfile };

        for (const key of SwiftFormatProvider.PROFILE_FIELDS) {
            const lv = (local as unknown as Record<string, unknown>)[key];
            const gv = (globalBase as unknown as Record<string, unknown>)[key];
            if (JSON.stringify(lv) !== JSON.stringify(gv)) { return true; }
        }
        return false;
    }

    /** Whether workspace state has any profile fields or a config file exists */
    hasLocalProfile(): boolean {
        if (this.hasConfigFile()) { return true; }
        const stored = this.workspaceState.get<Partial<SwiftFormatConfig>>('swiftFormatConfig');
        if (!stored) { return false; }
        return SwiftFormatProvider.PROFILE_FIELDS.some((key) => key in stored);
    }

    hasWorkspaceConfig(): boolean {
        return !!this.workspaceState.get('swiftFormatConfig');
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}
