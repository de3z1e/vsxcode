import { cleanup, compareVersions, parseSwiftVersion, parseSwiftToolsVersion } from './version';

describe('cleanup', () => {
    it('strips surrounding double quotes', () => {
        expect(cleanup('"hello"')).toBe('hello');
    });

    it('trims whitespace', () => {
        expect(cleanup('  hello  ')).toBe('hello');
    });

    it('trims and strips surrounding quotes', () => {
        expect(cleanup('"hello"')).toBe('hello');
        // When whitespace is outside the quotes, trim happens after regex
        expect(cleanup('  "hello"  ')).toBe('"hello"');
    });

    it('returns empty string for null', () => {
        expect(cleanup(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
        expect(cleanup(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
        expect(cleanup('')).toBe('');
    });

    it('handles value without quotes', () => {
        expect(cleanup('hello')).toBe('hello');
    });

    it('strips multiple outer quotes', () => {
        expect(cleanup('""hello""')).toBe('hello');
    });
});

describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
        expect(compareVersions('5.9', '5.9')).toBe(0);
    });

    it('returns 1 when left is greater', () => {
        expect(compareVersions('6.0', '5.9')).toBe(1);
    });

    it('returns -1 when left is lesser', () => {
        expect(compareVersions('5.8', '5.9')).toBe(-1);
    });

    it('handles different length versions', () => {
        expect(compareVersions('5.9.1', '5.9')).toBe(1);
        expect(compareVersions('5.9', '5.9.1')).toBe(-1);
    });

    it('handles major version difference', () => {
        expect(compareVersions('6.0', '5.0')).toBe(1);
    });

    it('handles three-part versions', () => {
        expect(compareVersions('5.9.2', '5.9.1')).toBe(1);
        expect(compareVersions('5.9.1', '5.9.2')).toBe(-1);
    });

    it('treats missing parts as 0', () => {
        expect(compareVersions('5.9.0', '5.9')).toBe(0);
    });
});

describe('parseSwiftVersion', () => {
    it('extracts highest swift version from pbxproj content', () => {
        const content = `
            SWIFT_VERSION = 5.0;
            SWIFT_VERSION = 5.9;
            SWIFT_VERSION = 5.5;
        `;
        expect(parseSwiftVersion(content)).toBe('5.9');
    });

    it('returns single version', () => {
        const content = `SWIFT_VERSION = 5.9;`;
        expect(parseSwiftVersion(content)).toBe('5.9');
    });

    it('returns null for no matches', () => {
        expect(parseSwiftVersion('no version here')).toBeNull();
    });

    it('handles quoted values', () => {
        const content = `SWIFT_VERSION = "6.0";`;
        expect(parseSwiftVersion(content)).toBe('6.0');
    });

    it('deduplicates before sorting', () => {
        const content = `
            SWIFT_VERSION = 5.9;
            SWIFT_VERSION = 5.9;
        `;
        expect(parseSwiftVersion(content)).toBe('5.9');
    });
});

describe('parseSwiftToolsVersion', () => {
    it('parses version from xcrun swift --version output', () => {
        const output = 'Apple Swift version 5.9.2 (swiftlang-5.9.2.2.56 clang-1500.1.0.2.5)';
        expect(parseSwiftToolsVersion(output)).toBe('5.9.2');
    });

    it('parses version from swift language version format', () => {
        const output = 'Swift language version 6.0.2';
        expect(parseSwiftToolsVersion(output)).toBe('6.0.2');
    });

    it('returns null for null input', () => {
        expect(parseSwiftToolsVersion(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(parseSwiftToolsVersion(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseSwiftToolsVersion('')).toBeNull();
    });

    it('returns null for unrecognized format', () => {
        expect(parseSwiftToolsVersion('some random output')).toBeNull();
    });
});
