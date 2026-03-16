import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { SwiftLintConfig, SwiftLintRule } from '../types/interfaces';
import { SwiftLintProvider, fetchRuleDefaultConfig } from './swiftLintProvider';

const execFile = promisify(execFileCallback);

interface WebviewState {
    pathResolved: boolean;
    resolvedPath: string | null;
    version: string | null;
    config: SwiftLintConfig;
    rules: Array<SwiftLintRule & { enabled: boolean; hasConfig: boolean }> | null;
    installing: boolean;
    brewAvailable: boolean;
}

export class LinterWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private ruleDefaultsCache = new Map<string, Record<string, string>>();
    private installing = false;
    private brewAvailable: boolean | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly swiftLintProvider: SwiftLintProvider,
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
        const config = this.swiftLintProvider.getConfig();
        const rawRules = this.swiftLintProvider.getRules();
        let rules: WebviewState['rules'] = null;

        if (rawRules) {
            const lintRules = rawRules.filter((r) => !r.analyzer);
            rules = lintRules.map((r) => {
                const isDefault = !r.optIn;
                const isDisabled = config.disabledRules.includes(r.identifier);
                const isOptedIn = config.optInRules.includes(r.identifier);
                const enabled = (isDefault && !isDisabled) || isOptedIn;
                const hasConfig = !!config.ruleConfigs[r.identifier] || this.ruleDefaultsCache.has(r.identifier);
                return { ...r, enabled, hasConfig };
            });
        }

        return {
            pathResolved: this.swiftLintProvider.isPathResolved(),
            resolvedPath: this.swiftLintProvider.getResolvedPath(),
            version: this.swiftLintProvider.getResolvedVersion(),
            config,
            rules,
            installing: this.installing,
            brewAvailable: this.brewAvailable ?? false,
        };
    }

    private postState(): void {
        this._view?.webview.postMessage({ type: 'setState', state: this.getState() });
    }

    // ── Messages ─────────────────────────────────────────────

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'ready':
                if (this.brewAvailable === null) {
                    this.brewAvailable = await this.checkBrewAvailable();
                }
                this.postState();
                break;

            case 'installSwiftLint': {
                this.installing = true;
                this.postState();

                const brewPath = await this.findBrew();
                if (!brewPath) {
                    vscode.window.showErrorMessage('Homebrew not found. Install it from https://brew.sh');
                    this.installing = false;
                    this.postState();
                    break;
                }

                try {
                    await execFile(brewPath, ['install', 'swiftlint'], { encoding: 'utf8', timeout: 300000 });
                    await this.swiftLintProvider.resolvePathAndVersion();
                    vscode.window.showInformationMessage('SwiftLint installed successfully.');
                } catch (error: unknown) {
                    const message = (error as { stderr?: string }).stderr || 'Installation failed';
                    vscode.window.showErrorMessage(`SwiftLint install failed: ${message.split('\n')[0]}`);
                }

                this.installing = false;
                this.postState();
                break;
            }

            case 'openInstallGuide':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/realm/SwiftLint'));
                break;

            case 'openInstallInstructions':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/realm/SwiftLint#installation'));
                break;

            case 'toggleEnabled':
                await this.swiftLintProvider.updateConfig({ enabled: msg.value as boolean });
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

            case 'toggleRule': {
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

            case 'fetchRuleConfig': {
                const ruleId = msg.ruleId as string;
                const resolvedPath = this.swiftLintProvider.getResolvedPath();
                if (!resolvedPath) { break; }

                let defaults = this.ruleDefaultsCache.get(ruleId);
                if (!defaults) {
                    defaults = await fetchRuleDefaultConfig(resolvedPath, ruleId);
                    if (Object.keys(defaults).length > 0) {
                        this.ruleDefaultsCache.set(ruleId, defaults);
                    }
                }

                const config = this.swiftLintProvider.getConfig();
                const current = config.ruleConfigs[ruleId] || null;

                this._view?.webview.postMessage({
                    type: 'ruleConfigData',
                    ruleId,
                    defaults,
                    current,
                });
                break;
            }

            case 'updateRuleConfig': {
                const ruleId = msg.ruleId as string;
                const newConfig = msg.config as Record<string, string>;
                const config = this.swiftLintProvider.getConfig();
                const defaults = this.ruleDefaultsCache.get(ruleId) || {};

                const ruleConfigs = { ...config.ruleConfigs };
                const isDefault = Object.keys(newConfig).length === Object.keys(defaults).length
                    && Object.entries(newConfig).every(([k, v]) => defaults[k] === v);

                if (isDefault || Object.keys(newConfig).length === 0) {
                    delete ruleConfigs[ruleId];
                } else {
                    ruleConfigs[ruleId] = newConfig;
                }

                await this.swiftLintProvider.updateConfig({ ruleConfigs });
                // Send lightweight update instead of full re-render to avoid flash
                this._view?.webview.postMessage({
                    type: 'ruleConfigUpdated',
                    ruleId,
                    hasCustomConfig: ruleId in (this.swiftLintProvider.getConfig().ruleConfigs),
                });
                break;
            }

            case 'resetAllRules': {
                const answer = await vscode.window.showWarningMessage(
                    'Reset all rules and rule configs to defaults?',
                    { modal: true },
                    'Reset',
                );
                if (answer === 'Reset') {
                    await this.swiftLintProvider.updateConfig({
                        disabledRules: [],
                        optInRules: [],
                        ruleConfigs: {},
                    });
                    this.ruleDefaultsCache.clear();
                    this.postState();
                }
                break;
            }

            case 'changePath': {
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
/* toggle switch */
.switch{position:relative;width:34px;height:18px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:9px;cursor:pointer;transition:background .2s}
.slider::before{content:'';position:absolute;height:12px;width:12px;left:2px;top:2px;background:var(--vscode-foreground);border-radius:50%;transition:transform .2s;opacity:.5}
.switch input:checked+.slider{background:var(--vscode-button-background)}
.switch input:checked+.slider::before{transform:translateX(16px);opacity:1}
/* rules */
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
.rule-row{display:flex;align-items:center;padding:3px 14px;gap:8px;min-height:26px}
.rule-row:hover{background:var(--vscode-list-hoverBackground)}
.rule-row .switch{width:28px;height:15px}
.rule-row .slider::before{height:9px;width:9px;left:2px;top:2px}
.rule-row .switch input:checked+.slider::before{transform:translateX(13px)}
.rule-name{flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;user-select:none}
.rule-tags{font-size:10px;opacity:.45;white-space:nowrap}
.rule-modified{width:6px;height:6px;border-radius:50%;background:var(--vscode-button-background);flex-shrink:0;margin-left:2px}
.gear-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.4;font-size:13px;padding:2px 4px;line-height:1}
.gear-btn:hover{opacity:1}
.gear-btn.active{opacity:1;color:var(--vscode-button-background)}
.rule-config{padding:6px 14px 8px 50px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.1))}
.config-modified{width:5px;height:5px;border-radius:50%;background:var(--vscode-button-background);flex-shrink:0;visibility:visible}
.config-modified.default{visibility:hidden}
.config-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px}
.config-row label{flex:1;opacity:.7;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.config-row input,.config-row textarea{width:80px;flex-shrink:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:3px;padding:2px 6px;font-size:11px;font-family:var(--vscode-font-family);outline:none;text-align:right;-moz-appearance:textfield}
.config-row input::-webkit-outer-spin-button,.config-row input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.config-row textarea{resize:none;overflow:hidden;height:20px;line-height:14px;white-space:nowrap}
.config-row textarea:focus{white-space:pre-wrap;word-break:break-all;text-align:left}
.config-row textarea.expand-w:focus,.config-row input.expand-w:focus{width:120px}
.config-row select{width:80px;flex-shrink:0;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:3px;padding:2px 6px;font-size:11px;outline:none;cursor:pointer;text-align:right}
.config-row input:focus{border-color:var(--vscode-focusBorder)}
.config-actions{display:flex;gap:6px;margin-top:6px}
.config-actions button{padding:2px 10px;font-size:11px;border-radius:3px;border:none;cursor:pointer}
.btn-reset{background:transparent;color:var(--vscode-foreground);opacity:.6;border:1px solid var(--vscode-input-border,rgba(128,128,128,.4))}
.btn-reset:hover{opacity:1}
.reset-all-btn{background:none;border:none;cursor:pointer;opacity:.35;padding:2px 4px;line-height:1;display:inline-flex;align-items:center}
.reset-all-btn:hover{opacity:.8}
.reset-all-btn svg{width:14px;height:14px;fill:var(--vscode-foreground)}
/* excluded */
.excluded-row{display:flex;align-items:center;padding:2px 14px;gap:6px;font-size:12px}
.excluded-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.remove-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.3;font-size:14px;padding:0 4px}
.remove-btn:hover{opacity:1;color:var(--vscode-errorForeground)}
.add-btns{display:flex;gap:6px;padding:6px 14px}
.add-btns button{padding:2px 8px;font-size:11px;border-radius:3px;border:1px solid var(--vscode-button-border,var(--vscode-input-border,rgba(128,128,128,.4)));background:transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.7}
.add-btns button:hover{opacity:1;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.1))}
.hidden{display:none!important}
.not-found{padding:10px 14px;opacity:.6;font-size:12px}
</style>
</head>
<body>
<div id="app">
  <div class="not-found" id="loading">Detecting SwiftLint...</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
let state = null;
const groupCollapsed = {}; // tracks user's manual collapse state per kind
let savedSearch = '';
let openConfigRuleId = null;

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'setState') { state = msg.state; render(); }
  if (msg.type === 'ruleConfigData') { showRuleConfig(msg.ruleId, msg.defaults, msg.current); }
  if (msg.type === 'ruleConfigUpdated') { updateRuleIndicators(msg.ruleId, msg.hasCustomConfig); }
});

vscode.postMessage({ type: 'ready' });

const ghIcon = '<span class="gh-link" id="gh-link" title="SwiftLint on GitHub"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.64 7.64 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></span>';

function render() {
  if (!state) return;
  // Save transient UI state before re-render
  const prevSearch = document.getElementById('rules-search');
  if (prevSearch) { savedSearch = prevSearch.value; }
  if (!state.pathResolved) { app.innerHTML = '<div class="not-found">Detecting SwiftLint...</div>'; return; }
  if (!state.resolvedPath) {
    let nf = '<div class="section"><div class="row"><span>SwiftLint' + ghIcon + '</span><span class="value" id="path-btn">Not Found</span></div>';
    if (state.installing) {
      nf += '<div class="not-found">Installing via Homebrew\u2026</div>';
    } else {
      nf += '<div class="add-btns" style="padding-top:8px">';
      if (state.brewAvailable) { nf += '<button id="install-btn">Install via Homebrew</button>'; }
      else { nf += '<button id="manual-install-btn">Installation Guide</button>'; }
      nf += '<button id="path-btn2">Set Custom Path</button></div>';
    }
    nf += '</div>';
    app.innerHTML = nf;
    document.getElementById('path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
    document.getElementById('path-btn2')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
    document.getElementById('install-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'installSwiftLint' }));
    document.getElementById('manual-install-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'openInstallInstructions' }));
    return;
  }

  const c = state.config;
  const rules = state.rules || [];
  const kinds = ['style','lint','idiomatic','metrics','performance'];
  const enabledCount = rules.filter(r => r.enabled).length;

  let h = '';
  // header
  h += '<div class="section">';
  h += '<div class="row"><span>SwiftLint' + ghIcon + '</span><span class="value" id="path-btn">' + esc(state.version ? 'v' + state.version : state.resolvedPath) + '</span></div>';
  h += '</div>';

  // toggles + severity
  h += '<div class="section">';
  h += toggleRow('Enabled', 'toggle-enabled', c.enabled);
  h += toggleRow('Fix on Save', 'toggle-fixOnSave', c.fixOnSave);
  h += '<div class="row"><span>Severity</span><select id="severity-select">';
  for (const v of ['normal','strict','lenient']) {
    h += '<option value="' + v + '"' + (c.severity === v ? ' selected' : '') + '>' + v.charAt(0).toUpperCase() + v.slice(1) + '</option>';
  }
  h += '</select></div></div>';

  // rules
  h += '<div class="rules-header"><span class="label">Rules</span><span class="badge">' + enabledCount + ' / ' + rules.length + '</span><button class="reset-all-btn" id="reset-all-btn" title="Reset all rules to defaults"><svg viewBox="0 0 16 16"><path d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 1 0 1.563-4.163l-.755-.657A6 6 0 1 1 2.006 8.267z"/></svg></button></div>';
  h += '<div class="search-wrap" id="search-wrap"><input type="text" class="search" id="rules-search" placeholder="Filter rules..."><button class="search-clear" id="search-clear" title="Clear"><svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708z"/></svg></button></div>';

  for (const kind of kinds) {
    const group = rules.filter(r => r.kind === kind);
    if (!group.length) continue;
    const gc = (groupCollapsed[kind] ?? true) ? ' collapsed' : '';
    h += '<div class="group-header' + gc + '" data-kind="' + kind + '" data-group="' + kind + '"><span class="group-chevron"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4z"/></svg></span>' + kind.charAt(0).toUpperCase() + kind.slice(1) + ' (' + group.length + ')</div>';
    h += '<div class="group-body' + gc + '" data-group-body="' + kind + '">';
    for (const r of group) {
      const tags = [];
      if (r.optIn) tags.push('opt-in');
      if (r.correctable) tags.push('fixable');
      const hasCustomConfig = !!c.ruleConfigs[r.identifier];
      const toggleChanged = r.optIn ? r.enabled : !r.enabled;
      const modified = toggleChanged || hasCustomConfig;
      const gearClass = hasCustomConfig ? ' active' : '';
      h += '<div class="rule-row" data-id="' + r.identifier + '" data-kind="' + kind + '">';
      h += '<label class="switch"><input type="checkbox" data-rule="' + r.identifier + '"' + (r.enabled ? ' checked' : '') + '><span class="slider"></span></label>';
      h += '<span class="rule-name">' + esc(r.identifier) + '</span>';
      if (modified) h += '<span class="rule-modified" title="Modified from default"></span>';
      if (tags.length) h += '<span class="rule-tags">' + tags.join(', ') + '</span>';
      h += '<button class="gear-btn' + gearClass + '" data-gear="' + r.identifier + '" title="Configure">\u2699</button>';
      h += '</div>';
      h += '<div class="rule-config hidden" data-config="' + r.identifier + '"></div>';
    }
    h += '</div>';
  }

  // excluded
  h += '<div class="section" style="border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2));margin-top:4px">';
  h += '<div class="row"><span class="label">Excluded Paths</span></div>';
  for (const p of c.excludedPaths) {
    h += '<div class="excluded-row"><span>' + esc(p) + '</span><button class="remove-btn" data-remove="' + esc(p) + '">\u00d7</button></div>';
  }
  h += '<div class="add-btns"><button id="add-path-btn">+ Path</button><button id="add-folder-btn">+ Folder</button></div>';
  h += '</div>';

  app.innerHTML = h;
  bind();
  // Restore search text and re-apply filter
  if (savedSearch) {
    const si = document.getElementById('rules-search');
    if (si) { si.value = savedSearch; applySearch(); }
  }
  // Restore open config panel
  if (openConfigRuleId) {
    const panel = document.querySelector('[data-config="' + openConfigRuleId + '"]');
    const btn = document.querySelector('[data-gear="' + openConfigRuleId + '"]');
    if (panel && btn) {
      panel.classList.remove('hidden');
      btn.classList.add('active');
      vscode.postMessage({ type: 'fetchRuleConfig', ruleId: openConfigRuleId });
    }
  }
}

function toggleRow(label, id, checked) {
  return '<div class="row"><span>' + label + '</span><label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span class="slider"></span></label></div>';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function applySearch() {
  const searchInput = document.getElementById('rules-search');
  const searchWrap = document.getElementById('search-wrap');
  const q = (searchInput?.value || '').toLowerCase();
  searchWrap?.classList.toggle('has-value', q.length > 0);
  document.querySelectorAll('.rule-row').forEach(row => {
    const id = row.dataset.id || '';
    row.classList.toggle('hidden', q.length > 0 && !id.includes(q));
  });
  document.querySelectorAll('.group-header').forEach(gh => {
    const kind = gh.dataset.group;
    const body = document.querySelector('[data-group-body="' + kind + '"]');
    const hasVisible = body ? body.querySelectorAll('.rule-row:not(.hidden)').length > 0 : false;
    gh.classList.toggle('hidden', !hasVisible);
    if (body) body.classList.toggle('hidden', !hasVisible);
    if (q.length > 0) {
      const expanded = hasVisible;
      gh.classList.toggle('collapsed', !expanded);
      if (body) body.classList.toggle('collapsed', !expanded);
    } else {
      const collapsed = groupCollapsed[kind] ?? true;
      gh.classList.toggle('collapsed', collapsed);
      if (body) body.classList.toggle('collapsed', collapsed);
    }
  });
}

function bind() {
  document.getElementById('path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
  document.getElementById('gh-link')?.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'openInstallGuide' }); });
  document.getElementById('toggle-enabled')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleEnabled', value: e.target.checked }));
  document.getElementById('toggle-fixOnSave')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleFixOnSave', value: e.target.checked }));
  document.getElementById('severity-select')?.addEventListener('change', e => vscode.postMessage({ type: 'changeSeverity', value: e.target.value }));

  // Initialize user collapse state for any new groups
  document.querySelectorAll('.group-header').forEach(gh => {
    const kind = gh.dataset.group;
    if (!(kind in groupCollapsed)) { groupCollapsed[kind] = true; }
  });

  document.getElementById('rules-search')?.addEventListener('input', applySearch);
  document.getElementById('search-clear')?.addEventListener('click', () => {
    const si = document.getElementById('rules-search');
    if (si) { si.value = ''; }
    savedSearch = '';
    applySearch();
    si?.focus();
  });

  document.querySelectorAll('input[data-rule]').forEach(cb => {
    cb.addEventListener('change', e => vscode.postMessage({ type: 'toggleRule', ruleId: e.target.dataset.rule, enabled: e.target.checked }));
  });

  document.querySelectorAll('.group-header').forEach(gh => {
    gh.addEventListener('click', () => {
      const kind = gh.dataset.group;
      const body = document.querySelector('[data-group-body="' + kind + '"]');
      if (!body) return;
      const isCollapsed = !gh.classList.contains('collapsed');
      gh.classList.toggle('collapsed', isCollapsed);
      body.classList.toggle('collapsed', isCollapsed);
      groupCollapsed[kind] = isCollapsed;
    });
  });

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
    document.querySelectorAll('.gear-btn.active').forEach(b => { if (!state?.config?.ruleConfigs[b.dataset.gear]) b.classList.remove('active'); });
    if (btn) { btn.classList.add('active'); }
    panel.classList.remove('hidden');
    openConfigRuleId = ruleId;
    panel.innerHTML = '<div class="not-found">Loading...</div>';
    vscode.postMessage({ type: 'fetchRuleConfig', ruleId });
  }

  document.querySelectorAll('.gear-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleRuleConfig(btn.dataset.gear));
  });

  document.querySelectorAll('.rule-name').forEach(name => {
    const row = name.closest('.rule-row');
    if (row) { name.addEventListener('click', () => toggleRuleConfig(row.dataset.id)); }
  });

  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'removeExcludedPath', path: btn.dataset.remove }));
  });
  document.getElementById('add-path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'addExcludedPath' }));
  document.getElementById('add-folder-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'addExcludedFolder' }));
  document.getElementById('reset-all-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'resetAllRules' }));
}

function updateRuleIndicators(ruleId, hasCustomConfig) {
  const row = document.querySelector('.rule-row[data-id="' + ruleId + '"]');
  if (!row) return;
  const gear = row.querySelector('.gear-btn');
  if (gear) { gear.classList.toggle('active', hasCustomConfig); }
  // Update modified dot: check toggle state + config
  const rule = (state?.rules || []).find(r => r.identifier === ruleId);
  if (rule) {
    const toggleChanged = rule.optIn ? rule.enabled : !rule.enabled;
    const modified = toggleChanged || hasCustomConfig;
    let dot = row.querySelector('.rule-modified');
    if (modified && !dot) {
      dot = document.createElement('span');
      dot.className = 'rule-modified';
      dot.title = 'Modified from default';
      const name = row.querySelector('.rule-name');
      if (name) { name.after(dot); }
    } else if (!modified && dot) {
      dot.remove();
    }
  }
  // Update internal state so next full render is consistent
  if (state?.config) {
    if (hasCustomConfig) {
      state.config.ruleConfigs[ruleId] = state.config.ruleConfigs[ruleId] || {};
    } else {
      delete state.config.ruleConfigs[ruleId];
    }
  }
}

function showRuleConfig(ruleId, defaults, current) {
  const panel = document.querySelector('[data-config="' + ruleId + '"]');
  if (!panel) return;
  const defs = defaults || {};
  const vals = current || defs;
  const entries = Object.entries(defs);
  if (!entries.length) { panel.innerHTML = '<div style="opacity:.5;font-size:11px;padding:4px 0">No configurable parameters</div>'; return; }
  let h = '';
  for (const [key, defRaw] of entries) {
    const defVal = String(defRaw).trim();
    const sv = String(vals[key] ?? defRaw).trim();
    const changed = sv !== defVal;
    const isBool = sv === 'true' || sv === 'false';
    h += '<div class="config-row">';
    h += '<span class="config-modified' + (changed ? '' : ' default') + '" data-dot="' + esc(key) + '"></span>';
    h += '<label title="' + esc(key) + ' (default: ' + esc(defVal) + ')">' + esc(key) + '</label>';
    if (isBool) {
      h += '<select data-key="' + esc(key) + '" data-default="' + esc(defVal) + '" title="' + esc(key) + ': ' + esc(sv) + '"><option value="true"' + (sv === 'true' ? ' selected' : '') + '>true</option><option value="false"' + (sv === 'false' ? ' selected' : '') + '>false</option></select>';
    } else {
      const isNum = /^\d+$/.test(defVal);
      if (isNum) {
        h += '<input type="number" data-key="' + esc(key) + '" data-default="' + esc(defVal) + '" value="' + esc(sv) + '" title="' + esc(key) + ': ' + esc(sv) + ' (default: ' + esc(defVal) + ')" min="0">';
      } else {
        h += '<textarea data-key="' + esc(key) + '" data-default="' + esc(defVal) + '" rows="1" title="' + esc(key) + ': ' + esc(sv) + ' (default: ' + esc(defVal) + ')">' + esc(sv) + '</textarea>';
      }
    }
    h += '</div>';
  }
  h += '<div class="config-actions"><button class="btn-reset" data-reset="' + ruleId + '">Reset to Defaults</button></div>';
  panel.innerHTML = h;

  function autoSave() {
    const config = {};
    panel.querySelectorAll('[data-key]').forEach(el => { config[el.dataset.key] = el.value; });
    vscode.postMessage({ type: 'updateRuleConfig', ruleId, config });
  }

  // Auto-save: dropdowns save immediately, text inputs save on Enter/blur
  panel.querySelectorAll('select[data-key]').forEach(el => {
    el.addEventListener('change', () => { updateConfigDot(panel, el); autoSave(); });
  });
  panel.querySelectorAll('input[data-key], textarea[data-key]').forEach(el => {
    function checkOverflow() { el.classList.toggle('expand-w', el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight); }
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') { el.blur(); } });
    el.addEventListener('focus', checkOverflow);
    el.addEventListener('input', checkOverflow);
    el.addEventListener('blur', () => {
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
  });
}

function updateConfigDot(panel, el) {
  const dot = panel.querySelector('[data-dot="' + el.dataset.key + '"]');
  if (dot) { dot.classList.toggle('default', el.value.trim() === (el.dataset.default || '').trim()); }
}
</script>
</body>
</html>`;
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
