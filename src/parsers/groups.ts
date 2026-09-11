import * as path from 'path';
import { readProject, stringList, stringValue } from './projectIndex';

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

/** Map every group reachable from mainGroup to its absolute on-disk dir. A group adds a path segment only if it has a `path`; name-only "virtual" groups inherit the parent dir. */
export function buildGroupDirectories(
    groups: Map<string, PBXGroupInfo>,
    mainGroupId: string,
    rootPath: string
): Map<string, string> {
    const dirs = new Map<string, string>();
    const visited = new Set<string>();

    const visit = (groupId: string, parentDir: string): void => {
        if (visited.has(groupId)) { return; } // guard against malformed cyclic trees
        visited.add(groupId);
        const group = groups.get(groupId);
        if (!group) { return; }
        const dir = group.path ? path.join(parentDir, group.path) : parentDir;
        dirs.set(groupId, dir);
        for (const childId of group.childIds) {
            visit(childId, dir);
        }
    };

    visit(mainGroupId, rootPath);
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
