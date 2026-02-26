import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

import type {
    TargetDefinition,
    TargetOutput,
    ProductDefinition,
    SwiftPackageProductDependency
} from './types/interfaces';
import { DEFAULT_SWIFT_VERSION, SWIFT_VERSION_MAP } from './types/constants';
import { detectSwiftToolsVersion, detectMacOSVersion, parseSwiftVersion, cleanup, compareVersions } from './utils/version';
import { determineTargetPath } from './utils/path';
import { parseNativeTargets, isTestTarget, mapProductType, parseTargetDependencies, parseBuildPhaseIds } from './parsers/targets';
import { parseSwiftPackageReferences, parseSwiftPackageProductDependencies } from './parsers/packages';
import { getBuildSettingsForTarget, getProjectBuildSettings } from './parsers/buildSettings';
import { parseLinkedFrameworksForTarget } from './parsers/frameworks';
import { parseResourcesForTarget, scanForUnhandledFiles } from './parsers/resources';
import { generateSwiftSettings } from './generators/swiftSettings';
import { generateLinkerSettings } from './generators/linkerSettings';
import { buildPackageSwift, formatPackageDependencyEntry } from './generators/packageSwift';
import { listAvailableSimulators, listPhysicalDevices, devicectlInstall, checkDeviceReady } from './utils/simulator';
import { XcodeBuildTaskProvider, TASK_TYPE } from './providers/taskProvider';
import { XcodeDebugConfigProvider } from './providers/debugConfigProvider';
import { SidebarProvider, autoConfigureBuildTasks } from './providers/sidebarProvider';
import { createSwiftFileWatcher } from './sync/swiftFileSync';
import type { BuildTaskConfig } from './types/interfaces';

import type { PlatformName, DeploymentTarget } from './types/interfaces';
import { PLATFORM_KEYS, DEFAULT_PLATFORM } from './types/constants';

function parseDefaultLocalization(pbxContents: string): string | null {
    const projectRegex = /\/\* Begin PBXProject section \*\/([\s\S]*?)\/\* End PBXProject section \*\//;
    const projectMatch = projectRegex.exec(pbxContents);
    if (!projectMatch) {
        return null;
    }
    const projectSection = projectMatch[1];
    const localizationMatch = /developmentRegion = ([^;]+);/.exec(projectSection);
    if (localizationMatch) {
        return cleanup(localizationMatch[1]);
    }
    return null;
}

function parseDeploymentTargets(pbxContents: string): DeploymentTarget[] {
    const found = new Map<PlatformName, string>();
    const entries = Object.entries(PLATFORM_KEYS) as Array<[string, PlatformName]>;
    for (const [key, platform] of entries) {
        const regex = new RegExp(`${key} = ([^;]+);`, 'g');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(pbxContents)) !== null) {
            const version = cleanup(match[1]);
            if (!version) {
                continue;
            }
            const current = found.get(platform);
            if (!current || compareVersions(version, current) > 0) {
                found.set(platform, version);
            }
        }
    }
    if (found.size === 0) {
        found.set(DEFAULT_PLATFORM.platform, DEFAULT_PLATFORM.version);
    }
    return Array.from(found.entries()).map(([platform, version]) => ({ platform, version }));
}

async function ensureMacOSPlatform(platforms: DeploymentTarget[]): Promise<DeploymentTarget[]> {
    const detectedVersion = await detectMacOSVersion();
    if (!detectedVersion) {
        return platforms;
    }
    const next = platforms.slice();
    const macIndex = next.findIndex(({ platform }) => platform === 'macOS');
    const macEntry: DeploymentTarget = { platform: 'macOS', version: detectedVersion };
    if (macIndex === -1) {
        next.push(macEntry);
    } else {
        next[macIndex] = macEntry;
    }
    return next;
}

function resolveSwiftLanguageMode(swiftVersion: string | undefined): string | undefined {
    if (!swiftVersion) {
        return undefined;
    }
    const mapped = SWIFT_VERSION_MAP[swiftVersion];
    if (mapped) {
        return mapped;
    }
    const majorMinor = swiftVersion.split('.').slice(0, 2).join('.');
    return SWIFT_VERSION_MAP[majorMinor] || undefined;
}

function parseExcludedFiles(pbxContents: string, targetName: string): string[] {
    const syncGroupRegex =
        /\/\* Begin PBXFileSystemSynchronizedRootGroup section \*\/([\s\S]*?)\/\* End PBXFileSystemSynchronizedRootGroup section \*\//;
    const syncMatch = syncGroupRegex.exec(pbxContents);
    if (!syncMatch) {
        return [];
    }
    const section = syncMatch[1];

    const exceptionRegex =
        /\/\* Begin PBXFileSystemSynchronizedBuildFileExceptionSet section \*\/([\s\S]*?)\/\* End PBXFileSystemSynchronizedBuildFileExceptionSet section \*\//;
    const exceptionMatch = exceptionRegex.exec(pbxContents);
    if (!exceptionMatch) {
        return [];
    }

    const excluded: string[] = [];
    const entryRegex = /membershipExceptions = \(([\s\S]*?)\);/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(exceptionMatch[1])) !== null) {
        const items = match[1];
        const fileRegex = /"([^"]+)"/g;
        let fileMatch: RegExpExecArray | null;
        while ((fileMatch = fileRegex.exec(items)) !== null) {
            excluded.push(fileMatch[1]);
        }
    }
    return excluded;
}

function generateCSettings(headerSearchPaths: string[] | undefined): string[] {
    if (!headerSearchPaths || headerSearchPaths.length === 0) {
        return [];
    }
    const filtered = headerSearchPaths.filter(
        (p) => p !== '$(inherited)' && p.length > 0
    );
    return filtered.map((p) => `.headerSearchPath("${p}")`);
}

async function generatePackageSwift(rootPath: string, configurationName: string = 'Debug', silent: boolean = false): Promise<void> {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const xcodeProjects = entries.filter(
        (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj')
    );
    if (xcodeProjects.length === 0) {
        throw new Error('No .xcodeproj found in the workspace root.');
    }

    let selectedProject = xcodeProjects[0].name;
    if (xcodeProjects.length > 1 && !silent) {
        const pick = await vscode.window.showQuickPick(
            xcodeProjects.map((entry) => entry.name),
            { placeHolder: 'Select the Xcode project to read' }
        );
        if (!pick) {
            return;
        }
        selectedProject = pick;
    }

    const pbxprojPath = path.join(rootPath, selectedProject, 'project.pbxproj');
    let pbxContents: string;
    try {
        pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
    } catch (error) {
        const message = (error as { message?: string }).message;
        throw new Error(`Unable to read ${pbxprojPath}: ${message}`);
    }

    const swiftVersion =
        (await detectSwiftToolsVersion()) || parseSwiftVersion(pbxContents) || DEFAULT_SWIFT_VERSION;
    const platforms = await ensureMacOSPlatform(parseDeploymentTargets(pbxContents));
    const defaultLocalization = parseDefaultLocalization(pbxContents);
    const nativeTargets = parseNativeTargets(pbxContents);
    const packageReferences = parseSwiftPackageReferences(pbxContents);
    const packageProductDependencies = parseSwiftPackageProductDependencies(pbxContents);
    const targetDependencies = parseTargetDependencies(pbxContents);
    const projectBuildSettings = getProjectBuildSettings(pbxContents, configurationName);

    if (nativeTargets.length === 0) {
        throw new Error('No native targets found in the Xcode project.');
    }

    const packageName = path.basename(selectedProject, '.xcodeproj');

    const targetDefinitions: TargetDefinition[] = nativeTargets.map((target) => {
        const testTarget = isTestTarget(target.productType);
        const targetPackageDependencies =
            target.packageProductDependencyIds && target.packageProductDependencyIds.length > 0
                ? target.packageProductDependencyIds
                      .map((dependencyId) => packageProductDependencies.get(dependencyId))
                      .filter(
                          (dependency): dependency is SwiftPackageProductDependency => Boolean(dependency)
                      )
                      .map((dependency) => {
                          const packageRef = dependency.packageRef
                              ? packageReferences.get(dependency.packageRef)
                              : undefined;
                          const packageNameValue = (
                              (packageRef && packageRef.name) ||
                              dependency.packageName ||
                              dependency.productName
                          ) as string;
                          return `.product(name: "${dependency.productName}", package: "${packageNameValue}")`;
                      })
                : [];

        const nativeTargetDeps = targetDependencies.get(target.name) || [];
        const targetDepStrings = nativeTargetDeps.map(
            (dep) => `.target(name: "${dep.targetName}")`
        );

        const uniqueDependencies = Array.from(new Set([...targetDepStrings, ...targetPackageDependencies]));
        return {
            name: target.name,
            productName: target.productName,
            productType: target.productType,
            spmType: testTarget ? '.testTarget' as const : '.target' as const,
            path: determineTargetPath(rootPath, target.name, testTarget, target.productName),
            isTest: testTarget,
            dependencies: uniqueDependencies
        };
    });

    const productMap = new Map<string, ProductDefinition>();
    for (const target of targetDefinitions) {
        if (target.isTest) {
            continue;
        }
        const type = mapProductType(target.productType);
        if (!productMap.has(target.productName)) {
            productMap.set(target.productName, {
                type,
                name: target.productName,
                targets: [target.name]
            });
        } else {
            const existing = productMap.get(target.productName);
            if (existing && !existing.targets.includes(target.name)) {
                existing.targets.push(target.name);
            }
        }
    }

    const products = Array.from(productMap.values());
    const packageDependenciesList = Array.from(packageReferences.values())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((reference) => formatPackageDependencyEntry(reference))
        .filter((entry): entry is string => Boolean(entry));
    const uniquePackageDependencies = Array.from(new Set(packageDependenciesList));

    const targetOutputs: TargetOutput[] = nativeTargets.map((nativeTarget) => {
        const targetDef = targetDefinitions.find((t) => t.name === nativeTarget.name)!;
        const buildPhases = parseBuildPhaseIds(pbxContents, nativeTarget.name);
        const targetSettings = nativeTarget.buildConfigurationListId
            ? getBuildSettingsForTarget(pbxContents, nativeTarget.buildConfigurationListId, configurationName)
            : null;

        const swiftSettings = generateSwiftSettings(projectBuildSettings, targetSettings, configurationName);
        const linkedFrameworks = parseLinkedFrameworksForTarget(pbxContents, buildPhases.frameworksBuildPhaseId);
        const targetAbsolutePath = path.join(rootPath, targetDef.path);
        const resources = parseResourcesForTarget(pbxContents, buildPhases.resourcesBuildPhaseId, targetAbsolutePath);
        const excluded = parseExcludedFiles(pbxContents, nativeTarget.name);

        const { additionalExcludes, additionalResources } = scanForUnhandledFiles(
            targetAbsolutePath, resources, excluded
        );
        const allResources = [...resources, ...additionalResources];
        const allExcludes = [...excluded, ...additionalExcludes];

        const headerPaths = targetSettings?.headerSearchPaths;
        const cSettings = generateCSettings(headerPaths);

        const swiftLangVersion = targetSettings?.swiftVersion;
        const swiftLanguageMode = resolveSwiftLanguageMode(swiftLangVersion);
        if (swiftLanguageMode) {
            swiftSettings.unshift(`.swiftLanguageMode(${swiftLanguageMode})`);
        }

        const packageDependencyNames = new Set(
            Array.from(packageReferences.values()).map((ref) => ref.name)
        );
        const filteredFrameworks = linkedFrameworks.filter((name) => !packageDependencyNames.has(name));
        const linkerSettings = generateLinkerSettings(filteredFrameworks);

        return {
            spmType: targetDef.spmType,
            name: targetDef.name,
            path: targetDef.path,
            dependencies: targetDef.dependencies.length > 0 ? targetDef.dependencies : undefined,
            resources: allResources.length > 0 ? allResources : undefined,
            swiftSettings: swiftSettings.length > 0 ? swiftSettings : undefined,
            cSettings: cSettings.length > 0 ? cSettings : undefined,
            linkerSettings: linkerSettings.length > 0 ? linkerSettings : undefined,
            exclude: allExcludes.length > 0 ? allExcludes : undefined
        };
    });

    const packageContents = buildPackageSwift({
        packageName,
        swiftVersion,
        platforms,
        products,
        dependencies: uniquePackageDependencies,
        targets: targetOutputs,
        defaultLocalization: defaultLocalization || undefined
    });

    // Populate SourceKit-LSP settings for iOS simulator target resolution
    const iosPlatform = platforms.find((p) => p.platform === 'iOS');
    if (iosPlatform) {
        try {
            const cp = await import('child_process');
            const developerDir = cp.execSync('xcode-select -p', { encoding: 'utf8' }).trim();
            const sdkPath = `${developerDir}/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk`;
            const serverArguments = [
                '-Xswiftc', '-sdk',
                '-Xswiftc', sdkPath,
                '-Xswiftc', '-target',
                '-Xswiftc', `arm64-apple-ios${iosPlatform.version}-simulator`,
                '-Xswiftc', '-F',
                '-Xswiftc', `${sdkPath}/System/Library/Frameworks`
            ];

            const lspConfig = vscode.workspace.getConfiguration('swift.sourcekit-lsp');
            await lspConfig.update('serverArguments', serverArguments, vscode.ConfigurationTarget.Workspace);
        } catch {
            vscode.window.showWarningMessage(
                'Could not configure SourceKit-LSP: xcode-select failed. Run "xcode-select --install" in Terminal to install command-line tools.'
            );
        }
    }

    const packagePath = path.join(rootPath, 'Package.swift');

    if (fs.existsSync(packagePath)) {
        const existingContents = await fsp.readFile(packagePath, 'utf8');
        if (existingContents === packageContents) {
            if (!silent) {
                vscode.window.showInformationMessage('Package.swift is already up to date.');
            }
            return;
        }

        if (!silent) {
            const existingUri = vscode.Uri.file(packagePath);
            const previewUri = vscode.Uri.parse(`untitled:Package.swift.preview`);
            const previewDoc = await vscode.workspace.openTextDocument(previewUri);
            const previewEditor = await vscode.window.showTextDocument(previewDoc, { preview: true });
            await previewEditor.edit((edit) => {
                edit.insert(new vscode.Position(0, 0), packageContents);
            });

            await vscode.commands.executeCommand(
                'vscode.diff',
                existingUri,
                previewUri,
                'Package.swift: Current vs Generated'
            );

            const overwrite = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], {
                placeHolder: 'Package.swift already exists. Overwrite with generated version?'
            });

            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

            if (overwrite !== 'Overwrite') {
                return;
            }
        }
    }

    await fsp.writeFile(packagePath, packageContents, 'utf8');
    if (!silent) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(packagePath));
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Package.swift generated from ${selectedProject}`);
    }
}

async function configureBuildTasks(rootPath: string, workspaceState: vscode.Memento): Promise<void> {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const xcodeProjects = entries.filter(
        (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj')
    );
    if (xcodeProjects.length === 0) {
        throw new Error('No .xcodeproj found in the workspace root.');
    }

    let selectedProject = xcodeProjects[0].name;
    if (xcodeProjects.length > 1) {
        const pick = await vscode.window.showQuickPick(
            xcodeProjects.map((entry) => entry.name),
            { placeHolder: 'Select the Xcode project' }
        );
        if (!pick) {
            return;
        }
        selectedProject = pick;
    }

    const pbxprojPath = path.join(rootPath, selectedProject, 'project.pbxproj');
    let pbxContents: string;
    try {
        pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
    } catch (error) {
        const message = (error as { message?: string }).message;
        throw new Error(`Unable to read ${pbxprojPath}: ${message}`);
    }

    const nativeTargets = parseNativeTargets(pbxContents);
    const nonTestTargets = nativeTargets.filter((t) => !isTestTarget(t.productType));
    if (nonTestTargets.length === 0) {
        throw new Error('No non-test targets found in the Xcode project.');
    }

    let selectedTarget = nonTestTargets[0];
    if (nonTestTargets.length > 1) {
        const pick = await vscode.window.showQuickPick(
            nonTestTargets.map((t) => t.name),
            { placeHolder: 'Select the target to build' }
        );
        if (!pick) {
            return;
        }
        selectedTarget = nonTestTargets.find((t) => t.name === pick)!;
    }

    let bundleIdentifier = '';
    let resolvedProductName = selectedTarget.productName || selectedTarget.name;
    if (selectedTarget.buildConfigurationListId) {
        const settings = getBuildSettingsForTarget(pbxContents, selectedTarget.buildConfigurationListId, 'Debug');
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
        const input = await vscode.window.showInputBox({
            prompt: 'Could not detect bundle identifier. Please enter it manually.',
            placeHolder: 'com.example.MyApp'
        });
        if (!input) {
            return;
        }
        bundleIdentifier = input;
    }

    const [simulators, physicalDevices] = await Promise.all([
        listAvailableSimulators(),
        listPhysicalDevices(),
    ]);
    if (simulators.length === 0 && physicalDevices.length === 0) {
        throw new Error('No available iOS devices found. Connect a device or install simulators via Xcode.');
    }

    const devicePicks: (vscode.QuickPickItem & { udid: string; deviceIdentifier: string; isPhysical: boolean })[] = [];
    if (physicalDevices.length > 0) {
        devicePicks.push({ label: 'Physical Devices', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', isPhysical: false });
        for (const d of physicalDevices) {
            const transport = d.connectionType === 'wired' ? 'USB' : d.connectionType === 'localNetwork' ? 'Wi-Fi' : d.connectionType;
            devicePicks.push({ label: d.name, description: `iOS ${d.osVersion} (${transport})`, udid: d.udid, deviceIdentifier: d.deviceIdentifier, isPhysical: true });
        }
    }
    if (simulators.length > 0) {
        devicePicks.push({ label: 'Simulators', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', isPhysical: false });
        for (const s of simulators) {
            devicePicks.push({ label: s.name, description: s.state, detail: s.runtime, udid: s.udid, deviceIdentifier: '', isPhysical: false });
        }
    }

    const simulatorPick = await vscode.window.showQuickPick(devicePicks, {
        placeHolder: 'Select device'
    });
    if (!simulatorPick) {
        return;
    }

    const projectName = path.basename(selectedProject, '.xcodeproj');

    const schemesDir = path.join(rootPath, selectedProject, 'xcshareddata', 'xcschemes');
    let schemes: string[] = [];
    try {
        const schemeFiles = await fsp.readdir(schemesDir);
        schemes = schemeFiles
            .filter((f) => f.endsWith('.xcscheme'))
            .map((f) => path.basename(f, '.xcscheme'));
    } catch {
        // No shared schemes directory
    }

    let schemeName = projectName;
    if (schemes.length === 1) {
        schemeName = schemes[0];
    } else if (schemes.length > 1) {
        const pick = await vscode.window.showQuickPick(schemes, {
            placeHolder: 'Select the scheme to build'
        });
        if (!pick) {
            return;
        }
        schemeName = pick;
    } else {
        const targetNames = nonTestTargets.map((t) => t.name);
        if (targetNames.length === 1) {
            schemeName = targetNames[0];
        } else {
            const pick = await vscode.window.showQuickPick([projectName, ...targetNames], {
                placeHolder: 'No shared schemes found. Select scheme name'
            });
            if (!pick) {
                return;
            }
            schemeName = pick;
        }
    }

    const buildTaskConfig: BuildTaskConfig = {
        projectFile: selectedProject,
        schemeName,
        targetName: selectedTarget.name,
        productName: resolvedProductName,
        bundleIdentifier,
        simulatorDevice: simulatorPick.label,
        simulatorUdid: simulatorPick.udid,
        isPhysicalDevice: simulatorPick.isPhysical,
        deviceIdentifier: simulatorPick.deviceIdentifier,
    };

    await workspaceState.update('buildTaskConfig', buildTaskConfig);

    vscode.window.showInformationMessage(
        `Build tasks configured for ${selectedTarget.name} on ${simulatorPick.label}`
    );

    vscode.commands.executeCommand('setContext', 'swiftPackageHelper.buildTasksConfigured', true);

    if (!vscode.extensions.getExtension('llvm-vs-code-extensions.lldb-dap')) {
        const install = await vscode.window.showWarningMessage(
            'LLDB DAP extension is required for debugging. Install it?',
            'Install', 'Dismiss'
        );
        if (install === 'Install') {
            vscode.commands.executeCommand('workbench.extensions.installExtension', 'llvm-vs-code-extensions.lldb-dap');
        }
    }
}

let consoleExecution: vscode.TaskExecution | undefined;

function printToSharedPanel(message: string, color = '33'): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const task = new vscode.Task(
        { type: 'shell' },
        folder,
        'Print Message',
        'swift-package-helper',
        new vscode.ShellExecution(`printf '\\e[${color}m${message}\\e[0m\\n\\n'`),
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Shared,
        showReuseMessage: false,
        echo: false,
    };
    vscode.tasks.executeTask(task);
}

function executeTaskAndWait(task: vscode.Task): Promise<number | undefined> {
    return new Promise(async (resolve) => {
        const listener = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution.task === task || event.execution.task.name === task.name) {
                listener.dispose();
                resolve(event.exitCode);
            }
        });
        await vscode.tasks.executeTask(task);
    });
}

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Swift Package Helper');
    const log = (message: string): void => {
        const timestamp = new Date().toLocaleTimeString();
        outputChannel.appendLine(`[${timestamp}] ${message}`);
    };

    // Always register sidebar (shows welcome message when no project found)
    const sidebarProvider = new SidebarProvider(context.workspaceState);
    const treeView = vscode.window.createTreeView('swiftPackageHelper.sidebar', {
        treeDataProvider: sidebarProvider,
    });

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        context.subscriptions.push(treeView, outputChannel);
        return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;

    function hasXcodeProject(): boolean {
        try {
            const entries = fs.readdirSync(rootPath, { withFileTypes: true });
            return entries.some(
                (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj')
            );
        } catch {
            return false;
        }
    }

    if (!hasXcodeProject()) {
        // Watch for .xcodeproj creation, then fully activate
        const xcodeprojWatcher = vscode.workspace.createFileSystemWatcher('**/*.xcodeproj');
        const onXcodeprojCreated = xcodeprojWatcher.onDidCreate(() => {
            xcodeprojWatcher.dispose();
            onXcodeprojCreated.dispose();
            setupFullExtension();
        });
        context.subscriptions.push(treeView, outputChannel, xcodeprojWatcher, onXcodeprojCreated);
        return;
    }

    setupFullExtension();

    function setupFullExtension(): void {

    // Enable Cmd+R keybinding if build tasks were previously configured
    const existingConfig = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
    if (existingConfig) {
        vscode.commands.executeCommand('setContext', 'swiftPackageHelper.buildTasksConfigured', true);
    }

    // Register TaskProvider and DebugConfigurationProvider
    const buildTaskProvider = new XcodeBuildTaskProvider(context.workspaceState);
    const taskProvider = vscode.tasks.registerTaskProvider(TASK_TYPE, buildTaskProvider);
    const debugProvider = vscode.debug.registerDebugConfigurationProvider(
        'lldb-dap',
        new XcodeDebugConfigProvider(context.workspaceState)
    );

    // Auto-configure on activation (non-blocking)
    autoConfigureBuildTasks(context.workspaceState, sidebarProvider);
    generatePackageSwift(rootPath, 'Debug', true).catch(() => {});

    // Helper to patch config and refresh sidebar
    async function updateConfig(patch: Partial<BuildTaskConfig>): Promise<void> {
        const current = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!current) { return; }
        await context.workspaceState.update('buildTaskConfig', { ...current, ...patch });
        sidebarProvider.notifyConfigChanged();
    }

    // ── Package.swift commands ────────────────────────────────

    const generateCommand = vscode.commands.registerCommand(
        'swiftPackageHelper.createFromXcodeproj',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                await generatePackageSwift(workspaceFolders[0].uri.fsPath);
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    const generateWithOptionsCommand = vscode.commands.registerCommand(
        'swiftPackageHelper.createFromXcodeprojWithOptions',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                const config = await vscode.window.showQuickPick(['Debug', 'Release'], {
                    placeHolder: 'Select build configuration for settings extraction'
                });
                if (!config) { return; }
                await generatePackageSwift(workspaceFolders[0].uri.fsPath, config);
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    // ── Manual configure command (fallback) ───────────────────

    const generateBuildTasksCommand = vscode.commands.registerCommand(
        'swiftPackageHelper.generateBuildTasks',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                await configureBuildTasks(workspaceFolders[0].uri.fsPath, context.workspaceState);
                sidebarProvider.refresh();
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    // ── Sidebar commands ──────────────────────────────────────

    const changeProjectCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.changeProject',
        async () => {
            const data = sidebarProvider.getProjectData();
            if (!data || data.xcodeProjects.length <= 1) { return; }
            const pick = await vscode.window.showQuickPick(data.xcodeProjects, {
                placeHolder: 'Select Xcode project'
            });
            if (pick) {
                await updateConfig({ projectFile: pick });
                sidebarProvider.refresh();
            }
        }
    );

    const changeTargetCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.changeTarget',
        async () => {
            const data = sidebarProvider.getProjectData();
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!data || !config) { return; }
            const picks = data.targets.map((t) => t.name);
            const pick = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select target'
            });
            if (pick) {
                const target = data.targets.find((t) => t.name === pick)!;
                const rootPath = vscode.workspace.workspaceFolders![0].uri.fsPath;
                const pbxprojPath = path.join(rootPath, config.projectFile, 'project.pbxproj');
                let bundleIdentifier = config.bundleIdentifier;
                let productName = target.productName || target.name;
                try {
                    const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                    if (target.buildConfigurationListId) {
                        const settings = getBuildSettingsForTarget(
                            pbxContents, target.buildConfigurationListId, 'Debug'
                        );
                        if (settings?.bundleIdentifier) {
                            bundleIdentifier = settings.bundleIdentifier;
                        }
                        if (settings?.productName && !settings.productName.includes('$(')) {
                            productName = settings.productName;
                        }
                    }
                } catch { /* use existing values */ }
                await updateConfig({ targetName: pick, productName, bundleIdentifier });
            }
        }
    );

    const changeSchemeCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.changeScheme',
        async () => {
            const data = sidebarProvider.getProjectData();
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!data || !config) { return; }
            const projectName = path.basename(config.projectFile, '.xcodeproj');
            const targetNames = data.targets.map((t) => t.name);
            const options = [...new Set([...data.schemes, projectName, ...targetNames])];
            const pick = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select scheme'
            });
            if (pick) {
                await updateConfig({ schemeName: pick });
            }
        }
    );

    const changeBundleIdCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.changeBundleId',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const input = await vscode.window.showInputBox({
                prompt: 'Enter bundle identifier',
                value: config.bundleIdentifier,
                placeHolder: 'com.example.MyApp'
            });
            if (input !== undefined) {
                await updateConfig({ bundleIdentifier: input });
            }
        }
    );

    const selectSimulatorCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.selectSimulator',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const [simulators, physicalDevices] = await Promise.all([
                listAvailableSimulators(),
                listPhysicalDevices(),
            ]);
            if (simulators.length === 0 && physicalDevices.length === 0) {
                vscode.window.showWarningMessage('No devices found.');
                return;
            }
            type DevicePick = vscode.QuickPickItem & { udid: string; deviceIdentifier: string; isPhysical: boolean };
            const picks: DevicePick[] = [];
            let activePick: DevicePick | undefined;
            if (physicalDevices.length > 0) {
                picks.push({ label: 'Physical Devices', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', isPhysical: false });
                for (const d of physicalDevices) {
                    const transport = d.connectionType === 'wired' ? 'USB' : d.connectionType === 'localNetwork' ? 'Wi-Fi' : d.connectionType;
                    const item: DevicePick = {
                        label: d.name,
                        description: `iOS ${d.osVersion} (${transport})`,
                        udid: d.udid,
                        deviceIdentifier: d.deviceIdentifier,
                        isPhysical: true,
                    };
                    if (d.udid === config.simulatorUdid || d.deviceIdentifier === config.deviceIdentifier) {
                        activePick = item;
                    }
                    picks.push(item);
                }
            }
            if (simulators.length > 0) {
                picks.push({ label: 'Simulators', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', isPhysical: false });
                for (const s of simulators) {
                    const runtime = sidebarProvider.formatRuntime(s.runtime);
                    const booted = s.state === 'Booted' ? ' (Booted)' : '';
                    const item: DevicePick = {
                        label: s.name,
                        description: `${runtime}${booted}`,
                        udid: s.udid,
                        deviceIdentifier: '',
                        isPhysical: false,
                    };
                    if (s.udid === config.simulatorUdid) {
                        activePick = item;
                    }
                    picks.push(item);
                }
            }
            const pick = await new Promise<DevicePick | undefined>((resolve) => {
                const qp = vscode.window.createQuickPick<DevicePick>();
                qp.items = picks;
                qp.placeholder = 'Select device';
                if (activePick) {
                    qp.activeItems = [activePick];
                }
                qp.onDidAccept(() => {
                    resolve(qp.selectedItems[0]);
                    qp.dispose();
                });
                qp.onDidHide(() => {
                    resolve(undefined);
                    qp.dispose();
                });
                qp.show();
            });
            if (pick) {
                await updateConfig({ simulatorDevice: pick.label, simulatorUdid: pick.udid, deviceIdentifier: pick.deviceIdentifier, isPhysicalDevice: pick.isPhysical });
            }
        }
    );

    const buildCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.build',
        async () => {
            const tasks = await vscode.tasks.fetchTasks({ type: 'xcode-build' });
            const buildTask = tasks.find((t) => t.name === 'Build');
            if (buildTask) {
                await vscode.tasks.executeTask(buildTask);
            } else {
                vscode.window.showErrorMessage('Build task not available. Check configuration.');
            }
        }
    );

    // ── Debug orchestration ─────────────────────────────────────
    async function buildAndDebugSimulator(config: BuildTaskConfig): Promise<void> {
        // 1. Fetch and execute build task, wait for completion
        const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
        const buildTask = tasks.find((t) => t.name === 'Build');
        if (!buildTask) {
            vscode.window.showErrorMessage('Build task not available. Check configuration.');
            return;
        }

        // Use shared panel so build output and console share the same terminal
        buildTask.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear: true,
        };

        log('[simulator-debug] starting build...');
        const exitCode = await executeTaskAndWait(buildTask);
        if (exitCode !== 0) {
            log(`[simulator-debug] build failed with exit code ${exitCode}`);
            return;
        }
        log('[simulator-debug] build succeeded');

        const udid = config.simulatorUdid || config.simulatorDevice;
        const homeDir = require('os').homedir();
        const appPath = path.join(homeDir, 'Library', 'Developer', 'VSCode', 'DerivedData', config.schemeName, 'Build', 'Products', 'Debug-iphonesimulator', `${config.productName}.app`);

        // 2. Boot simulator and install app
        const cp = await import('child_process');
        log('[simulator-debug] booting simulator and installing app...');
        await new Promise<void>((resolve, reject) => {
            cp.exec(
                [
                    `xcrun simctl boot "${udid}" 2>/dev/null || true`,
                    `xcrun simctl terminate booted "${config.bundleIdentifier}" 2>/dev/null || true`,
                    `xcrun simctl install booted "${appPath}"`,
                    'open -a Simulator',
                ].join(' && '),
                (error) => error ? reject(error) : resolve()
            );
        });
        log('[simulator-debug] install succeeded');

        // 3. Launch app with console streaming via task
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found.');
            return;
        }

        if (consoleExecution) {
            consoleExecution.terminate();
            consoleExecution = undefined;
        }

        const allTasks = await vscode.tasks.fetchTasks();
        const launchTask = allTasks.find((t) => t.name === 'Run and Debug');
        if (!launchTask) {
            log('[simulator-debug] ERROR: Run and Debug task not found');
            return;
        }
        log('[simulator-debug] starting console task...');
        consoleExecution = await vscode.tasks.executeTask(launchTask);

        // 4. Attach debugger
        const debugConfig: vscode.DebugConfiguration = {
            type: 'lldb-dap',
            request: 'attach',
            name: `Debug ${config.productName}`,
            attachCommands: [
                `process attach --name ${config.productName} --waitfor`
            ]
        };
        log('[simulator-debug] starting debug session...');
        const started = await vscode.debug.startDebugging(folder, debugConfig);
        if (!started) {
            log('[simulator-debug] debug session failed to start');
            consoleExecution?.terminate();
            consoleExecution = undefined;
        }
    }

    async function buildAndDebugPhysicalDevice(config: BuildTaskConfig): Promise<void> {
        // 1. Fetch and execute build task, wait for completion
        const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
        const buildTask = tasks.find((t) => t.name === 'Build');
        if (!buildTask) {
            vscode.window.showErrorMessage('Build task not available. Check configuration.');
            return;
        }

        // Use shared panel so build output and console share the same terminal
        buildTask.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear: true,
        };

        log('[physical-debug] starting build...');
        const exitCode = await executeTaskAndWait(buildTask);
        if (exitCode !== 0) {
            log(`[physical-debug] build failed with exit code ${exitCode}`);
            return;
        }
        log('[physical-debug] build succeeded');

        const devId = config.deviceIdentifier || config.simulatorUdid || config.simulatorDevice;
        const homeDir = require('os').homedir();
        const appPath = path.join(homeDir, 'Library', 'Developer', 'VSCode', 'DerivedData', config.schemeName, 'Build', 'Products', 'Debug-iphoneos', `${config.productName}.app`);

        // 2. Install app on device
        try {
            log(`[physical-debug] installing ${config.productName}.app on device...`);
            await devicectlInstall(devId, appPath);
            log('[physical-debug] install succeeded');
        } catch (error) {
            const message = (error as { message?: string }).message || String(error);
            log(`[physical-debug] install failed: ${message}`);
            vscode.window.showErrorMessage(`Failed to install app on device: ${message}`);
            return;
        }

        // 3. Verify device is unlocked before launching
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found.');
            return;
        }

        log('[physical-debug] checking device readiness...');
        const initialCheck = await checkDeviceReady(devId);
        if (!initialCheck.ready) {
            log(`[physical-debug] device not ready: ${initialCheck.message}`);
            const unlocked = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Device is locked. Waiting for unlock…',
                    cancellable: true,
                },
                async (_progress, token) => {
                    while (!token.isCancellationRequested) {
                        await new Promise<void>((resolve) => {
                            const timeout = setTimeout(resolve, 3000);
                            token.onCancellationRequested(() => { clearTimeout(timeout); resolve(); });
                        });
                        if (token.isCancellationRequested) return false;
                        const check = await checkDeviceReady(devId);
                        if (check.ready) return true;
                    }
                    return false;
                }
            );
            if (!unlocked) {
                log('[physical-debug] cancelled waiting for device unlock');
                printToSharedPanel('App launch cancelled.');
                return;
            }
            log('[physical-debug] device unlocked');
        }

        // 4. Launch app with console streaming via task
        if (consoleExecution) {
            consoleExecution.terminate();
            consoleExecution = undefined;
        }

        const debugConsoleTask = buildTaskProvider.createPhysicalDebugTask(config, folder);
        log('[physical-debug] starting debug console task...');
        consoleExecution = await vscode.tasks.executeTask(debugConsoleTask);

        // 5. Wait for console task to settle — detect early failures (locked device, etc.)
        const earlyExit = await Promise.race<number | null>([
            new Promise<number>((resolve) => {
                const listener = vscode.tasks.onDidEndTaskProcess((event) => {
                    if (event.execution.task.name === 'Run and Debug') {
                        listener.dispose();
                        resolve(event.exitCode ?? 1);
                    }
                });
                setTimeout(() => listener.dispose(), 3500);
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);

        if (earlyExit !== null) {
            log(`[physical-debug] console task exited early with code ${earlyExit}`);
            consoleExecution = undefined;
            buildTaskProvider.writeToConsole('\r\n\x1b[33mApp launch exited.\x1b[0m\r\n\r\n');
            return;
        }
        log('[physical-debug] console task is running');
        buildTaskProvider.writeToConsole('\r\n\x1b[32mApp launched successfully.\x1b[0m\r\n\r\n');

        // 6. Attach debugger by name (--waitfor finds the --start-stopped process)
        const debugConfig: vscode.DebugConfiguration = {
            type: 'lldb-dap',
            request: 'attach',
            name: `Debug ${config.productName} (Device)`,
            program: appPath,
            initCommands: [
                'platform select remote-ios',
            ],
            attachCommands: [
                `script lldb.debugger.HandleCommand('device select ${devId}')`,
                `script lldb.debugger.HandleCommand('device process attach --name ${config.productName} --waitfor --include-existing')`,
            ],
        };
        log('[physical-debug] starting debug session...');
        const started = await vscode.debug.startDebugging(folder, debugConfig);
        if (!started) {
            log('[physical-debug] debug session failed to start');
            buildTaskProvider.writeToConsole('\r\n\x1b[33mApp launch cancelled.\x1b[0m\r\n\r\n');
            consoleExecution?.terminate();
            consoleExecution = undefined;
        }
    }

    const buildAndRunCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.buildAndRun',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) {
                vscode.window.showErrorMessage(
                    'No build configuration found. Run "Swift: Configure Build Tasks" first.',
                    'Configure'
                ).then((action) => {
                    if (action === 'Configure') {
                        vscode.commands.executeCommand('swiftPackageHelper.generateBuildTasks');
                    }
                });
                return;
            }
            if (config.isPhysicalDevice) {
                await buildAndDebugPhysicalDevice(config);
            } else {
                await buildAndDebugSimulator(config);
            }
        }
    );

    const refreshCmd = vscode.commands.registerCommand(
        'swiftPackageHelper.sidebar.refresh',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            await sidebarProvider.loadProjectData(config);
            sidebarProvider.refresh();
        }
    );

    // ── File watcher ──────────────────────────────────────────

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.pbxproj');
    const onProjectChange = watcher.onDidChange(async () => {
        sidebarProvider.refresh();
        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 0) {
            generatePackageSwift(wsFolders[0].uri.fsPath, 'Debug', true).catch((error) => {
                const message = (error as { message?: string }).message || String(error);
                log(`[file-watcher] Package.swift regen failed: ${message}`);
            });
        }
    });

    // ── Swift file watcher (auto-sync to pbxproj) ─────────────

    const swiftWatcherDisposables = createSwiftFileWatcher(rootPath, log);
    context.subscriptions.push(...swiftWatcherDisposables);

    // ── Debug cleanup ──────────────────────────────────────────

    const onDebugEnd = vscode.debug.onDidTerminateDebugSession(async () => {
        // Physical device: killing the console process (devicectl --console) terminates the app.
        // Next launch uses --terminate-existing as a safety net.
        const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');

        // Simulator: terminate the app first, then kill the console process.
        // simctl terminate tells the simulator runtime to stop the app (which is
        // a separate process not in our group), then killConsoleProcess ends the
        // monitoring process (simctl launch --console-pty) and completes the task.
        if (config && !config.isPhysicalDevice) {
            const cp = await import('child_process');
            const udid = config.simulatorUdid || config.simulatorDevice;
            log(`[debug-end] terminating app "${config.bundleIdentifier}" on simulator`);
            await new Promise<void>((resolve) => {
                cp.exec(
                    `xcrun simctl terminate "${udid}" "${config.bundleIdentifier}"`,
                    () => resolve()
                );
            });
        }

        log('[debug-end] killing console process');
        buildTaskProvider.killConsoleProcess();
    });

    const onDebugStart = vscode.debug.onDidStartDebugSession((session) => {
        const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        const target = config?.isPhysicalDevice ? 'device' : 'simulator';
        log(`[run-and-debug] ${session.name} — debugger attached to ${target}`);
    });

    // ── Register all disposables ──────────────────────────────

    context.subscriptions.push(
        generateCommand, generateWithOptionsCommand, generateBuildTasksCommand,
        taskProvider, debugProvider, treeView,
        changeProjectCmd, changeTargetCmd, changeSchemeCmd, changeBundleIdCmd,
        selectSimulatorCmd, buildCmd, buildAndRunCmd, refreshCmd,
        watcher, onProjectChange, onDebugStart, onDebugEnd,
        outputChannel
    );

    // One-time migration notice for users with old file-based build tasks
    const oldScriptsExist = fs.existsSync(path.join(rootPath, '.vscode', 'scripts', 'build.sh'));
    const noticeShown = context.workspaceState.get<boolean>('migrationNoticeShown');
    if (oldScriptsExist && !noticeShown) {
        vscode.window.showInformationMessage(
            'Swift Package Helper now uses integrated build tasks. You can safely delete .vscode/scripts/ and the build entries in tasks.json/launch.json.'
        );
        context.workspaceState.update('migrationNoticeShown', true);
    }

    } // end setupFullExtension
}

export function deactivate(): void {
    if (consoleExecution) {
        consoleExecution.terminate();
        consoleExecution = undefined;
    }
}
