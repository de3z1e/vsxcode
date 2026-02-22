import { formatResourceEntry, generateResourceEntries } from './resources';
import type { ResourceOutput } from '../types/interfaces';

describe('formatResourceEntry', () => {
    it('formats .process resource', () => {
        const resource: ResourceOutput = { type: '.process', path: 'Assets.xcassets' };
        expect(formatResourceEntry(resource)).toBe('.process("Assets.xcassets")');
    });

    it('formats .copy resource', () => {
        const resource: ResourceOutput = { type: '.copy', path: 'config.json' };
        expect(formatResourceEntry(resource)).toBe('.copy("config.json")');
    });

    it('formats resource with subdirectory path', () => {
        const resource: ResourceOutput = { type: '.process', path: 'Resources/Main.storyboard' };
        expect(formatResourceEntry(resource)).toBe('.process("Resources/Main.storyboard")');
    });
});

describe('generateResourceEntries', () => {
    it('formats all resources', () => {
        const resources: ResourceOutput[] = [
            { type: '.process', path: 'Assets.xcassets' },
            { type: '.copy', path: 'config.json' },
        ];
        const result = generateResourceEntries(resources);
        expect(result).toEqual([
            '.process("Assets.xcassets")',
            '.copy("config.json")',
        ]);
    });

    it('returns empty array for empty input', () => {
        expect(generateResourceEntries([])).toEqual([]);
    });
});
