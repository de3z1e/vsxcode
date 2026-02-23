import type { NativeTarget, TargetDependencyInfo } from '../types/interfaces';
import { cleanup } from '../utils/version';

export function isTestTarget(productType: string | undefined): boolean {
    if (!productType) {
        return false;
    }
    return (
        productType.includes('unit-test') ||
        productType.includes('ui-testing') ||
        productType.includes('.test')
    );
}

export function mapProductType(_productType: string | undefined): '.library' {
    return '.library';
}

export function parseNativeTargets(pbxContents: string): NativeTarget[] {
    const sectionRegex =
        /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return [];
    }
    const section = sectionMatch[1];
    const targetRegex =
        /\s*[A-F0-9]+\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*PBXNativeTarget;([\s\S]*?)\};/g;
    const targets: NativeTarget[] = [];
    let match: RegExpExecArray | null;
    while ((match = targetRegex.exec(section)) !== null) {
        const displayName = cleanup(match[1]);
        const body = match[2];
        const nameMatch = /name = ([^;]+);/.exec(body);
        const productNameMatch = /productName = ([^;]+);/.exec(body);
        const productTypeMatch = /productType = "([^"]+)"/.exec(body);
        const buildConfigListMatch = /buildConfigurationList = ([A-F0-9]+)/.exec(body);
        const packageProductDependenciesMatch = /packageProductDependencies = \(([\s\S]*?)\);/.exec(
            body
        );
        const packageProductDependencyIds: string[] = [];
        if (packageProductDependenciesMatch) {
            const block = packageProductDependenciesMatch[1];
            const idRegex = /([A-F0-9]{24})/g;
            let idMatch: RegExpExecArray | null;
            while ((idMatch = idRegex.exec(block)) !== null) {
                packageProductDependencyIds.push(idMatch[1]);
            }
        }
        const name = cleanup(nameMatch ? nameMatch[1] : displayName);
        const productName = cleanup(productNameMatch ? productNameMatch[1] : name);
        const productType = cleanup(productTypeMatch ? productTypeMatch[1] : '');
        const buildConfigurationListId = cleanup(buildConfigListMatch ? buildConfigListMatch[1] : '');
        targets.push({ name, productName, productType, packageProductDependencyIds, buildConfigurationListId });
    }
    return targets;
}

export function parseTargetDependencies(pbxContents: string): Map<string, TargetDependencyInfo[]> {
    const result = new Map<string, TargetDependencyInfo[]>();

    const sectionRegex =
        /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return result;
    }
    const section = sectionMatch[1];

    const targetRegex =
        /\s*([A-F0-9]+)\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*PBXNativeTarget;([\s\S]*?)\};/g;
    const targetIdToName = new Map<string, string>();
    const targetDependencyRefs = new Map<string, string[]>();

    let match: RegExpExecArray | null;
    while ((match = targetRegex.exec(section)) !== null) {
        const targetId = match[1];
        const targetName = cleanup(match[2]);
        targetIdToName.set(targetId, targetName);

        const body = match[3];
        const depsMatch = /dependencies = \(([\s\S]*?)\);/.exec(body);
        if (depsMatch) {
            const block = depsMatch[1];
            const idRegex = /([A-F0-9]{24})/g;
            const depIds: string[] = [];
            let idMatch: RegExpExecArray | null;
            while ((idMatch = idRegex.exec(block)) !== null) {
                depIds.push(idMatch[1]);
            }
            if (depIds.length > 0) {
                targetDependencyRefs.set(targetName, depIds);
            }
        }
    }

    const depSectionRegex =
        /\/\* Begin PBXTargetDependency section \*\/([\s\S]*?)\/\* End PBXTargetDependency section \*\//;
    const depSectionMatch = depSectionRegex.exec(pbxContents);
    if (!depSectionMatch) {
        return result;
    }
    const depSection = depSectionMatch[1];

    const depIdToTarget = new Map<string, string>();
    const depEntryRegex =
        /([A-F0-9]+)\s*\/\*[^*]*\*\/\s*=\s*\{[^}]*target = ([A-F0-9]+)\s*\/\*\s*([^*]+)\s*\*\/;/g;
    let depMatch: RegExpExecArray | null;
    while ((depMatch = depEntryRegex.exec(depSection)) !== null) {
        const depId = depMatch[1];
        const depTargetName = cleanup(depMatch[3]);
        depIdToTarget.set(depId, depTargetName);
    }

    for (const [targetName, depIds] of targetDependencyRefs) {
        const deps: TargetDependencyInfo[] = [];
        for (const depId of depIds) {
            const depTargetName = depIdToTarget.get(depId);
            if (depTargetName) {
                deps.push({ targetId: depId, targetName: depTargetName });
            }
        }
        if (deps.length > 0) {
            result.set(targetName, deps);
        }
    }

    return result;
}

export function parseBuildPhaseIds(
    pbxContents: string,
    targetName: string
): { sourcesBuildPhaseId?: string; frameworksBuildPhaseId?: string; resourcesBuildPhaseId?: string } {
    const sectionRegex =
        /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return {};
    }
    const section = sectionMatch[1];

    const targetRegex =
        /\s*[A-F0-9]+\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*PBXNativeTarget;([\s\S]*?)\};/g;
    let match: RegExpExecArray | null;
    while ((match = targetRegex.exec(section)) !== null) {
        const name = cleanup(match[1]);
        if (name !== targetName) {
            continue;
        }
        const body = match[2];
        const buildPhasesMatch = /buildPhases = \(([\s\S]*?)\);/.exec(body);
        if (!buildPhasesMatch) {
            return {};
        }
        const phasesBlock = buildPhasesMatch[1];

        const sourcesMatch = /([A-F0-9]+)\s*\/\*\s*Sources\s*\*\//.exec(phasesBlock);
        const frameworkMatch = /([A-F0-9]+)\s*\/\*\s*Frameworks\s*\*\//.exec(phasesBlock);
        const resourceMatch = /([A-F0-9]+)\s*\/\*\s*Resources\s*\*\//.exec(phasesBlock);

        return {
            sourcesBuildPhaseId: sourcesMatch ? sourcesMatch[1] : undefined,
            frameworksBuildPhaseId: frameworkMatch ? frameworkMatch[1] : undefined,
            resourcesBuildPhaseId: resourceMatch ? resourceMatch[1] : undefined
        };
    }
    return {};
}
