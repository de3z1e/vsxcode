import {
    parseFrameworksBuildPhase,
    extractFrameworkNames,
    parseLinkedFrameworksForTarget,
} from './frameworks';
import { FRAMEWORKS_BUILD_PHASE_SECTION } from '../__fixtures__/pbxproj';

describe('parseFrameworksBuildPhase', () => {
    it('parses framework file names from build phase', () => {
        const names = parseFrameworksBuildPhase(
            FRAMEWORKS_BUILD_PHASE_SECTION,
            'BBBB11111111111111111111'
        );
        expect(names).toContain('AVFoundation.framework');
        expect(names).toContain('CoreData.framework');
        expect(names).toContain('libsqlite3.tbd');
        expect(names).toContain('Alamofire');
    });

    it('returns empty array for missing phase ID', () => {
        const names = parseFrameworksBuildPhase(
            FRAMEWORKS_BUILD_PHASE_SECTION,
            'ZZZZZZZZZZZZZZZZZZZZZZZZ'
        );
        expect(names).toEqual([]);
    });

    it('returns empty array for empty phase ID', () => {
        const names = parseFrameworksBuildPhase(FRAMEWORKS_BUILD_PHASE_SECTION, '');
        expect(names).toEqual([]);
    });
});

describe('extractFrameworkNames', () => {
    it('strips .framework extension', () => {
        const result = extractFrameworkNames(['AVFoundation.framework']);
        expect(result).toEqual(['AVFoundation']);
    });

    it('strips .tbd extension and lib prefix', () => {
        const result = extractFrameworkNames(['libsqlite3.tbd']);
        expect(result).toEqual(['sqlite3']);
    });

    it('filters out implicit frameworks', () => {
        const result = extractFrameworkNames([
            'Foundation.framework',
            'UIKit.framework',
            'AVFoundation.framework',
        ]);
        expect(result).toEqual(['AVFoundation']);
    });

    it('deduplicates framework names', () => {
        const result = extractFrameworkNames([
            'AVFoundation.framework',
            'AVFoundation.framework',
        ]);
        expect(result).toEqual(['AVFoundation']);
    });

    it('returns empty array for empty input', () => {
        const result = extractFrameworkNames([]);
        expect(result).toEqual([]);
    });

    it('passes through names without extensions', () => {
        const result = extractFrameworkNames(['Alamofire']);
        expect(result).toEqual(['Alamofire']);
    });
});

describe('parseLinkedFrameworksForTarget', () => {
    it('returns extracted framework names for valid phase ID', () => {
        const names = parseLinkedFrameworksForTarget(
            FRAMEWORKS_BUILD_PHASE_SECTION,
            'BBBB11111111111111111111'
        );
        expect(names).toContain('AVFoundation');
        expect(names).toContain('CoreData');
        expect(names).toContain('sqlite3');
        expect(names).toContain('Alamofire');
    });

    it('returns empty array for undefined phase ID', () => {
        const names = parseLinkedFrameworksForTarget(
            FRAMEWORKS_BUILD_PHASE_SECTION,
            undefined
        );
        expect(names).toEqual([]);
    });
});
