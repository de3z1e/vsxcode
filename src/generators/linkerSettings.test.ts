import { generateLinkerSettings } from './linkerSettings';

describe('generateLinkerSettings', () => {
    it('generates .linkedFramework for each framework', () => {
        const result = generateLinkerSettings(['AVFoundation', 'CoreData']);
        expect(result).toEqual([
            '.linkedFramework("AVFoundation")',
            '.linkedFramework("CoreData")',
        ]);
    });

    it('returns empty array for empty input', () => {
        const result = generateLinkerSettings([]);
        expect(result).toEqual([]);
    });

    it('handles single framework', () => {
        const result = generateLinkerSettings(['AVFoundation']);
        expect(result).toEqual(['.linkedFramework("AVFoundation")']);
    });
});
