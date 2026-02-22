import {
    parseBuildConfigurations,
    resolveConfigurationListId,
    getBuildSettingsForTarget,
    getProjectBuildSettings,
    mergeWithInherited,
} from './buildSettings';
import {
    BUILD_CONFIGURATION_SECTION,
    CONFIGURATION_LIST_SECTION,
    PROJECT_SECTION,
    FULL_PBXPROJ,
} from '../__fixtures__/pbxproj';

describe('parseBuildConfigurations', () => {
    it('parses all build configurations from section', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        expect(configs.size).toBe(4);
    });

    it('parses Debug configuration settings correctly', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        const debug = configs.get('ABC12345678901234567890A');
        expect(debug).toBeDefined();
        expect(debug!.configurationName).toBe('Debug');
        expect(debug!.swiftVersion).toBe('5.9');
        expect(debug!.bundleIdentifier).toBe('com.example.MyApp');
        expect(debug!.productName).toBe('MyApp');
        expect(debug!.strictConcurrency).toBe('complete');
    });

    it('parses compilation conditions as list', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        const debug = configs.get('ABC12345678901234567890A');
        expect(debug!.swiftActiveCompilationConditions).toEqual([
            '$(inherited)',
            'DEBUG',
            'BETA_FEATURE',
        ]);
    });

    it('parses OTHER_SWIFT_FLAGS', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        const debug = configs.get('ABC12345678901234567890A');
        expect(debug!.otherSwiftFlags).toEqual([
            '$(inherited)',
            '-Xfrontend',
            '-warn-concurrency',
        ]);
    });

    it('parses GCC_PREPROCESSOR_DEFINITIONS', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        const debug = configs.get('ABC12345678901234567890A');
        expect(debug!.gccPreprocessorDefinitions).toEqual([
            '$(inherited)',
            'DEBUG=1',
            'APP_VERSION=42',
        ]);
    });

    it('parses HEADER_SEARCH_PATHS', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        const debug = configs.get('ABC12345678901234567890A');
        expect(debug!.headerSearchPaths).toEqual([
            '$(inherited)',
            '$(SRCROOT)/Headers',
        ]);
    });

    it('parses Release configuration with single-value conditions', () => {
        const configs = parseBuildConfigurations(BUILD_CONFIGURATION_SECTION);
        const release = configs.get('ABC12345678901234567890B');
        expect(release).toBeDefined();
        expect(release!.configurationName).toBe('Release');
        expect(release!.swiftActiveCompilationConditions).toEqual(['RELEASE_FLAG']);
    });

    it('returns empty map for missing section', () => {
        const configs = parseBuildConfigurations('no section here');
        expect(configs.size).toBe(0);
    });
});

describe('resolveConfigurationListId', () => {
    const combined = BUILD_CONFIGURATION_SECTION + CONFIGURATION_LIST_SECTION;

    it('resolves config IDs for project configuration list', () => {
        const ids = resolveConfigurationListId(combined, 'CCCCCCCCCCCCCCCCCCCCCCCA');
        expect(ids).toEqual(['ABC12345678901234567890A', 'ABC12345678901234567890B']);
    });

    it('resolves config IDs for target configuration list', () => {
        const ids = resolveConfigurationListId(combined, 'CCCCCCCCCCCCCCCCCCCCCCCD');
        expect(ids).toEqual(['DEF12345678901234567890A', 'DEF12345678901234567890B']);
    });

    it('returns empty array for unknown list ID', () => {
        const ids = resolveConfigurationListId(combined, 'ZZZZZZZZZZZZZZZZZZZZZZZZ');
        expect(ids).toEqual([]);
    });
});

describe('getBuildSettingsForTarget', () => {
    const combined = BUILD_CONFIGURATION_SECTION + CONFIGURATION_LIST_SECTION;

    it('returns Debug settings for target', () => {
        const settings = getBuildSettingsForTarget(combined, 'CCCCCCCCCCCCCCCCCCCCCCCA', 'Debug');
        expect(settings).not.toBeNull();
        expect(settings!.configurationName).toBe('Debug');
        expect(settings!.swiftVersion).toBe('5.9');
    });

    it('returns Release settings for target', () => {
        const settings = getBuildSettingsForTarget(combined, 'CCCCCCCCCCCCCCCCCCCCCCCA', 'Release');
        expect(settings).not.toBeNull();
        expect(settings!.configurationName).toBe('Release');
    });

    it('returns null for unknown configuration name', () => {
        const settings = getBuildSettingsForTarget(combined, 'CCCCCCCCCCCCCCCCCCCCCCCA', 'Staging');
        expect(settings).toBeNull();
    });
});

describe('getProjectBuildSettings', () => {
    it('returns project-level build settings', () => {
        const settings = getProjectBuildSettings(FULL_PBXPROJ, 'Debug');
        expect(settings).not.toBeNull();
        expect(settings!.configurationName).toBe('Debug');
    });

    it('returns null for missing project section', () => {
        const settings = getProjectBuildSettings('no project here', 'Debug');
        expect(settings).toBeNull();
    });
});

describe('mergeWithInherited', () => {
    it('returns project values when target is undefined', () => {
        const result = mergeWithInherited(['FLAG_A'], undefined);
        expect(result).toEqual(['FLAG_A']);
    });

    it('returns project values when target is empty', () => {
        const result = mergeWithInherited(['FLAG_A'], []);
        expect(result).toEqual(['FLAG_A']);
    });

    it('returns target values when no $(inherited)', () => {
        const result = mergeWithInherited(['FLAG_A'], ['FLAG_B']);
        expect(result).toEqual(['FLAG_B']);
    });

    it('merges project + target when $(inherited) is present', () => {
        const result = mergeWithInherited(['FLAG_A'], ['$(inherited)', 'FLAG_B']);
        expect(result).toEqual(['FLAG_A', 'FLAG_B']);
    });

    it('returns empty array when both undefined', () => {
        const result = mergeWithInherited(undefined, undefined);
        expect(result).toEqual([]);
    });

    it('handles $(inherited) in embedded form', () => {
        const result = mergeWithInherited(['FLAG_A'], ['prefix$(inherited)suffix', 'FLAG_B']);
        expect(result).toEqual(['FLAG_A', 'FLAG_B']);
    });
});
