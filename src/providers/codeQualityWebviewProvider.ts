import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { SwiftFormatConfig, SwiftFormatRule, SwiftLintConfig, SwiftLintRule } from '../types/interfaces';
import { SwiftFormatProvider } from './swiftFormatProvider';
import { SwiftLintProvider, fetchRuleDefaultConfig, type RuleDefaultConfig } from './swiftLintProvider';
import { buildUnifiedRules, OVERLAP_PAIRS, CATEGORY_ORDER, CATEGORY_LABELS, getSettingsOverlaps, humanReadableName, SF_FORMAT_RULES, type UnifiedRule, type UnifiedCategory, type SettingsOverlap } from '../types/ruleMapping';

const execFile = promisify(execFileCallback);

interface WebviewState {
    // swift-format
    sfPathResolved: boolean;
    sfResolvedPath: string | null;
    sfVersion: string | null;
    sfUpdateAvailable: boolean;
    sfLatestVersion: string | null;
    sfInstalling: boolean;
    sfUpdating: boolean;
    // SwiftLint
    slPathResolved: boolean;
    slResolvedPath: string | null;
    slVersion: string | null;
    slUpdateAvailable: boolean;
    slLatestVersion: string | null;
    slInstalling: boolean;
    slUpdating: boolean;
    // Shared
    brewAvailable: boolean;
    profileMode: 'local' | 'global';
    // Configs
    sfConfig: SwiftFormatConfig;
    slConfig: SwiftLintConfig;
    // Rules
    unifiedRules: UnifiedRule[];
    analyzerRules: Array<SwiftLintRule & { enabled: boolean; hasConfig: boolean }> | null;
    // Overlaps
    settingsOverlaps: SettingsOverlap[];
    activeOverlapCount: number;
    // Excluded paths
    excludedPaths: string[];
}

export class CodeQualityWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private ruleDefaultsCache = new Map<string, RuleDefaultConfig>();
    private sfInstalling = false;
    private sfUpdating = false;
    private slInstalling = false;
    private slUpdating = false;
    private brewAvailable: boolean | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly swiftFormatProvider: SwiftFormatProvider,
        private readonly swiftLintProvider: SwiftLintProvider,
        private readonly workspaceState: vscode.Memento,
        private readonly log: (message: string) => void,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
        webviewView.onDidDispose(() => { this._view = undefined; });
    }

    refresh(): void {
        this.postState();
    }

    // ── State ────────────────────────────────────────────────

    private getState(): WebviewState {
        const sfConfig = this.swiftFormatProvider.getConfig();
        const slConfig = this.swiftLintProvider.getConfig();
        const sfRules = this.swiftFormatProvider.getRules();
        const slRules = this.swiftLintProvider.getRules();
        const overlapPrefs = this.workspaceState.get<Record<string, 'swift-format' | 'swiftlint' | 'both'>>('codeQualityOverlapPrefs') || {};

        const unifiedRules = buildUnifiedRules(sfRules, sfConfig, slRules, slConfig, overlapPrefs);

        // Analyzer rules (separate from unified)
        let analyzerRules: WebviewState['analyzerRules'] = null;
        if (slRules) {
            const aRules = slRules.filter((r) => r.analyzer);
            analyzerRules = aRules.map((r) => {
                const enabled = slConfig.analyzerRules.includes(r.identifier);
                const hasConfig = !!slConfig.ruleConfigs[r.identifier] || this.ruleDefaultsCache.has(r.identifier);
                return { ...r, enabled, hasConfig };
            });
        }

        // Settings overlaps
        const settingsOverlaps = getSettingsOverlaps(sfConfig, slConfig, slRules);

        // Active overlap count: overlaps where both tools have the rule enabled
        let activeOverlapCount = 0;
        for (const rule of unifiedRules) {
            if (rule.tool === 'overlap' && rule.sfRule && rule.slRule) {
                if (rule.sfRule.effectiveEnabled && rule.slRule.enabled) {
                    activeOverlapCount++;
                }
            }
        }

        // Profile mode (read from swift-format provider — both should be in sync)
        const profileMode = this.swiftFormatProvider.getProfileMode();

        return {
            sfPathResolved: this.swiftFormatProvider.isPathResolved(),
            sfResolvedPath: this.swiftFormatProvider.getResolvedPath(),
            sfVersion: this.swiftFormatProvider.getResolvedVersion(),
            sfUpdateAvailable: this.swiftFormatProvider.isUpdateAvailable(),
            sfLatestVersion: this.swiftFormatProvider.getLatestVersion(),
            sfInstalling: this.sfInstalling,
            sfUpdating: this.sfUpdating,
            slPathResolved: this.swiftLintProvider.isPathResolved(),
            slResolvedPath: this.swiftLintProvider.getResolvedPath(),
            slVersion: this.swiftLintProvider.getResolvedVersion(),
            slUpdateAvailable: this.swiftLintProvider.isUpdateAvailable(),
            slLatestVersion: this.swiftLintProvider.getLatestVersion(),
            slInstalling: this.slInstalling,
            slUpdating: this.slUpdating,
            brewAvailable: this.brewAvailable ?? false,
            profileMode,
            sfConfig,
            slConfig,
            unifiedRules,
            analyzerRules,
            settingsOverlaps,
            activeOverlapCount,
            excludedPaths: slConfig.excludedPaths,
        };
    }

    private postState(): void {
        this._view?.webview.postMessage({ type: 'setState', state: this.getState() });
    }

    // ── Messages ─────────────────────────────────────────────

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        try { await this._handleMessage(msg); } catch (e) {
            this.log(`[code-quality] error handling message '${msg.type}': ${e}`);
        }
    }

    private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.log('[code-quality] webview ready');
                this.postState();
                if (this.brewAvailable === null) {
                    try { this.brewAvailable = await this.checkBrewAvailable(); } catch { this.brewAvailable = false; }
                    this.log(`[code-quality] brew available: ${this.brewAvailable}`);
                    this.postState();
                }
                break;

            // ── swift-format install/update ──────────────────

            case 'installSwiftFormat': {
                this.log('[code-quality] installing swift-format via Homebrew');
                this.sfInstalling = true;
                this.postState();

                const brewPath = await this.findBrew();
                if (!brewPath) {
                    vscode.window.showErrorMessage('Homebrew not found. Install it from https://brew.sh');
                    this.sfInstalling = false;
                    this.postState();
                    break;
                }

                try {
                    await execFile(brewPath, ['install', 'swift-format'], { encoding: 'utf8', timeout: 300000 });
                    await this.swiftFormatProvider.resolvePathAndVersion();
                    this.log(`[code-quality] swift-format installed: ${this.swiftFormatProvider.getResolvedPath()}`);
                    vscode.window.showInformationMessage('swift-format installed successfully.');
                } catch (error: unknown) {
                    const message = (error as { stderr?: string }).stderr || 'Installation failed';
                    this.log(`[code-quality] swift-format install failed: ${message}`);
                    vscode.window.showErrorMessage(`swift-format install failed: ${message.split('\n')[0]}`);
                }

                this.sfInstalling = false;
                this.postState();
                break;
            }

            case 'updateSwiftFormat': {
                this.log('[code-quality] updating swift-format via Homebrew');
                this.sfUpdating = true;
                this.postState();

                const updateBrewPath = await this.findBrew();
                if (!updateBrewPath) {
                    vscode.window.showErrorMessage('Homebrew not found. Update manually.');
                    this.sfUpdating = false;
                    this.postState();
                    break;
                }

                try {
                    await execFile(updateBrewPath, ['upgrade', 'swift-format'], { encoding: 'utf8', timeout: 300000 });
                    await this.swiftFormatProvider.resolvePathAndVersion();
                    await this.swiftFormatProvider.checkForUpdate(true);
                    this.log(`[code-quality] swift-format updated to v${this.swiftFormatProvider.getResolvedVersion()}`);
                    vscode.window.showInformationMessage(`swift-format updated to v${this.swiftFormatProvider.getResolvedVersion()}.`);
                } catch (error: unknown) {
                    const message = (error as { stderr?: string }).stderr || 'Update failed';
                    this.log(`[code-quality] swift-format update failed: ${message}`);
                    vscode.window.showErrorMessage(`swift-format update failed: ${message.split('\n')[0]}`);
                }

                this.sfUpdating = false;
                this.postState();
                break;
            }

            // ── SwiftLint install/update ─────────────────────

            case 'installSwiftLint': {
                this.log('[code-quality] installing SwiftLint via Homebrew');
                this.slInstalling = true;
                this.postState();

                const brewPath = await this.findBrew();
                if (!brewPath) {
                    vscode.window.showErrorMessage('Homebrew not found. Install it from https://brew.sh');
                    this.slInstalling = false;
                    this.postState();
                    break;
                }

                try {
                    await execFile(brewPath, ['install', 'swiftlint'], { encoding: 'utf8', timeout: 300000 });
                    await this.swiftLintProvider.resolvePathAndVersion();
                    this.log(`[code-quality] SwiftLint installed: ${this.swiftLintProvider.getResolvedPath()}`);
                    vscode.window.showInformationMessage('SwiftLint installed successfully.');
                } catch (error: unknown) {
                    const message = (error as { stderr?: string }).stderr || 'Installation failed';
                    this.log(`[code-quality] SwiftLint install failed: ${message}`);
                    vscode.window.showErrorMessage(`SwiftLint install failed: ${message.split('\n')[0]}`);
                }

                this.slInstalling = false;
                this.postState();
                break;
            }

            case 'updateSwiftLint': {
                this.log('[code-quality] updating SwiftLint via Homebrew');
                this.slUpdating = true;
                this.postState();

                const updateBrewPath = await this.findBrew();
                if (!updateBrewPath) {
                    vscode.window.showErrorMessage('Homebrew not found. Update manually.');
                    this.slUpdating = false;
                    this.postState();
                    break;
                }

                try {
                    await execFile(updateBrewPath, ['upgrade', 'swiftlint'], { encoding: 'utf8', timeout: 300000 });
                    await this.swiftLintProvider.resolvePathAndVersion();
                    await this.swiftLintProvider.checkForUpdate(true);
                    this.log(`[code-quality] SwiftLint updated to v${this.swiftLintProvider.getResolvedVersion()}`);
                    vscode.window.showInformationMessage(`SwiftLint updated to v${this.swiftLintProvider.getResolvedVersion()}.`);
                } catch (error: unknown) {
                    const message = (error as { stderr?: string }).stderr || 'Update failed';
                    this.log(`[code-quality] SwiftLint update failed: ${message}`);
                    vscode.window.showErrorMessage(`SwiftLint update failed: ${message.split('\n')[0]}`);
                }

                this.slUpdating = false;
                this.postState();
                break;
            }

            // ── GitHub links ─────────────────────────────────

            case 'openSwiftFormatGithub':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/apple/swift-format'));
                break;

            case 'openSwiftLintGithub':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/realm/SwiftLint'));
                break;

            // ── Toggle controls ──────────────────────────────

            case 'toggleFormatterEnabled':
                await this.swiftFormatProvider.updateConfig({ enabled: msg.value as boolean });
                this.postState();
                break;

            case 'toggleLinterEnabled':
                await this.swiftLintProvider.updateConfig({ enabled: msg.value as boolean });
                this.postState();
                break;

            case 'toggleFormatOnSave':
                await this.swiftFormatProvider.updateConfig({ formatOnSave: msg.value as boolean });
                this.postState();
                break;

            case 'toggleLintMode':
                await this.swiftFormatProvider.updateConfig({ lintMode: msg.value as boolean });
                this.postState();
                break;

            case 'toggleFixOnSave':
                await this.swiftLintProvider.updateConfig({ fixOnSave: msg.value as boolean });
                this.postState();
                break;

            case 'changeSeverity':
                await this.swiftLintProvider.updateConfig({ severity: msg.value as SwiftLintConfig['severity'] });
                this.postState();
                break;

            // ── Formatting options ───────────────────────────

            case 'updateOption': {
                const key = msg.key as string;
                const value = msg.value;
                await this.swiftFormatProvider.updateConfig({ [key]: value } as Partial<SwiftFormatConfig>);
                this.postState();
                break;
            }

            case 'resetOptions': {
                const answer = await vscode.window.showWarningMessage(
                    'Reset all formatting options to defaults?',
                    { modal: true },
                    'Reset',
                );
                if (answer === 'Reset') {
                    await this.swiftFormatProvider.updateConfig({
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
                    });
                    this.postState();
                }
                break;
            }

            // ── Rule toggles ─────────────────────────────────

            case 'toggleSfRule': {
                const ruleId = msg.ruleId as string;
                const enabled = msg.enabled as boolean;
                const config = this.swiftFormatProvider.getConfig();
                const rules = this.swiftFormatProvider.getRules() || [];
                const rule = rules.find((r) => r.identifier === ruleId);
                if (!rule) { break; }

                const disabledRules = config.disabledRules.filter((r) => r !== ruleId);
                const enabledRules = config.enabledRules.filter((r) => r !== ruleId);

                if (rule.isDefault && !enabled) { disabledRules.push(ruleId); }
                if (!rule.isDefault && enabled) { enabledRules.push(ruleId); }

                await this.swiftFormatProvider.updateConfig({ disabledRules, enabledRules });
                this.postState();
                break;
            }

            case 'toggleSlRule': {
                const ruleId = msg.ruleId as string;
                const enabled = msg.enabled as boolean;
                const config = this.swiftLintProvider.getConfig();
                const rules = this.swiftLintProvider.getRules() || [];
                const rule = rules.find((r) => r.identifier === ruleId);
                if (!rule) { break; }

                const disabledRules = config.disabledRules.filter((r) => r !== ruleId);
                const optInRules = config.optInRules.filter((r) => r !== ruleId);

                if (!rule.optIn && !enabled) { disabledRules.push(ruleId); }
                if (rule.optIn && enabled) { optInRules.push(ruleId); }

                await this.swiftLintProvider.updateConfig({ disabledRules, optInRules });
                this.postState();
                break;
            }

            case 'toggleAnalyzerRule': {
                const ruleId = msg.ruleId as string;
                const enabled = msg.enabled as boolean;
                const config = this.swiftLintProvider.getConfig();
                const analyzerRules = config.analyzerRules.filter((r) => r !== ruleId);
                if (enabled) { analyzerRules.push(ruleId); }
                await this.swiftLintProvider.updateConfig({ analyzerRules });
                this.postState();
                break;
            }

            // ── Rule config (SwiftLint per-rule) ─────────────

            case 'fetchRuleConfig': {
                const ruleId = msg.ruleId as string;
                const resolvedPath = this.swiftLintProvider.getResolvedPath();
                if (!resolvedPath) { break; }

                let cached = this.ruleDefaultsCache.get(ruleId);
                if (!cached) {
                    cached = await fetchRuleDefaultConfig(resolvedPath, ruleId);
                    if (Object.keys(cached.config).length > 0) {
                        this.ruleDefaultsCache.set(ruleId, cached);
                    }
                }

                const config = this.swiftLintProvider.getConfig();
                const current = config.ruleConfigs[ruleId] || null;

                this._view?.webview.postMessage({
                    type: 'ruleConfigData',
                    ruleId,
                    defaults: cached.config,
                    current,
                    description: cached.description,
                });
                break;
            }

            case 'updateRuleConfig': {
                const ruleId = msg.ruleId as string;
                const newConfig = msg.config as Record<string, string>;
                const config = this.swiftLintProvider.getConfig();
                const defaults = this.ruleDefaultsCache.get(ruleId)?.config || {};

                const ruleConfigs = { ...config.ruleConfigs };
                const isDefault = Object.keys(newConfig).length === Object.keys(defaults).length
                    && Object.entries(newConfig).every(([k, v]) => defaults[k] === v);

                if (isDefault || Object.keys(newConfig).length === 0) {
                    delete ruleConfigs[ruleId];
                } else {
                    ruleConfigs[ruleId] = newConfig;
                }

                await this.swiftLintProvider.updateConfig({ ruleConfigs });
                this._view?.webview.postMessage({
                    type: 'ruleConfigUpdated',
                    ruleId,
                    hasCustomConfig: ruleId in (this.swiftLintProvider.getConfig().ruleConfigs),
                });
                break;
            }

            // ── Reset rules ──────────────────────────────────

            case 'resetAllRules': {
                const answer = await vscode.window.showWarningMessage(
                    'Reset all swift-format and SwiftLint rules to defaults?',
                    { modal: true },
                    'Reset',
                );
                if (answer === 'Reset') {
                    await this.swiftFormatProvider.updateConfig({ disabledRules: [], enabledRules: [] });
                    await this.swiftLintProvider.updateConfig({
                        disabledRules: [],
                        optInRules: [],
                        analyzerRules: [],
                        ruleConfigs: {},
                    });
                    this.ruleDefaultsCache.clear();
                    await this.workspaceState.update('codeQualityOverlapPrefs', {});
                    this.postState();
                }
                break;
            }

            // ── Profile mode ─────────────────────────────────

            case 'changeProfileMode': {
                const newMode = msg.value as 'local' | 'global';
                if (newMode === 'global') {
                    const sfConfig = this.swiftFormatProvider.getConfig();
                    const slConfig = this.swiftLintProvider.getConfig();
                    const hasLocalChanges = sfConfig.disabledRules.length > 0
                        || sfConfig.enabledRules.length > 0
                        || slConfig.disabledRules.length > 0
                        || slConfig.optInRules.length > 0
                        || slConfig.analyzerRules.length > 0
                        || Object.keys(slConfig.ruleConfigs).length > 0;
                    if (hasLocalChanges) {
                        const answer = await vscode.window.showWarningMessage(
                            'Switch to global profile? This project\'s local rule customizations will be replaced by the global profile.',
                            { modal: true },
                            'Switch to Global',
                        );
                        if (answer !== 'Switch to Global') {
                            this.postState();
                            break;
                        }
                    }
                }
                await this.swiftFormatProvider.setProfileMode(newMode);
                await this.swiftLintProvider.setProfileMode(newMode);
                this.postState();
                break;
            }

            // ── Binary path changes ──────────────────────────

            case 'changeFormatterPath': {
                const config = this.swiftFormatProvider.getConfig();
                const resolvedPath = this.swiftFormatProvider.getResolvedPath();

                type PathPick = vscode.QuickPickItem & { action: 'auto' | 'custom' | 'browse' };
                const picks: PathPick[] = [];
                if (config.path) {
                    picks.push({ label: '$(refresh) Reset to Auto-Detect', description: resolvedPath || undefined, action: 'auto' });
                }
                picks.push(
                    { label: '$(edit) Enter Custom Path\u2026', action: 'custom' },
                    { label: '$(folder-opened) Browse\u2026', action: 'browse' },
                );

                const pick = await vscode.window.showQuickPick(picks, { placeHolder: resolvedPath || 'swift-format not found' });
                if (!pick) { break; }

                switch (pick.action) {
                    case 'auto':
                        await this.swiftFormatProvider.updateConfig({ path: '' });
                        await this.swiftFormatProvider.resolvePathAndVersion();
                        break;
                    case 'custom': {
                        const input = await vscode.window.showInputBox({ prompt: 'Enter path to swift-format binary', value: resolvedPath || '/opt/homebrew/bin/swift-format' });
                        if (input !== undefined) { await this.swiftFormatProvider.updateConfig({ path: input }); await this.swiftFormatProvider.resolvePathAndVersion(); }
                        break;
                    }
                    case 'browse': {
                        const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select swift-format Binary' });
                        if (uris && uris.length > 0) { await this.swiftFormatProvider.updateConfig({ path: uris[0].fsPath }); await this.swiftFormatProvider.resolvePathAndVersion(); }
                        break;
                    }
                }
                this.postState();
                break;
            }

            case 'changeLinterPath': {
                const config = this.swiftLintProvider.getConfig();
                const resolvedPath = this.swiftLintProvider.getResolvedPath();

                type PathPick = vscode.QuickPickItem & { action: 'auto' | 'custom' | 'browse' };
                const picks: PathPick[] = [];
                if (config.path) {
                    picks.push({ label: '$(refresh) Reset to Auto-Detect', description: resolvedPath || undefined, action: 'auto' });
                }
                picks.push(
                    { label: '$(edit) Enter Custom Path\u2026', action: 'custom' },
                    { label: '$(folder-opened) Browse\u2026', action: 'browse' },
                );

                const pick = await vscode.window.showQuickPick(picks, { placeHolder: resolvedPath || 'SwiftLint not found' });
                if (!pick) { break; }

                switch (pick.action) {
                    case 'auto':
                        await this.swiftLintProvider.updateConfig({ path: '' });
                        await this.swiftLintProvider.resolvePathAndVersion();
                        break;
                    case 'custom': {
                        const input = await vscode.window.showInputBox({ prompt: 'Enter path to swiftlint binary', value: resolvedPath || '/opt/homebrew/bin/swiftlint' });
                        if (input !== undefined) { await this.swiftLintProvider.updateConfig({ path: input }); await this.swiftLintProvider.resolvePathAndVersion(); }
                        break;
                    }
                    case 'browse': {
                        const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select SwiftLint Binary' });
                        if (uris && uris.length > 0) { await this.swiftLintProvider.updateConfig({ path: uris[0].fsPath }); await this.swiftLintProvider.resolvePathAndVersion(); }
                        break;
                    }
                }
                this.postState();
                break;
            }

            // ── Excluded paths ───────────────────────────────

            case 'addExcludedPath': {
                const input = await vscode.window.showInputBox({ prompt: 'Enter path to exclude (relative to workspace root)', placeHolder: 'Pods/' });
                if (input) {
                    const config = this.swiftLintProvider.getConfig();
                    await this.swiftLintProvider.updateConfig({ excludedPaths: [...config.excludedPaths, input] });
                    this.postState();
                }
                break;
            }

            case 'addExcludedFolder': {
                const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true, title: 'Select Folders to Exclude' });
                if (uris && uris.length > 0) {
                    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    const newPaths = uris.map((u) => rootPath ? path.relative(rootPath, u.fsPath) : u.fsPath);
                    const config = this.swiftLintProvider.getConfig();
                    await this.swiftLintProvider.updateConfig({ excludedPaths: [...config.excludedPaths, ...newPaths] });
                    this.postState();
                }
                break;
            }

            case 'removeExcludedPath': {
                const config = this.swiftLintProvider.getConfig();
                await this.swiftLintProvider.updateConfig({ excludedPaths: config.excludedPaths.filter((p) => p !== msg.path) });
                this.postState();
                break;
            }

            // ── Overlap handling ─────────────────────────────

            case 'changeOverlapHandler': {
                const sfRule = msg.sfRule as string;
                const handler = msg.handler as 'swift-format' | 'swiftlint' | 'both';
                const prefs = this.workspaceState.get<Record<string, string>>('codeQualityOverlapPrefs') || {};
                prefs[sfRule] = handler;
                await this.workspaceState.update('codeQualityOverlapPrefs', prefs);

                // Find the overlap pair to get the SL rule ID(s)
                const pair = OVERLAP_PAIRS.find((p) => p.sfRule === sfRule);
                if (pair) {
                    const slRuleIds = Array.isArray(pair.slRule) ? pair.slRule : [pair.slRule];

                    if (handler === 'swift-format') {
                        // Ensure SF rule is enabled
                        await this.ensureSfRuleEnabled(sfRule, true);
                        // Disable SL rule(s)
                        for (const slId of slRuleIds) {
                            await this.ensureSlRuleEnabled(slId, false);
                        }
                    } else if (handler === 'swiftlint') {
                        // Disable SF rule
                        await this.ensureSfRuleEnabled(sfRule, false);
                        // Ensure SL rule(s) enabled
                        for (const slId of slRuleIds) {
                            await this.ensureSlRuleEnabled(slId, true);
                        }
                    } else {
                        // 'both' — enable both sides
                        await this.ensureSfRuleEnabled(sfRule, true);
                        for (const slId of slRuleIds) {
                            await this.ensureSlRuleEnabled(slId, true);
                        }
                    }
                }

                this.postState();
                break;
            }

            case 'autoResolveOverlaps': {
                const prefs = this.workspaceState.get<Record<string, string>>('codeQualityOverlapPrefs') || {};

                for (const pair of OVERLAP_PAIRS) {
                    const handler = pair.defaultHandler;
                    prefs[pair.sfRule] = handler;
                    const slRuleIds = Array.isArray(pair.slRule) ? pair.slRule : [pair.slRule];

                    if (handler === 'swift-format') {
                        await this.ensureSfRuleEnabled(pair.sfRule, true);
                        for (const slId of slRuleIds) {
                            await this.ensureSlRuleEnabled(slId, false);
                        }
                    } else {
                        await this.ensureSfRuleEnabled(pair.sfRule, false);
                        for (const slId of slRuleIds) {
                            await this.ensureSlRuleEnabled(slId, true);
                        }
                    }
                }

                await this.workspaceState.update('codeQualityOverlapPrefs', prefs);
                this.postState();
                const count = OVERLAP_PAIRS.length;
                vscode.window.showInformationMessage(`Auto-resolved ${count} overlap${count === 1 ? '' : 's'} using recommended defaults.`);
                break;
            }
        }
    }

    // ── Rule enable/disable helpers ──────────────────────────

    private async ensureSfRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
        const config = this.swiftFormatProvider.getConfig();
        const rules = this.swiftFormatProvider.getRules() || [];
        const rule = rules.find((r) => r.identifier === ruleId);
        if (!rule) { return; }

        const disabledRules = config.disabledRules.filter((r) => r !== ruleId);
        const enabledRules = config.enabledRules.filter((r) => r !== ruleId);

        if (enabled) {
            // To enable: if default-on, just remove from disabled; if opt-in, add to enabled
            if (!rule.isDefault) { enabledRules.push(ruleId); }
        } else {
            // To disable: if default-on, add to disabled; if opt-in, just remove from enabled
            if (rule.isDefault) { disabledRules.push(ruleId); }
        }

        await this.swiftFormatProvider.updateConfig({ disabledRules, enabledRules });
    }

    private async ensureSlRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
        const config = this.swiftLintProvider.getConfig();
        const rules = this.swiftLintProvider.getRules() || [];
        const rule = rules.find((r) => r.identifier === ruleId);
        if (!rule) { return; }

        const disabledRules = config.disabledRules.filter((r) => r !== ruleId);
        const optInRules = config.optInRules.filter((r) => r !== ruleId);

        if (enabled) {
            // To enable: if opt-in, add to optInRules; if default, just remove from disabled
            if (rule.optIn) { optInRules.push(ruleId); }
        } else {
            // To disable: if default-on, add to disabled; if opt-in, just remove from optIn
            if (!rule.optIn) { disabledRules.push(ruleId); }
        }

        await this.swiftLintProvider.updateConfig({ disabledRules, optInRules });
    }

    // ── Brew helpers ────────────────────────────────────────

    private async findBrew(): Promise<string | null> {
        const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
        for (const candidate of candidates) {
            try {
                await execFile(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
                return candidate;
            } catch { /* try next */ }
        }
        return null;
    }

    private async checkBrewAvailable(): Promise<boolean> {
        return (await this.findBrew()) !== null;
    }

    // ── HTML ─────────────────────────────────────────────────

    private getHtml(_webview: vscode.Webview): string {
        const nonce = getNonce();
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;">
<style nonce="${nonce}">
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0}
.section{padding:10px 14px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}
.row{display:flex;align-items:center;justify-content:space-between;min-height:28px}
.row+.row{margin-top:6px}
.label{opacity:.85;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.value{cursor:pointer;opacity:.7;font-size:12px}
.value:hover{opacity:1}
.gh-link{display:inline-flex;align-items:center;opacity:.35;cursor:pointer;margin-left:6px;vertical-align:middle}
.gh-link:hover{opacity:.8}
.gh-link svg{width:14px;height:14px;fill:var(--vscode-foreground)}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:3px;padding:2px 6px;font-size:12px;outline:none;cursor:pointer}
input[type="number"]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:3px;padding:2px 6px;font-size:12px;outline:none;width:50px;text-align:right;-moz-appearance:textfield}
input[type="number"]::-webkit-outer-spin-button,input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
input[type="number"]:focus{border-color:var(--vscode-focusBorder)}
.switch{position:relative;width:34px;height:18px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:9px;cursor:pointer;transition:background .2s}
.slider::before{content:'';position:absolute;height:12px;width:12px;left:2px;top:2px;background:var(--vscode-foreground);border-radius:50%;transition:transform .2s;opacity:.5}
.switch input:checked+.slider{background:var(--vscode-button-background)}
.switch input:checked+.slider::before{transform:translateX(16px);opacity:1}
.rules-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 6px}
.rules-header .label{flex:1}
.badge{font-size:11px;opacity:.6}
.search-wrap{position:relative;margin:0 14px 8px}
.search{display:block;width:100%;padding:4px 24px 4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:3px;font-size:12px;outline:none;box-sizing:border-box}
.search:focus{border-color:var(--vscode-focusBorder)}
.search-clear{position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:2px;line-height:1;display:none;color:var(--vscode-foreground);opacity:.4}
.search-clear:hover{opacity:1}
.search-clear svg{width:12px;height:12px;fill:var(--vscode-foreground)}
.search-wrap.has-value .search-clear{display:block}
.group-header{padding:4px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.5;background:var(--vscode-sideBar-background,transparent);cursor:pointer;display:flex;align-items:center;gap:4px;user-select:none}
.group-header:hover{opacity:.8}
.group-chevron{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;transition:transform .15s}
.group-chevron svg{width:10px;height:10px;fill:var(--vscode-foreground)}
.group-header.collapsed .group-chevron{transform:rotate(-90deg)}
.group-body.collapsed{display:none}
.rule-row{display:flex;align-items:center;padding:3px 14px;gap:8px;min-height:26px;cursor:pointer}
.rule-row:hover{background:var(--vscode-list-hoverBackground)}
.rule-row .switch{width:28px;height:15px}
.rule-row .slider::before{height:9px;width:9px;left:2px;top:2px}
.rule-row .switch input:checked+.slider::before{transform:translateX(13px)}
.rule-name{flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:none}
.rule-tags{font-size:10px;opacity:.45;white-space:nowrap;pointer-events:none;user-select:none}
.rule-modified{width:6px;height:6px;border-radius:50%;background:var(--vscode-button-background);flex-shrink:0;margin-left:2px}
.opt-modified{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--vscode-button-background);margin-left:6px;vertical-align:middle}
.info-wrap{position:relative;display:inline-flex;align-items:center;vertical-align:middle}
.info-btn{background:none;border:none;cursor:pointer;opacity:.3;padding:0;margin-left:6px;line-height:1;display:inline-flex;align-items:center;vertical-align:middle}
.info-btn:hover{opacity:.7}
.info-btn svg{width:12px;height:12px;fill:var(--vscode-foreground)}
.info-tip{display:none;position:absolute;left:0;top:calc(100% + 4px);background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border,rgba(128,128,128,.4)));border-radius:4px;padding:6px 8px;font-size:11px;line-height:1.4;white-space:normal;width:200px;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.info-wrap.open .info-tip{display:block}
.update-row{padding:4px 14px 0;font-size:11px;opacity:.6}
.update-btn{padding:1px 6px;font-size:10px;border-radius:3px;border:1px solid var(--vscode-button-border,var(--vscode-input-border,rgba(128,128,128,.4)));background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.8;margin-left:4px}
.update-btn:hover{opacity:1;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.1))}
.update-link{cursor:pointer;opacity:.8;margin-left:4px;text-decoration:underline}
.update-link:hover{opacity:1}
.gear-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.4;font-size:13px;padding:2px 4px;line-height:1;user-select:none}
.gear-btn:hover{opacity:1}
.gear-btn.active{opacity:1;color:var(--vscode-button-background)}
.rule-config{padding:6px 14px 8px 50px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.1))}
.config-desc{font-size:11px;opacity:.5;padding:0 0 6px;line-height:1.4}
.config-modified{width:5px;height:5px;border-radius:50%;background:var(--vscode-button-background);flex-shrink:0;visibility:visible;position:absolute;left:-14px;top:50%;transform:translateY(-50%)}
.config-modified.default{visibility:hidden}
.config-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;position:relative}
.config-row label{flex:1;opacity:.7;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.config-row input,.config-row textarea{width:80px;flex-shrink:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:3px;padding:2px 6px;font-size:11px;font-family:var(--vscode-font-family);outline:none;text-align:right;-moz-appearance:textfield}
.config-row input::-webkit-outer-spin-button,.config-row input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.config-row textarea{resize:none;overflow:hidden;height:20px;line-height:14px;white-space:nowrap}
.config-row textarea:focus{white-space:pre-wrap;word-break:break-all;text-align:left}
.config-row textarea.expand-w:focus,.config-row input.expand-w:focus{width:120px}
.config-row select{width:80px;flex-shrink:0;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:3px;padding:2px 6px;font-size:11px;outline:none;cursor:pointer;text-align:right}
.config-row input:focus{border-color:var(--vscode-focusBorder)}
.config-actions{margin-top:6px}
.btn-reset{padding:2px 8px;font-size:11px;border-radius:3px;border:1px solid var(--vscode-button-border,var(--vscode-input-border,rgba(128,128,128,.4)));background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.7}
.btn-reset:hover{opacity:1;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.1))}
.excluded-row{display:flex;align-items:center;padding:2px 14px;gap:6px;font-size:12px}
.excluded-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.remove-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.3;font-size:14px;padding:0 4px}
.remove-btn:hover{opacity:1;color:var(--vscode-errorForeground)}
.add-btns{display:flex;gap:6px;padding:6px 14px}
.add-btns button{padding:2px 8px;font-size:11px;border-radius:3px;border:1px solid var(--vscode-button-border,var(--vscode-input-border,rgba(128,128,128,.4)));background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.7}
.add-btns button:hover{opacity:1;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.1))}
.tool-badge{display:inline-block;font-size:9px;font-weight:600;letter-spacing:.3px;padding:0 4px;border-radius:3px;line-height:16px;vertical-align:middle;opacity:.6;border:1px solid rgba(128,128,128,.3);white-space:nowrap;flex-shrink:0}
.tool-badge.sf{color:var(--vscode-charts-blue,#4fc1ff);border-color:var(--vscode-charts-blue,#4fc1ff40)}
.tool-badge.sl{color:var(--vscode-charts-orange,#cca700);border-color:var(--vscode-charts-orange,#cca70040)}
.overlap-indicator{display:inline-flex;gap:2px;flex-shrink:0}
.overlap-detail{padding:4px 14px 8px 50px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.1));font-size:11px}
.overlap-detail .od-row{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.overlap-detail .od-label{opacity:.6;min-width:50px}
.overlap-detail .od-value{opacity:.8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.overlap-detail select{font-size:11px;padding:1px 4px}
.conflict-badge{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;font-size:10px;font-weight:bold;color:var(--vscode-errorForeground,#f48771);opacity:.7;margin-left:4px;cursor:help;vertical-align:middle;flex-shrink:0}
.overlap-banner{padding:8px 14px;font-size:11px;background:var(--vscode-inputValidation-warningBackground,rgba(255,204,0,.1));border-bottom:1px solid var(--vscode-inputValidation-warningBorder,rgba(255,204,0,.3))}
.overlap-banner button{margin-left:8px;padding:1px 8px;font-size:10px;border-radius:3px;border:1px solid var(--vscode-button-border,var(--vscode-input-border,rgba(128,128,128,.4)));background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.8}
.overlap-banner button:hover{opacity:1;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.1))}
.analyzer-note{padding:2px 14px 6px;font-size:11px;opacity:.45;font-style:italic}
.hidden{display:none!important}
.not-found{padding:10px 14px;opacity:.6;font-size:12px}
</style>
</head>
<body>
<div id="app">
  <div class="not-found" id="loading">Detecting tools...</div>
</div>
<script nonce="${nonce}">
${this.getScript()}
</script>
</body>
</html>`;
    }

    private getScript(): string {
        return `
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
let state = null;
const groupCollapsed = {};
let savedSearch = '';
let openConfigRuleId = null;
let openOverlapSfRule = null;

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'setState') { state = msg.state; render(); }
  if (msg.type === 'ruleConfigData') { showRuleConfig(msg.ruleId, msg.defaults, msg.current, msg.description); }
  if (msg.type === 'ruleConfigUpdated') { updateRuleIndicators(msg.ruleId, msg.hasCustomConfig); }
});

vscode.postMessage({ type: 'ready' });

// ── Rule descriptions ─────────────────────────────────────

const ruleDescs = {
  AllPublicDeclarationsHaveDocumentation: 'All public and open declarations must have a documentation comment.',
  AlwaysUseLiteralForEmptyCollectionInit: 'Use literal syntax [] or [:] instead of initializer calls for empty collections.',
  AlwaysUseLowerCamelCase: 'Non-type declarations must use lowerCamelCase naming.',
  AmbiguousTrailingClosureOverload: 'Avoid overloads that differ only by trailing closure label.',
  AvoidRetroactiveConformances: 'Avoid retroactive conformances to types defined in other modules.',
  BeginDocumentationCommentWithOneLineSummary: 'Documentation comments must begin with a single-line summary.',
  DoNotUseSemicolons: 'Semicolons at the end of statements are removed.',
  DontRepeatTypeInStaticProperties: 'Static properties should not repeat the type name.',
  FileScopedDeclarationPrivacy: 'File-scoped declarations use the configured access level (private or fileprivate).',
  FullyIndirectEnum: 'Enums where all cases are indirect use a single enum-level indirect keyword.',
  GroupNumericLiterals: 'Numeric literals are grouped with underscores for readability.',
  IdentifiersMustBeASCII: 'Identifiers must contain only ASCII characters.',
  NeverForceUnwrap: 'Force unwraps (!) are not allowed.',
  NeverUseForceTry: 'Force try (try!) is not allowed.',
  NeverUseImplicitlyUnwrappedOptionals: 'Implicitly unwrapped optionals (!) are not allowed in declarations.',
  NoAccessLevelOnExtensionDeclaration: 'Access levels are set on individual extension members, not the extension itself.',
  NoAssignmentInExpressions: 'Assignment expressions must not appear inside other expressions.',
  NoBlockComments: 'Block comments (/* ... */) are replaced with line comments (//).',
  NoCasesWithOnlyFallthrough: 'Switch cases that only contain fallthrough are collapsed.',
  NoEmptyLinesOpeningClosingBraces: 'Empty lines immediately after opening braces and before closing braces are removed.',
  NoEmptyTrailingClosureParentheses: 'Empty parentheses before trailing closures are removed.',
  NoLabelsInCasePatterns: 'Redundant labels in case patterns are removed.',
  NoLeadingUnderscores: 'Declarations must not have leading underscores in their names.',
  NoParensAroundConditions: 'Parentheses around if/while/guard/switch conditions are removed.',
  NoPlaygroundLiterals: 'Playground-specific literals (#colorLiteral, etc.) are not allowed.',
  NoVoidReturnOnFunctionSignature: 'Explicit Void return types on functions are removed.',
  OmitExplicitReturns: 'Single-expression functions and closures omit the return keyword.',
  OneCasePerLine: 'Each case in a switch must be on its own line.',
  OneVariableDeclarationPerLine: 'Each variable declaration must be on its own line.',
  OnlyOneTrailingClosureArgument: 'Functions with multiple trailing closures use only one trailing closure.',
  OrderedImports: 'Import statements are sorted alphabetically.',
  ReplaceForEachWithForLoop: 'Replace .forEach { } calls with for-in loops.',
  ReturnVoidInsteadOfEmptyTuple: 'Use Void instead of () for return types.',
  TypeNamesShouldBeCapitalized: 'Type names must begin with an uppercase letter.',
  UseEarlyExits: 'Replace if conditions with guard-else for early exits.',
  UseExplicitNilCheckInConditions: 'Use explicit != nil checks instead of optional binding when the value is unused.',
  UseLetInEveryBoundCaseVariable: 'Each bound variable in a case pattern uses its own let/var keyword.',
  UseShorthandTypeNames: 'Use shorthand syntax for Optional, Array, and Dictionary types.',
  UseSingleLinePropertyGetter: 'Single-expression computed property getters omit the get keyword.',
  UseSynthesizedInitializer: 'Prefer the synthesized memberwise initializer over a manually written equivalent.',
  UseTripleSlashForDocumentationComments: 'Use /// for documentation comments instead of /** */.',
  UseWhereClausesInForLoops: 'Move conditions from if-continue into the for-loop where clause.',
  ValidateDocumentationComments: 'Documentation comments must match the declared parameters, throws, and returns.',
};

// ── Icons ─────────────────────────────────────────────────

const ghIconSF = '<span class="gh-link" data-gh="sf" title="swift-format on GitHub"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.64 7.64 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></span>';
const ghIconSL = '<span class="gh-link" data-gh="sl" title="SwiftLint on GitHub"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.64 7.64 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></span>';

// ── Render ────────────────────────────────────────────────

function render() {
  if (!state) return;
  const prevSearch = document.getElementById('rules-search');
  if (prevSearch) { savedSearch = prevSearch.value; }

  const sfFound = state.sfPathResolved && state.sfResolvedPath;
  const slFound = state.slPathResolved && state.slResolvedPath;
  const sfC = state.sfConfig;
  const slC = state.slConfig;

  let h = '';

  // ── Section 1: Tool Status ────────────────────────────

  h += '<div class="section">';

  // swift-format row
  h += '<div class="row"><span>swift-format' + ghIconSF + '</span>';
  if (!state.sfPathResolved) {
    h += '<span class="value">Detecting\\u2026</span>';
  } else if (!state.sfResolvedPath) {
    h += '<span class="value" id="sf-path-btn">Not Found</span>';
  } else {
    h += '<span class="value" id="sf-path-btn">' + esc(state.sfVersion ? 'v' + state.sfVersion : state.sfResolvedPath) + '</span>';
  }
  h += '</div>';

  if (state.sfPathResolved && !state.sfResolvedPath) {
    if (state.sfInstalling) {
      h += '<div class="update-row">Installing via Homebrew\\u2026</div>';
    } else {
      h += '<div class="add-btns" style="padding-top:4px">';
      if (state.brewAvailable) { h += '<button id="sf-install-btn">Install via Homebrew</button>'; }
      else { h += '<button id="sf-manual-btn">Installation Guide</button>'; }
      h += '<button id="sf-path-btn2">Set Path</button></div>';
    }
  } else if (sfFound) {
    if (state.sfUpdating) {
      h += '<div class="update-row">Updating via Homebrew\\u2026</div>';
    } else if (state.sfUpdateAvailable && state.sfLatestVersion) {
      h += '<div class="update-row">v' + esc(state.sfLatestVersion) + ' available';
      if (state.brewAvailable) { h += ' <button class="update-btn" id="sf-update-btn">Update</button>'; }
      else { h += ' <a class="update-link" id="sf-update-link">View release</a>'; }
      h += '</div>';
    }
  }

  // SwiftLint row
  h += '<div class="row" style="margin-top:8px"><span>SwiftLint' + ghIconSL + '</span>';
  if (!state.slPathResolved) {
    h += '<span class="value">Detecting\\u2026</span>';
  } else if (!state.slResolvedPath) {
    h += '<span class="value" id="sl-path-btn">Not Found</span>';
  } else {
    h += '<span class="value" id="sl-path-btn">' + esc(state.slVersion ? 'v' + state.slVersion : state.slResolvedPath) + '</span>';
  }
  h += '</div>';

  if (state.slPathResolved && !state.slResolvedPath) {
    if (state.slInstalling) {
      h += '<div class="update-row">Installing via Homebrew\\u2026</div>';
    } else {
      h += '<div class="add-btns" style="padding-top:4px">';
      if (state.brewAvailable) { h += '<button id="sl-install-btn">Install via Homebrew</button>'; }
      else { h += '<button id="sl-manual-btn">Installation Guide</button>'; }
      h += '<button id="sl-path-btn2">Set Path</button></div>';
    }
  } else if (slFound) {
    if (state.slUpdating) {
      h += '<div class="update-row">Updating via Homebrew\\u2026</div>';
    } else if (state.slUpdateAvailable && state.slLatestVersion) {
      h += '<div class="update-row">v' + esc(state.slLatestVersion) + ' available';
      if (state.brewAvailable) { h += ' <button class="update-btn" id="sl-update-btn">Update</button>'; }
      else { h += ' <a class="update-link" id="sl-update-link">View release</a>'; }
      h += '</div>';
    }
  }

  h += '</div>';

  // ── Section 2: Controls ───────────────────────────────

  h += '<div class="section">';
  if (sfFound) {
    h += toggleRow('Formatter', 'toggle-formatter', sfC.enabled);
  }
  if (slFound) {
    h += toggleRow('Linter', 'toggle-linter', slC.enabled);
  }
  if (sfFound && sfC.enabled) {
    h += toggleRow('Format on Save', 'toggle-formatOnSave', sfC.formatOnSave, 'Formats Swift files automatically when saving. Runs before SwiftLint fix-on-save.');
    h += toggleRow('Lint Mode', 'toggle-lintMode', sfC.lintMode, 'Shows swift-format violations as diagnostics in the Problems panel.');
  }
  if (slFound && slC.enabled) {
    h += toggleRow('Fix on Save', 'toggle-fixOnSave', slC.fixOnSave, 'Auto-corrects fixable rule violations when saving a Swift file.');
    h += '<div class="row"><span>Severity' + infoIcon('<b>Normal</b>: warnings stay warnings, errors stay errors.<br><b>Strict</b>: all violations become errors.<br><b>Lenient</b>: all violations become warnings.') + '</span><select id="severity-select">';
    for (const v of ['normal','strict','lenient']) {
      h += '<option value="' + v + '"' + (slC.severity === v ? ' selected' : '') + '>' + v.charAt(0).toUpperCase() + v.slice(1) + '</option>';
    }
    h += '</select></div>';
  }
  h += '<div class="row"><span>Profile' + infoIcon('<b>Global</b>: options and rules shared across all projects.<br><b>Local</b>: options and rules specific to this project.') + '</span><select id="profile-select">';
  h += '<option value="global"' + (state.profileMode === 'global' ? ' selected' : '') + '>Global</option>';
  h += '<option value="local"' + (state.profileMode === 'local' ? ' selected' : '') + '>Local</option>';
  h += '</select></div>';
  h += '</div>';

  // ── Section 3: Formatting Options ─────────────────────

  if (sfFound) {
    const df = {indentation:'spaces',indentationCount:4,lineLength:100,maximumBlankLines:1,respectsExistingLineBreaks:true,lineBreakBeforeControlFlowKeywords:false,lineBreakBeforeEachArgument:false,lineBreakBeforeEachGenericRequirement:false,lineBreakAroundMultilineExpressionChainComponents:false,lineBreakBeforeSwitchCaseBody:false,lineBreakBetweenDeclarationAttributes:false,indentConditionalCompilationBlocks:true,indentSwitchCaseLabels:false,fileScopedDeclarationPrivacy:'private',multiElementCollectionTrailingCommas:true,prioritizeKeepingFunctionOutputTogether:false,spacesAroundRangeFormationOperators:false,spacesBeforeEndOfLineComments:2,reflowMultilineStringLiterals:'never'};

    const so = state.settingsOverlaps || [];
    const lineLengthConflict = so.find(o => o.name === 'Line Length' && o.conflict);
    const privacyConflict = so.find(o => o.name === 'File-Scoped Privacy' && o.conflict);
    const trailingConflict = so.find(o => o.name === 'Trailing Commas' && o.conflict);

    h += '<div class="section">';
    h += '<div class="row"><span class="label">Formatting Options</span></div>';

    h += '<div class="row"><span title="' + esc('Use spaces or tabs for indentation.\\nDefault: Spaces') + '">Indentation' + modDot(sfC.indentation !== df.indentation) + '</span><select id="indent-type">';
    h += '<option value="spaces"' + (sfC.indentation === 'spaces' ? ' selected' : '') + '>Spaces</option>';
    h += '<option value="tabs"' + (sfC.indentation === 'tabs' ? ' selected' : '') + '>Tabs</option>';
    h += '</select></div>';

    if (sfC.indentation === 'spaces') {
      h += '<div class="row"><span title="' + esc('Number of spaces per indentation level.\\nDefault: 4') + '">Indent Width' + modDot(sfC.indentationCount !== df.indentationCount) + '</span><input type="number" id="indent-count" value="' + sfC.indentationCount + '" min="1" max="8"></div>';
    }

    h += '<div class="row"><span title="' + esc('Maximum number of characters per line before wrapping.\\nDefault: 100') + '">Line Length' + modDot(sfC.lineLength !== df.lineLength) + (lineLengthConflict ? conflictBadge('swift-format line length exceeds SwiftLint line_length warning threshold') : '') + '</span><input type="number" id="lineLength" value="' + sfC.lineLength + '" min="1" max="999"></div>';
    h += '<div class="row"><span title="' + esc('Maximum number of consecutive blank lines allowed.\\nDefault: 1') + '">Max Blank Lines' + modDot(sfC.maximumBlankLines !== df.maximumBlankLines) + '</span><input type="number" id="maximumBlankLines" value="' + sfC.maximumBlankLines + '" min="0" max="10"></div>';

    h += toggleRow('Respects Existing Line Breaks', 'opt-respectsExistingLineBreaks', sfC.respectsExistingLineBreaks, 'Preserves existing line breaks in source code.', sfC.respectsExistingLineBreaks !== df.respectsExistingLineBreaks, 'On');
    h += toggleRow('Break Before Control Flow Keywords', 'opt-lineBreakBeforeControlFlowKeywords', sfC.lineBreakBeforeControlFlowKeywords, 'Places else, catch on a new line.', sfC.lineBreakBeforeControlFlowKeywords !== df.lineBreakBeforeControlFlowKeywords, 'Off');
    h += toggleRow('Break Before Each Argument', 'opt-lineBreakBeforeEachArgument', sfC.lineBreakBeforeEachArgument, 'Each argument on its own line when wrapping.', sfC.lineBreakBeforeEachArgument !== df.lineBreakBeforeEachArgument, 'Off');
    h += toggleRow('Break Before Generic Requirements', 'opt-lineBreakBeforeEachGenericRequirement', sfC.lineBreakBeforeEachGenericRequirement, 'Each generic requirement on its own line.', sfC.lineBreakBeforeEachGenericRequirement !== df.lineBreakBeforeEachGenericRequirement, 'Off');
    h += toggleRow('Break Around Multiline Chains', 'opt-lineBreakAroundMultilineExpressionChainComponents', sfC.lineBreakAroundMultilineExpressionChainComponents, 'Adds line breaks around multiline chain components.', sfC.lineBreakAroundMultilineExpressionChainComponents !== df.lineBreakAroundMultilineExpressionChainComponents, 'Off');
    h += toggleRow('Break Before Switch Case Body', 'opt-lineBreakBeforeSwitchCaseBody', sfC.lineBreakBeforeSwitchCaseBody, 'Case body on line after the label.', sfC.lineBreakBeforeSwitchCaseBody !== df.lineBreakBeforeSwitchCaseBody, 'Off');
    h += toggleRow('Break Between Declaration Attributes', 'opt-lineBreakBetweenDeclarationAttributes', sfC.lineBreakBetweenDeclarationAttributes, 'Places each declaration attribute on its own line.', sfC.lineBreakBetweenDeclarationAttributes !== df.lineBreakBetweenDeclarationAttributes, 'Off');
    h += toggleRow('Indent #if/#else Blocks', 'opt-indentConditionalCompilationBlocks', sfC.indentConditionalCompilationBlocks, 'Indents code inside conditional compilation blocks.', sfC.indentConditionalCompilationBlocks !== df.indentConditionalCompilationBlocks, 'On');
    h += toggleRow('Indent Switch Case Labels', 'opt-indentSwitchCaseLabels', sfC.indentSwitchCaseLabels, 'Indents case labels relative to switch.', sfC.indentSwitchCaseLabels !== df.indentSwitchCaseLabels, 'Off');

    h += '<div class="row"><span title="' + esc('File-scoped declarations use private or fileprivate.\\nDefault: private') + '">File-Scoped Privacy' + modDot(sfC.fileScopedDeclarationPrivacy !== df.fileScopedDeclarationPrivacy) + (privacyConflict ? conflictBadge('swift-format uses fileprivate but SwiftLint private_over_fileprivate is enabled') : '') + '</span><select id="fileScopedDeclarationPrivacy">';
    h += '<option value="private"' + (sfC.fileScopedDeclarationPrivacy === 'private' ? ' selected' : '') + '>private</option>';
    h += '<option value="fileprivate"' + (sfC.fileScopedDeclarationPrivacy === 'fileprivate' ? ' selected' : '') + '>fileprivate</option>';
    h += '</select></div>';

    h += toggleRow('Trailing Commas', 'opt-multiElementCollectionTrailingCommas', sfC.multiElementCollectionTrailingCommas, 'Adds trailing comma after last element in multi-line collections.' + (trailingConflict ? ' Conflicts with SwiftLint trailing_comma config.' : ''), sfC.multiElementCollectionTrailingCommas !== df.multiElementCollectionTrailingCommas, 'On', trailingConflict);
    h += toggleRow('Prioritize Function Output Together', 'opt-prioritizeKeepingFunctionOutputTogether', sfC.prioritizeKeepingFunctionOutputTogether, 'Keeps the return type on the same line as the closing parenthesis when wrapping.', sfC.prioritizeKeepingFunctionOutputTogether !== df.prioritizeKeepingFunctionOutputTogether, 'Off');
    h += toggleRow('Spaces Around Range Operators', 'opt-spacesAroundRangeFormationOperators', sfC.spacesAroundRangeFormationOperators, 'Adds spaces around range operators (... and ..<).', sfC.spacesAroundRangeFormationOperators !== df.spacesAroundRangeFormationOperators, 'Off');

    h += '<div class="row"><span title="' + esc('Number of spaces before end-of-line comments.\\nDefault: 2') + '">Spaces Before EOL Comments' + modDot(sfC.spacesBeforeEndOfLineComments !== df.spacesBeforeEndOfLineComments) + '</span><input type="number" id="spacesBeforeEndOfLineComments" value="' + sfC.spacesBeforeEndOfLineComments + '" min="1" max="10"></div>';

    h += '<div class="row"><span title="' + esc('Controls whether multiline string literals are reflowed to fit line length.\\nDefault: never') + '">Reflow Multiline Strings' + modDot(sfC.reflowMultilineStringLiterals !== df.reflowMultilineStringLiterals) + '</span><select id="reflowMultilineStringLiterals">';
    h += '<option value="never"' + (sfC.reflowMultilineStringLiterals === 'never' ? ' selected' : '') + '>never</option>';
    h += '<option value="always"' + (sfC.reflowMultilineStringLiterals === 'always' ? ' selected' : '') + '>always</option>';
    h += '</select></div>';

    h += '<div class="add-btns" style="padding-top:4px"><button id="reset-options-btn">Reset Options to Defaults</button></div>';
    h += '</div>';
  }

  // ── Section 4: Rules ──────────────────────────────────

  const rules = state.unifiedRules || [];
  const aRules = state.analyzerRules || [];

  if (rules.length > 0 || aRules.length > 0) {
    // Count enabled
    let enabledCount = 0;
    for (const r of rules) {
      if (r.tool === 'swift-format' && r.sfRule && r.sfRule.effectiveEnabled) enabledCount++;
      else if (r.tool === 'swiftlint' && r.slRule && r.slRule.enabled) enabledCount++;
      else if (r.tool === 'overlap') {
        if (r.sfRule && r.sfRule.effectiveEnabled) enabledCount++;
        if (r.slRule && r.slRule.enabled && !(r.sfRule && r.sfRule.effectiveEnabled && r.overlap && r.overlap.activeHandler !== 'both')) enabledCount++;
      }
    }
    for (const r of aRules) { if (r.enabled) enabledCount++; }
    const totalCount = rules.length + aRules.length;

    h += '<div class="rules-header"><span class="label">Rules</span><span class="badge">' + enabledCount + ' / ' + totalCount + '</span></div>';
    h += '<div class="search-wrap" id="search-wrap"><input type="text" class="search" id="rules-search" placeholder="Filter rules..."><button class="search-clear" id="search-clear" title="Clear"><svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708z"/></svg></button></div>';

    // Overlap banner
    if (state.activeOverlapCount > 0) {
      h += '<div class="overlap-banner">' + state.activeOverlapCount + ' rule' + (state.activeOverlapCount === 1 ? '' : 's') + ' handled by both tools <button id="auto-resolve-btn">Auto-resolve</button></div>';
    }

    // Categories
    const cats = ${JSON.stringify(CATEGORY_ORDER.filter((c) => c !== 'analyzer'))};
    const catLabels = ${JSON.stringify(CATEGORY_LABELS)};
    for (const cat of cats) {
      const group = rules.filter(r => r.category === cat);
      if (!group.length) continue;
      const gc = (groupCollapsed[cat] ?? true) ? ' collapsed' : '';
      h += '<div class="group-header' + gc + '" data-group="' + cat + '"><span class="group-chevron"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4z"/></svg></span>' + (catLabels[cat] || cat) + ' (' + group.length + ')</div>';
      h += '<div class="group-body' + gc + '" data-group-body="' + cat + '">';
      for (const r of group) { h += unifiedRuleRow(r); }
      h += '</div>';
    }

    // Analyzer rules
    if (aRules.length > 0) {
      const aEnabled = aRules.filter(r => r.enabled).length;
      const aCollapsed = (groupCollapsed['analyzer'] ?? true) ? ' collapsed' : '';
      h += '<div class="group-header' + aCollapsed + '" data-group="analyzer"><span class="group-chevron"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4z"/></svg></span>Analyzer (' + aRules.length + ')<span class="badge" style="margin-left:auto">' + aEnabled + ' enabled</span></div>';
      h += '<div class="group-body' + aCollapsed + '" data-group-body="analyzer">';
      h += '<div class="analyzer-note">Runs after builds using compiler logs</div>';
      for (const r of aRules) {
        const hasCustomConfig = !!slC.ruleConfigs[r.identifier];
        const modified = r.enabled || hasCustomConfig;
        const gearClass = hasCustomConfig ? ' active' : '';
        h += '<div class="rule-row" data-id="' + r.identifier + '" data-group="analyzer" data-analyzer="1">';
        h += '<label class="switch"><input type="checkbox" data-analyzer-rule="' + r.identifier + '"' + (r.enabled ? ' checked' : '') + '><span class="slider"></span></label>';
        h += '<span class="rule-name">' + esc(r.identifier) + '</span>';
        if (modified) h += '<span class="rule-modified" title="Modified from default"></span>';
        h += '<span class="tool-badge sl">SL</span>';
        h += '<button class="gear-btn' + gearClass + '" data-gear="' + r.identifier + '" title="Configure">\\u2699</button>';
        h += '</div>';
        h += '<div class="rule-config hidden" data-config="' + r.identifier + '"></div>';
      }
      h += '</div>';
    }

    h += '<div class="add-btns" style="padding-top:4px"><button id="reset-all-btn">Reset All Rules to Defaults</button></div>';
  }

  // ── Section 5: Excluded Paths ─────────────────────────

  if (slFound) {
    h += '<div class="section" style="border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2));margin-top:4px">';
    h += '<div class="row"><span class="label">Excluded Paths</span></div>';
    for (const p of state.excludedPaths) {
      h += '<div class="excluded-row"><span>' + esc(p) + '</span><button class="remove-btn" data-remove="' + esc(p) + '">\\u00d7</button></div>';
    }
    h += '<div class="add-btns"><button id="add-path-btn">+ Path</button><button id="add-folder-btn">+ Folder</button></div>';
    h += '</div>';
  }

  app.innerHTML = h;
  bind();
  if (savedSearch) {
    const si = document.getElementById('rules-search');
    if (si) { si.value = savedSearch; applySearch(); }
  }
  if (openConfigRuleId) {
    const panel = document.querySelector('[data-config="' + openConfigRuleId + '"]');
    const btn = document.querySelector('[data-gear="' + openConfigRuleId + '"]');
    if (panel && btn) {
      panel.classList.remove('hidden');
      btn.classList.add('active');
      vscode.postMessage({ type: 'fetchRuleConfig', ruleId: openConfigRuleId });
    }
  }
  if (openOverlapSfRule) {
    const detail = document.querySelector('[data-overlap-detail="' + openOverlapSfRule + '"]');
    if (detail) { detail.classList.remove('hidden'); }
  }
}

// ── Unified rule row ──────────────────────────────────────

function unifiedRuleRow(r) {
  const isSf = r.tool === 'swift-format';
  const isSl = r.tool === 'swiftlint';
  const isOv = r.tool === 'overlap';

  let enabled = false;
  let ruleId = '';
  let modified = false;
  let tags = [];
  let showGear = false;
  let gearClass = '';
  let gearRuleId = '';

  if (isSf && r.sfRule) {
    enabled = r.sfRule.effectiveEnabled;
    ruleId = r.sfRule.identifier;
    modified = r.sfRule.isDefault ? !enabled : enabled;
  } else if (isSl && r.slRule) {
    enabled = r.slRule.enabled;
    ruleId = r.slRule.identifier;
    const toggleChanged = r.slRule.optIn ? enabled : !enabled;
    modified = toggleChanged || r.slRule.hasConfig;
    if (r.slRule.optIn) tags.push('opt-in');
    if (r.slRule.correctable) tags.push('fixable');
    showGear = true;
    gearRuleId = r.slRule.identifier;
    gearClass = r.slRule.hasConfig ? ' active' : '';
  } else if (isOv) {
    // Overlap: show the primary tool's toggle state
    if (r.overlap) {
      const handler = r.overlap.activeHandler;
      if (handler === 'swift-format' || handler === 'both') {
        enabled = r.sfRule ? r.sfRule.effectiveEnabled : false;
      } else {
        enabled = r.slRule ? r.slRule.enabled : false;
      }
    }
    ruleId = r.sfRule ? r.sfRule.identifier : (r.slRule ? r.slRule.identifier : '');
    // Modified if either side is non-default
    if (r.sfRule) {
      const sfMod = r.sfRule.isDefault ? !r.sfRule.effectiveEnabled : r.sfRule.effectiveEnabled;
      if (sfMod) modified = true;
    }
    if (r.slRule) {
      const slMod = r.slRule.optIn ? r.slRule.enabled : !r.slRule.enabled;
      if (slMod || r.slRule.hasConfig) modified = true;
    }
    if (r.slRule && r.slRule.correctable) tags.push('fixable');
    if (r.slRule) {
      showGear = true;
      gearRuleId = r.slRule.identifier;
      gearClass = r.slRule.hasConfig ? ' active' : '';
    }
  }

  // Tool type data attribute for toggle routing
  const toolAttr = isSf ? 'data-sf-rule="' + esc(ruleId) + '"' : isSl ? 'data-sl-rule="' + esc(ruleId) + '"' : 'data-overlap-rule="' + esc(r.sfRule ? r.sfRule.identifier : '') + '"';

  const desc = r.sfRule ? ruleDescs[r.sfRule.identifier] : '';
  const defaultLabel = isSf ? (r.sfRule && r.sfRule.isDefault ? 'Enabled' : 'Disabled') : (isSl ? (r.slRule && !r.slRule.optIn ? 'Enabled' : 'Disabled') : '');
  const tip = desc ? desc + (defaultLabel ? '\\nDefault: ' + defaultLabel : '') : (defaultLabel ? 'Default: ' + defaultLabel : '');

  let row = '<div class="rule-row" data-id="' + esc(ruleId) + '" data-display="' + esc(r.displayName) + '" data-group="' + r.category + '">';
  row += '<label class="switch"><input type="checkbox" ' + toolAttr + (enabled ? ' checked' : '') + '><span class="slider"></span></label>';
  row += '<span class="rule-name" title="' + esc(tip) + '">' + esc(r.displayName) + '</span>';
  if (modified) row += '<span class="rule-modified" title="Modified from default"></span>';
  if (tags.length) row += '<span class="rule-tags">' + tags.join(', ') + '</span>';

  // Tool badges
  if (isOv) {
    row += '<span class="overlap-indicator">';
    row += '<span class="tool-badge sf">SF</span>';
    row += '<span class="tool-badge sl">SL</span>';
    row += '</span>';
  } else if (isSf) {
    row += '<span class="tool-badge sf">SF</span>';
  } else if (isSl) {
    row += '<span class="tool-badge sl">SL</span>';
  }

  if (showGear) {
    row += '<button class="gear-btn' + gearClass + '" data-gear="' + esc(gearRuleId) + '" title="Configure">\\u2699</button>';
  }
  row += '</div>';

  // Overlap detail (hidden by default)
  if (isOv) {
    const detailHidden = openOverlapSfRule === (r.sfRule ? r.sfRule.identifier : '') ? '' : ' hidden';
    row += '<div class="overlap-detail' + detailHidden + '" data-overlap-detail="' + esc(r.sfRule ? r.sfRule.identifier : '') + '">';
    row += '<div class="od-row"><span class="od-label">SF:</span><span class="od-value">' + esc(r.sfRule ? r.sfRule.identifier : 'N/A') + (r.sfRule ? (r.sfRule.effectiveEnabled ? ' (on)' : ' (off)') : '') + '</span></div>';
    row += '<div class="od-row"><span class="od-label">SL:</span><span class="od-value">' + esc(r.slRule ? r.slRule.identifier : 'N/A') + (r.slRule ? (r.slRule.enabled ? ' (on)' : ' (off)') : '') + '</span></div>';
    row += '<div class="od-row"><span class="od-label">Handle:</span><select data-overlap-handler="' + esc(r.sfRule ? r.sfRule.identifier : '') + '">';
    const handler = r.overlap ? r.overlap.activeHandler : 'both';
    row += '<option value="swift-format"' + (handler === 'swift-format' ? ' selected' : '') + '>swift-format</option>';
    row += '<option value="swiftlint"' + (handler === 'swiftlint' ? ' selected' : '') + '>SwiftLint</option>';
    row += '<option value="both"' + (handler === 'both' ? ' selected' : '') + '>Both</option>';
    row += '</select></div>';
    row += '</div>';
  }

  // SL rule config panel (hidden)
  if (showGear) {
    row += '<div class="rule-config hidden" data-config="' + esc(gearRuleId) + '"></div>';
  }

  return row;
}

// ── Helpers ───────────────────────────────────────────────

function toggleRow(label, id, checked, desc, modified, defaultLabel, hasConflict) {
  let tip = '';
  if (desc && defaultLabel) { tip = desc + '\\nDefault: ' + defaultLabel; }
  else if (desc) { tip = desc; }
  else if (defaultLabel) { tip = 'Default: ' + defaultLabel; }
  const titleAttr = tip ? ' title="' + esc(tip) + '"' : '';
  return '<div class="row"><span' + titleAttr + '>' + label + modDot(modified) + (hasConflict ? conflictBadge('Settings conflict detected with SwiftLint') : '') + '</span><label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span class="slider"></span></label></div>';
}

function modDot(isModified) {
  return isModified ? '<span class="opt-modified"></span>' : '';
}

function conflictBadge(tooltip) {
  return '<span class="conflict-badge" title="' + esc(tooltip) + '">!</span>';
}

function infoIcon(text) {
  return '<span class="info-wrap"><button class="info-btn" data-info><svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.6A5.6 5.6 0 1 1 8 2.4a5.6 5.6 0 0 1 0 11.2zM7.4 5h1.2V3.8H7.4V5zm0 7.2h1.2V6.2H7.4v6z"/></svg></button><span class="info-tip">' + text + '</span></span>';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── Search ────────────────────────────────────────────────

function applySearch() {
  const searchInput = document.getElementById('rules-search');
  const searchWrap = document.getElementById('search-wrap');
  const q = (searchInput?.value || '').toLowerCase();
  searchWrap?.classList.toggle('has-value', q.length > 0);
  document.querySelectorAll('.rule-row').forEach(row => {
    const id = (row.dataset.id || '').toLowerCase();
    const display = (row.dataset.display || '').toLowerCase();
    row.classList.toggle('hidden', q.length > 0 && !id.includes(q) && !display.includes(q));
  });
  document.querySelectorAll('.group-header').forEach(gh => {
    const group = gh.dataset.group;
    const body = document.querySelector('[data-group-body="' + group + '"]');
    const hasVisible = body ? body.querySelectorAll('.rule-row:not(.hidden)').length > 0 : false;
    gh.classList.toggle('hidden', !hasVisible);
    if (body) body.classList.toggle('hidden', !hasVisible);
    if (q.length > 0) {
      gh.classList.toggle('collapsed', !hasVisible);
      if (body) body.classList.toggle('collapsed', !hasVisible);
    } else {
      const collapsed = groupCollapsed[group] ?? true;
      gh.classList.toggle('collapsed', collapsed);
      if (body) body.classList.toggle('collapsed', collapsed);
    }
  });
}

// ── Bind ──────────────────────────────────────────────────

function bind() {
  // Info tips
  document.querySelectorAll('.info-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const wrap = btn.closest('.info-wrap');
      const wasOpen = wrap?.classList.contains('open');
      document.querySelectorAll('.info-wrap.open').forEach(w => w.classList.remove('open'));
      if (!wasOpen) { wrap?.classList.add('open'); }
    });
  });
  document.addEventListener('click', () => document.querySelectorAll('.info-wrap.open').forEach(w => w.classList.remove('open')));

  // Tool status
  document.querySelector('[data-gh="sf"]')?.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'openSwiftFormatGithub' }); });
  document.querySelector('[data-gh="sl"]')?.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'openSwiftLintGithub' }); });
  document.getElementById('sf-path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changeFormatterPath' }));
  document.getElementById('sf-path-btn2')?.addEventListener('click', () => vscode.postMessage({ type: 'changeFormatterPath' }));
  document.getElementById('sf-install-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'installSwiftFormat' }));
  document.getElementById('sf-manual-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'openSwiftFormatGithub' }));
  document.getElementById('sf-update-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'updateSwiftFormat' }));
  document.getElementById('sf-update-link')?.addEventListener('click', () => vscode.postMessage({ type: 'openSwiftFormatGithub' }));
  document.getElementById('sl-path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changeLinterPath' }));
  document.getElementById('sl-path-btn2')?.addEventListener('click', () => vscode.postMessage({ type: 'changeLinterPath' }));
  document.getElementById('sl-install-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'installSwiftLint' }));
  document.getElementById('sl-manual-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'openSwiftLintGithub' }));
  document.getElementById('sl-update-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'updateSwiftLint' }));
  document.getElementById('sl-update-link')?.addEventListener('click', () => vscode.postMessage({ type: 'openSwiftLintGithub' }));

  // Controls
  document.getElementById('toggle-formatter')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleFormatterEnabled', value: e.target.checked }));
  document.getElementById('toggle-linter')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleLinterEnabled', value: e.target.checked }));
  document.getElementById('toggle-formatOnSave')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleFormatOnSave', value: e.target.checked }));
  document.getElementById('toggle-lintMode')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleLintMode', value: e.target.checked }));
  document.getElementById('toggle-fixOnSave')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleFixOnSave', value: e.target.checked }));
  document.getElementById('severity-select')?.addEventListener('change', e => vscode.postMessage({ type: 'changeSeverity', value: e.target.value }));
  document.getElementById('profile-select')?.addEventListener('change', e => vscode.postMessage({ type: 'changeProfileMode', value: e.target.value }));

  // Formatting options
  document.getElementById('indent-type')?.addEventListener('change', e => vscode.postMessage({ type: 'updateOption', key: 'indentation', value: e.target.value }));

  const indentCount = document.getElementById('indent-count');
  if (indentCount) {
    indentCount.addEventListener('change', () => {
      const val = parseInt(indentCount.value) || 4;
      vscode.postMessage({ type: 'updateOption', key: 'indentationCount', value: val });
    });
  }

  const lineLength = document.getElementById('lineLength');
  if (lineLength) {
    lineLength.addEventListener('change', () => {
      const val = parseInt(lineLength.value) || 100;
      vscode.postMessage({ type: 'updateOption', key: 'lineLength', value: val });
    });
  }

  const maxBlankLines = document.getElementById('maximumBlankLines');
  if (maxBlankLines) {
    maxBlankLines.addEventListener('change', () => {
      const val = parseInt(maxBlankLines.value) || 1;
      vscode.postMessage({ type: 'updateOption', key: 'maximumBlankLines', value: val });
    });
  }

  document.getElementById('fileScopedDeclarationPrivacy')?.addEventListener('change', e => vscode.postMessage({ type: 'updateOption', key: 'fileScopedDeclarationPrivacy', value: e.target.value }));
  document.getElementById('reflowMultilineStringLiterals')?.addEventListener('change', e => vscode.postMessage({ type: 'updateOption', key: 'reflowMultilineStringLiterals', value: e.target.value }));

  const spacesEOL = document.getElementById('spacesBeforeEndOfLineComments');
  if (spacesEOL) {
    spacesEOL.addEventListener('change', () => {
      const val = parseInt(spacesEOL.value) || 2;
      vscode.postMessage({ type: 'updateOption', key: 'spacesBeforeEndOfLineComments', value: val });
    });
  }

  const boolOptions = [
    'respectsExistingLineBreaks',
    'lineBreakBeforeControlFlowKeywords',
    'lineBreakBeforeEachArgument',
    'lineBreakBeforeEachGenericRequirement',
    'lineBreakAroundMultilineExpressionChainComponents',
    'lineBreakBeforeSwitchCaseBody',
    'lineBreakBetweenDeclarationAttributes',
    'indentConditionalCompilationBlocks',
    'indentSwitchCaseLabels',
    'multiElementCollectionTrailingCommas',
    'prioritizeKeepingFunctionOutputTogether',
    'spacesAroundRangeFormationOperators',
  ];
  for (const opt of boolOptions) {
    document.getElementById('opt-' + opt)?.addEventListener('change', e => {
      vscode.postMessage({ type: 'updateOption', key: opt, value: e.target.checked });
    });
  }

  document.getElementById('reset-options-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'resetOptions' }));

  // Rule toggles (swift-format)
  document.querySelectorAll('input[data-sf-rule]').forEach(cb => {
    cb.addEventListener('change', e => vscode.postMessage({ type: 'toggleSfRule', ruleId: e.target.dataset.sfRule, enabled: e.target.checked }));
  });

  // Rule toggles (SwiftLint)
  document.querySelectorAll('input[data-sl-rule]').forEach(cb => {
    cb.addEventListener('change', e => vscode.postMessage({ type: 'toggleSlRule', ruleId: e.target.dataset.slRule, enabled: e.target.checked }));
  });

  // Rule toggles (overlap — routes to the active handler's toggle)
  document.querySelectorAll('input[data-overlap-rule]').forEach(cb => {
    cb.addEventListener('change', e => {
      const sfId = e.target.dataset.overlapRule;
      const rule = (state?.unifiedRules || []).find(r => r.sfRule && r.sfRule.identifier === sfId);
      if (!rule || !rule.overlap) return;
      const handler = rule.overlap.activeHandler;
      if (handler === 'swift-format' || handler === 'both') {
        vscode.postMessage({ type: 'toggleSfRule', ruleId: sfId, enabled: e.target.checked });
      }
      if ((handler === 'swiftlint' || handler === 'both') && rule.slRule) {
        vscode.postMessage({ type: 'toggleSlRule', ruleId: rule.slRule.identifier, enabled: e.target.checked });
      }
    });
  });

  // Analyzer rule toggles
  document.querySelectorAll('input[data-analyzer-rule]').forEach(cb => {
    cb.addEventListener('change', e => vscode.postMessage({ type: 'toggleAnalyzerRule', ruleId: e.target.dataset.analyzerRule, enabled: e.target.checked }));
  });

  // Group collapse
  document.querySelectorAll('.group-header').forEach(gh => {
    const group = gh.dataset.group;
    if (!(group in groupCollapsed)) { groupCollapsed[group] = true; }
    gh.addEventListener('click', () => {
      const body = document.querySelector('[data-group-body="' + group + '"]');
      if (!body) return;
      const isCollapsed = !gh.classList.contains('collapsed');
      gh.classList.toggle('collapsed', isCollapsed);
      body.classList.toggle('collapsed', isCollapsed);
      groupCollapsed[group] = isCollapsed;
    });
  });

  // Search
  document.getElementById('rules-search')?.addEventListener('input', applySearch);
  document.getElementById('search-clear')?.addEventListener('click', () => {
    const si = document.getElementById('rules-search');
    if (si) { si.value = ''; }
    savedSearch = '';
    applySearch();
    si?.focus();
  });

  // Gear buttons (SL rule config)
  function toggleRuleConfig(ruleId) {
    const panel = document.querySelector('[data-config="' + ruleId + '"]');
    const btn = document.querySelector('[data-gear="' + ruleId + '"]');
    if (!panel) return;
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      if (btn) { btn.classList.remove('active'); }
      openConfigRuleId = null;
      return;
    }
    document.querySelectorAll('.rule-config:not(.hidden)').forEach(p => { p.classList.add('hidden'); });
    document.querySelectorAll('.gear-btn.active').forEach(b => {
      const gId = b.dataset.gear;
      if (!state?.slConfig?.ruleConfigs[gId]) b.classList.remove('active');
    });
    if (btn) { btn.classList.add('active'); }
    panel.classList.remove('hidden');
    openConfigRuleId = ruleId;
    panel.innerHTML = '<div class="not-found">Loading...</div>';
    vscode.postMessage({ type: 'fetchRuleConfig', ruleId });
  }

  document.querySelectorAll('.gear-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleRuleConfig(btn.dataset.gear); });
  });

  // Click on rule row to open config (SL rules) or overlap detail (overlap rules)
  document.querySelectorAll('.rule-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.switch') || e.target.closest('.gear-btn') || e.target.closest('.overlap-indicator')) return;
      // Check if this is an overlap rule
      const overlapInput = row.querySelector('input[data-overlap-rule]');
      if (overlapInput) {
        const sfId = overlapInput.dataset.overlapRule;
        toggleOverlapDetail(sfId);
        return;
      }
      // Otherwise try gear config
      const gear = row.querySelector('.gear-btn');
      if (gear) { toggleRuleConfig(gear.dataset.gear); }
    });
  });

  // Overlap detail toggle via badges
  document.querySelectorAll('.overlap-indicator').forEach(ind => {
    ind.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = ind.closest('.rule-row');
      const overlapInput = row?.querySelector('input[data-overlap-rule]');
      if (overlapInput) { toggleOverlapDetail(overlapInput.dataset.overlapRule); }
    });
  });

  // Overlap handler selectors
  document.querySelectorAll('select[data-overlap-handler]').forEach(sel => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', e => {
      vscode.postMessage({ type: 'changeOverlapHandler', sfRule: e.target.dataset.overlapHandler, handler: e.target.value });
    });
  });

  // Auto-resolve
  document.getElementById('auto-resolve-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'autoResolveOverlaps' }));

  // Reset all
  document.getElementById('reset-all-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'resetAllRules' }));

  // Excluded paths
  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'removeExcludedPath', path: btn.dataset.remove }));
  });
  document.getElementById('add-path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'addExcludedPath' }));
  document.getElementById('add-folder-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'addExcludedFolder' }));
}

// ── Overlap detail toggle ─────────────────────────────────

function toggleOverlapDetail(sfRule) {
  const detail = document.querySelector('[data-overlap-detail="' + sfRule + '"]');
  if (!detail) return;
  if (detail.classList.contains('hidden')) {
    // Close any other open detail
    document.querySelectorAll('.overlap-detail:not(.hidden)').forEach(d => d.classList.add('hidden'));
    detail.classList.remove('hidden');
    openOverlapSfRule = sfRule;
  } else {
    detail.classList.add('hidden');
    openOverlapSfRule = null;
  }
}

// ── Rule config panel ─────────────────────────────────────

const configDefaults = {};

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/^\\w/, c => c.toUpperCase());
}

function showRuleConfig(ruleId, defaults, current, description) {
  const panel = document.querySelector('[data-config="' + ruleId + '"]');
  if (!panel) return;
  const defs = defaults || {};
  configDefaults[ruleId] = defs;
  const vals = current || defs;
  const entries = Object.entries(defs);
  if (!entries.length) { panel.innerHTML = '<div class="not-found">No configurable parameters</div>'; return; }
  let h = '';
  if (description) {
    h += '<div class="config-desc">' + esc(description) + '</div>';
  }
  for (const [key, defRaw] of entries) {
    const defVal = String(defRaw).trim();
    const sv = String(vals[key] ?? defRaw).trim();
    const changed = sv !== defVal;
    const isBool = sv === 'true' || sv === 'false';
    const isSeverity = sv === 'warning' || sv === 'error';
    h += '<div class="config-row">';
    h += '<span class="config-modified' + (changed ? '' : ' default') + '" data-dot="' + esc(key) + '"></span>';
    h += '<label title="' + esc(key) + '">' + esc(key) + '</label>';
    if (isBool) {
      h += '<select data-key="' + esc(key) + '"><option value="true"' + (sv === 'true' ? ' selected' : '') + '>true</option><option value="false"' + (sv === 'false' ? ' selected' : '') + '>false</option></select>';
    } else if (isSeverity) {
      h += '<select data-key="' + esc(key) + '"><option value="warning"' + (sv === 'warning' ? ' selected' : '') + '>warning</option><option value="error"' + (sv === 'error' ? ' selected' : '') + '>error</option></select>';
    } else {
      const isNum = /^\\d+$/.test(defVal);
      if (isNum) {
        h += '<input type="number" data-key="' + esc(key) + '" value="' + esc(sv) + '" min="0">';
      } else {
        h += '<textarea data-key="' + esc(key) + '" rows="1"></textarea>';
      }
    }
    h += '</div>';
  }
  h += '<div class="config-actions"><button class="btn-reset" data-reset="' + ruleId + '">Reset to Defaults</button></div>';
  panel.innerHTML = h;

  panel.querySelectorAll('textarea[data-key]').forEach(el => {
    el.value = String(vals[el.dataset.key] ?? defs[el.dataset.key] ?? '').trim();
  });

  panel.querySelectorAll('[data-key]').forEach(el => {
    const key = el.dataset.key;
    const defVal = String(defs[key] ?? '');
    el.title = humanize(key) + '\\nDefault: ' + defVal;
  });
  panel.querySelectorAll('label[title]').forEach(lbl => {
    const key = lbl.title;
    const defVal = String(defs[key] ?? '');
    lbl.title = humanize(key) + '\\nDefault: ' + defVal;
  });

  function autoSave() {
    const config = {};
    panel.querySelectorAll('[data-key]').forEach(el => { config[el.dataset.key] = el.value; });
    vscode.postMessage({ type: 'updateRuleConfig', ruleId, config });
  }

  panel.querySelectorAll('select[data-key]').forEach(el => {
    el.addEventListener('change', () => { updateConfigDot(panel, el); autoSave(); });
  });
  panel.querySelectorAll('input[data-key], textarea[data-key]').forEach(el => {
    function checkOverflow() { el.classList.toggle('expand-w', el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight); }
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('focus', checkOverflow);
    el.addEventListener('input', checkOverflow);
    el.addEventListener('blur', () => {
      el.value = el.value.trim();
      updateConfigDot(panel, el);
      autoSave();
      if (el.tagName === 'TEXTAREA') { el.style.height = '20px'; }
    });
    if (el.tagName === 'TEXTAREA') {
      function autoHeight() { el.style.height = '20px'; el.style.height = el.scrollHeight + 'px'; }
      el.addEventListener('focus', autoHeight);
      el.addEventListener('input', autoHeight);
    }
  });

  panel.querySelector('[data-reset]')?.addEventListener('click', () => {
    panel.querySelectorAll('[data-key]').forEach(el => {
      const def = defs[el.dataset.key];
      if (def !== undefined) { el.value = String(def); }
      updateConfigDot(panel, el);
    });
    vscode.postMessage({ type: 'updateRuleConfig', ruleId, config: defs });
    // Also reset the toggle to its default state
    const aRule = (state?.analyzerRules || []).find(r => r.identifier === ruleId);
    if (aRule) {
      vscode.postMessage({ type: 'toggleAnalyzerRule', ruleId, enabled: false });
    } else {
      // Find rule in unified list
      const uRule = (state?.unifiedRules || []).find(r => r.slRule && r.slRule.identifier === ruleId);
      if (uRule && uRule.slRule) {
        vscode.postMessage({ type: 'toggleSlRule', ruleId, enabled: !uRule.slRule.optIn });
      }
    }
  });
}

function updateConfigDot(panel, el) {
  const dot = panel.querySelector('[data-dot="' + el.dataset.key + '"]');
  if (!dot) return;
  const ruleId = panel.dataset.config;
  const defVal = String((configDefaults[ruleId] || {})[el.dataset.key] || '').trim();
  dot.classList.toggle('default', el.value.trim() === defVal);
}

function updateRuleIndicators(ruleId, hasCustomConfig) {
  const row = document.querySelector('.rule-row[data-id="' + ruleId + '"]');
  if (!row) return;
  const gear = row.querySelector('.gear-btn');
  if (gear) { gear.classList.toggle('active', hasCustomConfig); }
  if (state?.slConfig) {
    if (hasCustomConfig) {
      state.slConfig.ruleConfigs[ruleId] = state.slConfig.ruleConfigs[ruleId] || {};
    } else {
      delete state.slConfig.ruleConfigs[ruleId];
    }
  }
}
`.replace(/<\//g, '<\\/');
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
