import type { PlatformName, DeploymentTarget } from '../types/interfaces';
import { PLATFORM_KEYS, DEFAULT_PLATFORM } from '../types/constants';
import { compareVersions } from '../utils/version';
import { readProject, stringList, stringValue } from './projectIndex';
import type { ProjectIndex } from './projectIndex';

/** The non-empty string values a setting has across every configuration, in definition order. */
function settingValues(index: ProjectIndex, key: string): string[] {
    const values: string[] = [];
    for (const { object } of index.objectsOfIsa('XCBuildConfiguration')) {
        const settings = object.buildSettings;
        const value = settings && typeof settings === 'object' && !Array.isArray(settings)
            ? stringValue((settings as Record<string, unknown>)[key])
            : undefined;
        if (value) { values.push(value); }
    }
    return values;
}

/** The project's `developmentRegion`; null when absent or unreadable. */
export function parseDefaultLocalization(pbxContents: string): string | null {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? null : stringValue(index.project?.developmentRegion) ?? null;
}

/** The highest `SWIFT_VERSION` any configuration sets; null when none or unreadable. */
export function parseSwiftVersion(pbxContents: string): string | null {
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return null; }
    const unique = [...new Set(settingValues(index, 'SWIFT_VERSION'))];
    unique.sort((a, b) => compareVersions(b, a));
    return unique[0] || null;
}

/** Each platform's highest deployment target across the configurations; the default platform when none is set. */
export function parseDeploymentTargets(pbxContents: string): DeploymentTarget[] {
    const found = new Map<PlatformName, string>();
    const index = readProject(pbxContents);
    if (typeof index !== 'string') {
        for (const [key, platform] of Object.entries(PLATFORM_KEYS) as Array<[string, PlatformName]>) {
            for (const version of settingValues(index, key)) {
                const current = found.get(platform);
                if (!current || compareVersions(version, current) > 0) {
                    found.set(platform, version);
                }
            }
        }
    }
    if (found.size === 0) {
        found.set(DEFAULT_PLATFORM.platform, DEFAULT_PLATFORM.version);
    }
    return Array.from(found.entries()).map(([platform, version]) => ({ platform, version }));
}

/** The `membershipExceptions` of every synchronized-folder exception set whose target has the name, in definition order. */
export function parseExcludedFiles(pbxContents: string, targetName: string): string[] {
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return []; }
    const excluded: string[] = [];
    for (const { object } of index.objectsOfIsa('PBXFileSystemSynchronizedBuildFileExceptionSet')) {
        if (stringValue(index.object(object.target)?.name) === targetName) {
            excluded.push(...stringList(object.membershipExceptions));
        }
    }
    return excluded;
}

/** Whether the project uses SwiftPM's `OBJ_<n>` object ids, the form `swift package generate-xcodeproj` writes. */
export function usesSwiftPMObjectIds(pbxContents: string): boolean {
    const index = readProject(pbxContents);
    return typeof index !== 'string' && Object.keys(index.objects).some((id) => /^OBJ_\d+$/.test(id));
}
