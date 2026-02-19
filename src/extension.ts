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
import { parseResourcesForTarget } from './parsers/resources';
import { generateSwiftSettings } from './generators/swiftSettings';
import { generateLinkerSettings } from './generators/linkerSettings';
import { buildPackageSwift, formatPackageDependencyEntry } from './generators/packageSwift';
import { generateBuildScript, generateBuildAndDebugScript, generateTasksJson, generateLaunchJson } from './generators/buildTasks';
import { listAvailableSimulators } from './utils/simulator';

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

async function generatePackageSwift(rootPath: string, configurationName: string = 'Debug'): Promise<void> {
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
            path: determineTargetPath(rootPath, target.name, testTarget),
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
        const resources = parseResourcesForTarget(pbxContents, buildPhases.resourcesBuildPhaseId);
        const excluded = parseExcludedFiles(pbxContents, nativeTarget.name);

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
            resources: resources.length > 0 ? resources : undefined,
            swiftSettings: swiftSettings.length > 0 ? swiftSettings : undefined,
            cSettings: cSettings.length > 0 ? cSettings : undefined,
            linkerSettings: linkerSettings.length > 0 ? linkerSettings : undefined,
            exclude: excluded.length > 0 ? excluded : undefined
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

    const packagePath = path.join(rootPath, 'Package.swift');

    if (fs.existsSync(packagePath)) {
        const existingContents = await fsp.readFile(packagePath, 'utf8');
        if (existingContents === packageContents) {
            vscode.window.showInformationMessage('Package.swift is already up to date.');
            return;
        }

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

    await fsp.writeFile(packagePath, packageContents, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(packagePath));
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(`Package.swift generated from ${selectedProject}`);
}

async function generateBuildTasks(rootPath: string): Promise<void> {
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

    const simulators = await listAvailableSimulators();
    if (simulators.length === 0) {
        throw new Error('No available iOS simulators found. Install simulators via Xcode.');
    }

    const simulatorPick = await vscode.window.showQuickPick(
        simulators.map((s) => ({ label: s.name, description: s.state, detail: s.runtime })),
        { placeHolder: 'Select simulator device' }
    );
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

    const buildTasksOptions = {
        projectFile: selectedProject,
        schemeName,
        productName: resolvedProductName,
        bundleIdentifier,
        simulatorDevice: simulatorPick.label
    };

    const buildScriptContent = generateBuildScript(buildTasksOptions);
    const buildAndDebugScriptContent = generateBuildAndDebugScript(buildTasksOptions);
    const tasksContent = generateTasksJson();
    const launchContent = generateLaunchJson(resolvedProductName);

    const vscodeDir = path.join(rootPath, '.vscode');
    const scriptsDir = path.join(vscodeDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) {
        await fsp.mkdir(scriptsDir, { recursive: true });
    }

    const tasksPath = path.join(vscodeDir, 'tasks.json');
    const launchPath = path.join(vscodeDir, 'launch.json');
    const buildScriptPath = path.join(scriptsDir, 'build.sh');
    const buildAndDebugScriptPath = path.join(scriptsDir, 'build-and-debug.sh');

    if (fs.existsSync(tasksPath) || fs.existsSync(launchPath) || fs.existsSync(buildScriptPath) || fs.existsSync(buildAndDebugScriptPath)) {
        const overwrite = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], {
            placeHolder: '.vscode build files already exist. Overwrite?'
        });
        if (overwrite !== 'Overwrite') {
            return;
        }
    }

    await fsp.writeFile(buildScriptPath, buildScriptContent, 'utf8');
    await fsp.writeFile(buildAndDebugScriptPath, buildAndDebugScriptContent, 'utf8');
    await fsp.writeFile(tasksPath, tasksContent, 'utf8');
    await fsp.writeFile(launchPath, launchContent, 'utf8');
    await fsp.chmod(buildScriptPath, 0o755);
    await fsp.chmod(buildAndDebugScriptPath, 0o755);

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(buildAndDebugScriptPath));
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(
        `Build scripts generated for ${selectedTarget.name} on ${simulatorPick.label}`
    );

    if (!vscode.extensions.getExtension('vadimcn.vscode-lldb')) {
        const install = await vscode.window.showWarningMessage(
            'CodeLLDB extension is required for debugging. Install it?',
            'Install', 'Dismiss'
        );
        if (install === 'Install') {
            vscode.commands.executeCommand('workbench.extensions.installExtension', 'vadimcn.vscode-lldb');
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const generateCommand = vscode.commands.registerCommand(
        'swiftPackageHelper.createFromXcodeproj',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                const rootPath = workspaceFolders[0].uri.fsPath;
                await generatePackageSwift(rootPath);
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
                const rootPath = workspaceFolders[0].uri.fsPath;

                const config = await vscode.window.showQuickPick(['Debug', 'Release'], {
                    placeHolder: 'Select build configuration for settings extraction'
                });
                if (!config) {
                    return;
                }
                await generatePackageSwift(rootPath, config);
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    const generateBuildTasksCommand = vscode.commands.registerCommand(
        'swiftPackageHelper.generateBuildTasks',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                const rootPath = workspaceFolders[0].uri.fsPath;
                await generateBuildTasks(rootPath);
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.pbxproj');
    const onProjectChange = watcher.onDidChange(async () => {
        const action = await vscode.window.showInformationMessage(
            'Xcode project file changed. Regenerate Package.swift?',
            'Regenerate',
            'Dismiss'
        );
        if (action === 'Regenerate') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                try {
                    await generatePackageSwift(workspaceFolders[0].uri.fsPath);
                } catch (error) {
                    const message = (error as { message?: string }).message as string;
                    vscode.window.showErrorMessage(message);
                }
            }
        }
    });

    context.subscriptions.push(generateCommand, generateWithOptionsCommand, generateBuildTasksCommand, watcher, onProjectChange);
}

export function deactivate(): void {}
