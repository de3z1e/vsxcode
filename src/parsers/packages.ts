import type { SwiftPackageReference, SwiftPackageProductDependency, RemoteSwiftPackageReference, LocalSwiftPackageReference } from '../types/interfaces';
import { extractObjectBody, parsePackageRequirement } from './base';
import { cleanup } from '../utils/version';

export function parseSwiftPackageReferences(pbxContents: string): Map<string, SwiftPackageReference> {
    const references = new Map<string, SwiftPackageReference>();

    const remoteRegex =
        /([A-F0-9]+)\s*\/\*\s*XCRemoteSwiftPackageReference\s*"([^"]+)"\s*\*\/\s*=\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = remoteRegex.exec(pbxContents)) !== null) {
        const [, id, displayName] = match;
        const objectBody = extractObjectBody(pbxContents, remoteRegex.lastIndex - 1);
        if (!objectBody) {
            continue;
        }
        remoteRegex.lastIndex = objectBody.endIndex;
        const body = objectBody.body;
        const urlMatch = /repositoryURL = "([^"]+)";/.exec(body);
        const requirementMatch = /requirement = \{([\s\S]*?)\};/.exec(body);
        references.set(id, {
            id,
            name: cleanup(displayName),
            type: 'remote',
            url: cleanup(urlMatch ? urlMatch[1] : ''),
            requirement: requirementMatch ? parsePackageRequirement(requirementMatch[1]) : {}
        } as RemoteSwiftPackageReference);
    }

    const localRegex =
        /([A-F0-9]+)\s*\/\*\s*XCLocalSwiftPackageReference\s*"([^"]+)"\s*\*\/\s*=\s*\{/g;
    while ((match = localRegex.exec(pbxContents)) !== null) {
        const [, id, displayName] = match;
        const objectBody = extractObjectBody(pbxContents, localRegex.lastIndex - 1);
        if (!objectBody) {
            continue;
        }
        localRegex.lastIndex = objectBody.endIndex;
        const body = objectBody.body;
        const pathMatch = /relativePath = "([^"]+)";/.exec(body) || /path = "([^"]+)";/.exec(body);
        references.set(id, {
            id,
            name: cleanup(displayName),
            type: 'local',
            path: cleanup(pathMatch ? pathMatch[1] : '')
        } as LocalSwiftPackageReference);
    }

    return references;
}

export function parseSwiftPackageProductDependencies(pbxContents: string): Map<string, SwiftPackageProductDependency> {
    const dependencies = new Map<string, SwiftPackageProductDependency>();
    const regex =
        /([A-F0-9]+)\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{\s*isa\s*=\s*XCSwiftPackageProductDependency;([\s\S]*?)\};/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(pbxContents)) !== null) {
        const [, id, displayName, body] = match;
        const productNameMatch = /productName = ([^;]+);/.exec(body);
        const packageMatch = /package = ([A-F0-9]+)(?:\s*\/\*\s*[^*]*?"([^"]+)"\s*\*\/)?;/.exec(
            body
        );
        const productName = cleanup(productNameMatch ? productNameMatch[1] : displayName);
        const packageRef = packageMatch ? cleanup(packageMatch[1]) : null;
        const packageName = packageMatch && packageMatch[2] ? cleanup(packageMatch[2]) : null;
        dependencies.set(id, {
            id,
            productName,
            packageRef,
            packageName
        });
    }
    return dependencies;
}
