import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import type { BuildTaskConfig, NativeTarget } from '../types/interfaces';
import { listAvailableSimulators, type SimulatorDevice } from '../utils/simulator';
import { parseNativeTargets, isTestTarget } from '../parsers/targets';
import { getBuildSettingsForTarget, getProjectBuildSettings } from '../parsers/buildSettings';

// ── Tree item types ──────────────────────────────────────────────

type SidebarItemType =
    | 'section-config'
    | 'config-project'
    | 'config-target'
    | 'config-scheme'
    | 'config-bundleId'
    | 'config-simulator';

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
}

// ── TreeDataProvider ─────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private projectData: ProjectData | null = null;

    constructor(private workspaceState: vscode.Memento) {}

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
        return [
            this.createConfigItem('config-project', 'Project', config.projectFile,
                'swiftPackageHelper.sidebar.changeProject', 'project'),
            this.createConfigItem('config-target', 'Target', config.targetName,
                'swiftPackageHelper.sidebar.changeTarget', 'symbol-method'),
            this.createConfigItem('config-scheme', 'Scheme', config.schemeName,
                'swiftPackageHelper.sidebar.changeScheme', 'play-circle'),
            this.createConfigItem('config-bundleId', 'Bundle ID', config.bundleIdentifier,
                'swiftPackageHelper.sidebar.changeBundleId', 'tag'),
            this.createConfigItem('config-simulator', 'Simulator', config.simulatorDevice,
                'swiftPackageHelper.sidebar.selectSimulator', 'device-mobile'),
        ];
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
        item.iconPath = new vscode.ThemeIcon(iconId);
        item.command = { command: commandId, title: label };
        return item;
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

        const projectFile = config?.projectFile || xcodeProjects[0];
        if (projectFile) {
            const pbxprojPath = path.join(rootPath, projectFile, 'project.pbxproj');
            try {
                const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                targets = parseNativeTargets(pbxContents).filter(
                    (t) => !isTestTarget(t.productType)
                );
            } catch { /* no pbxproj */ }

            const schemesDir = path.join(rootPath, projectFile, 'xcshareddata', 'xcschemes');
            try {
                const schemeFiles = await fsp.readdir(schemesDir);
                schemes = schemeFiles
                    .filter((f) => f.endsWith('.xcscheme'))
                    .map((f) => path.basename(f, '.xcscheme'));
            } catch { /* no schemes dir */ }
        }

        const simulators = await listAvailableSimulators();

        this.projectData = { xcodeProjects, targets, schemes, simulators };
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

        const projectName = path.basename(projectFile, '.xcodeproj');
        const schemesDir = path.join(rootPath, projectFile, 'xcshareddata', 'xcschemes');
        let schemeName = projectName;
        try {
            const schemeFiles = await fsp.readdir(schemesDir);
            const schemes = schemeFiles
                .filter((f) => f.endsWith('.xcscheme'))
                .map((f) => path.basename(f, '.xcscheme'));
            if (schemes.length >= 1) {
                schemeName = schemes.find((s) => s === target.name) || schemes[0];
            }
        } catch { /* no schemes dir */ }

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
        };
        await workspaceState.update('buildTaskConfig', config);

        vscode.commands.executeCommand('setContext', 'swiftPackageHelper.buildTasksConfigured', true);

        await provider.loadProjectData(config);
        provider.notifyConfigChanged();

        return true;
    } catch {
        return false;
    }
}
