import * as vscode from 'vscode';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { SwiftFormatConfig, SwiftFormatRule } from '../types/interfaces';
import { SwiftFormatProvider } from './swiftFormatProvider';

const execFile = promisify(execFileCallback);

const SF_FORMAT_RULES = new Set([
    'AlwaysUseLiteralForEmptyCollectionInit', 'DoNotUseSemicolons', 'FileScopedDeclarationPrivacy',
    'FullyIndirectEnum', 'GroupNumericLiterals', 'NoAccessLevelOnExtensionDeclaration',
    'NoCasesWithOnlyFallthrough', 'NoEmptyLinesOpeningClosingBraces',
    'NoEmptyTrailingClosureParentheses', 'NoLabelsInCasePatterns',
    'NoParensAroundConditions', 'NoVoidReturnOnFunctionSignature', 'OmitExplicitReturns',
    'OneVariableDeclarationPerLine', 'OrderedImports', 'ReturnVoidInsteadOfEmptyTuple',
    'UseExplicitNilCheckInConditions', 'UseLetInEveryBoundCaseVariable',
    'UseShorthandTypeNames', 'UseSingleLinePropertyGetter',
    'UseTripleSlashForDocumentationComments',
]);

interface WebviewState {
    pathResolved: boolean;
    resolvedPath: string | null;
    version: string | null;
    updateAvailable: boolean;
    latestVersion: string | null;
    config: SwiftFormatConfig;
    rules: Array<SwiftFormatRule & { effectiveEnabled: boolean; isFormatRule: boolean }> | null;
    profileMode: 'local' | 'global';
}

export class CodeQualityWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private sfInstalling = false;
    private sfUpdating = false;
    private brewAvailable: boolean | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly swiftFormatProvider: SwiftFormatProvider,
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

    private postState(): void {
        if (!this.swiftFormatProvider.hasConfigFile() && this.swiftFormatProvider.isPathResolved()) {
            this.swiftFormatProvider.writeConfigFile();
        }
        this._view?.webview.postMessage({ type: 'setState', state: this.getState() });
    }

    private getState(): WebviewState {
        const config = this.swiftFormatProvider.getConfig();
        const rawRules = this.swiftFormatProvider.getRules();

        let rules: WebviewState['rules'] = null;
        if (rawRules) {
            rules = rawRules.map((r) => {
                const isDisabled = config.disabledRules.includes(r.identifier);
                const isEnabled = config.enabledRules.includes(r.identifier);
                const effectiveEnabled = (r.isDefault && !isDisabled) || isEnabled;
                const isFormatRule = SF_FORMAT_RULES.has(r.identifier);
                return { ...r, effectiveEnabled, isFormatRule };
            });
        }

        const profileMode = this.swiftFormatProvider.getProfileMode();

        return {
            pathResolved: this.swiftFormatProvider.isPathResolved(),
            resolvedPath: this.swiftFormatProvider.getResolvedPath(),
            version: this.swiftFormatProvider.getResolvedVersion(),
            updateAvailable: this.swiftFormatProvider.isUpdateAvailable(),
            latestVersion: this.swiftFormatProvider.getLatestVersion(),
            config,
            rules,
            profileMode,
        };
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

            // ── GitHub link ─────────────────────────────────

            case 'openGithub':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/apple/swift-format'));
                break;

            // ── Toggle controls ─────────────────────────────

            case 'toggleFormatOnSave': {
                const enabled = msg.value as boolean;
                await this.swiftFormatProvider.updateConfig({ formatOnSave: enabled });
                this.postState();
                break;
            }

            case 'toggleLintMode': {
                const lintEnabled = msg.value as boolean;
                await this.swiftFormatProvider.updateConfig({ lintMode: lintEnabled });
                if (!lintEnabled) {
                    this.swiftFormatProvider.lintOpenDocuments();
                }
                this.postState();
                break;
            }

            // ── Formatting options ──────────────────────────

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

            // ── Rule toggles ────────────────────────────────

            case 'toggleRule': {
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

            case 'resetRule': {
                const ruleId = msg.ruleId as string;
                const config = this.swiftFormatProvider.getConfig();
                const disabledRules = config.disabledRules.filter((r) => r !== ruleId);
                const enabledRules = config.enabledRules.filter((r) => r !== ruleId);
                await this.swiftFormatProvider.updateConfig({ disabledRules, enabledRules });
                this.postState();
                break;
            }

            case 'resetAllRules': {
                const answer = await vscode.window.showWarningMessage(
                    'Reset all swift-format rules to defaults?',
                    { modal: true },
                    'Reset',
                );
                if (answer === 'Reset') {
                    await this.swiftFormatProvider.updateConfig({ disabledRules: [], enabledRules: [] });
                    this.postState();
                }
                break;
            }

            // ── Rule config ─────────────────────────────────

            case 'fetchRuleConfig': {
                const ruleId = msg.ruleId as string;
                this._view?.webview.postMessage({
                    type: 'ruleConfigData',
                    ruleId,
                    description: msg.description as string || '',
                });
                break;
            }

            // ── Profile mode ────────────────────────────────

            case 'changeProfileMode': {
                const newMode = msg.value as 'local' | 'global';
                if (newMode === 'global') {
                    const config = this.swiftFormatProvider.getConfig();
                    const hasLocalChanges = config.disabledRules.length > 0
                        || config.enabledRules.length > 0;
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
                this.postState();
                break;
            }

            // ── Binary path change ──────────────────────────

            case 'changePath': {
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

        }
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
.hidden{display:none!important}
.add-btns{display:flex;gap:6px;padding:6px 14px}
.add-btns button,.btn-reset{padding:3px 10px;font-size:11px;border-radius:3px;border:1px solid var(--vscode-button-border,var(--vscode-input-border,rgba(128,128,128,.4)));background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.7}
.add-btns button:hover,.btn-reset:hover{opacity:1;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15))}
.config-actions{padding:4px 0 0}
.reset-options-wrap{margin-top:6px!important}
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

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'setState') { state = msg.state; render(); }
  if (msg.type === 'ruleConfigData') { showRuleConfig(msg.ruleId, msg.description); }
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

const SF_FORMAT_RULES = new Set([
  'AlwaysUseLiteralForEmptyCollectionInit', 'DoNotUseSemicolons', 'FileScopedDeclarationPrivacy',
  'FullyIndirectEnum', 'GroupNumericLiterals', 'NoAccessLevelOnExtensionDeclaration',
  'NoCasesWithOnlyFallthrough', 'NoEmptyLinesOpeningClosingBraces',
  'NoEmptyTrailingClosureParentheses', 'NoLabelsInCasePatterns',
  'NoParensAroundConditions', 'NoVoidReturnOnFunctionSignature', 'OmitExplicitReturns',
  'OneVariableDeclarationPerLine', 'OrderedImports', 'ReturnVoidInsteadOfEmptyTuple',
  'UseExplicitNilCheckInConditions', 'UseLetInEveryBoundCaseVariable',
  'UseShorthandTypeNames', 'UseSingleLinePropertyGetter',
  'UseTripleSlashForDocumentationComments',
]);

// ── Icons ─────────────────────────────────────────────────

const ghIcon = '<span class="gh-link" data-gh="sf" title="swift-format on GitHub"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.64 7.64 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></span>';

// ── Helpers ───────────────────────────────────────────────

function humanReadableName(identifier) {
  return identifier.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function boolOptionRow(label, id, value, desc, modified, defaultLabel) {
  let tip = '';
  if (desc && defaultLabel) { tip = desc + '\\nDefault: ' + defaultLabel; }
  else if (desc) { tip = desc; }
  else if (defaultLabel) { tip = 'Default: ' + defaultLabel; }
  const titleAttr = tip ? ' title="' + esc(tip) + '"' : '';
  return '<div class="row"><span' + titleAttr + '>' + label + modDot(modified) + '</span><select id="' + id + '"><option value="true"' + (value ? ' selected' : '') + '>true</option><option value="false"' + (!value ? ' selected' : '') + '>false</option></select></div>';
}

function toggleRow(label, id, checked, desc, modified, defaultLabel) {
  let tip = '';
  if (desc && defaultLabel) { tip = desc + '\\nDefault: ' + defaultLabel; }
  else if (desc) { tip = desc; }
  else if (defaultLabel) { tip = 'Default: ' + defaultLabel; }
  const titleAttr = tip ? ' title="' + esc(tip) + '"' : '';
  return '<div class="row"><span' + titleAttr + '>' + label + modDot(modified) + '</span><label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span class="slider"></span></label></div>';
}

function modDot(isModified) {
  return isModified ? '<span class="opt-modified"></span>' : '';
}

function infoIcon(text) {
  return '<span class="info-wrap"><button class="info-btn" data-info><svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.6A5.6 5.6 0 1 1 8 2.4a5.6 5.6 0 0 1 0 11.2zM7.4 5h1.2V3.8H7.4V5zm0 7.2h1.2V6.2H7.4v6z"/></svg></button><span class="info-tip">' + text + '</span></span>';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── Render ────────────────────────────────────────────────

function render() {
  if (!state) return;
  const prevSearch = document.getElementById('rules-search');
  if (prevSearch) { savedSearch = prevSearch.value; }

  const sfFound = state.pathResolved && state.resolvedPath;
  const c = state.config;

  let h = '';

  // ── Section 1: Tool Status ────────────────────────────

  h += '<div class="section">';

  h += '<div class="row"><span>swift-format' + ghIcon + '</span>';
  if (!state.pathResolved) {
    h += '<span class="value">Detecting\\u2026</span>';
  } else if (!state.resolvedPath) {
    h += '<span class="value" id="sf-path-btn">Not Found</span>';
  } else {
    h += '<span class="value" id="sf-path-btn">' + esc(state.version ? 'v' + state.version : state.resolvedPath) + '</span>';
  }
  h += '</div>';

  if (state.pathResolved && !state.resolvedPath) {
    if (state.config && state.config.path === undefined) {
      // sfInstalling is tracked via re-render
    }
    h += '<div class="add-btns" style="padding-top:4px">';
    h += '<button id="sf-install-btn">Install via Homebrew</button>';
    h += '<button id="sf-path-btn2">Set Path</button></div>';
  } else if (sfFound) {
    if (state.updateAvailable && state.latestVersion) {
      h += '<div class="update-row">v' + esc(state.latestVersion) + ' available';
      h += ' <button class="update-btn" id="sf-update-btn">Update</button>';
      h += '</div>';
    }
  }

  h += '</div>';

  // ── Section 2: Controls ───────────────────────────────

  if (sfFound) {
    h += '<div class="section">';
    h += toggleRow('Format on Save', 'toggle-formatOnSave', c.formatOnSave, 'Applies swift-format formatting when saving a Swift file.');
    h += toggleRow('Lint Mode', 'toggle-lintMode', c.lintMode, 'Shows code quality violations as diagnostics in the Problems panel.');
    h += '<div class="row"><span>Profile' + infoIcon('<b>Global</b>: options and rules shared across all projects.<br><b>Local</b>: options and rules specific to this project.') + '</span><select id="profile-select">';
    h += '<option value="global"' + (state.profileMode === 'global' ? ' selected' : '') + '>Global</option>';
    h += '<option value="local"' + (state.profileMode === 'local' ? ' selected' : '') + '>Local</option>';
    h += '</select></div>';
    h += '</div>';
  }

  // ── Section 3: Formatting Options ─────────────────────

  if (sfFound) {
    const df = {indentation:'spaces',indentationCount:4,lineLength:100,maximumBlankLines:1,respectsExistingLineBreaks:true,lineBreakBeforeControlFlowKeywords:false,lineBreakBeforeEachArgument:false,lineBreakBeforeEachGenericRequirement:false,lineBreakAroundMultilineExpressionChainComponents:false,lineBreakBeforeSwitchCaseBody:false,lineBreakBetweenDeclarationAttributes:false,indentConditionalCompilationBlocks:true,indentSwitchCaseLabels:false,fileScopedDeclarationPrivacy:'private',multiElementCollectionTrailingCommas:true,prioritizeKeepingFunctionOutputTogether:false,spacesAroundRangeFormationOperators:false,spacesBeforeEndOfLineComments:2,reflowMultilineStringLiterals:'never'};

    h += '<div class="section">';
    h += '<div class="row"><span class="label">Formatting Options</span></div>';

    h += '<div class="row"><span title="' + esc('Use spaces or tabs for indentation.\\nDefault: Spaces') + '">Indentation' + modDot(c.indentation !== df.indentation) + '</span><select id="indent-type">';
    h += '<option value="spaces"' + (c.indentation === 'spaces' ? ' selected' : '') + '>Spaces</option>';
    h += '<option value="tabs"' + (c.indentation === 'tabs' ? ' selected' : '') + '>Tabs</option>';
    h += '</select></div>';

    if (c.indentation === 'spaces') {
      h += '<div class="row"><span title="' + esc('Number of spaces per indentation level.\\nDefault: 4') + '">Indent Width' + modDot(c.indentationCount !== df.indentationCount) + '</span><input type="number" id="indent-count" value="' + c.indentationCount + '" min="1" max="8"></div>';
    }

    h += '<div class="row"><span title="' + esc('Maximum number of characters per line before wrapping.\\nDefault: 100') + '">Line Length' + modDot(c.lineLength !== df.lineLength) + '</span><input type="number" id="lineLength" value="' + c.lineLength + '" min="1" max="999"></div>';

    h += '<div class="row"><span title="' + esc('Maximum number of consecutive blank lines allowed.\\nDefault: 1') + '">Max Blank Lines' + modDot(c.maximumBlankLines !== df.maximumBlankLines) + '</span><input type="number" id="maximumBlankLines" value="' + c.maximumBlankLines + '" min="0" max="10"></div>';

    h += boolOptionRow('Respects Existing Line Breaks', 'opt-respectsExistingLineBreaks', c.respectsExistingLineBreaks, 'Preserves existing line breaks in source code.', c.respectsExistingLineBreaks !== df.respectsExistingLineBreaks, 'true');
    h += boolOptionRow('Break Before Control Flow Keywords', 'opt-lineBreakBeforeControlFlowKeywords', c.lineBreakBeforeControlFlowKeywords, 'Places else, catch on a new line.', c.lineBreakBeforeControlFlowKeywords !== df.lineBreakBeforeControlFlowKeywords, 'false');
    h += boolOptionRow('Break Before Each Argument', 'opt-lineBreakBeforeEachArgument', c.lineBreakBeforeEachArgument, 'Each argument on its own line when wrapping.', c.lineBreakBeforeEachArgument !== df.lineBreakBeforeEachArgument, 'false');
    h += boolOptionRow('Break Before Generic Requirements', 'opt-lineBreakBeforeEachGenericRequirement', c.lineBreakBeforeEachGenericRequirement, 'Each generic requirement on its own line.', c.lineBreakBeforeEachGenericRequirement !== df.lineBreakBeforeEachGenericRequirement, 'false');
    h += boolOptionRow('Break Around Multiline Chains', 'opt-lineBreakAroundMultilineExpressionChainComponents', c.lineBreakAroundMultilineExpressionChainComponents, 'Adds line breaks around multiline chain components.', c.lineBreakAroundMultilineExpressionChainComponents !== df.lineBreakAroundMultilineExpressionChainComponents, 'false');
    h += boolOptionRow('Break Before Switch Case Body', 'opt-lineBreakBeforeSwitchCaseBody', c.lineBreakBeforeSwitchCaseBody, 'Case body on line after the label.', c.lineBreakBeforeSwitchCaseBody !== df.lineBreakBeforeSwitchCaseBody, 'false');
    h += boolOptionRow('Break Between Declaration Attributes', 'opt-lineBreakBetweenDeclarationAttributes', c.lineBreakBetweenDeclarationAttributes, 'Places each declaration attribute on its own line.', c.lineBreakBetweenDeclarationAttributes !== df.lineBreakBetweenDeclarationAttributes, 'false');
    h += boolOptionRow('Indent #if/#else Blocks', 'opt-indentConditionalCompilationBlocks', c.indentConditionalCompilationBlocks, 'Indents code inside conditional compilation blocks.', c.indentConditionalCompilationBlocks !== df.indentConditionalCompilationBlocks, 'true');
    h += boolOptionRow('Indent Switch Case Labels', 'opt-indentSwitchCaseLabels', c.indentSwitchCaseLabels, 'Indents case labels relative to switch.', c.indentSwitchCaseLabels !== df.indentSwitchCaseLabels, 'false');

    h += '<div class="row"><span title="' + esc('File-scoped declarations use private or fileprivate.\\nDefault: private') + '">File-Scoped Privacy' + modDot(c.fileScopedDeclarationPrivacy !== df.fileScopedDeclarationPrivacy) + '</span><select id="fileScopedDeclarationPrivacy">';
    h += '<option value="private"' + (c.fileScopedDeclarationPrivacy === 'private' ? ' selected' : '') + '>private</option>';
    h += '<option value="fileprivate"' + (c.fileScopedDeclarationPrivacy === 'fileprivate' ? ' selected' : '') + '>fileprivate</option>';
    h += '</select></div>';

    h += boolOptionRow('Trailing Commas', 'opt-multiElementCollectionTrailingCommas', c.multiElementCollectionTrailingCommas, 'Adds trailing comma after last element in multi-line collections.', c.multiElementCollectionTrailingCommas !== df.multiElementCollectionTrailingCommas, 'true');
    h += boolOptionRow('Prioritize Function Output Together', 'opt-prioritizeKeepingFunctionOutputTogether', c.prioritizeKeepingFunctionOutputTogether, 'Keeps the return type on the same line as the closing parenthesis when wrapping.', c.prioritizeKeepingFunctionOutputTogether !== df.prioritizeKeepingFunctionOutputTogether, 'false');
    h += boolOptionRow('Spaces Around Range Operators', 'opt-spacesAroundRangeFormationOperators', c.spacesAroundRangeFormationOperators, 'Adds spaces around range operators (... and ..<).', c.spacesAroundRangeFormationOperators !== df.spacesAroundRangeFormationOperators, 'false');

    h += '<div class="row"><span title="' + esc('Number of spaces before end-of-line comments.\\nDefault: 2') + '">Spaces Before EOL Comments' + modDot(c.spacesBeforeEndOfLineComments !== df.spacesBeforeEndOfLineComments) + '</span><input type="number" id="spacesBeforeEndOfLineComments" value="' + c.spacesBeforeEndOfLineComments + '" min="1" max="10"></div>';

    h += '<div class="row"><span title="' + esc('Controls whether multiline string literals are reflowed to fit line length.\\nDefault: never') + '">Reflow Multiline Strings' + modDot(c.reflowMultilineStringLiterals !== df.reflowMultilineStringLiterals) + '</span><select id="reflowMultilineStringLiterals">';
    h += '<option value="never"' + (c.reflowMultilineStringLiterals === 'never' ? ' selected' : '') + '>never</option>';
    h += '<option value="always"' + (c.reflowMultilineStringLiterals === 'always' ? ' selected' : '') + '>always</option>';
    h += '</select></div>';

    h += '<div class="reset-options-wrap"><button class="btn-reset" id="reset-options-btn">Reset Options to Defaults</button></div>';
    h += '</div>';
  }

  // ── Section 4: Rules ──────────────────────────────────

  const rules = state.rules || [];

  if (rules.length > 0) {
    const enabledCount = rules.filter(r => r.effectiveEnabled).length;
    const totalCount = rules.length;

    h += '<div class="rules-header"><span class="label">Rules</span><span class="badge">' + enabledCount + ' / ' + totalCount + '</span></div>';
    h += '<div class="search-wrap" id="search-wrap"><input type="text" class="search" id="rules-search" placeholder="Filter rules..."><button class="search-clear" id="search-clear" title="Clear"><svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708z"/></svg></button></div>';

    // Format Rules group
    const nameSort = (a, b) => humanReadableName(a.identifier).localeCompare(humanReadableName(b.identifier));
    const formatRules = rules.filter(r => r.isFormatRule).sort(nameSort);
    const lintRules = rules.filter(r => !r.isFormatRule).sort(nameSort);

    if (formatRules.length > 0) {
      const fmtEnabled = formatRules.filter(r => r.effectiveEnabled).length;
      const gc = (groupCollapsed['format'] ?? true) ? ' collapsed' : '';
      h += '<div class="group-header' + gc + '" data-group="format"><span class="group-chevron"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4z"/></svg></span>Format Rules (' + fmtEnabled + ' / ' + formatRules.length + ')</div>';
      h += '<div class="group-body' + gc + '" data-group-body="format">';
      for (const r of formatRules) { h += ruleRow(r); }
      h += '</div>';
    }

    if (lintRules.length > 0) {
      const lintEnabled = lintRules.filter(r => r.effectiveEnabled).length;
      const gc = (groupCollapsed['lint'] ?? true) ? ' collapsed' : '';
      h += '<div class="group-header' + gc + '" data-group="lint"><span class="group-chevron"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4z"/></svg></span>Lint Rules (' + lintEnabled + ' / ' + lintRules.length + ')</div>';
      h += '<div class="group-body' + gc + '" data-group-body="lint">';
      for (const r of lintRules) { h += ruleRow(r); }
      h += '</div>';
    }

    h += '<div class="add-btns" style="padding-top:4px"><button id="reset-all-btn">Reset All Rules to Defaults</button></div>';
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
      vscode.postMessage({ type: 'fetchRuleConfig', ruleId: openConfigRuleId, description: ruleDescs[openConfigRuleId] || '' });
    }
  }
}

// ── Rule row ──────────────────────────────────────────────

function ruleRow(r) {
  const enabled = r.effectiveEnabled;
  const ruleId = r.identifier;
  const modified = r.isDefault ? !enabled : enabled;
  const displayName = humanReadableName(ruleId);

  let row = '<div class="rule-row" data-id="' + esc(ruleId) + '" data-display="' + esc(displayName) + '" data-group="' + (r.isFormatRule ? 'format' : 'lint') + '">';
  row += '<label class="switch"><input type="checkbox" data-rule="' + esc(ruleId) + '"' + (enabled ? ' checked' : '') + '><span class="slider"></span></label>';
  row += '<span class="rule-name">' + esc(displayName) + '</span>';
  if (modified) row += '<span class="rule-modified" title="Modified from default"></span>';
  row += '<button class="gear-btn" data-gear="' + esc(ruleId) + '" title="Configure">\\u2699</button>';
  row += '</div>';
  row += '<div class="rule-config hidden" data-config="' + esc(ruleId) + '"></div>';

  return row;
}

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
  document.querySelector('[data-gh="sf"]')?.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'openGithub' }); });
  document.getElementById('sf-path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
  document.getElementById('sf-path-btn2')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
  document.getElementById('sf-install-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'installSwiftFormat' }));
  document.getElementById('sf-update-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'updateSwiftFormat' }));

  // Controls
  document.getElementById('toggle-formatOnSave')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleFormatOnSave', value: e.target.checked }));
  document.getElementById('toggle-lintMode')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleLintMode', value: e.target.checked }));
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
      vscode.postMessage({ type: 'updateOption', key: opt, value: e.target.value === 'true' });
    });
  }

  document.getElementById('reset-options-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'resetOptions' }));

  // Rule toggles
  document.querySelectorAll('input[data-rule]').forEach(cb => {
    cb.addEventListener('change', e => vscode.postMessage({ type: 'toggleRule', ruleId: e.target.dataset.rule, enabled: e.target.checked }));
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

  // Gear buttons (rule config)
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
    document.querySelectorAll('.gear-btn.active').forEach(b => { b.classList.remove('active'); });
    if (btn) { btn.classList.add('active'); }
    panel.classList.remove('hidden');
    openConfigRuleId = ruleId;
    panel.innerHTML = '<div class="not-found">Loading...</div>';
    const desc = ruleDescs[ruleId] || '';
    vscode.postMessage({ type: 'fetchRuleConfig', ruleId, description: desc });
  }

  document.querySelectorAll('.gear-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleRuleConfig(btn.dataset.gear); });
  });

  // Click on rule row to open config
  document.querySelectorAll('.rule-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.switch') || e.target.closest('.gear-btn')) return;
      const gear = row.querySelector('.gear-btn');
      if (gear) { toggleRuleConfig(gear.dataset.gear); }
    });
  });

  // Reset all
  document.getElementById('reset-all-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'resetAllRules' }));
}

// ── Rule config panel ─────────────────────────────────────

function showRuleConfig(ruleId, description) {
  const panel = document.querySelector('[data-config="' + ruleId + '"]');
  if (!panel) return;

  const rule = (state?.rules || []).find(r => r.identifier === ruleId);
  const defaultLabel = rule && rule.isDefault ? 'Enabled' : 'Disabled';
  const descFromMap = ruleDescs[ruleId] || description || '';
  let descText = descFromMap;
  if (descText) { descText += ' Default: ' + defaultLabel + '.'; }
  else { descText = 'Default: ' + defaultLabel + '.'; }
  let h = '<div class="config-desc">' + esc(descText) + '</div>';
  h += '<div class="config-actions"><button class="btn-reset" data-reset-rule="' + esc(ruleId) + '">Reset to Default</button></div>';
  panel.innerHTML = h;
  panel.querySelectorAll('[data-reset-rule]').forEach(btn => {
    btn.addEventListener('click', () => { vscode.postMessage({ type: 'resetRule', ruleId: btn.dataset.resetRule }); });
  });
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
