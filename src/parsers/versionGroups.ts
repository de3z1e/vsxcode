import { locateObject, readProject, stringList, stringValue } from './projectIndex';

export const VERSION_GROUP_SECTION_BEGIN = '/* Begin XCVersionGroup section */';
export const VERSION_GROUP_SECTION_END = '/* End XCVersionGroup section */';

/** The pbxproj node for a `.xcdatamodeld`: it stands in for the bundle wherever a PBXFileReference normally would, and its children are the `.xcdatamodel` version refs. */
export interface XCVersionGroupInfo {
    id: string;
    /** On-disk bundle name, e.g. "MyApp.xcdatamodeld". */
    path?: string;
    name?: string;
    /** PBXFileReference ids of the `.xcdatamodel` versions inside the bundle. */
    childIds: string[];
    currentVersionId?: string;
    /** Raw sourceTree value, e.g. "<group>" or "SOURCE_ROOT". */
    sourceTree?: string;
    /** Offset of the entry's first character in the source, at the start of its line. */
    startIndex: number;
    /** Offset just past the entry's terminating `};` and line break. */
    endIndex: number;
}

/** Every XCVersionGroup in the file, in definition order. */
export function parseVersionGroups(pbxContents: string): XCVersionGroupInfo[] {
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return []; }

    const groups: XCVersionGroupInfo[] = [];
    for (const { id, object } of index.objectsOfIsa('XCVersionGroup')) {
        // An entry the text walk can't place is left out rather than given guessed offsets.
        const location = locateObject(pbxContents, id);
        if (!location) { continue; }
        groups.push({
            id,
            name: stringValue(object.name),
            path: stringValue(object.path),
            childIds: stringList(object.children),
            currentVersionId: stringValue(object.currentVersion),
            sourceTree: stringValue(object.sourceTree),
            startIndex: location.startIndex,
            endIndex: location.endIndex
        });
    }
    return groups;
}

/** The bundle name an XCVersionGroup refers to on disk, as a path relative to its parent group. */
export function versionGroupBundleName(group: XCVersionGroupInfo): string | undefined {
    return group.path ?? group.name;
}

/** Just the bundle's directory name, for comparing against what's on disk. */
export function versionGroupBaseName(group: XCVersionGroupInfo): string | undefined {
    const bundleName = versionGroupBundleName(group);
    return bundleName ? bundleName.split('/').filter((s) => s.length > 0).pop() : undefined;
}
