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
