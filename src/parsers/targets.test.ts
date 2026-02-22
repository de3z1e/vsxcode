import {
    parseNativeTargets,
    isTestTarget,
    mapProductType,
    parseTargetDependencies,
    parseBuildPhaseIds,
} from './targets';
import {
    NATIVE_TARGET_SECTION,
    TARGET_DEPENDENCY_SECTION,
    FULL_PBXPROJ,
} from '../__fixtures__/pbxproj';

describe('isTestTarget', () => {
    it('returns true for unit-test product type', () => {
        expect(isTestTarget('com.apple.product-type.bundle.unit-test')).toBe(true);
    });

    it('returns true for ui-testing product type', () => {
        expect(isTestTarget('com.apple.product-type.bundle.ui-testing')).toBe(true);
    });

    it('returns true for .test product type', () => {
        expect(isTestTarget('com.apple.product-type.test')).toBe(true);
    });

    it('returns false for application product type', () => {
        expect(isTestTarget('com.apple.product-type.application')).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isTestTarget(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isTestTarget('')).toBe(false);
    });
});

describe('mapProductType', () => {
    it('always returns .library', () => {
        expect(mapProductType('com.apple.product-type.application')).toBe('.library');
        expect(mapProductType(undefined)).toBe('.library');
    });
});

describe('parseNativeTargets', () => {
    it('parses all native targets', () => {
        const targets = parseNativeTargets(NATIVE_TARGET_SECTION);
        expect(targets).toHaveLength(2);
    });

    it('parses app target correctly', () => {
        const targets = parseNativeTargets(NATIVE_TARGET_SECTION);
        const app = targets.find((t) => t.name === 'MyApp');
        expect(app).toBeDefined();
        expect(app!.productName).toBe('MyApp');
        expect(app!.productType).toBe('com.apple.product-type.application');
        expect(app!.packageProductDependencyIds).toEqual(['FFFF11111111111111111111']);
    });

    it('parses test target correctly', () => {
        const targets = parseNativeTargets(NATIVE_TARGET_SECTION);
        const test = targets.find((t) => t.name === 'MyAppTests');
        expect(test).toBeDefined();
        expect(test!.productName).toBe('MyAppTests');
        expect(test!.productType).toBe('com.apple.product-type.bundle.unit-test');
        expect(test!.packageProductDependencyIds).toEqual([]);
    });

    it('returns empty array for missing section', () => {
        const targets = parseNativeTargets('no targets here');
        expect(targets).toEqual([]);
    });
});

describe('parseTargetDependencies', () => {
    const combined = NATIVE_TARGET_SECTION + TARGET_DEPENDENCY_SECTION;

    it('parses target dependencies', () => {
        const deps = parseTargetDependencies(combined);
        expect(deps.has('MyApp')).toBe(true);
        const appDeps = deps.get('MyApp')!;
        expect(appDeps).toHaveLength(1);
        expect(appDeps[0].targetName).toBe('CoreLib');
    });

    it('target without dependencies is not in map', () => {
        const deps = parseTargetDependencies(combined);
        expect(deps.has('MyAppTests')).toBe(false);
    });

    it('returns empty map for missing sections', () => {
        const deps = parseTargetDependencies('no sections');
        expect(deps.size).toBe(0);
    });
});

describe('parseBuildPhaseIds', () => {
    it('parses framework and resource build phase IDs', () => {
        const result = parseBuildPhaseIds(NATIVE_TARGET_SECTION, 'MyApp');
        expect(result.frameworksBuildPhaseId).toBe('BBBB11111111111111111111');
        expect(result.resourcesBuildPhaseId).toBe('CCCC11111111111111111111');
    });

    it('returns only frameworks phase for test target', () => {
        const result = parseBuildPhaseIds(NATIVE_TARGET_SECTION, 'MyAppTests');
        expect(result.frameworksBuildPhaseId).toBe('BBBB22222222222222222222');
        expect(result.resourcesBuildPhaseId).toBeUndefined();
    });

    it('returns empty object for unknown target', () => {
        const result = parseBuildPhaseIds(NATIVE_TARGET_SECTION, 'UnknownTarget');
        expect(result).toEqual({});
    });

    it('returns empty object for missing section', () => {
        const result = parseBuildPhaseIds('no section', 'MyApp');
        expect(result).toEqual({});
    });
});
