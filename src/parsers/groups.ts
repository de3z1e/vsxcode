import { cleanup } from '../utils/version';
import { extractObjectBody } from './base';

export interface PBXGroupInfo {
    id: string;
    name?: string;
    path?: string;
    childIds: string[];
}

export function parseGroups(pbxContents: string): Map<string, PBXGroupInfo> {
    const groups = new Map<string, PBXGroupInfo>();

    const sectionRegex =
        /\/\* Begin PBXGroup section \*\/([\s\S]*?)\/\* End PBXGroup section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return groups;
    }
    const section = sectionMatch[1];

    const groupRegex =
        /\s*([A-F0-9]{24})\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{[^}]*isa\s*=\s*PBXGroup;/g;
    let match: RegExpExecArray | null;

    while ((match = groupRegex.exec(section)) !== null) {
        const id = match[1];
        const startIdx = match.index;

        // Find the closing brace for this group entry by tracking brace depth
        let depth = 0;
        let bodyStart = -1;
        let bodyEnd = -1;
        for (let i = section.indexOf('{', startIdx); i < section.length; i++) {
            if (section[i] === '{') {
                if (depth === 0) { bodyStart = i; }
                depth++;
            } else if (section[i] === '}') {
                depth--;
                if (depth === 0) {
                    bodyEnd = i;
                    break;
                }
            }
        }
        if (bodyStart === -1 || bodyEnd === -1) { continue; }

        const body = section.slice(bodyStart + 1, bodyEnd);

        // Extract children IDs
        const childIds: string[] = [];
        const childrenMatch = /children\s*=\s*\(([\s\S]*?)\);/.exec(body);
        if (childrenMatch) {
            const childIdRegex = /([A-F0-9]{24})/g;
            let childMatch: RegExpExecArray | null;
            while ((childMatch = childIdRegex.exec(childrenMatch[1])) !== null) {
                childIds.push(childMatch[1]);
            }
        }

        // Extract name and path
        const nameMatch = /\bname\s*=\s*([^;]+);/.exec(body);
        const pathMatch = /\bpath\s*=\s*([^;]+);/.exec(body);

        const name = nameMatch ? cleanup(nameMatch[1]) : undefined;
        const groupPath = pathMatch ? cleanup(pathMatch[1]) : undefined;

        groups.set(id, { id, name, path: groupPath, childIds });
    }

    // Parse PBXFileSystemSynchronizedRootGroup entries as leaf-node groups
    // so resolveGroupForPath() can find them in mainGroup children
    parseSynchronizedRootGroups(pbxContents, groups);

    return groups;
}

function parseSynchronizedRootGroups(
    pbxContents: string,
    groups: Map<string, PBXGroupInfo>
): void {
    const sectionRegex =
        /\/\* Begin PBXFileSystemSynchronizedRootGroup section \*\/([\s\S]*?)\/\* End PBXFileSystemSynchronizedRootGroup section \*\//;
    const sectionMatch = sectionRegex.exec(pbxContents);
    if (!sectionMatch) {
        return;
    }
    const section = sectionMatch[1];

    const entryRegex =
        /\s*([A-F0-9]{24})\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{[^}]*isa\s*=\s*PBXFileSystemSynchronizedRootGroup;/g;
    let match: RegExpExecArray | null;

    while ((match = entryRegex.exec(section)) !== null) {
        const id = match[1];
        const result = extractObjectBody(section, match.index);
        if (!result) { continue; }

        const pathMatch = /\bpath\s*=\s*([^;]+);/.exec(result.body);
        const groupPath = pathMatch ? cleanup(pathMatch[1]) : undefined;

        // Synchronized root groups have no children — they are leaf nodes
        groups.set(id, { id, name: groupPath, path: groupPath, childIds: [] });
    }
}

export function findMainGroupId(pbxContents: string): string | null {
    const projectRegex =
        /\/\* Begin PBXProject section \*\/([\s\S]*?)\/\* End PBXProject section \*\//;
    const projectMatch = projectRegex.exec(pbxContents);
    if (!projectMatch) {
        return null;
    }
    const mainGroupMatch = /mainGroup\s*=\s*([A-F0-9]{24})/.exec(projectMatch[1]);
    return mainGroupMatch ? mainGroupMatch[1] : null;
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
