import * as vscode from 'vscode';
import * as path from 'path';
import type { SwiftLintConfig, SwiftLintRule } from '../types/interfaces';
import { SwiftLintProvider, fetchRuleDefaultConfig } from './swiftLintProvider';

interface WebviewState {
    pathResolved: boolean;
    resolvedPath: string | null;
    version: string | null;
    config: SwiftLintConfig;
    rules: Array<SwiftLintRule & { enabled: boolean; hasConfig: boolean }> | null;
}

export class LinterWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private ruleDefaultsCache = new Map<string, Record<string, string>>();

    constructor(
        private readonly extensionUri: vscode.Uri,
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
        };
    }

    private postState(): void {
        this._view?.webview.postMessage({ type: 'setState', state: this.getState() });
    }

    // ── Messages ─────────────────────────────────────────────

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.postState();
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
                const current = config.ruleConfigs[ruleId] || defaults;

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
                this.postState();
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

    // ── HTML ─────────────────────────────────────────────────

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0}
.section{padding:10px 14px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}
.row{display:flex;align-items:center;justify-content:space-between;min-height:28px}
.row+.row{margin-top:6px}
.label{opacity:.85;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.value{cursor:pointer;opacity:.7;font-size:12px}
.value:hover{opacity:1}
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
.search{display:block;width:calc(100% - 28px);margin:0 14px 8px;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:3px;font-size:12px;outline:none}
.search:focus{border-color:var(--vscode-focusBorder)}
.group-header{padding:4px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.5;background:var(--vscode-sideBar-background,transparent)}
.rule-row{display:flex;align-items:center;padding:3px 14px;gap:8px;min-height:26px}
.rule-row:hover{background:var(--vscode-list-hoverBackground)}
.rule-row .switch{width:28px;height:15px}
.rule-row .slider::before{height:9px;width:9px;left:2px;top:2px}
.rule-row .switch input:checked+.slider::before{transform:translateX(13px)}
.rule-name{flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rule-tags{font-size:10px;opacity:.45;white-space:nowrap}
.gear-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.4;font-size:13px;padding:2px 4px;line-height:1}
.gear-btn:hover{opacity:1}
.gear-btn.active{opacity:1;color:var(--vscode-button-background)}
.rule-config{padding:6px 14px 8px 50px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.1))}
.config-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px}
.config-row label{width:120px;opacity:.7;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;flex-shrink:0}
.config-row input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:3px;padding:2px 6px;font-size:11px;outline:none}
.config-row input:focus{border-color:var(--vscode-focusBorder)}
.config-actions{display:flex;gap:6px;margin-top:6px}
.config-actions button{padding:2px 10px;font-size:11px;border-radius:3px;border:none;cursor:pointer}
.btn-save{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn-save:hover{background:var(--vscode-button-hoverBackground)}
.btn-reset{background:transparent;color:var(--vscode-foreground);opacity:.6}
.btn-reset:hover{opacity:1}
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

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'setState') { state = msg.state; render(); }
  if (msg.type === 'ruleConfigData') { showRuleConfig(msg.ruleId, msg.defaults, msg.current); }
});

vscode.postMessage({ type: 'ready' });

function render() {
  if (!state) return;
  if (!state.pathResolved) { app.innerHTML = '<div class="not-found">Detecting SwiftLint...</div>'; return; }
  if (!state.resolvedPath) {
    app.innerHTML = '<div class="section"><div class="row"><span>SwiftLint</span><span class="value" id="path-btn">Not Found</span></div></div>';
    document.getElementById('path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
    return;
  }

  const c = state.config;
  const rules = state.rules || [];
  const kinds = ['style','lint','idiomatic','metrics','performance'];
  const enabledCount = rules.filter(r => r.enabled).length;

  let h = '';
  // header
  h += '<div class="section">';
  h += '<div class="row"><span>SwiftLint</span><span class="value" id="path-btn">' + esc(state.version ? 'v' + state.version : state.resolvedPath) + '</span></div>';
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
  h += '<div class="rules-header"><span class="label">Rules</span><span class="badge">' + enabledCount + ' / ' + rules.length + '</span></div>';
  h += '<input type="text" class="search" id="rules-search" placeholder="Filter rules...">';

  for (const kind of kinds) {
    const group = rules.filter(r => r.kind === kind);
    if (!group.length) continue;
    h += '<div class="group-header" data-kind="' + kind + '">' + kind.charAt(0).toUpperCase() + kind.slice(1) + ' (' + group.length + ')</div>';
    for (const r of group) {
      const tags = [];
      if (r.optIn) tags.push('opt-in');
      if (r.correctable) tags.push('fixable');
      const customized = c.ruleConfigs[r.identifier] ? ' active' : '';
      h += '<div class="rule-row" data-id="' + r.identifier + '">';
      h += '<label class="switch"><input type="checkbox" data-rule="' + r.identifier + '"' + (r.enabled ? ' checked' : '') + '><span class="slider"></span></label>';
      h += '<span class="rule-name">' + esc(r.identifier) + '</span>';
      if (tags.length) h += '<span class="rule-tags">' + tags.join(', ') + '</span>';
      h += '<button class="gear-btn' + customized + '" data-gear="' + r.identifier + '" title="Configure">\u2699</button>';
      h += '</div>';
      h += '<div class="rule-config hidden" data-config="' + r.identifier + '"></div>';
    }
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
}

function toggleRow(label, id, checked) {
  return '<div class="row"><span>' + label + '</span><label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span class="slider"></span></label></div>';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function bind() {
  document.getElementById('path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'changePath' }));
  document.getElementById('toggle-enabled')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleEnabled', value: e.target.checked }));
  document.getElementById('toggle-fixOnSave')?.addEventListener('change', e => vscode.postMessage({ type: 'toggleFixOnSave', value: e.target.checked }));
  document.getElementById('severity-select')?.addEventListener('change', e => vscode.postMessage({ type: 'changeSeverity', value: e.target.value }));

  document.getElementById('rules-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.rule-row').forEach(row => {
      const id = row.dataset.id || '';
      row.classList.toggle('hidden', q.length > 0 && !id.includes(q));
    });
    document.querySelectorAll('.group-header').forEach(gh => {
      const kind = gh.dataset.kind;
      const visible = document.querySelectorAll('.rule-row[data-id]:not(.hidden)');
      const hasVisible = Array.from(visible).some(r => {
        const rule = (state?.rules || []).find(x => x.identifier === r.dataset.id);
        return rule && rule.kind === kind;
      });
      gh.classList.toggle('hidden', !hasVisible);
    });
  });

  document.querySelectorAll('input[data-rule]').forEach(cb => {
    cb.addEventListener('change', e => vscode.postMessage({ type: 'toggleRule', ruleId: e.target.dataset.rule, enabled: e.target.checked }));
  });

  document.querySelectorAll('.gear-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ruleId = btn.dataset.gear;
      const panel = document.querySelector('[data-config="' + ruleId + '"]');
      if (!panel) return;
      if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); btn.classList.remove('active'); return; }
      document.querySelectorAll('.rule-config:not(.hidden)').forEach(p => { p.classList.add('hidden'); });
      document.querySelectorAll('.gear-btn.active').forEach(b => { if (!state?.config?.ruleConfigs[b.dataset.gear]) b.classList.remove('active'); });
      btn.classList.add('active');
      panel.classList.remove('hidden');
      panel.innerHTML = '<div style="opacity:.5;font-size:11px;padding:4px 0">Loading...</div>';
      vscode.postMessage({ type: 'fetchRuleConfig', ruleId });
    });
  });

  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'removeExcludedPath', path: btn.dataset.remove }));
  });
  document.getElementById('add-path-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'addExcludedPath' }));
  document.getElementById('add-folder-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'addExcludedFolder' }));
}

function showRuleConfig(ruleId, defaults, current) {
  const panel = document.querySelector('[data-config="' + ruleId + '"]');
  if (!panel) return;
  const entries = Object.entries(current || defaults || {});
  if (!entries.length) { panel.innerHTML = '<div style="opacity:.5;font-size:11px;padding:4px 0">No configurable parameters</div>'; return; }
  let h = '';
  for (const [key, val] of entries) {
    h += '<div class="config-row"><label title="' + esc(key) + '">' + esc(key) + '</label><input type="text" data-key="' + esc(key) + '" value="' + esc(String(val)) + '"></div>';
  }
  h += '<div class="config-actions"><button class="btn-save" data-save="' + ruleId + '">Save</button><button class="btn-reset" data-reset="' + ruleId + '">Reset</button></div>';
  panel.innerHTML = h;

  panel.querySelector('[data-save]')?.addEventListener('click', () => {
    const config = {};
    panel.querySelectorAll('input[data-key]').forEach(inp => { config[inp.dataset.key] = inp.value; });
    vscode.postMessage({ type: 'updateRuleConfig', ruleId, config });
  });
  panel.querySelector('[data-reset]')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'updateRuleConfig', ruleId, config: defaults || {} });
  });
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
