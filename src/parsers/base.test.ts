import { extractObjectBody, parsePackageRequirement, parseListValue } from './base';

describe('extractObjectBody', () => {
    it('extracts body between matching braces', () => {
        const input = 'prefix { body content }';
        const result = extractObjectBody(input, 0);
        expect(result).toEqual({ body: ' body content ', endIndex: 23 });
    });

    it('handles nested braces', () => {
        const input = 'start { outer { inner } end }';
        const result = extractObjectBody(input, 0);
        expect(result).toEqual({ body: ' outer { inner } end ', endIndex: 29 });
    });

    it('returns null when no opening brace found', () => {
        const result = extractObjectBody('no braces here', 0);
        expect(result).toBeNull();
    });

    it('handles startIndex offset', () => {
        const input = 'skip { first } target { second }';
        const result = extractObjectBody(input, 15);
        expect(result).toEqual({ body: ' second ', endIndex: 32 });
    });

    it('handles unclosed brace by returning rest of string', () => {
        const input = 'start { unclosed content';
        const result = extractObjectBody(input, 0);
        expect(result).toEqual({ body: ' unclosed content', endIndex: 24 });
    });

    it('handles deeply nested braces', () => {
        const input = '{ a { b { c } d } e }';
        const result = extractObjectBody(input, 0);
        expect(result).toEqual({ body: ' a { b { c } d } e ', endIndex: 21 });
    });
});

describe('parsePackageRequirement', () => {
    it('parses key-value pairs from requirement block', () => {
        const block = `
            kind = upToNextMajorVersion;
            minimumVersion = 5.8.0;
        `;
        const result = parsePackageRequirement(block);
        expect(result).toEqual({
            kind: 'upToNextMajorVersion',
            minimumVersion: '5.8.0',
        });
    });

    it('handles quoted values', () => {
        const block = `kind = "exactVersion"; version = "1.0.0";`;
        const result = parsePackageRequirement(block);
        expect(result).toEqual({
            kind: 'exactVersion',
            version: '1.0.0',
        });
    });

    it('returns empty object for empty block', () => {
        const result = parsePackageRequirement('');
        expect(result).toEqual({});
    });

    it('parses branch requirement', () => {
        const block = `kind = branch; branch = main;`;
        const result = parsePackageRequirement(block);
        expect(result).toEqual({ kind: 'branch', branch: 'main' });
    });
});

describe('parseListValue', () => {
    it('parses parenthesized list', () => {
        const input = `(
            "$(inherited)",
            DEBUG,
            BETA_FEATURE,
        )`;
        const result = parseListValue(input);
        expect(result).toEqual(['$(inherited)', 'DEBUG', 'BETA_FEATURE']);
    });

    it('parses single unquoted value', () => {
        const result = parseListValue('DEBUG');
        expect(result).toEqual(['DEBUG']);
    });

    it('parses single quoted value', () => {
        const result = parseListValue('"CUSTOM_FLAG"');
        expect(result).toEqual(['CUSTOM_FLAG']);
    });

    it('parses space-separated values', () => {
        const result = parseListValue('"$(inherited) -Xfrontend -warn-concurrency"');
        expect(result).toEqual(['$(inherited)', '-Xfrontend', '-warn-concurrency']);
    });

    it('returns empty array for empty input', () => {
        const result = parseListValue('');
        expect(result).toEqual([]);
    });

    it('filters empty items from parenthesized list', () => {
        const input = '( , DEBUG, )';
        const result = parseListValue(input);
        expect(result).toEqual(['DEBUG']);
    });
});
