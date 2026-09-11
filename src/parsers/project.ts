import type { PlatformName, DeploymentTarget } from '../types/interfaces';
import { PLATFORM_KEYS, DEFAULT_PLATFORM } from '../types/constants';
import { cleanup, compareVersions } from '../utils/version';
import { extractObjectBody } from './base';
import { readProject } from './projectIndex';

export function parseDefaultLocalization(pbxContents: string): string | null {
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

export function parseDeploymentTargets(pbxContents: string): DeploymentTarget[] {
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

export function parseExcludedFiles(pbxContents: string, targetName: string): string[] {
    const exceptionRegex =
        /\/\* Begin PBXFileSystemSynchronizedBuildFileExceptionSet section \*\/([\s\S]*?)\/\* End PBXFileSystemSynchronizedBuildFileExceptionSet section \*\//;
    const exceptionMatch = exceptionRegex.exec(pbxContents);
    if (!exceptionMatch) {
        return [];
    }
    const section = exceptionMatch[1];

    // Parse each exception set entry individually, filtering by target name.
    // Uses brace-depth tracking to handle nested {} (e.g. attributesByRelativePath).
    const entryStartRegex =
        /([A-F0-9]{24})\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{/g;
    const excluded: string[] = [];
    let entry: RegExpExecArray | null;
    while ((entry = entryStartRegex.exec(section)) !== null) {
        const result = extractObjectBody(section, entry.index);
        if (!result) { continue; }
        const body = result.body;

        const targetMatch = /target\s*=\s*[A-F0-9]{24}\s*\/\*\s*([^*]+)\s*\*\/\s*;/.exec(body);
        if (!targetMatch || targetMatch[1].trim() !== targetName) {
            continue;
        }

        const exceptionsMatch = /membershipExceptions\s*=\s*\(([\s\S]*?)\);/.exec(body);
        if (!exceptionsMatch) {
            continue;
        }

        // Match both quoted ("Info.plist") and unquoted (Info.plist) paths
        const pathRegex = /(?:"([^"]+)"|([A-Za-z0-9_./+-]+))\s*,?/g;
        let pathMatch: RegExpExecArray | null;
        while ((pathMatch = pathRegex.exec(exceptionsMatch[1])) !== null) {
            const filePath = pathMatch[1] || pathMatch[2];
            if (filePath) {
                excluded.push(filePath);
            }
        }
    }
    return excluded;
}

/** Whether the project uses SwiftPM's `OBJ_<n>` object ids, the form `swift package generate-xcodeproj` writes. */
export function usesSwiftPMObjectIds(pbxContents: string): boolean {
    const index = readProject(pbxContents);
    return typeof index !== 'string' && Object.keys(index.objects).some((id) => /^OBJ_\d+$/.test(id));
}

/** Whether every object id has the 24-character uppercase hex form Xcode writes, the only form the pbxproj writers match. */
export function usesXcodeObjectIds(pbxContents: string): boolean {
    const index = readProject(pbxContents);
    return typeof index !== 'string' && Object.keys(index.objects).every((id) => /^[A-F0-9]{24}$/.test(id));
}
