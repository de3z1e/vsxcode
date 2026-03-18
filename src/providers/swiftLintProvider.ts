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
    analyzerRules: [],
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
    private analyzerDiagnosticCollection: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private resolvedPath: string | null = null;
    private resolvedVersion: string | null = null;
    private _pathResolved = false;
    private fixingFiles = new Set<string>();
    private cachedRules: SwiftLintRule[] | null = null;
    private analyzing = false;
    private _writingConfigFile = false;
    private latestVersion: string | null = null;

    private _onDidSyncConfig = new vscode.EventEmitter<void>();
    readonly onDidSyncConfig = this._onDidSyncConfig.event;

    constructor(
        private workspaceState: vscode.Memento,
        private globalState: vscode.Memento,
        private readonly log: (message: string) => void = () => {},
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('swiftlint');
        this.analyzerDiagnosticCollection = vscode.languages.createDiagnosticCollection('swiftlint-analyzer');

        this.disposables.push(
            this.diagnosticCollection,
            this.analyzerDiagnosticCollection,
            this._onDidSyncConfig,
            vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
            vscode.workspace.onDidOpenTextDocument((doc) => this.lintDocument(doc)),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.diagnosticCollection.delete(doc.uri);
            }),
        );

        const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (rootUri) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(rootUri, '.vscode/.swiftlint.yml'),
            );
            watcher.onDidChange(() => this.syncFromConfigFile());
            watcher.onDidCreate(() => this.syncFromConfigFile());
            this.disposables.push(watcher);
        }
    }

    // ── Config access ────────────────────────────────────────

    private static readonly PROFILE_FIELDS: (keyof SwiftLintConfig)[] = [
        'severity', 'fixOnSave', 'disabledRules', 'optInRules', 'analyzerRules', 'ruleConfigs',
    ];

    getProfileMode(): 'local' | 'global' {
        return this.workspaceState.get<'local' | 'global'>('swiftLintProfileMode', 'global');
    }

    isProfileModeExplicit(): boolean {
        return this.workspaceState.get('swiftLintProfileMode') !== undefined;
    }

    async setProfileMode(mode: 'local' | 'global'): Promise<void> {
        const prevMode = this.getProfileMode();
        if (mode === prevMode) { return; }

        if (mode === 'global' && !this.globalState.get('swiftLintGlobalProfile')) {
            // Initialize global profile with defaults
            const profile: Partial<SwiftLintConfig> = {};
            for (const key of SwiftLintProvider.PROFILE_FIELDS) {
                (profile as unknown as Record<string, unknown>)[key] = DEFAULT_CONFIG[key];
            }
            await this.globalState.update('swiftLintGlobalProfile', profile);
            this.log('[swiftlint] initialized global profile with defaults');
        }

        if (mode === 'local') {
            // Copy global settings as local starting point
            const global = this.globalState.get<Partial<SwiftLintConfig>>('swiftLintGlobalProfile');
            if (global) {
                const current = this.workspaceState.get<Partial<SwiftLintConfig>>('swiftLintConfig') || {};
                await this.workspaceState.update('swiftLintConfig', { ...current, ...global });
                this.log('[swiftlint] copied global profile to local settings');
            }
        }

        await this.workspaceState.update('swiftLintProfileMode', mode);
        this.log(`[swiftlint] profile mode: ${mode}`);
        await this.writeConfigFile();
        this.lintOpenDocuments();
    }

    hasConfigFile(): boolean {
        return fs.existsSync(this.getConfigFilePath());
    }

    getConfig(): SwiftLintConfig {
        const stored = this.workspaceState.get<Partial<SwiftLintConfig>>('swiftLintConfig');
        const base: SwiftLintConfig = {
            ...DEFAULT_CONFIG,
            ...stored,
            disabledRules: stored?.disabledRules || [],
            optInRules: stored?.optInRules || [],
            analyzerRules: stored?.analyzerRules || [],
            excludedPaths: stored?.excludedPaths || [],
            ruleConfigs: stored?.ruleConfigs || {},
        };

        if (this.getProfileMode() === 'global') {
            const global = this.globalState.get<Partial<SwiftLintConfig>>('swiftLintGlobalProfile');
            if (global) {
                for (const key of SwiftLintProvider.PROFILE_FIELDS) {
                    if (key in global) {
                        (base as unknown as Record<string, unknown>)[key] = global[key];
                    }
                }
                // Ensure arrays
                base.disabledRules = base.disabledRules || [];
                base.optInRules = base.optInRules || [];
                base.analyzerRules = base.analyzerRules || [];
                base.excludedPaths = base.excludedPaths || [];
                base.ruleConfigs = base.ruleConfigs || {};
            }
        }

        return base;
    }

    async updateConfig(patch: Partial<SwiftLintConfig>): Promise<void> {
        // Local-only fields always go to workspaceState
        const localPatch: Partial<SwiftLintConfig> = {};
        const profilePatch: Partial<SwiftLintConfig> = {};
        for (const [key, value] of Object.entries(patch)) {
            if (SwiftLintProvider.PROFILE_FIELDS.includes(key as keyof SwiftLintConfig)) {
                (profilePatch as Record<string, unknown>)[key] = value;
            } else {
                (localPatch as Record<string, unknown>)[key] = value;
            }
        }

        // Write local fields
        if (Object.keys(localPatch).length > 0) {
            const current = this.workspaceState.get<Partial<SwiftLintConfig>>('swiftLintConfig') || {};
            await this.workspaceState.update('swiftLintConfig', { ...current, ...localPatch });
        }

        // Write profile fields to the active storage
        if (Object.keys(profilePatch).length > 0) {
            if (this.getProfileMode() === 'global') {
                const current = this.globalState.get<Partial<SwiftLintConfig>>('swiftLintGlobalProfile') || {};
                await this.globalState.update('swiftLintGlobalProfile', { ...current, ...profilePatch });
            } else {
                const current = this.workspaceState.get<Partial<SwiftLintConfig>>('swiftLintConfig') || {};
                await this.workspaceState.update('swiftLintConfig', { ...current, ...profilePatch });
            }
        }

        if ('path' in patch) {
            this._pathResolved = false;
        }

        // Write config file when rule/exclusion/ruleConfig settings change
        if ('disabledRules' in patch || 'optInRules' in patch || 'analyzerRules' in patch || 'excludedPaths' in patch || 'ruleConfigs' in patch) {
            await this.writeConfigFile();
        }

        const updatedConfig = this.getConfig();
        if (!updatedConfig.enabled) {
            this.diagnosticCollection.clear();
            this.analyzerDiagnosticCollection.clear();
        } else {
            this.lintOpenDocuments();
        }

        if ('analyzerRules' in patch && updatedConfig.analyzerRules.length === 0) {
            this.analyzerDiagnosticCollection.clear();
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
            this.log(`[swiftlint] loaded ${this.cachedRules.length} rules (${analyzerCount} analyzer)`);
        } else {
            this.log('[swiftlint] binary not found');
        }

        this._pathResolved = true;
    }

    getResolvedPath(): string | null { return this.resolvedPath; }
    getResolvedVersion(): string | null { return this.resolvedVersion; }
    getLatestVersion(): string | null { return this.latestVersion; }
    isPathResolved(): boolean { return this._pathResolved; }

    private static readonly UPDATE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

    async checkForUpdate(force = false): Promise<void> {
        if (!this.resolvedVersion) { return; }

        if (!force) {
            const lastCheck = this.workspaceState.get<number>('swiftLintLastUpdateCheck', 0);
            const cached = this.workspaceState.get<string>('swiftLintLatestVersion');
            if (Date.now() - lastCheck < SwiftLintProvider.UPDATE_CHECK_COOLDOWN_MS && cached) {
                this.latestVersion = cached;
                return;
            }
        }

        this.log('[swiftlint] checking for updates...');
        try {
            const { stdout } = await execFile('curl', [
                '-sf', '--max-time', '5',
                'https://api.github.com/repos/realm/SwiftLint/releases/latest',
            ], { encoding: 'utf8', timeout: 10000 });
            const tag = JSON.parse(stdout).tag_name as string;
            this.latestVersion = tag.replace(/^v/, '') || null;
            await this.workspaceState.update('swiftLintLastUpdateCheck', Date.now());
            await this.workspaceState.update('swiftLintLatestVersion', this.latestVersion);
            if (this.isUpdateAvailable()) {
                this.log(`[swiftlint] update available: v${this.resolvedVersion} → v${this.latestVersion}`);
            } else {
                this.log(`[swiftlint] up to date (v${this.resolvedVersion})`);
            }
        } catch {
            this.latestVersion = null;
            this.log('[swiftlint] update check failed');
        }
    }

    isUpdateAvailable(): boolean {
        if (!this.resolvedVersion || !this.latestVersion) { return false; }
        return this.latestVersion !== this.resolvedVersion;
    }

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
            || config.analyzerRules.length > 0
            || config.excludedPaths.length > 0
            || Object.keys(config.ruleConfigs).length > 0;
    }

    private getConfigFilePath(): string {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return path.join(rootPath, '.vscode', '.swiftlint.yml');
    }

    async writeConfigFile(): Promise<void> {
        if (!this.hasConfigOverrides()) {
            // Remove stale config file when all overrides are cleared
            try { await fs.promises.unlink(this.getConfigFilePath()); } catch { /* already gone */ }
            return;
        }

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

        if (config.analyzerRules.length > 0) {
            lines.push('', 'analyzer_rules:');
            for (const rule of config.analyzerRules) {
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
        this._writingConfigFile = true;
        await fs.promises.writeFile(this.getConfigFilePath(), lines.join('\n'));
        setTimeout(() => { this._writingConfigFile = false; }, 500);
    }

    // ── Linting ──────────────────────────────────────────────

    private async onDocumentSaved(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'swift') { return; }
        if (document.uri.scheme !== 'file') { return; }

        const filePath = document.uri.fsPath;
        if (this.fixingFiles.has(filePath)) { return; }

        const config = this.getConfig();

        if (!this._pathResolved) {
            await this.resolvePathAndVersion();
        }
        if (!this.resolvedPath) { return; }

        // Fix on save runs independently of lint enabled state
        if (config.fixOnSave) {
            await this.fixDocument(document);
        }

        // Linting only runs when enabled
        if (config.enabled) {
            await this.lintDocument(document);
        }
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

    // ── Analyzer ────────────────────────────────────────────

    getEnabledAnalyzerRuleCount(): number {
        if (!this.cachedRules) { return 0; }
        const config = this.getConfig();
        return config.analyzerRules.length;
    }

    getTotalAnalyzerRuleCount(): number {
        if (!this.cachedRules) { return 0; }
        return this.cachedRules.filter((r) => r.analyzer).length;
    }

    async analyzeWorkspace(compilerLogPath: string): Promise<void> {
        if (!this.resolvedPath) { return; }

        const config = this.getConfig();
        if (!config.enabled) { return; }
        if (config.analyzerRules.length === 0) { return; }
        if (!fs.existsSync(compilerLogPath)) { return; }
        if (this.analyzing) { return; }

        // Determine which log to use — incremental builds have no swiftc invocations
        const fullLogPath = compilerLogPath.replace(/\.log$/, '_full.log');
        let effectiveLogPath = compilerLogPath;
        try {
            const logContent = await fs.promises.readFile(compilerLogPath, 'utf8');
            if (logContent.includes('swiftc')) {
                await fs.promises.copyFile(compilerLogPath, fullLogPath);
            } else if (fs.existsSync(fullLogPath)) {
                effectiveLogPath = fullLogPath;
            } else {
                this.log('[swiftlint] analyzer skipped: no compiler invocations in build log (need a full build)');
                return;
            }
        } catch {
            return;
        }

        this.analyzing = true;
        this.log('[swiftlint] running analyzer...');

        try {
            const args = ['analyze', '--reporter', 'json', '--quiet', '--compiler-log-path', effectiveLogPath];
            if (this.hasConfigOverrides()) {
                args.push('--config', this.getConfigFilePath());
            }

            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) { return; }

            let stdout: string;
            try {
                const result = await execFile(this.resolvedPath, args, { encoding: 'utf8', cwd, timeout: 120000 });
                stdout = result.stdout;
            } catch (error: unknown) {
                const execError = error as { stdout?: string };
                if (execError.stdout) {
                    stdout = execError.stdout;
                } else {
                    throw error;
                }
            }

            if (!stdout.trim()) {
                this.analyzerDiagnosticCollection.clear();
                return;
            }

            const violations: SwiftLintViolation[] = JSON.parse(stdout);
            const grouped = new Map<string, vscode.Diagnostic[]>();

            for (const v of violations) {
                const line = Math.max(0, v.line - 1);
                const char = Math.max(0, (v.character || 1) - 1);
                const range = new vscode.Range(line, char, line, Number.MAX_SAFE_INTEGER);
                const severity = v.severity === 'Error'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning;
                const diagnostic = new vscode.Diagnostic(range, v.reason, severity);
                diagnostic.source = 'SwiftLint (Analyzer)';
                diagnostic.code = v.rule_id;

                const fileDiags = grouped.get(v.file) || [];
                fileDiags.push(diagnostic);
                grouped.set(v.file, fileDiags);
            }

            this.analyzerDiagnosticCollection.clear();
            for (const [file, diags] of grouped) {
                this.analyzerDiagnosticCollection.set(vscode.Uri.file(file), diags);
            }

            this.log(`[swiftlint] analyzer complete (${violations.length} violation${violations.length === 1 ? '' : 's'})`);
        } catch (error) {
            this.log(`[swiftlint] analyzer failed: ${error}`);
        } finally {
            this.analyzing = false;
        }
    }

    // ── Config file sync (external edits) ─────────────────────

    private static readonly KNOWN_SECTIONS = new Set(['disabled_rules', 'opt_in_rules', 'analyzer_rules', 'excluded']);

    private parseConfigFileContent(content: string): Pick<SwiftLintConfig, 'disabledRules' | 'optInRules' | 'analyzerRules' | 'excludedPaths' | 'ruleConfigs'> {
        const disabledRules: string[] = [];
        const optInRules: string[] = [];
        const analyzerRules: string[] = [];
        const excludedPaths: string[] = [];
        const ruleConfigs: Record<string, Record<string, string>> = {};
        let currentSection: string | null = null;

        for (const line of content.split('\n')) {
            if (line.startsWith('#') || line.trim() === '') { continue; }

            const sectionMatch = /^([a-z_][a-z_0-9]*):\s*$/.exec(line);
            if (sectionMatch) {
                currentSection = sectionMatch[1];
                continue;
            }
            if (!currentSection) { continue; }

            const listMatch = /^\s+-\s+(.+)$/.exec(line);
            if (listMatch && SwiftLintProvider.KNOWN_SECTIONS.has(currentSection)) {
                const value = listMatch[1].trim();
                switch (currentSection) {
                    case 'disabled_rules': disabledRules.push(value); break;
                    case 'opt_in_rules': optInRules.push(value); break;
                    case 'analyzer_rules': analyzerRules.push(value); break;
                    case 'excluded': excludedPaths.push(value); break;
                }
                continue;
            }

            const mapMatch = /^\s+(\w+):\s+(.+)$/.exec(line);
            if (mapMatch && !SwiftLintProvider.KNOWN_SECTIONS.has(currentSection)) {
                if (!ruleConfigs[currentSection]) { ruleConfigs[currentSection] = {}; }
                ruleConfigs[currentSection][mapMatch[1]] = mapMatch[2].trim();
            }
        }

        return { disabledRules, optInRules, analyzerRules, excludedPaths, ruleConfigs };
    }

    async syncFromConfigFile(): Promise<void> {
        if (this._writingConfigFile) { return; }

        try {
            const content = await fs.promises.readFile(this.getConfigFilePath(), 'utf8');
            const parsed = this.parseConfigFileContent(content);
            const current = this.getConfig();

            const same = JSON.stringify(current.disabledRules) === JSON.stringify(parsed.disabledRules)
                && JSON.stringify(current.optInRules) === JSON.stringify(parsed.optInRules)
                && JSON.stringify(current.analyzerRules) === JSON.stringify(parsed.analyzerRules)
                && JSON.stringify(current.excludedPaths) === JSON.stringify(parsed.excludedPaths)
                && JSON.stringify(current.ruleConfigs) === JSON.stringify(parsed.ruleConfigs);
            if (same) { return; }

            await this.workspaceState.update('swiftLintConfig', { ...current, ...parsed });
            this.log('[swiftlint] config synced from .swiftlint.yml');
            this.lintOpenDocuments();
            this._onDidSyncConfig.fire();
        } catch { /* file may not exist or be invalid */ }
    }

    // ── Global profile ────────────────────────────────────────

    hasGlobalProfile(): boolean {
        return !!this.globalState.get('swiftLintGlobalProfile');
    }

    hasWorkspaceConfig(): boolean {
        return !!this.workspaceState.get('swiftLintConfig');
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}
