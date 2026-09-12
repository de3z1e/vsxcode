import type { SwiftPackageReference, SwiftPackageProductDependency, PackageRequirement } from '../types/interfaces';
import { readProject, stringValue } from './projectIndex';
import type { ProjectObject } from './projectIndex';

/** A local package's folder as the reference spells it: `relativePath`, or the older `path`. */
function localPath(object: ProjectObject): string {
    return stringValue(object.relativePath) ?? stringValue(object.path) ?? '';
}

/** What Xcode shows for a package reference: a remote's repository name without `.git`, a local's relative path. */
function packageName(object: ProjectObject): string {
    if (object.isa === 'XCLocalSwiftPackageReference') { return localPath(object); }
    const url = stringValue(object.repositoryURL) ?? '';
    return (url.replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.git$/, '');
}

/** The requirement's non-empty string entries with keys in code-point order, which is how Xcode writes them; plutil's JSON doesn't keep it. */
function requirementOf(value: unknown): PackageRequirement {
    const requirement: PackageRequirement = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = value as Record<string, unknown>;
        for (const key of Object.keys(entries).sort()) {
            const entry = stringValue(entries[key]);
            if (entry) { requirement[key] = entry; }
        }
    }
    return requirement;
}

/** Every remote package reference, then every local one, by id in definition order; empty when plutil can't read the text. */
export function parseSwiftPackageReferences(pbxContents: string): Map<string, SwiftPackageReference> {
    const references = new Map<string, SwiftPackageReference>();
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return references; }
    for (const { id, object } of index.objectsOfIsa('XCRemoteSwiftPackageReference')) {
        references.set(id, {
            id,
            name: packageName(object),
            type: 'remote',
            url: stringValue(object.repositoryURL) ?? '',
            requirement: requirementOf(object.requirement)
        });
    }
    for (const { id, object } of index.objectsOfIsa('XCLocalSwiftPackageReference')) {
        references.set(id, { id, name: packageName(object), type: 'local', path: localPath(object) });
    }
    return references;
}

/** Every product dependency in definition order, naming its package as the reference does; empty when plutil can't read the text. */
export function parseSwiftPackageProductDependencies(pbxContents: string): Map<string, SwiftPackageProductDependency> {
    const dependencies = new Map<string, SwiftPackageProductDependency>();
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return dependencies; }
    for (const { id, object } of index.objectsOfIsa('XCSwiftPackageProductDependency')) {
        const packageRef = stringValue(object.package) ?? null;
        const reference = index.object(packageRef);
        dependencies.set(id, {
            id,
            productName: stringValue(object.productName) ?? '',
            packageRef,
            packageName: reference ? packageName(reference) : null
        });
    }
    return dependencies;
}
