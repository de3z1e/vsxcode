import {
    formatPlatformVersion,
    formatPlatforms,
    formatRemotePackageRequirement,
    formatPackageDependencyEntry,
    buildPackageSwift,
} from './packageSwift';
import type {
    RemoteSwiftPackageReference,
    LocalSwiftPackageReference,
} from '../types/interfaces';

describe('formatPlatformVersion', () => {
    it('formats major version', () => {
        expect(formatPlatformVersion('17.0')).toBe('.v17');
    });

    it('formats version with only major', () => {
        expect(formatPlatformVersion('16')).toBe('.v16');
    });

    it('extracts major from full version', () => {
        expect(formatPlatformVersion('15.2.1')).toBe('.v15');
    });

    it('falls back to .v13 for invalid version', () => {
        expect(formatPlatformVersion('invalid')).toBe('.v13');
    });

    it('falls back to .v13 for empty string', () => {
        expect(formatPlatformVersion('')).toBe('.v13');
    });
});

describe('formatPlatforms', () => {
    it('formats single platform', () => {
        const result = formatPlatforms([{ platform: 'iOS', version: '17.0' }]);
        expect(result).toContain('.iOS(.v17)');
    });

    it('formats multiple platforms with commas', () => {
        const result = formatPlatforms([
            { platform: 'iOS', version: '17.0' },
            { platform: 'macOS', version: '14.0' },
        ]);
        expect(result).toContain('.iOS(.v17),');
        expect(result).toContain('.macOS(.v14)');
        // Last one should NOT have comma
        expect(result).not.toMatch(/\.macOS\(\.v14\),/);
    });
});

describe('formatRemotePackageRequirement', () => {
    it('formats upToNextMajorVersion', () => {
        const result = formatRemotePackageRequirement({
            kind: 'upToNextMajorVersion',
            minimumVersion: '5.8.0',
        });
        expect(result).toBe('.upToNextMajor(from: "5.8.0")');
    });

    it('formats upToNextMinorVersion', () => {
        const result = formatRemotePackageRequirement({
            kind: 'upToNextMinorVersion',
            minimumVersion: '1.2.0',
        });
        expect(result).toBe('.upToNextMinor(from: "1.2.0")');
    });

    it('formats exactVersion', () => {
        const result = formatRemotePackageRequirement({
            kind: 'exactVersion',
            version: '5.6.0',
        });
        expect(result).toBe('.exact("5.6.0")');
    });

    it('formats branch', () => {
        const result = formatRemotePackageRequirement({
            kind: 'branch',
            branch: 'main',
        });
        expect(result).toBe('.branch("main")');
    });

    it('formats revision', () => {
        const result = formatRemotePackageRequirement({
            kind: 'revision',
            revision: 'abc123',
        });
        expect(result).toBe('.revision("abc123")');
    });

    it('formats versionRange', () => {
        const result = formatRemotePackageRequirement({
            kind: 'versionRange',
            minimumVersion: '1.0.0',
            maximumVersion: '2.0.0',
        });
        expect(result).toBe('"1.0.0"..<"2.0.0"');
    });

    it('formats range with lowerBound/upperBound', () => {
        const result = formatRemotePackageRequirement({
            kind: 'range',
            lowerBound: '1.0.0',
            upperBound: '2.0.0',
        });
        expect(result).toBe('"1.0.0"..<"2.0.0"');
    });

    it('returns null for null requirement', () => {
        expect(formatRemotePackageRequirement(null)).toBeNull();
    });

    it('returns null for undefined requirement', () => {
        expect(formatRemotePackageRequirement(undefined)).toBeNull();
    });

    it('returns null for empty requirement with no kind', () => {
        expect(formatRemotePackageRequirement({})).toBeNull();
    });

    it('falls back to upToNextMajor when kind is unknown but has minimumVersion', () => {
        const result = formatRemotePackageRequirement({
            kind: 'unknownKind',
            minimumVersion: '3.0.0',
        });
        expect(result).toBe('.upToNextMajor(from: "3.0.0")');
    });

    it('uses version field for upToNextMajorVersion', () => {
        const result = formatRemotePackageRequirement({
            kind: 'upToNextMajorVersion',
            version: '2.0.0',
        });
        expect(result).toBe('.upToNextMajor(from: "2.0.0")');
    });
});

describe('formatPackageDependencyEntry', () => {
    it('formats remote package with requirement', () => {
        const ref: RemoteSwiftPackageReference = {
            id: 'AAA',
            name: 'Alamofire',
            type: 'remote',
            url: 'https://github.com/Alamofire/Alamofire.git',
            requirement: { kind: 'upToNextMajorVersion', minimumVersion: '5.8.0' },
        };
        const result = formatPackageDependencyEntry(ref);
        expect(result).toBe(
            '.package(url: "https://github.com/Alamofire/Alamofire.git", .upToNextMajor(from: "5.8.0"))'
        );
    });

    it('formats remote package without requirement', () => {
        const ref: RemoteSwiftPackageReference = {
            id: 'BBB',
            name: 'SomePackage',
            type: 'remote',
            url: 'https://github.com/example/SomePackage.git',
        };
        const result = formatPackageDependencyEntry(ref);
        expect(result).toBe('.package(url: "https://github.com/example/SomePackage.git")');
    });

    it('formats local package with path', () => {
        const ref: LocalSwiftPackageReference = {
            id: 'CCC',
            name: 'CoreLib',
            type: 'local',
            path: '../CoreLib',
        };
        const result = formatPackageDependencyEntry(ref);
        expect(result).toBe('.package(path: "../CoreLib")');
    });

    it('uses name as fallback path for local package', () => {
        const ref: LocalSwiftPackageReference = {
            id: 'DDD',
            name: 'MyLib',
            type: 'local',
            path: '',
        };
        const result = formatPackageDependencyEntry(ref);
        expect(result).toBe('.package(path: "./MyLib")');
    });
});

describe('buildPackageSwift', () => {
    it('generates valid Package.swift content', () => {
        const result = buildPackageSwift({
            packageName: 'MyApp',
            swiftVersion: '5.9',
            platforms: [{ platform: 'iOS', version: '17.0' }],
            products: [{ type: '.library', name: 'MyApp', targets: ['MyApp'] }],
            dependencies: [],
            targets: [
                {
                    spmType: '.target',
                    name: 'MyApp',
                    path: 'Sources/MyApp',
                },
            ],
        });
        expect(result).toContain('// swift-tools-version: 5.9');
        expect(result).toContain('import PackageDescription');
        expect(result).toContain('name: "MyApp"');
        expect(result).toContain('.iOS(.v17)');
        expect(result).toContain('.library(');
        expect(result).toContain('.target(');
        expect(result).toContain('path: "Sources/MyApp"');
    });

    it('includes defaultLocalization when provided', () => {
        const result = buildPackageSwift({
            packageName: 'MyApp',
            swiftVersion: '5.9',
            platforms: [{ platform: 'iOS', version: '17.0' }],
            products: [],
            dependencies: [],
            targets: [],
            defaultLocalization: 'en',
        });
        expect(result).toContain('defaultLocalization: "en"');
    });

    it('omits defaultLocalization when not provided', () => {
        const result = buildPackageSwift({
            packageName: 'MyApp',
            swiftVersion: '5.9',
            platforms: [{ platform: 'iOS', version: '17.0' }],
            products: [],
            dependencies: [],
            targets: [],
        });
        expect(result).not.toContain('defaultLocalization');
    });

    it('includes dependencies section when provided', () => {
        const result = buildPackageSwift({
            packageName: 'MyApp',
            swiftVersion: '5.9',
            platforms: [{ platform: 'iOS', version: '17.0' }],
            products: [],
            dependencies: ['.package(url: "https://github.com/Alamofire/Alamofire.git", .upToNextMajor(from: "5.8.0"))'],
            targets: [],
        });
        expect(result).toContain('dependencies: [');
        expect(result).toContain('Alamofire');
    });

    it('omits dependencies section when empty', () => {
        const result = buildPackageSwift({
            packageName: 'MyApp',
            swiftVersion: '5.9',
            platforms: [{ platform: 'iOS', version: '17.0' }],
            products: [],
            dependencies: [],
            targets: [],
        });
        expect(result).not.toContain('dependencies: [');
    });

    it('renders target with all optional fields', () => {
        const result = buildPackageSwift({
            packageName: 'MyApp',
            swiftVersion: '5.9',
            platforms: [{ platform: 'iOS', version: '17.0' }],
            products: [],
            dependencies: [],
            targets: [
                {
                    spmType: '.target',
                    name: 'MyApp',
                    path: 'Sources/MyApp',
                    dependencies: ['.product(name: "Alamofire", package: "Alamofire")'],
                    resources: [{ type: '.process', path: 'Assets.xcassets' }],
                    swiftSettings: ['.define("BETA")'],
                    linkerSettings: ['.linkedFramework("AVFoundation")'],
                    exclude: ['Info.plist'],
                },
            ],
        });
        expect(result).toContain('dependencies:');
        expect(result).toContain('resources:');
        expect(result).toContain('swiftSettings:');
        expect(result).toContain('linkerSettings:');
        expect(result).toContain('exclude:');
    });
});
