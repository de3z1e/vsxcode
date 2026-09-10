import type { BuildSettings, SwiftSettingsInput } from '../types/interfaces';
import type { SwiftSettingFlagRow } from '../types/swiftSettingFlags';
import {
    SWIFT_SETTING_FLAG_ROWS,
    APPROACHABLE_CONCURRENCY_SETTING,
    KNOWN_IGNORED_SWIFT_SETTINGS
} from '../types/swiftSettingFlags';
import { mergeWithInherited } from '../parsers/buildSettings';
import { parseListValue } from '../parsers/base';
import { compareVersions } from '../utils/version';

/** SWIFT_VERSION as Xcode resolves it: the target's, else the project's. */
function resolveSwiftVersion(
    targetSettings: BuildSettings | null,
    projectSettings: BuildSettings | null
): string | undefined {
    return targetSettings?.swiftVersion || projectSettings?.swiftVersion;
}

/**
 * Swift language major, resolved target → project → toolchain. Returns `NaN` verbatim: the
 * version gate relies on `NaN < 6` being false and `extension.ts` substitutes '5' for momc.
 */
export function effectiveSwiftMajor(
    targetSettings: BuildSettings | null,
    projectSettings: BuildSettings | null,
    fallbackSwiftVersion: string
): number {
    const version = resolveSwiftVersion(targetSettings, projectSettings) || fallbackSwiftVersion;
    return parseInt(version.split('.')[0], 10);
}

/** Never the toolchain fallback — that would declare a language mode the project never asked for. */
function resolveSwiftLanguageMode(swiftVersion: string | undefined): string | undefined {
    if (!swiftVersion) {
        return undefined;
    }
    // 4.2 is its own mode; truncating to the major would silently compile as .v4.
    if (swiftVersion.startsWith('4.2')) {
        return '.v4_2';
    }
    const major = parseInt(swiftVersion.split('.')[0], 10);
    return isNaN(major) ? undefined : `.v${major}`;
}

function escapeSwiftString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function unsafeFlags(flags: string[]): string {
    return `.unsafeFlags([${flags.map((flag) => `"${escapeSwiftString(flag)}"`).join(', ')}])`;
}

/**
 * Falls back to `.unsafeFlags` whenever the first-class factory postdates the manifest's
 * tools-version; availability comes from PackageDescription's shipped .swiftinterface.
 */
function flagsToSwiftSetting(flags: string[], toolsVersion: string): string {
    const atLeast = (version: string) => compareVersions(toolsVersion, version) >= 0;
    const [first, second] = flags;

    if (flags.length === 2 && first === '-enable-upcoming-feature' && atLeast('5.8')) {
        return `.enableUpcomingFeature("${escapeSwiftString(second)}")`;
    }
    if (flags.length === 2 && first === '-enable-experimental-feature' && atLeast('5.8')) {
        return `.enableExperimentalFeature("${escapeSwiftString(second)}")`;
    }
    if (flags.length === 2 && first === '-Werror' && atLeast('6.2')) {
        return `.treatWarning("${escapeSwiftString(second)}", as: .error)`;
    }
    if (flags.length === 2 && first === '-Wwarning' && atLeast('6.2')) {
        return `.treatWarning("${escapeSwiftString(second)}", as: .warning)`;
    }
    if (flags.length === 1) {
        if (first === '-default-isolation=MainActor' && atLeast('6.2')) {
            return '.defaultIsolation(MainActor.self)';
        }
        // The :migrate variant has no first-class form, so it stays on unsafeFlags.
        if (first === '-strict-memory-safety' && atLeast('6.2')) {
            return '.strictMemorySafety()';
        }
        if (first === '-cxx-interoperability-mode=default' && atLeast('5.9')) {
            return '.interoperabilityMode(.Cxx)';
        }
        if (first === '-warnings-as-errors' && atLeast('6.2')) {
            return '.treatAllWarnings(as: .error)';
        }
    }
    return unsafeFlags(flags);
}

/** Target value wins, else the project's — the scalar half of `$(inherited)`. An empty
 *  target value falls through rather than suppressing the project's, matching Xcode. */
function resolveRawSetting(
    projectSettings: BuildSettings | null,
    targetSettings: BuildSettings | null,
    key: string
): string | undefined {
    return targetSettings?.raw?.[key] || projectSettings?.raw?.[key];
}

/** Xcode's editor writes list values as `"$(inherited) Unsafe"`, so the project's items merge
 *  in rather than the whole setting being discarded by the scalar `$(` guard. */
function listItemsForRow(
    row: SwiftSettingFlagRow,
    projectSettings: BuildSettings | null,
    targetSettings: BuildSettings | null
): string[] {
    const parse = (value: string | undefined) => (value === undefined ? undefined : parseListValue(value));
    const merged = mergeWithInherited(
        parse(projectSettings?.raw?.[row.setting]),
        parse(targetSettings?.raw?.[row.setting])
    );
    return merged.filter((item) => item.length > 0 && !item.includes('$('));
}

/** Flags one row contributes, or [] when its value maps to nothing. */
function flagsForRow(row: SwiftSettingFlagRow, value: string): string[][] {
    const mapped = row.values[value.toUpperCase()];
    if (mapped) {
        return mapped.length > 0 ? [mapped] : [];
    }
    return row.otherwise && row.otherwise.length > 0 ? [row.otherwise] : [];
}

export function generateSwiftSettings({
    projectSettings,
    targetSettings,
    configurationName,
    fallbackSwiftVersion,
    toolsVersion,
    logger,
    reportedSettings = new Set<string>()
}: SwiftSettingsInput): string[] {
    const settings: string[] = [];

    const swiftLanguageMode = resolveSwiftLanguageMode(resolveSwiftVersion(targetSettings, projectSettings));
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
        settings.push(unsafeFlags(filteredFlags));
    }

    // ── Table-driven settings, in declaration order so output is deterministic ──
    const swiftMajor = effectiveSwiftMajor(targetSettings, projectSettings, fallbackSwiftVersion);
    const umbrellaValue = resolveRawSetting(projectSettings, targetSettings, APPROACHABLE_CONCURRENCY_SETTING);
    const umbrellaOn = (umbrellaValue || 'NO').toUpperCase() === 'YES';
    const handled = new Set<string>([APPROACHABLE_CONCURRENCY_SETTING]);

    for (const row of SWIFT_SETTING_FLAG_ROWS) {
        handled.add(row.setting);

        // Xcode consults these only below language mode 6, which already implies them.
        if (row.v45Only && !(swiftMajor < 6)) {
            continue;
        }

        if (row.listFlag) {
            for (const item of listItemsForRow(row, projectSettings, targetSettings)) {
                settings.push(flagsToSwiftSetting([row.listFlag, item], toolsVersion));
            }
            continue;
        }

        const explicit = resolveRawSetting(projectSettings, targetSettings, row.setting);
        if (explicit !== undefined && explicit.includes('$(')) {
            logger?.(`[swiftSettings] ${row.setting} left unresolved ("${explicit}") — skipped`);
            continue;
        }

        // Table defaults are pre-resolved, so an absent setting still lands on Xcode's value.
        const value = explicit ?? (row.umbrella && umbrellaOn ? 'YES' : row.defaultValue);
        if (value.length === 0) {
            continue;
        }

        for (const group of flagsForRow(row, value)) {
            settings.push(flagsToSwiftSetting(group, toolsVersion));
        }
    }

    if (logger) {
        for (const source of [projectSettings, targetSettings]) {
            for (const key of Object.keys(source?.raw ?? {})) {
                if (!key.startsWith('SWIFT_') || handled.has(key) || KNOWN_IGNORED_SWIFT_SETTINGS.has(key)) {
                    continue;
                }
                if (reportedSettings.has(key)) {
                    continue;
                }
                reportedSettings.add(key);
                logger(`[swiftSettings] ${key} has no flag mapping — not forwarded to Package.swift`);
            }
        }
    }

    return settings;
}
