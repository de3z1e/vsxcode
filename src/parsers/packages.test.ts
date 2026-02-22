import {
    parseSwiftPackageReferences,
    parseSwiftPackageProductDependencies,
} from './packages';
import {
    REMOTE_PACKAGE_SECTION,
    LOCAL_PACKAGE_SECTION,
    PACKAGE_PRODUCT_DEPENDENCY_SECTION,
} from '../__fixtures__/pbxproj';

describe('parseSwiftPackageReferences', () => {
    it('parses remote package references', () => {
        const refs = parseSwiftPackageReferences(REMOTE_PACKAGE_SECTION);
        expect(refs.size).toBe(3);
    });

    it('parses Alamofire remote reference correctly', () => {
        const refs = parseSwiftPackageReferences(REMOTE_PACKAGE_SECTION);
        const alamofire = refs.get('EEEEEEEEEEEEEEEEEEEEEEEA');
        expect(alamofire).toBeDefined();
        expect(alamofire!.type).toBe('remote');
        expect(alamofire!.name).toBe('Alamofire');
        if (alamofire!.type === 'remote') {
            expect(alamofire!.url).toBe('https://github.com/Alamofire/Alamofire.git');
            expect(alamofire!.requirement).toEqual({
                kind: 'upToNextMajorVersion',
                minimumVersion: '5.8.0',
            });
        }
    });

    it('parses exact version requirement', () => {
        const refs = parseSwiftPackageReferences(REMOTE_PACKAGE_SECTION);
        const snapkit = refs.get('EEEEEEEEEEEEEEEEEEEEEEE2');
        expect(snapkit).toBeDefined();
        if (snapkit!.type === 'remote') {
            expect(snapkit!.requirement).toEqual({
                kind: 'exactVersion',
                version: '5.6.0',
            });
        }
    });

    it('parses branch requirement', () => {
        const refs = parseSwiftPackageReferences(REMOTE_PACKAGE_SECTION);
        const moya = refs.get('EEEEEEEEEEEEEEEEEEEEEEE3');
        expect(moya).toBeDefined();
        if (moya!.type === 'remote') {
            expect(moya!.requirement).toEqual({
                kind: 'branch',
                branch: 'main',
            });
        }
    });

    it('parses local package references', () => {
        const refs = parseSwiftPackageReferences(LOCAL_PACKAGE_SECTION);
        expect(refs.size).toBe(1);
        const local = refs.get('AABB11111111111111111101');
        expect(local).toBeDefined();
        expect(local!.type).toBe('local');
        expect(local!.name).toBe('CoreLib');
        if (local!.type === 'local') {
            expect(local!.path).toBe('../CoreLib');
        }
    });

    it('parses both remote and local from combined content', () => {
        const combined = REMOTE_PACKAGE_SECTION + LOCAL_PACKAGE_SECTION;
        const refs = parseSwiftPackageReferences(combined);
        expect(refs.size).toBe(4);
    });

    it('returns empty map for content with no packages', () => {
        const refs = parseSwiftPackageReferences('no packages here');
        expect(refs.size).toBe(0);
    });
});

describe('parseSwiftPackageProductDependencies', () => {
    it('parses product dependencies', () => {
        const deps = parseSwiftPackageProductDependencies(PACKAGE_PRODUCT_DEPENDENCY_SECTION);
        expect(deps.size).toBe(2);
    });

    it('parses Alamofire product dependency correctly', () => {
        const deps = parseSwiftPackageProductDependencies(PACKAGE_PRODUCT_DEPENDENCY_SECTION);
        const alamofire = deps.get('FFFF11111111111111111111');
        expect(alamofire).toBeDefined();
        expect(alamofire!.productName).toBe('Alamofire');
        expect(alamofire!.packageRef).toBe('EEEEEEEEEEEEEEEEEEEEEEEA');
        expect(alamofire!.packageName).toBe('Alamofire');
    });

    it('parses SnapKit product dependency correctly', () => {
        const deps = parseSwiftPackageProductDependencies(PACKAGE_PRODUCT_DEPENDENCY_SECTION);
        const snapkit = deps.get('FFFF22222222222222222222');
        expect(snapkit).toBeDefined();
        expect(snapkit!.productName).toBe('SnapKit');
        expect(snapkit!.packageRef).toBe('EEEEEEEEEEEEEEEEEEEEEEE2');
    });

    it('returns empty map for content with no dependencies', () => {
        const deps = parseSwiftPackageProductDependencies('no deps here');
        expect(deps.size).toBe(0);
    });
});
