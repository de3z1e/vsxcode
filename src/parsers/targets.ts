import type { NativeTarget, TargetDependencyInfo } from '../types/interfaces';
import { readProject, stringList, stringValue } from './projectIndex';
import type { ProjectIndex } from './projectIndex';

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

/** The project's index, or null when plutil can't read the contents. */
function projectIndex(pbxContents: string): ProjectIndex | null {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? null : index;
}

export function parseNativeTargets(pbxContents: string): NativeTarget[] {
    const index = projectIndex(pbxContents);
    if (!index) {
        return [];
    }
    return index.objectsOfIsa('PBXNativeTarget').map(({ object: target }) => {
        const name = stringValue(target.name) ?? '';
        return {
            name,
            productName: stringValue(target.productName) ?? name,
            productType: stringValue(target.productType) ?? '',
            packageProductDependencyIds: stringList(target.packageProductDependencies),
            buildConfigurationListId: stringValue(target.buildConfigurationList) ?? '',
            fileSystemSynchronizedGroupIds: stringList(target.fileSystemSynchronizedGroups)
        };
    });
}

export function parseTargetDependencies(pbxContents: string): Map<string, TargetDependencyInfo[]> {
    const result = new Map<string, TargetDependencyInfo[]>();
    const index = projectIndex(pbxContents);
    if (!index) {
        return result;
    }
    for (const { object: target } of index.objectsOfIsa('PBXNativeTarget')) {
        const dependencies: TargetDependencyInfo[] = [];
        for (const dependencyId of stringList(target.dependencies)) {
            // Only dependencies on a target in this project; one whose target is gone has no name to report.
            const targetName = stringValue(index.object(index.object(dependencyId)?.target)?.name);
            if (targetName !== undefined) {
                dependencies.push({ targetId: dependencyId, targetName });
            }
        }
        if (dependencies.length > 0) {
            result.set(stringValue(target.name) ?? '', dependencies);
        }
    }
    return result;
}

export function parseBuildPhaseIds(
    pbxContents: string,
    targetName: string
): { sourcesBuildPhaseId?: string; frameworksBuildPhaseId?: string; resourcesBuildPhaseId?: string } {
    const index = projectIndex(pbxContents);
    const target = index?.objectsOfIsa('PBXNativeTarget').find(({ object }) => object.name === targetName);
    if (!index || !target) {
        return {};
    }
    const phaseIds = stringList(target.object.buildPhases);
    const firstOfIsa = (isa: string): string | undefined => phaseIds.find((id) => index.object(id)?.isa === isa);
    return {
        sourcesBuildPhaseId: firstOfIsa('PBXSourcesBuildPhase'),
        frameworksBuildPhaseId: firstOfIsa('PBXFrameworksBuildPhase'),
        resourcesBuildPhaseId: firstOfIsa('PBXResourcesBuildPhase')
    };
}
