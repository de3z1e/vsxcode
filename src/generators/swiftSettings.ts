import type { BuildSettings } from '../types/interfaces';
import { mergeWithInherited } from '../parsers/buildSettings';

export function generateSwiftSettings(
    projectSettings: BuildSettings | null,
    targetSettings: BuildSettings | null,
    configurationName: string
): string[] {
    const settings: string[] = [];

    const projectConditions = projectSettings?.swiftActiveCompilationConditions;
    const targetConditions = targetSettings?.swiftActiveCompilationConditions;
    const mergedConditions = mergeWithInherited(projectConditions, targetConditions);

    const filteredConditions = mergedConditions.filter(
        (c) => c !== '$(inherited)' && c !== 'DEBUG' && c.length > 0
    );

    for (const condition of filteredConditions) {
        settings.push(`.define("${condition}")`);
    }

    if (mergedConditions.includes('DEBUG') || mergedConditions.some((c) => c === 'DEBUG')) {
        // DEBUG is typically only for debug configuration
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

    return settings;
}
