import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';

import { parseNativeTargets, isTestTarget, parseBuildPhaseIds } from '../parsers/targets';
import { parseGroups, findMainGroupId, resolveGroupForPath } from '../parsers/groups';
import type { PBXGroupInfo } from '../parsers/groups';
import { determineTargetPath } from '../utils/path';
import {
    addSwiftFileToPbxproj,
    removeSwiftFileFromPbxproj,
    findFileReferenceId
} from '../writers/pbxproj';

export interface TargetDirectoryMapping {
    absolutePath: string;
    targetName: string;
    sourcesBuildPhaseId: string;
    groupId: string;
    pbxprojPath: string;
    /** Relative path from workspace root to target directory (e.g., "Pets" or "Sources/MyApp") */
    relativePath: string;
}

export function buildTargetMappings(
    rootPath: string,
    pbxContents: string,
    pbxprojPath: string
): TargetDirectoryMapping[] {
    const mappings: TargetDirectoryMapping[] = [];
    const targets = parseNativeTargets(pbxContents);
    const groups = parseGroups(pbxContents);
    const mainGroupId = findMainGroupId(pbxContents);
    if (!mainGroupId) { return mappings; }

    for (const target of targets) {
        const isTest = isTestTarget(target.productType);
        const relativePath = determineTargetPath(rootPath, target.name, isTest, target.productName);
        const buildPhases = parseBuildPhaseIds(pbxContents, target.name);
        if (!buildPhases.sourcesBuildPhaseId) { continue; }

        const groupId = resolveGroupForPath(groups, mainGroupId, relativePath);
        if (!groupId) { continue; }

        mappings.push({
            absolutePath: path.join(rootPath, relativePath),
            targetName: target.name,
            sourcesBuildPhaseId: buildPhases.sourcesBuildPhaseId,
            groupId,
            pbxprojPath,
            relativePath
        });
    }

    return mappings;
}

export function findMappingForFile(
    filePath: string,
    mappings: TargetDirectoryMapping[]
): TargetDirectoryMapping | null {
    let bestMatch: TargetDirectoryMapping | null = null;
    let bestLength = 0;

    for (const mapping of mappings) {
        const prefix = mapping.absolutePath + path.sep;
        if (filePath.startsWith(prefix) && prefix.length > bestLength) {
            bestMatch = mapping;
            bestLength = prefix.length;
        }
    }
    return bestMatch;
}

export function resolveGroupForFile(
    filePath: string,
    mapping: TargetDirectoryMapping,
    groups: Map<string, PBXGroupInfo>,
    mainGroupId: string
): string | null {
    const relativeToTarget = path.relative(mapping.absolutePath, path.dirname(filePath));

    // File is directly in the target root directory
    if (relativeToTarget === '' || relativeToTarget === '.') {
        return mapping.groupId;
    }

    // File is in a subdirectory — try to resolve the subgroup
    const subgroupPath = mapping.relativePath + '/' + relativeToTarget.split(path.sep).join('/');
    return resolveGroupForPath(groups, mainGroupId, subgroupPath);
}

function findPbxprojPath(rootPath: string): string | null {
    const fs = require('fs') as typeof import('fs');
    try {
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });
        const xcodeProject = entries.find(
            (e: import('fs').Dirent) => e.isDirectory() && e.name.endsWith('.xcodeproj')
        );
        if (xcodeProject) {
            return path.join(rootPath, xcodeProject.name, 'project.pbxproj');
        }
    } catch { /* ignore */ }
    return null;
}

export function createSwiftFileWatcher(
    rootPath: string,
    log: (message: string) => void
): vscode.Disposable[] {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) {
        log('[swift-sync] No xcodeproj found, skipping Swift file watcher');
        return [];
    }

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.swift');
    let isWriting = false;
    const pendingOps = new Map<string, ReturnType<typeof setTimeout>>();

    function scheduleOperation(filePath: string, operation: () => Promise<void>): void {
        const existing = pendingOps.get(filePath);
        if (existing) { clearTimeout(existing); }

        pendingOps.set(filePath, setTimeout(async () => {
            pendingOps.delete(filePath);
            if (isWriting) { return; }
            isWriting = true;
            try {
                await operation();
            } catch (error) {
                const message = (error as { message?: string }).message || String(error);
                log(`[swift-sync] Error: ${message}`);
            } finally {
                isWriting = false;
            }
        }, 300));
    }

    const onCreate = watcher.onDidCreate((uri) => {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        scheduleOperation(filePath, async () => {
            const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');

            // Skip if file already registered in pbxproj
            if (findFileReferenceId(pbxContents, fileName)) {
                log(`[swift-sync] ${fileName} already in pbxproj, skipping`);
                return;
            }

            const mappings = buildTargetMappings(rootPath, pbxContents, pbxprojPath);
            const mapping = findMappingForFile(filePath, mappings);
            if (!mapping) {
                return; // Not in a known target directory
            }

            // Resolve the correct group (may be a subgroup for subdirectory files)
            const groups = parseGroups(pbxContents);
            const mainGroupId = findMainGroupId(pbxContents);
            if (!mainGroupId) { return; }

            const groupId = resolveGroupForFile(filePath, mapping, groups, mainGroupId);
            if (!groupId) {
                log(
                    `[swift-sync] No matching PBXGroup for ${path.relative(rootPath, filePath)}, skipping`
                );
                return;
            }

            const result = addSwiftFileToPbxproj(
                pbxContents, fileName, groupId, mapping.sourcesBuildPhaseId
            );
            await fsp.writeFile(pbxprojPath, result, 'utf8');
            log(
                `[swift-sync] Added ${fileName} to ${mapping.targetName}`
            );
        });
    });

    const onDelete = watcher.onDidDelete((uri) => {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        scheduleOperation(filePath, async () => {
            const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');

            // Skip if file not in pbxproj
            if (!findFileReferenceId(pbxContents, fileName)) {
                return;
            }

            const result = removeSwiftFileFromPbxproj(pbxContents, fileName);
            if (!result) { return; }

            await fsp.writeFile(pbxprojPath, result, 'utf8');
            log(
                `[swift-sync] Removed ${fileName} from pbxproj`
            );
        });
    });

    log('[swift-sync] Swift file watcher active');
    return [watcher, onCreate, onDelete];
}
