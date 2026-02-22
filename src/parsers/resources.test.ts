import { determineResourceType, parseResourcesBuildPhase } from './resources';
import { RESOURCES_BUILD_PHASE_SECTION } from '../__fixtures__/pbxproj';

describe('determineResourceType', () => {
    it('returns .process for xcassets', () => {
        expect(determineResourceType('Assets.xcassets')).toBe('.process');
    });

    it('returns .process for storyboard', () => {
        expect(determineResourceType('Main.storyboard')).toBe('.process');
    });

    it('returns .process for xib', () => {
        expect(determineResourceType('View.xib')).toBe('.process');
    });

    it('returns .process for strings', () => {
        expect(determineResourceType('Localizable.strings')).toBe('.process');
    });

    it('returns .process for stringsdict', () => {
        expect(determineResourceType('Localizable.stringsdict')).toBe('.process');
    });

    it('returns .process for xcdatamodeld', () => {
        expect(determineResourceType('Model.xcdatamodeld')).toBe('.process');
    });

    it('returns .process for lproj', () => {
        expect(determineResourceType('en.lproj')).toBe('.process');
    });

    it('returns .copy for json', () => {
        expect(determineResourceType('config.json')).toBe('.copy');
    });

    it('returns .copy for plist', () => {
        expect(determineResourceType('data.plist')).toBe('.copy');
    });

    it('returns .copy for txt', () => {
        expect(determineResourceType('readme.txt')).toBe('.copy');
    });

    it('returns .copy for unknown extension', () => {
        expect(determineResourceType('file.xyz')).toBe('.copy');
    });

    it('is case-insensitive for extension', () => {
        expect(determineResourceType('Assets.XCASSETS')).toBe('.process');
    });
});

describe('parseResourcesBuildPhase', () => {
    it('parses resource file names from build phase', () => {
        const names = parseResourcesBuildPhase(
            RESOURCES_BUILD_PHASE_SECTION,
            'CCCC11111111111111111111'
        );
        expect(names).toContain('Assets.xcassets');
        expect(names).toContain('Main.storyboard');
        expect(names).toContain('config.json');
        expect(names).toContain('Localizable.strings');
        expect(names).toHaveLength(4);
    });

    it('returns empty array for missing phase ID', () => {
        const names = parseResourcesBuildPhase(
            RESOURCES_BUILD_PHASE_SECTION,
            'ZZZZZZZZZZZZZZZZZZZZZZZZ'
        );
        expect(names).toEqual([]);
    });

    it('returns empty array for empty phase ID', () => {
        const names = parseResourcesBuildPhase(RESOURCES_BUILD_PHASE_SECTION, '');
        expect(names).toEqual([]);
    });
});
