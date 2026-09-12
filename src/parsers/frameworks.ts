import { IMPLICIT_FRAMEWORKS } from '../types/constants';
import { phaseFileNames, readProject } from './projectIndex';

/** The names of a frameworks phase's files in list order: `UIKit.framework`, `libz.tbd`, a package product's name. */
export function parseFrameworksBuildPhase(
    pbxContents: string,
    frameworksBuildPhaseId: string
): string[] {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? [] : phaseFileNames(index, frameworksBuildPhaseId, 'PBXFrameworksBuildPhase');
}

export function extractFrameworkNames(rawNames: string[]): string[] {
    const frameworks: string[] = [];
    for (const raw of rawNames) {
        let name = raw;
        if (name.endsWith('.framework')) {
            name = name.replace(/\.framework$/, '');
        }
        if (name.endsWith('.tbd')) {
            name = name.replace(/\.tbd$/, '').replace(/^lib/, '');
        }
        if (!IMPLICIT_FRAMEWORKS.has(name) && name.length > 0) {
            frameworks.push(name);
        }
    }
    return [...new Set(frameworks)];
}

export function parseLinkedFrameworksForTarget(
    pbxContents: string,
    frameworksBuildPhaseId: string | undefined
): string[] {
    if (!frameworksBuildPhaseId) {
        return [];
    }
    const rawNames = parseFrameworksBuildPhase(pbxContents, frameworksBuildPhaseId);
    return extractFrameworkNames(rawNames);
}
