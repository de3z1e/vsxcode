import { IMPLICIT_FRAMEWORKS } from '../types/constants';
import { cleanup } from '../utils/version';

export function parseFrameworksBuildPhase(
    pbxContents: string,
    frameworksBuildPhaseId: string
): string[] {
    if (!frameworksBuildPhaseId) {
        return [];
    }

    const phaseRegex = new RegExp(
        frameworksBuildPhaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        /\s*\/\*\s*Frameworks\s*\*\/\s*=\s*\{[^}]*files = \(([\s\S]*?)\);/.source
    );
    const phaseMatch = phaseRegex.exec(pbxContents);
    if (!phaseMatch) {
        return [];
    }

    const fileIds: string[] = [];
    const fileIdRegex = /([A-F0-9]{24})\s*\/\*\s*([^*]+)\s*\*\//g;
    let match: RegExpExecArray | null;
    while ((match = fileIdRegex.exec(phaseMatch[1])) !== null) {
        const fileName = cleanup(match[2]);
        if (fileName.includes(' in Frameworks')) {
            const frameworkName = fileName.replace(' in Frameworks', '').trim();
            fileIds.push(frameworkName);
        }
    }

    return fileIds;
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
