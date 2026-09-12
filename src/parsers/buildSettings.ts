import type { BuildSettings } from '../types/interfaces';
import { parseListValue } from './base';
import { readProject, stringList, stringValue } from './projectIndex';
import type { ProjectObject } from './projectIndex';

/** Set in this order, which callers comparing serialized settings see; `listLiteral` ignores a string value, as the regex it replaces did. */
const TYPED_FIELDS: ReadonlyArray<[keyof BuildSettings, string, 'scalar' | 'list' | 'listLiteral']> = [
    ['swiftVersion', 'SWIFT_VERSION', 'scalar'],
    ['strictConcurrency', 'SWIFT_STRICT_CONCURRENCY', 'scalar'],
    ['swiftActiveCompilationConditions', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS', 'list'],
    ['otherSwiftFlags', 'OTHER_SWIFT_FLAGS', 'list'],
    ['gccPreprocessorDefinitions', 'GCC_PREPROCESSOR_DEFINITIONS', 'listLiteral'],
    ['headerSearchPaths', 'HEADER_SEARCH_PATHS', 'listLiteral'],
    ['bundleIdentifier', 'PRODUCT_BUNDLE_IDENTIFIER', 'scalar'],
    ['productName', 'PRODUCT_NAME', 'scalar'],
    ['supportedPlatforms', 'SUPPORTED_PLATFORMS', 'scalar'],
    ['sdkRoot', 'SDKROOT', 'scalar'],
    ['macosxDeploymentTarget', 'MACOSX_DEPLOYMENT_TARGET', 'scalar']
];

/** `raw` keys are sorted to restore the order Xcode writes them in, which plutil's JSON doesn't keep. */
function settingsOf(object: ProjectObject, configurationName: string): BuildSettings {
    const raw: Record<string, string | string[]> = {};
    const dictionary = object.buildSettings;
    if (dictionary && typeof dictionary === 'object' && !Array.isArray(dictionary)) {
        const entries = dictionary as Record<string, unknown>;
        for (const key of Object.keys(entries).sort()) {
            const value = entries[key];
            if (typeof value === 'string') {
                raw[key] = value;
            } else if (Array.isArray(value)) {
                raw[key] = stringList(value);
            }
        }
    }
    const settings: BuildSettings = { configurationName, targetId: null, raw };
    for (const [field, key, kind] of TYPED_FIELDS) {
        const value = raw[key];
        let typed: string | string[] | undefined;
        if (kind === 'scalar') {
            typed = typeof value === 'string' ? value : undefined;
        } else if (kind === 'list') {
            typed = value === undefined ? undefined : parseListValue(value);
        } else {
            typed = Array.isArray(value) ? parseListValue(value) : undefined;
        }
        if (typed !== undefined) { (settings as unknown as Record<string, unknown>)[field] = typed; }
    }
    return settings;
}

/** Every XCBuildConfiguration with a name, by id, in definition order; empty when plutil can't read the text. */
export function parseBuildConfigurations(pbxContents: string): Map<string, BuildSettings> {
    const configs = new Map<string, BuildSettings>();
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return configs; }
    for (const { id, object } of index.objectsOfIsa('XCBuildConfiguration')) {
        const name = stringValue(object.name);
        if (name !== undefined) { configs.set(id, settingsOf(object, name)); }
    }
    return configs;
}

/** The configuration ids of a configuration list; empty for an unknown list or unreadable text. */
export function resolveConfigurationListId(pbxContents: string, listId: string): string[] {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? [] : stringList(index.object(listId)?.buildConfigurations);
}

export function getBuildSettingsForTarget(
    pbxContents: string,
    buildConfigurationListId: string,
    configurationName: string
): BuildSettings | null {
    const allConfigs = parseBuildConfigurations(pbxContents);
    const configIds = resolveConfigurationListId(pbxContents, buildConfigurationListId);

    for (const configId of configIds) {
        const config = allConfigs.get(configId);
        if (config && config.configurationName === configurationName) {
            return config;
        }
    }
    return null;
}

export function getProjectBuildSettings(
    pbxContents: string,
    configurationName: string
): BuildSettings | null {
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return null; }
    const listId = stringValue(index.project?.buildConfigurationList);
    return listId === undefined ? null : getBuildSettingsForTarget(pbxContents, listId, configurationName);
}

/**
 * Determine which Apple platforms a target can build for. Checks the target's
 * own settings first and falls back to project-level settings, since
 * SUPPORTED_PLATFORMS / SDKROOT / MACOSX_DEPLOYMENT_TARGET are frequently
 * inherited from the project rather than set per target. When no signal is
 * present at all, assume iOS to preserve the extension's historical default.
 */
export function platformsSupported(
    target: BuildSettings | null,
    project: BuildSettings | null
): { ios: boolean; mac: boolean } {
    // SUPPORTED_PLATFORMS is authoritative when present: it lists exactly the
    // platforms the target builds for, so weaker signals (SDKROOT,
    // MACOSX_DEPLOYMENT_TARGET) must not add platforms it omits — many iOS-only
    // targets carry a MACOSX_DEPLOYMENT_TARGET from a shared xcconfig. When the
    // target inherits ($(inherited)), merge in the project value.
    const targetSupported = (target?.supportedPlatforms || '').toLowerCase();
    const projectSupported = (project?.supportedPlatforms || '').toLowerCase();
    let supported = targetSupported || projectSupported;
    if (targetSupported.includes('$(inherited)')) {
        supported = `${projectSupported} ${targetSupported}`;
    }
    // Strip unresolved interpolation so a bare `$(inherited)` with nothing to inherit falls through to the SDKROOT/deployment signals below; a surviving concrete token stays authoritative even when only non-iOS/mac (e.g. tvOS).
    const concreteSupported = supported.replace(/\$\([^)]*\)/g, ' ').trim();
    if (concreteSupported) {
        return {
            ios: /\biphoneos\b/.test(concreteSupported) || /\biphonesimulator\b/.test(concreteSupported),
            mac: /\bmacosx\b/.test(concreteSupported),
        };
    }

    // No SUPPORTED_PLATFORMS — fall back to a concrete SDKROOT.
    const sdkRoot = (target?.sdkRoot || project?.sdkRoot || '').toLowerCase();
    if (sdkRoot === 'macosx') { return { ios: false, mac: true }; }
    if (sdkRoot === 'iphoneos' || sdkRoot === 'iphonesimulator') { return { ios: true, mac: false }; }

    // Then a macOS deployment target (only signal left that implies macOS).
    if (target?.macosxDeploymentTarget || project?.macosxDeploymentTarget) {
        return { ios: false, mac: true };
    }

    // No usable signal — default to iOS (the extension's original assumption).
    return { ios: true, mac: false };
}

export function mergeWithInherited(project: string[] | undefined, target: string[] | undefined): string[] {
    if (!target || target.length === 0) {
        return project || [];
    }
    const hasInherited = target.some((v) => v.includes('$(inherited)'));
    if (hasInherited) {
        const filtered = target.filter((v) => !v.includes('$(inherited)'));
        return [...(project || []), ...filtered];
    }
    return target;
}
