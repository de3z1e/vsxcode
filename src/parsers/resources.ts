import type { ResourceOutput } from '../types/interfaces';
import {
    PROCESSABLE_RESOURCE_EXTENSIONS,
    SPM_SOURCE_EXTENSIONS,
    SPM_AUTO_EXCLUDE_FILENAMES,
    SPM_AUTO_EXCLUDE_EXTENSIONS,
    SPM_RESOURCE_DIR_EXTENSIONS
} from '../types/constants';
import { cleanup } from '../utils/version';
import * as path from 'path';
import * as fs from 'fs';

export function determineResourceType(filePath: string): '.process' | '.copy' {
    const ext = path.extname(filePath).toLowerCase();
    return PROCESSABLE_RESOURCE_EXTENSIONS.has(ext) ? '.process' : '.copy';
}

export function parseResourcesBuildPhase(
    pbxContents: string,
    resourcesBuildPhaseId: string
): string[] {
    if (!resourcesBuildPhaseId) {
        return [];
    }

    const phaseRegex = new RegExp(
        resourcesBuildPhaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        /\s*\/\*\s*Resources\s*\*\/\s*=\s*\{[^}]*files = \(([\s\S]*?)\);/.source
    );
    const phaseMatch = phaseRegex.exec(pbxContents);
    if (!phaseMatch) {
        return [];
    }

    const fileRefs: string[] = [];
    const fileRefRegex = /([A-F0-9]{24})\s*\/\*\s*([^*]+)\s*\*\//g;
    let match: RegExpExecArray | null;
    while ((match = fileRefRegex.exec(phaseMatch[1])) !== null) {
        const fileName = cleanup(match[2]);
        if (fileName.includes(' in Resources')) {
            const resourceName = fileName.replace(' in Resources', '').trim();
            fileRefs.push(resourceName);
        }
    }

    return fileRefs;
}

function findFileInDirectory(dir: string, fileName: string): string | null {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === fileName) {
                return dir;
            }
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const found = findFileInDirectory(path.join(dir, entry.name), fileName);
                if (found) {
                    return found;
                }
            }
        }
    } catch {
        // directory not readable
    }
    return null;
}

export function resolveResourcePaths(
    fileNames: string[],
    targetAbsolutePath: string
): ResourceOutput[] {
    if (fileNames.length === 0) {
        return [];
    }

    const outputs: ResourceOutput[] = [];
    const addedPaths = new Set<string>();

    for (const fileName of fileNames) {
        const resourceType = determineResourceType(fileName);
        const containingDir = findFileInDirectory(targetAbsolutePath, fileName);

        if (!containingDir) {
            // File not found on disk — use bare name as fallback
            if (!addedPaths.has(fileName)) {
                outputs.push({ type: resourceType, path: fileName });
                addedPaths.add(fileName);
            }
            continue;
        }

        const relativePath = path.relative(targetAbsolutePath, path.join(containingDir, fileName));
        const normalizedPath = relativePath.split(path.sep).join('/');

        if (resourceType === '.process') {
            // For processable resources at the target root, use the file directly
            // For processable resources in a subdirectory, use the file path
            if (!addedPaths.has(normalizedPath)) {
                outputs.push({ type: '.process', path: normalizedPath });
                addedPaths.add(normalizedPath);
            }
        } else {
            // For non-processable resources in a subdirectory, use the full relative path
            if (!addedPaths.has(normalizedPath)) {
                outputs.push({ type: '.copy', path: normalizedPath });
                addedPaths.add(normalizedPath);
            }
        }
    }

    return outputs;
}

export function scanForUnhandledFiles(
    targetAbsolutePath: string,
    existingResources: ResourceOutput[],
    existingExcludes: string[]
): { additionalExcludes: string[]; additionalResources: ResourceOutput[] } {
    const additionalExcludes: string[] = [];
    const additionalResources: ResourceOutput[] = [];

    const existingResourcePaths = new Set(existingResources.map((r) => r.path));
    const existingExcludeSet = new Set(existingExcludes);

    function scan(dir: string, relativePath: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(dir, entry.name);
            const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            const ext = path.extname(entry.name).toLowerCase();

            if (entry.isDirectory()) {
                if (SPM_RESOURCE_DIR_EXTENSIONS.has(ext)) {
                    const dirPrefix = relPath + '/';
                    const hasChildResource = [...existingResourcePaths].some((p) => p.startsWith(dirPrefix));
                    if (!hasChildResource && !existingResourcePaths.has(relPath) && !existingExcludeSet.has(relPath)) {
                        const type = PROCESSABLE_RESOURCE_EXTENSIONS.has(ext) ? '.process' : '.copy';
                        additionalResources.push({ type, path: relPath });
                    }
                } else {
                    scan(fullPath, relPath);
                }
            } else {
                if (SPM_SOURCE_EXTENSIONS.has(ext)) {
                    continue;
                }
                if (existingResourcePaths.has(relPath) || existingExcludeSet.has(relPath)) {
                    continue;
                }
                if (SPM_AUTO_EXCLUDE_FILENAMES.has(entry.name) || SPM_AUTO_EXCLUDE_EXTENSIONS.has(ext)) {
                    additionalExcludes.push(relPath);
                }
            }
        }
    }

    try {
        scan(targetAbsolutePath, '');
    } catch {
        // directory not accessible
    }

    return { additionalExcludes, additionalResources };
}

export function parseResourcesForTarget(
    pbxContents: string,
    resourcesBuildPhaseId: string | undefined,
    targetAbsolutePath?: string
): ResourceOutput[] {
    if (!resourcesBuildPhaseId) {
        return [];
    }
    const fileNames = parseResourcesBuildPhase(pbxContents, resourcesBuildPhaseId);
    if (targetAbsolutePath) {
        return resolveResourcePaths(fileNames, targetAbsolutePath);
    }
    // Fallback: bare filenames with type inference
    return fileNames.map((fileName) => ({
        type: determineResourceType(fileName),
        path: fileName
    }));
}
