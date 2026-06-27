import type { BuildSettings } from '../types/interfaces';
import { cleanup } from '../utils/version';
import { parseListValue } from './base';

export function parseBuildConfigurations(pbxContents: string): Map<string, BuildSettings> {
    const configs = new Map<string, BuildSettings>();

    const sectionRegex =
        /\/\* Begin XCBuildConfiguration section \*\/([\s\S]*?)\/\* End XCBuildConfiguration section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return configs;
    }
    const section = sectionMatch[1];

    const configRegex =
        /([A-F0-9]+)\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*XCBuildConfiguration;\s*buildSettings\s*=\s*\{([\s\S]*?)\};\s*name\s*=\s*([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = configRegex.exec(section)) !== null) {
        const configId = match[1];
        const configurationName = cleanup(match[4]);
        const settingsBlock = match[3];

        const settings: BuildSettings = {
            configurationName,
            targetId: null
        };

        const swiftVersionMatch = /SWIFT_VERSION = ([^;]+);/.exec(settingsBlock);
        if (swiftVersionMatch) {
            settings.swiftVersion = cleanup(swiftVersionMatch[1]);
        }

        const strictConcurrencyMatch = /SWIFT_STRICT_CONCURRENCY = ([^;]+);/.exec(settingsBlock);
        if (strictConcurrencyMatch) {
            settings.strictConcurrency = cleanup(strictConcurrencyMatch[1]);
        }

        const compilationConditionsMatch = /SWIFT_ACTIVE_COMPILATION_CONDITIONS = ([^;]+);/.exec(settingsBlock);
        if (compilationConditionsMatch) {
            settings.swiftActiveCompilationConditions = parseListValue(compilationConditionsMatch[1]);
        }

        const otherSwiftFlagsMatch = /OTHER_SWIFT_FLAGS = ([^;]+);/.exec(settingsBlock);
        if (otherSwiftFlagsMatch) {
            settings.otherSwiftFlags = parseListValue(otherSwiftFlagsMatch[1]);
        }

        const gccMatch = /GCC_PREPROCESSOR_DEFINITIONS = \(([\s\S]*?)\);/.exec(settingsBlock);
        if (gccMatch) {
            settings.gccPreprocessorDefinitions = parseListValue(`(${gccMatch[1]})`);
        }

        const headerPathsMatch = /HEADER_SEARCH_PATHS = \(([\s\S]*?)\);/.exec(settingsBlock);
        if (headerPathsMatch) {
            settings.headerSearchPaths = parseListValue(`(${headerPathsMatch[1]})`);
        }

        const bundleIdMatch = /PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/.exec(settingsBlock);
        if (bundleIdMatch) {
            settings.bundleIdentifier = cleanup(bundleIdMatch[1]);
        }

        const productNameSettingMatch = /PRODUCT_NAME = ([^;]+);/.exec(settingsBlock);
        if (productNameSettingMatch) {
            settings.productName = cleanup(productNameSettingMatch[1]);
        }

        const supportedPlatformsMatch = /SUPPORTED_PLATFORMS = ([^;]+);/.exec(settingsBlock);
        if (supportedPlatformsMatch) {
            settings.supportedPlatforms = cleanup(supportedPlatformsMatch[1]);
        }

        const sdkRootMatch = /SDKROOT = ([^;]+);/.exec(settingsBlock);
        if (sdkRootMatch) {
            settings.sdkRoot = cleanup(sdkRootMatch[1]);
        }

        const macDeploymentMatch = /MACOSX_DEPLOYMENT_TARGET = ([^;]+);/.exec(settingsBlock);
        if (macDeploymentMatch) {
            settings.macosxDeploymentTarget = cleanup(macDeploymentMatch[1]);
        }

        configs.set(configId, settings);
    }

    return configs;
}

export function resolveConfigurationListId(pbxContents: string, listId: string): string[] {
    const listRegex = new RegExp(
        listId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        /\s*\/\*[^*]*\*\/\s*=\s*\{[^}]*buildConfigurations = \(([\s\S]*?)\);/.source
    );
    const listMatch = listRegex.exec(pbxContents);
    if (!listMatch) {
        return [];
    }
    const ids: string[] = [];
    const idRegex = /([A-F0-9]{24})/g;
    let idMatch: RegExpExecArray | null;
    while ((idMatch = idRegex.exec(listMatch[1])) !== null) {
        ids.push(idMatch[1]);
    }
    return ids;
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
    const projectSectionRegex =
        /\/\* Begin PBXProject section \*\/([\s\S]*?)\/\* End PBXProject section \*\//;
    const projectMatch = projectSectionRegex.exec(pbxContents);
    if (!projectMatch) {
        return null;
    }
    const projectSection = projectMatch[1];
    const buildConfigListMatch = /buildConfigurationList = ([A-F0-9]+)/.exec(projectSection);
    if (!buildConfigListMatch) {
        return null;
    }
    return getBuildSettingsForTarget(pbxContents, buildConfigListMatch[1], configurationName);
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
    if (supported) {
        return {
            ios: /\biphoneos\b/.test(supported) || /\biphonesimulator\b/.test(supported),
            mac: /\bmacosx\b/.test(supported),
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
