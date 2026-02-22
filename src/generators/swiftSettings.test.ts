import { generateSwiftSettings } from './swiftSettings';
import type { BuildSettings } from '../types/interfaces';

function makeSettings(overrides: Partial<BuildSettings> = {}): BuildSettings {
    return {
        configurationName: 'Debug',
        targetId: null,
        ...overrides,
    };
}

describe('generateSwiftSettings', () => {
    it('returns empty array when no settings', () => {
        const result = generateSwiftSettings(null, null, 'Debug');
        expect(result).toEqual([]);
    });

    it('generates .define for compilation conditions', () => {
        const target = makeSettings({
            swiftActiveCompilationConditions: ['BETA_FEATURE'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toContain('.define("BETA_FEATURE")');
    });

    it('filters out $(inherited) from conditions', () => {
        const target = makeSettings({
            swiftActiveCompilationConditions: ['$(inherited)', 'FEATURE_A'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).not.toContain('.define("$(inherited)")');
        expect(result).toContain('.define("FEATURE_A")');
    });

    it('generates conditional DEBUG define for Debug config', () => {
        const target = makeSettings({
            swiftActiveCompilationConditions: ['DEBUG', 'FEATURE_A'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toContain('.define("DEBUG", .when(configuration: .debug))');
        expect(result).toContain('.define("FEATURE_A")');
    });

    it('does not generate conditional DEBUG define for Release config', () => {
        const target = makeSettings({
            swiftActiveCompilationConditions: ['DEBUG', 'FEATURE_A'],
        });
        const result = generateSwiftSettings(null, target, 'Release');
        expect(result).not.toContain('.define("DEBUG", .when(configuration: .debug))');
    });

    it('merges project and target conditions with $(inherited)', () => {
        const project = makeSettings({
            swiftActiveCompilationConditions: ['PROJECT_FLAG'],
        });
        const target = makeSettings({
            swiftActiveCompilationConditions: ['$(inherited)', 'TARGET_FLAG'],
        });
        const result = generateSwiftSettings(project, target, 'Debug');
        expect(result).toContain('.define("PROJECT_FLAG")');
        expect(result).toContain('.define("TARGET_FLAG")');
    });

    it('generates .define with value for GCC preprocessor defs', () => {
        const target = makeSettings({
            gccPreprocessorDefinitions: ['APP_VERSION=42'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toContain('.define("APP_VERSION", to: "42")');
    });

    it('filters DEBUG=1 and COCOAPODS from GCC defs', () => {
        const target = makeSettings({
            gccPreprocessorDefinitions: ['DEBUG=1', 'COCOAPODS=1', 'CUSTOM=1'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toHaveLength(1);
        expect(result).toContain('.define("CUSTOM", to: "1")');
    });

    it('generates .unsafeFlags for OTHER_SWIFT_FLAGS', () => {
        const target = makeSettings({
            otherSwiftFlags: ['-Xfrontend', '-warn-concurrency'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toContain('.unsafeFlags(["-Xfrontend", "-warn-concurrency"])');
    });

    it('filters $(inherited) from swift flags', () => {
        const target = makeSettings({
            otherSwiftFlags: ['$(inherited)', '-Xfrontend'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toContain('.unsafeFlags(["-Xfrontend"])');
    });

    it('does not generate .unsafeFlags when all flags are filtered', () => {
        const target = makeSettings({
            otherSwiftFlags: ['$(inherited)'],
        });
        const result = generateSwiftSettings(null, target, 'Debug');
        expect(result).toEqual([]);
    });
});
