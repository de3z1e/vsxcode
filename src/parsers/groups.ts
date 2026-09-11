import { readProject, resolvedPath, stringList, stringValue } from './projectIndex';

export interface PBXGroupInfo {
    id: string;
    name?: string;
    path?: string;
    childIds: string[];
}

/** Every PBXGroup in definition order, then each synchronized root group. */
export function parseGroups(pbxContents: string): Map<string, PBXGroupInfo> {
    const groups = new Map<string, PBXGroupInfo>();
    const index = readProject(pbxContents);
    if (typeof index === 'string') {
        return groups;
    }

    for (const { id, object } of index.objectsOfIsa('PBXGroup')) {
        groups.set(id, { id, name: stringValue(object.name), path: stringValue(object.path), childIds: stringList(object.children) });
    }

    // Leaves, since Xcode discovers their files; listed so a path naming a synchronized folder resolves to that group.
    for (const { id, object } of index.objectsOfIsa('PBXFileSystemSynchronizedRootGroup')) {
        const groupPath = stringValue(object.path);
        groups.set(id, { id, name: groupPath, path: groupPath, childIds: [] });
    }

    return groups;
}

export function findMainGroupId(pbxContents: string): string | null {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? null : index.mainGroupId ?? null;
}

/** Each PBXGroup and synchronized root reachable from the main group with its `resolvedPath` folder; groups with none (build products) are left out. */
export function buildGroupDirectories(pbxContents: string, projectDir: string): Map<string, string> {
    const dirs = new Map<string, string>();
    const index = readProject(pbxContents);
    if (typeof index === 'string' || !index.mainGroupId) { return dirs; }
    const visited = new Set<string>();

    const visit = (groupId: string): void => {
        if (visited.has(groupId)) { return; } // guard against malformed cyclic trees
        visited.add(groupId);
        const object = index.object(groupId);
        if (!object || (object.isa !== 'PBXGroup' && object.isa !== 'PBXFileSystemSynchronizedRootGroup')) { return; }
        const dir = resolvedPath(index, groupId, projectDir);
        if (dir !== undefined) { dirs.set(groupId, dir); }
        for (const childId of stringList(object.children)) {
            visit(childId);
        }
    };

    visit(index.mainGroupId);
    return dirs;
}

export function resolveGroupForPath(
    groups: Map<string, PBXGroupInfo>,
    mainGroupId: string,
    relativePath: string
): string | null {
    const segments = relativePath.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
        return mainGroupId;
    }

    let currentGroupId = mainGroupId;

    for (const segment of segments) {
        const currentGroup = groups.get(currentGroupId);
        if (!currentGroup) {
            return null;
        }

        let found = false;
        for (const childId of currentGroup.childIds) {
            const childGroup = groups.get(childId);
            if (childGroup && (childGroup.path === segment || childGroup.name === segment)) {
                currentGroupId = childId;
                found = true;
                break;
            }
        }
        if (!found) {
            return null;
        }
    }

    return currentGroupId;
}
