"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const util_1 = require("util");
const child_process_1 = require("child_process");
const execFile = (0, util_1.promisify)(child_process_1.execFile);
const PLATFORM_KEYS = {
    IPHONEOS_DEPLOYMENT_TARGET: 'iOS',
    MACOSX_DEPLOYMENT_TARGET: 'macOS',
    TVOS_DEPLOYMENT_TARGET: 'tvOS',
    WATCHOS_DEPLOYMENT_TARGET: 'watchOS'
};
const PLATFORM_DECLARATIONS = {
    iOS: '.iOS',
    macOS: '.macOS',
    tvOS: '.tvOS',
    watchOS: '.watchOS'
};
const DEFAULT_SWIFT_VERSION = '6.2';
const DEFAULT_PLATFORM = { platform: 'iOS', version: '26.0' };
const INDENT = '    ';
function indent(level) {
    return INDENT.repeat(level);
}
function cleanup(value) {
    if (!value) {
        return '';
    }
    return value.replace(/^"+|"+$/g, '').trim();
}
function compareVersions(left, right) {
    const parse = (value) => value.split('.').map((part) => Number(part) || 0);
    const a = parse(left);
    const b = parse(right);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff > 0) {
            return 1;
        }
        if (diff < 0) {
            return -1;
        }
    }
    return 0;
}
function parseSwiftVersion(pbxContents) {
    const matches = [...pbxContents.matchAll(/SWIFT_VERSION = ([^;]+);/g)];
    const versions = matches
        .map((match) => cleanup(match[1]))
        .filter((value) => value.length > 0);
    const unique = [...new Set(versions)];
    unique.sort((a, b) => compareVersions(b, a));
    return unique[0] || null;
}
function parseSwiftToolsVersion(output) {
    if (!output) {
        return null;
    }
    const match = output.match(/Swift(?:\s+language)?\s+version\s+([0-9]+(?:\.[0-9]+)*)/i);
    return match ? match[1] : null;
}
async function detectSwiftToolsVersion() {
    const commands = [
        { command: 'xcrun', args: ['swift', '--version'] },
        { command: 'swift', args: ['--version'] }
    ];
    for (const entry of commands) {
        try {
            const { stdout } = await execFile(entry.command, entry.args, { encoding: 'utf8' });
            const version = parseSwiftToolsVersion(stdout);
            if (version) {
                return version;
            }
        }
        catch (error) {
            // Ignore and try next candidate.
        }
    }
    return null;
}
async function detectMacOSVersion() {
    if (process.platform !== 'darwin') {
        return null;
    }
    try {
        const { stdout } = await execFile('sw_vers', ['-productVersion'], { encoding: 'utf8' });
        const version = cleanup(stdout);
        return version.length > 0 ? version : null;
    }
    catch (error) {
        return null;
    }
}
function parseDeploymentTargets(pbxContents) {
    const found = new Map();
    const entries = Object.entries(PLATFORM_KEYS);
    for (const [key, platform] of entries) {
        const regex = new RegExp(`${key} = ([^;]+);`, 'g');
        let match;
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
async function ensureMacOSPlatform(platforms) {
    const detectedVersion = await detectMacOSVersion();
    if (!detectedVersion) {
        return platforms;
    }
    const next = platforms.slice();
    const macIndex = next.findIndex(({ platform }) => platform === 'macOS');
    const macEntry = { platform: 'macOS', version: detectedVersion };
    if (macIndex === -1) {
        next.push(macEntry);
    }
    else {
        next[macIndex] = macEntry;
    }
    return next;
}
function isTestTarget(productType) {
    if (!productType) {
        return false;
    }
    return (productType.includes('unit-test') ||
        productType.includes('ui-testing') ||
        productType.includes('.test'));
}
function mapProductType(_productType) {
    return '.library';
}
function parseNativeTargets(pbxContents) {
    const sectionRegex = /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return [];
    }
    const section = sectionMatch[1];
    const targetRegex = /\s*[A-F0-9]+\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*PBXNativeTarget;([\s\S]*?)\};/g;
    const targets = [];
    let match;
    while ((match = targetRegex.exec(section)) !== null) {
        const displayName = cleanup(match[1]);
        const body = match[2];
        const nameMatch = /name = ([^;]+);/.exec(body);
        const productNameMatch = /productName = ([^;]+);/.exec(body);
        const productTypeMatch = /productType = "([^"]+)"/.exec(body);
        const packageProductDependenciesMatch = /packageProductDependencies = \(([\s\S]*?)\);/.exec(body);
        const packageProductDependencyIds = [];
        if (packageProductDependenciesMatch) {
            const block = packageProductDependenciesMatch[1];
            const idRegex = /([A-F0-9]{24})/g;
            let idMatch;
            while ((idMatch = idRegex.exec(block)) !== null) {
                packageProductDependencyIds.push(idMatch[1]);
            }
        }
        const name = cleanup(nameMatch ? nameMatch[1] : displayName);
        const productName = cleanup(productNameMatch ? productNameMatch[1] : name);
        const productType = cleanup(productTypeMatch ? productTypeMatch[1] : '');
        targets.push({ name, productName, productType, packageProductDependencyIds });
    }
    return targets;
}
function extractObjectBody(contents, startIndex) {
    const length = contents.length;
    const braceIndex = contents.indexOf('{', startIndex);
    if (braceIndex === -1) {
        return null;
    }
    let depth = 1;
    let index = braceIndex + 1;
    const bodyStart = index;
    while (index < length) {
        const char = contents[index];
        if (char === '{') {
            depth += 1;
        }
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return {
                    body: contents.slice(bodyStart, index),
                    endIndex: index + 1
                };
            }
        }
        index += 1;
    }
    return {
        body: contents.slice(bodyStart),
        endIndex: length
    };
}
function parsePackageRequirement(block) {
    const requirement = {};
    const pairRegex = /([A-Za-z]+)\s*=\s*([^;]+);/g;
    let match;
    while ((match = pairRegex.exec(block)) !== null) {
        const key = cleanup(match[1]);
        const value = cleanup(match[2]);
        if (key && value) {
            requirement[key] = value;
        }
    }
    return requirement;
}
function parseSwiftPackageReferences(pbxContents) {
    const references = new Map();
    const remoteRegex = /([A-F0-9]+)\s*\/\*\s*XCRemoteSwiftPackageReference\s*"([^"]+)"\s*\*\/\s*=\s*\{/g;
    let match;
    while ((match = remoteRegex.exec(pbxContents)) !== null) {
        const [, id, displayName] = match;
        const objectBody = extractObjectBody(pbxContents, remoteRegex.lastIndex - 1);
        if (!objectBody) {
            continue;
        }
        remoteRegex.lastIndex = objectBody.endIndex;
        const body = objectBody.body;
        const urlMatch = /repositoryURL = "([^"]+)";/.exec(body);
        const requirementMatch = /requirement = \{([\s\S]*?)\};/.exec(body);
        references.set(id, {
            id,
            name: cleanup(displayName),
            type: 'remote',
            url: cleanup(urlMatch ? urlMatch[1] : ''),
            requirement: requirementMatch ? parsePackageRequirement(requirementMatch[1]) : {}
        });
    }
    const localRegex = /([A-F0-9]+)\s*\/\*\s*XCLocalSwiftPackageReference\s*"([^"]+)"\s*\*\/\s*=\s*\{/g;
    while ((match = localRegex.exec(pbxContents)) !== null) {
        const [, id, displayName] = match;
        const objectBody = extractObjectBody(pbxContents, localRegex.lastIndex - 1);
        if (!objectBody) {
            continue;
        }
        localRegex.lastIndex = objectBody.endIndex;
        const body = objectBody.body;
        const pathMatch = /relativePath = "([^"]+)";/.exec(body) || /path = "([^"]+)";/.exec(body);
        references.set(id, {
            id,
            name: cleanup(displayName),
            type: 'local',
            path: cleanup(pathMatch ? pathMatch[1] : '')
        });
    }
    return references;
}
function parseSwiftPackageProductDependencies(pbxContents) {
    const dependencies = new Map();
    const regex = /([A-F0-9]+)\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*XCSwiftPackageProductDependency;([\s\S]*?)\};/g;
    let match;
    while ((match = regex.exec(pbxContents)) !== null) {
        const [, id, displayName, body] = match;
        const productNameMatch = /productName = ([^;]+);/.exec(body);
        const packageMatch = /package = ([A-F0-9]+)(?:\s*\/\*\s*[^*]*?"([^"]+)"\s*\*\/)?;/.exec(body);
        const productName = cleanup(productNameMatch ? productNameMatch[1] : displayName);
        const packageRef = packageMatch ? cleanup(packageMatch[1]) : null;
        const packageName = packageMatch && packageMatch[2] ? cleanup(packageMatch[2]) : null;
        dependencies.set(id, {
            id,
            productName,
            packageRef,
            packageName
        });
    }
    return dependencies;
}
function formatPlatformVersion(version) {
    const major = Number.parseInt(String(version).split('.')[0], 10);
    if (Number.isFinite(major) && major > 0) {
        return `.v${major}`;
    }
    return `.v13`;
}
function determineTargetPath(rootPath, targetName, isTest) {
    const relativeCandidates = [];
    if (isTest) {
        relativeCandidates.push(path.join('Tests', targetName));
        if (targetName.endsWith('Tests')) {
            relativeCandidates.push(path.join('Tests', targetName.replace(/Tests$/, '')));
        }
    }
    else {
        relativeCandidates.push(path.join('Sources', targetName));
    }
    relativeCandidates.push(targetName);
    relativeCandidates.push(path.join('Sources', 'Shared', targetName));
    for (const relativeCandidate of relativeCandidates) {
        const absolute = path.join(rootPath, relativeCandidate);
        if (fs.existsSync(absolute)) {
            return relativeCandidate.split(path.sep).join('/');
        }
    }
    return targetName;
}
function formatPlatforms(platforms) {
    return platforms
        .map(({ platform, version }, index) => {
        const declaration = PLATFORM_DECLARATIONS[platform] || '.iOS';
        const formattedVersion = formatPlatformVersion(version);
        const suffix = index < platforms.length - 1 ? ',' : '';
        return `${indent(2)}${declaration}(${formattedVersion})${suffix}`;
    })
        .join('\n');
}
function formatProducts(products) {
    if (products.length === 0) {
        return `${indent(2)}.library(\n${indent(3)}name: "Library",\n${indent(3)}targets: []\n${indent(2)})`;
    }
    return products
        .map((product) => {
        const targetsList = product.targets.map((item) => `"${item}"`).join(', ');
        return [
            `${indent(2)}${product.type}(`,
            `${indent(3)}name: "${product.name}",`,
            `${indent(3)}targets: [${targetsList}]`,
            `${indent(2)})`
        ].join('\n');
    })
        .join('\n');
}
function formatRemotePackageRequirement(requirement) {
    if (!requirement) {
        return null;
    }
    const kind = requirement.kind;
    if (!kind) {
        return null;
    }
    const versionOrMinimum = requirement.version || requirement.minimumVersion;
    switch (kind) {
        case 'upToNextMajorVersion': {
            if (versionOrMinimum) {
                return `.upToNextMajor(from: "${versionOrMinimum}")`;
            }
            break;
        }
        case 'upToNextMinorVersion': {
            if (versionOrMinimum) {
                return `.upToNextMinor(from: "${versionOrMinimum}")`;
            }
            break;
        }
        case 'exactVersion': {
            if (versionOrMinimum) {
                return `.exact("${versionOrMinimum}")`;
            }
            break;
        }
        case 'branch': {
            if (requirement.branch) {
                return `.branch("${requirement.branch}")`;
            }
            break;
        }
        case 'revision': {
            if (requirement.revision) {
                return `.revision("${requirement.revision}")`;
            }
            break;
        }
        case 'versionRange': {
            if (requirement.minimumVersion && requirement.maximumVersion) {
                return `"${requirement.minimumVersion}"..<"${requirement.maximumVersion}"`;
            }
            break;
        }
        case 'range': {
            if (requirement.lowerBound && requirement.upperBound) {
                return `"${requirement.lowerBound}"..<"${requirement.upperBound}"`;
            }
            break;
        }
        default: {
            break;
        }
    }
    const fallbackVersion = requirement.minimumVersion || requirement.version;
    if (fallbackVersion) {
        return `.upToNextMajor(from: "${fallbackVersion}")`;
    }
    return null;
}
function formatPackageDependencyEntry(reference) {
    if (reference.type === 'local') {
        const pathValue = reference.path && reference.path.length > 0 ? reference.path : `./${reference.name}`;
        return `.package(path: "${pathValue}")`;
    }
    const url = reference.url || '';
    const requirement = reference.requirement || {};
    const formattedRequirement = formatRemotePackageRequirement(requirement);
    if (formattedRequirement) {
        return `.package(url: "${url}", ${formattedRequirement})`;
    }
    return `.package(url: "${url}")`;
}
function formatPackageDependencies(dependencies) {
    return dependencies.map((dependency) => `${indent(2)}${dependency}`).join('\n');
}
function formatTargets(targets) {
    if (targets.length === 0) {
        return `${indent(2)}.target(\n${indent(3)}name: "Placeholder",\n${indent(3)}path: "Sources"\n${indent(2)})`;
    }
    return targets
        .map((target) => {
        const properties = [`name: "${target.name}"`];
        if (target.dependencies && target.dependencies.length > 0) {
            properties.push(`dependencies: [${target.dependencies.join(', ')}]`);
        }
        properties.push(`path: "${target.path}"`);
        const lines = [`${indent(2)}${target.spmType}(`];
        properties.forEach((property, index) => {
            const suffix = index === properties.length - 1 ? '' : ',';
            lines.push(`${indent(3)}${property}${suffix}`);
        });
        lines.push(`${indent(2)})`);
        return lines.join('\n');
    })
        .join('\n');
}
function buildPackageSwift({ packageName, swiftVersion, platforms, products, dependencies, targets }) {
    const platformsSection = formatPlatforms(platforms);
    const productsSection = formatProducts(products);
    const dependenciesSection = dependencies && dependencies.length > 0 ? formatPackageDependencies(dependencies) : '';
    const targetsSection = formatTargets(targets);
    return `// swift-tools-version: ${swiftVersion}
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "${packageName}",
    platforms: [
${platformsSection}
    ],
    products: [
${productsSection}
    ],${dependenciesSection
        ? `
    dependencies: [
${dependenciesSection}
    ],`
        : ''}
    targets: [
${targetsSection}
    ]
)
`;
}
async function generatePackageSwift(rootPath) {
    const entries = await fs_1.promises.readdir(rootPath, { withFileTypes: true });
    const xcodeProjects = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'));
    if (xcodeProjects.length === 0) {
        throw new Error('No .xcodeproj found in the workspace root.');
    }
    let selectedProject = xcodeProjects[0].name;
    if (xcodeProjects.length > 1) {
        const pick = await vscode.window.showQuickPick(xcodeProjects.map((entry) => entry.name), { placeHolder: 'Select the Xcode project to read' });
        if (!pick) {
            return;
        }
        selectedProject = pick;
    }
    const pbxprojPath = path.join(rootPath, selectedProject, 'project.pbxproj');
    let pbxContents;
    try {
        pbxContents = await fs_1.promises.readFile(pbxprojPath, 'utf8');
    }
    catch (error) {
        const message = error.message;
        throw new Error(`Unable to read ${pbxprojPath}: ${message}`);
    }
    const swiftVersion = (await detectSwiftToolsVersion()) || parseSwiftVersion(pbxContents) || DEFAULT_SWIFT_VERSION;
    const platforms = await ensureMacOSPlatform(parseDeploymentTargets(pbxContents));
    const nativeTargets = parseNativeTargets(pbxContents);
    const packageReferences = parseSwiftPackageReferences(pbxContents);
    const packageProductDependencies = parseSwiftPackageProductDependencies(pbxContents);
    if (nativeTargets.length === 0) {
        throw new Error('No native targets found in the Xcode project.');
    }
    const packageName = path.basename(selectedProject, '.xcodeproj');
    const targetDefinitions = nativeTargets.map((target) => {
        const testTarget = isTestTarget(target.productType);
        const targetPackageDependencies = target.packageProductDependencyIds && target.packageProductDependencyIds.length > 0
            ? target.packageProductDependencyIds
                .map((dependencyId) => packageProductDependencies.get(dependencyId))
                .filter((dependency) => Boolean(dependency))
                .map((dependency) => {
                const packageRef = dependency.packageRef
                    ? packageReferences.get(dependency.packageRef)
                    : undefined;
                const packageNameValue = ((packageRef && packageRef.name) ||
                    dependency.packageName ||
                    dependency.productName);
                return `.product(name: "${dependency.productName}", package: "${packageNameValue}")`;
            })
            : [];
        const uniqueDependencies = Array.from(new Set(targetPackageDependencies));
        return {
            name: target.name,
            productName: target.productName,
            productType: target.productType,
            spmType: testTarget ? '.testTarget' : '.target',
            path: determineTargetPath(rootPath, target.name, testTarget),
            isTest: testTarget,
            dependencies: uniqueDependencies
        };
    });
    const productMap = new Map();
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
        }
        else {
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
        .filter((entry) => Boolean(entry));
    const uniquePackageDependencies = Array.from(new Set(packageDependenciesList));
    const packageContents = buildPackageSwift({
        packageName,
        swiftVersion,
        platforms,
        products,
        dependencies: uniquePackageDependencies,
        targets: targetDefinitions.map((target) => ({
            spmType: target.spmType,
            name: target.name,
            path: target.path,
            dependencies: target.dependencies
        }))
    });
    const packagePath = path.join(rootPath, 'Package.swift');
    if (fs.existsSync(packagePath)) {
        const overwrite = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], {
            placeHolder: 'Package.swift already exists. Overwrite?'
        });
        if (overwrite !== 'Overwrite') {
            return;
        }
    }
    await fs_1.promises.writeFile(packagePath, packageContents, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(packagePath));
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(`Package.swift generated from ${selectedProject}`);
}
function activate(context) {
    const disposable = vscode.commands.registerCommand('swiftPackageHelper.createFromXcodeproj', async () => {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('Open a workspace folder before running this command.');
            }
            const rootPath = workspaceFolders[0].uri.fsPath;
            await generatePackageSwift(rootPath);
        }
        catch (error) {
            const message = error.message;
            vscode.window.showErrorMessage(message);
        }
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map