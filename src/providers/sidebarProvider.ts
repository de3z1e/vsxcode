import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { BuildTaskConfig, NativeTarget } from '../types/interfaces';
import { listAvailableSimulators, listPhysicalDevices, type SimulatorDevice, type PhysicalDevice } from '../utils/simulator';
import { parseNativeTargets, isTestTarget } from '../parsers/targets';
import { getBuildSettingsForTarget, getProjectBuildSettings } from '../parsers/buildSettings';
import { detectSupportedSwiftVersions } from '../utils/version';

const execFile = promisify(execFileCallback);

// ── Tree item types ──────────────────────────────────────────────

type SidebarItemType =
    | 'section-config'
    | 'config-project'
    | 'config-target'
    | 'config-scheme'
    | 'config-bundleId'
    | 'config-simulator'
    | 'config-swiftVersion'
    | 'config-strictConcurrency';

export class SidebarItem extends vscode.TreeItem {
    constructor(
        public readonly itemType: SidebarItemType,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemValue?: string
    ) {
        super(label, collapsibleState);
    }
}

// ── Cached project data ──────────────────────────────────────────

export interface ProjectData {
    xcodeProjects: string[];
    targets: NativeTarget[];
    schemes: string[];
    simulators: SimulatorDevice[];
    physicalDevices: PhysicalDevice[];
    swiftVersionByTarget: Record<string, string>;
    strictConcurrencyByTarget: Record<string, string>;
    supportedSwiftVersions: string[];
}

// ── TreeDataProvider ─────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private projectData: ProjectData | null = null;

    constructor(
        private workspaceState: vscode.Memento,
        private readonly extensionUri: vscode.Uri
    ) {}

    refresh(): void {
        this.projectData = null;
        this._onDidChangeTreeData.fire();
    }

    notifyConfigChanged(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');

        if (!element) {
            if (!config) {
                return [];
            }
            return [
                this.createSectionItem('section-config', 'Configuration', 'gear'),
            ];
        }

        if (!this.projectData) {
            await this.loadProjectData(config);
        }

        if (element.itemType === 'section-config') {
            return this.getConfigItems(config!);
        }

        return [];
    }

    // ── Section builders ──────────────────────────────────────

    private createSectionItem(
        type: 'section-config',
        label: string,
        iconId: string
    ): SidebarItem {
        const item = new SidebarItem(type, label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(iconId);
        return item;
    }

    private getConfigItems(config: BuildTaskConfig): SidebarItem[] {
        const items = [
            this.createConfigItem('config-project', 'Project', config.projectFile,
                'vsxcode.sidebar.changeProject', 'project'),
            this.createConfigItem('config-target', 'Target', config.targetName,
                'vsxcode.sidebar.changeTarget', 'symbol-method'),
            this.createConfigItem('config-scheme', 'Scheme', config.schemeName,
                'vsxcode.sidebar.changeScheme', 'play-circle'),
            this.createConfigItem('config-bundleId', 'Bundle ID', config.bundleIdentifier,
                'vsxcode.sidebar.changeBundleId', 'tag'),
            this.createConfigItem('config-swiftVersion', 'Swift Language Version',
                this.projectData?.swiftVersionByTarget[config.targetName] ? `Swift ${this.projectData.swiftVersionByTarget[config.targetName].replace(/\.0$/, '')}` : '',
                'vsxcode.sidebar.changeSwiftVersion', 'swift'),
        ];
        const concurrency = this.formatStrictConcurrency(config.targetName);
        if (concurrency) {
            items.push(this.createConfigItem('config-strictConcurrency', 'Strict Concurrency Checking',
                concurrency, 'vsxcode.sidebar.changeStrictConcurrency', 'shield'));
        }
        const deviceLabel = this.formatDeviceLabel(config);
        items.push(this.createConfigItem('config-simulator', 'Device', deviceLabel,
            'vsxcode.sidebar.selectSimulator', 'device-mobile'));
        return items;
    }

    private createConfigItem(
        type: SidebarItemType,
        label: string,
        value: string,
        commandId: string,
        iconId: string
    ): SidebarItem {
        const item = new SidebarItem(type, label, vscode.TreeItemCollapsibleState.None, value);
        item.description = value;
        if (iconId === 'swift') {
            item.iconPath = {
                light: vscode.Uri.joinPath(this.extensionUri, 'images', 'swift-light.svg'),
                dark: vscode.Uri.joinPath(this.extensionUri, 'images', 'swift-dark.svg'),
            };
        } else {
            item.iconPath = new vscode.ThemeIcon(iconId);
        }
        item.command = { command: commandId, title: label };
        return item;
    }

    private formatStrictConcurrency(targetName: string): string {
        const value = this.projectData?.strictConcurrencyByTarget[targetName];
        if (!value) { return ''; }
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    private formatDeviceLabel(config: BuildTaskConfig): string {
        if (!config.simulatorDevice) { return ''; }
        if (!config.isPhysicalDevice) {
            return `${config.simulatorDevice} (Simulator)`;
        }
        const physical = this.projectData?.physicalDevices.find(
            d => d.udid === config.simulatorUdid || d.deviceIdentifier === config.deviceIdentifier
        );
        const connectionType = physical?.connectionType;
        const transport = connectionType === 'wired' ? 'USB' : connectionType === 'localNetwork' ? 'Wi-Fi' : connectionType || 'Unknown';
        return `${config.simulatorDevice} (${transport})`;
    }

    // ── Data loading ──────────────────────────────────────────

    async loadProjectData(config?: BuildTaskConfig | null): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return; }

        const entries = await fsp.readdir(rootPath, { withFileTypes: true });
        const xcodeProjects = entries
            .filter((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))
            .map((e) => e.name);

        let targets: NativeTarget[] = [];
        let schemes: string[] = [];
        const swiftVersionByTarget: Record<string, string> = {};
        const strictConcurrencyByTarget: Record<string, string> = {};

        const projectFile = config?.projectFile || xcodeProjects[0];
        if (projectFile) {
            const pbxprojPath = path.join(rootPath, projectFile, 'project.pbxproj');
            try {
                const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                targets = parseNativeTargets(pbxContents);
                for (const t of targets) {
                    if (t.buildConfigurationListId) {
                        const settings = getBuildSettingsForTarget(pbxContents, t.buildConfigurationListId, 'Debug');
                        if (settings?.swiftVersion) {
                            swiftVersionByTarget[t.name] = settings.swiftVersion;
                        }
                        if (settings?.strictConcurrency) {
                            strictConcurrencyByTarget[t.name] = settings.strictConcurrency;
                        }
                    }
                }
                // Fall back to project-level settings
                const projectSettings = getProjectBuildSettings(pbxContents, 'Debug');
                if (Object.keys(swiftVersionByTarget).length === 0 && projectSettings?.swiftVersion) {
                    for (const t of targets) {
                        swiftVersionByTarget[t.name] = projectSettings.swiftVersion;
                    }
                }
                if (Object.keys(strictConcurrencyByTarget).length === 0 && projectSettings?.strictConcurrency) {
                    for (const t of targets) {
                        strictConcurrencyByTarget[t.name] = projectSettings.strictConcurrency;
                    }
                }
                // When SWIFT_STRICT_CONCURRENCY is absent, infer "minimal" for pre-Swift 6
                // (Swift 6+ has complete by default — hide the row instead of showing it)
                for (const t of targets) {
                    if (!strictConcurrencyByTarget[t.name]) {
                        const ver = swiftVersionByTarget[t.name];
                        const major = ver ? parseInt(ver, 10) : 0;
                        if (major > 0 && major < 6) {
                            strictConcurrencyByTarget[t.name] = 'minimal';
                        }
                    }
                }
            } catch { /* no pbxproj */ }

            try {
                const { stdout } = await execFile('xcodebuild', ['-list', '-project', path.join(rootPath, projectFile)], { encoding: 'utf8', timeout: 10000 });
                const schemesMatch = /Schemes:\n([\s\S]*?)(?:\n\n|$)/.exec(stdout);
                if (schemesMatch) {
                    schemes = schemesMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 0);
                }
            } catch { /* xcodebuild -list failed */ }
        }

        const [simulators, physicalDevices, supportedSwiftVersions] = await Promise.all([
            listAvailableSimulators(),
            listPhysicalDevices(),
            detectSupportedSwiftVersions(),
        ]);

        this.projectData = { xcodeProjects, targets, schemes, simulators, physicalDevices, swiftVersionByTarget, strictConcurrencyByTarget, supportedSwiftVersions };
    }

    updatePhysicalDevices(devices: PhysicalDevice[]): void {
        if (this.projectData) {
            this.projectData.physicalDevices = devices;
        }
    }

    getProjectData(): ProjectData | null {
        return this.projectData;
    }

    // ── Helpers ───────────────────────────────────────────────

    formatRuntime(runtime: string): string {
        const match = /SimRuntime\.(\w+)-(\d+)-(\d+)/.exec(runtime);
        if (match) {
            return `${match[1]} ${match[2]}.${match[3]}`;
        }
        return runtime;
    }
}

// ── Auto-configuration ───────────────────────────────────────────

export async function autoConfigureBuildTasks(
    workspaceState: vscode.Memento,
    provider: SidebarProvider
): Promise<boolean> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
        return false;
    }

    if (workspaceState.get<BuildTaskConfig>('buildTaskConfig')) {
        // Already configured — just load data for sidebar display
        await provider.loadProjectData(workspaceState.get<BuildTaskConfig>('buildTaskConfig'));
        provider.notifyConfigChanged();
        return true;
    }

    try {
        const entries = await fsp.readdir(rootPath, { withFileTypes: true });
        const xcodeProjects = entries
            .filter((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))
            .map((e) => e.name);
        if (xcodeProjects.length === 0) {
            return false;
        }
        const projectFile = xcodeProjects[0];

        const pbxprojPath = path.join(rootPath, projectFile, 'project.pbxproj');
        const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const nativeTargets = parseNativeTargets(pbxContents);
        const nonTestTargets = nativeTargets.filter((t) => !isTestTarget(t.productType));
        if (nonTestTargets.length === 0) {
            return false;
        }
        const target = nonTestTargets[0];

        let bundleIdentifier = '';
        let resolvedProductName = target.productName || target.name;
        if (target.buildConfigurationListId) {
            const settings = getBuildSettingsForTarget(
                pbxContents, target.buildConfigurationListId, 'Debug'
            );
            bundleIdentifier = settings?.bundleIdentifier || '';
            if (settings?.productName && !settings.productName.includes('$(')) {
                resolvedProductName = settings.productName;
            }
        }
        if (!bundleIdentifier) {
            const projectSettings = getProjectBuildSettings(pbxContents, 'Debug');
            bundleIdentifier = projectSettings?.bundleIdentifier || '';
        }
        if (!bundleIdentifier) {
            bundleIdentifier = `com.example.${target.name}`;
        }

        let schemeName = path.basename(projectFile, '.xcodeproj');
        try {
            const { stdout } = await execFile('xcodebuild', ['-list', '-project', path.join(rootPath, projectFile)], { encoding: 'utf8', timeout: 10000 });
            const schemesMatch = /Schemes:\n([\s\S]*?)(?:\n\n|$)/.exec(stdout);
            if (schemesMatch) {
                const schemes = schemesMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 0);
                if (schemes.length >= 1) {
                    schemeName = schemes.find((s) => s === target.name) || schemes[0];
                }
            }
        } catch { /* xcodebuild -list failed */ }

        const simulators = await listAvailableSimulators();
        if (simulators.length === 0) {
            return false;
        }
        const iphone = simulators.find((s) => s.name.startsWith('iPhone')) || simulators[0];

        const config: BuildTaskConfig = {
            projectFile,
            schemeName,
            targetName: target.name,
            productName: resolvedProductName,
            bundleIdentifier,
            simulatorDevice: iphone.name,
            simulatorUdid: iphone.udid,
        };
        await workspaceState.update('buildTaskConfig', config);

        vscode.commands.executeCommand('setContext', 'vsxcode.buildTasksConfigured', true);

        await provider.loadProjectData(config);
        provider.notifyConfigChanged();

        return true;
    } catch {
        return false;
    }
}
