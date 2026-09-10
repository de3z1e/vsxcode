import type { BuildSettings, SwiftSettingsInput } from '../types/interfaces';
import { mergeWithInherited } from '../parsers/buildSettings';

/**
 * Target's own SWIFT_VERSION, else the toolchain fallback. Returns `NaN` verbatim —
 * the strict-concurrency gate below relies on `NaN < 6` being false.
 */
export function effectiveSwiftMajor(
    targetSettings: BuildSettings | null,
    fallbackSwiftVersion: string
): number {
    const version = targetSettings?.swiftVersion || fallbackSwiftVersion;
    return parseInt(version.split('.')[0], 10);
}

/** Never the toolchain fallback — that would declare a language mode the project never asked for. */
function resolveSwiftLanguageMode(swiftVersion: string | undefined): string | undefined {
    if (!swiftVersion) {
        return undefined;
    }
    const major = parseInt(swiftVersion.split('.')[0], 10);
    return isNaN(major) ? undefined : `.v${major}`;
}

export function generateSwiftSettings({
    projectSettings,
    targetSettings,
    configurationName,
    fallbackSwiftVersion
}: SwiftSettingsInput): string[] {
    const settings: string[] = [];

    const swiftLanguageMode = resolveSwiftLanguageMode(targetSettings?.swiftVersion);
    if (swiftLanguageMode) {
        settings.push(`.swiftLanguageMode(${swiftLanguageMode})`);
    }

    const projectConditions = projectSettings?.swiftActiveCompilationConditions;
    const targetConditions = targetSettings?.swiftActiveCompilationConditions;
    const mergedConditions = mergeWithInherited(projectConditions, targetConditions);

    const filteredConditions = mergedConditions.filter(
        (c) => c !== '$(inherited)' && c !== 'DEBUG' && c.length > 0
    );

    for (const condition of filteredConditions) {
        settings.push(`.define("${condition}")`);
    }

    const hasDebugCondition = mergedConditions.includes('DEBUG');
    if (hasDebugCondition && configurationName === 'Debug') {
        settings.push(`.define("DEBUG", .when(configuration: .debug))`);
    }

    const projectGcc = projectSettings?.gccPreprocessorDefinitions;
    const targetGcc = targetSettings?.gccPreprocessorDefinitions;
    const mergedGcc = mergeWithInherited(projectGcc, targetGcc);
    const filteredGcc = mergedGcc.filter(
        (d) => d !== '$(inherited)' && d !== 'DEBUG=1' && !d.startsWith('COCOAPODS=') && d.length > 0
    );
    for (const def of filteredGcc) {
        const parts = def.split('=');
        if (parts.length === 2) {
            settings.push(`.define("${parts[0]}", to: "${parts[1]}")`);
        } else {
            settings.push(`.define("${def}")`);
        }
    }

    const projectFlags = projectSettings?.otherSwiftFlags;
    const targetFlags = targetSettings?.otherSwiftFlags;
    const mergedFlags = mergeWithInherited(projectFlags, targetFlags);
    const filteredFlags = mergedFlags.filter(
        (f) => f !== '$(inherited)' && f.length > 0
    );
    if (filteredFlags.length > 0) {
        const flagsStr = filteredFlags.map((f) => `"${f}"`).join(', ');
        settings.push(`.unsafeFlags([${flagsStr}])`);
    }

    // Swift 6 is 'complete' by definition, so Xcode stops emitting the flag there.
    const strictConcurrency = targetSettings?.strictConcurrency || projectSettings?.strictConcurrency;
    if (strictConcurrency && effectiveSwiftMajor(targetSettings, fallbackSwiftVersion) < 6) {
        if (strictConcurrency === 'complete') {
            settings.push(`.enableUpcomingFeature("StrictConcurrency")`);
        } else if (strictConcurrency === 'targeted') {
            settings.push(`.unsafeFlags(["-strict-concurrency=targeted"])`);
        }
    }

    return settings;
}
