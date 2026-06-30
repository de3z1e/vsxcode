import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';

import { parseNativeTargets, isTestTarget, parseBuildPhaseIds } from '../parsers/targets';
import { parseGroups, findMainGroupId, resolveGroupForPath, buildGroupDirectories } from '../parsers/groups';
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
    /** Absolute dirs of the target's Xcode 16+ synchronized root groups; sync skips files under these (Xcode auto-discovers them) but not the rest of the target. */
    synchronizedRoots: string[];
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
    const groupDirs = buildGroupDirectories(groups, mainGroupId, rootPath);

    for (const target of targets) {
        const isTest = isTestTarget(target.productType);
        const relativePath = determineTargetPath(rootPath, target.name, isTest, target.productName);
        const buildPhases = parseBuildPhaseIds(pbxContents, target.name);
        if (!buildPhases.sourcesBuildPhaseId) { continue; }

        const absolutePath = path.join(rootPath, relativePath);

        // Resolve each sync root group's on-disk dir via the group tree; fall back to <targetDir>/<group.path> if it's not reachable as a child.
        const synchronizedRoots: string[] = [];
        for (const syncId of target.fileSystemSynchronizedGroupIds) {
            const dir = groupDirs.get(syncId);
            if (dir) {
                synchronizedRoots.push(dir);
            } else {
                const syncGroup = groups.get(syncId);
                if (syncGroup?.path) {
                    synchronizedRoots.push(path.join(absolutePath, syncGroup.path));
                }
            }
        }

        const groupId = resolveGroupForPath(groups, mainGroupId, relativePath);
        if (!groupId) { continue; }

        mappings.push({
            absolutePath,
            targetName: target.name,
            sourcesBuildPhaseId: buildPhases.sourcesBuildPhaseId,
            groupId,
            pbxprojPath,
            relativePath,
            synchronizedRoots
        });
    }

    return mappings;
}

/** Whether a file lives under one of the target's synchronized root groups, which Xcode 16+ auto-discovers — those must not get explicit pbxproj refs. */
export function isUnderSynchronizedRoot(filePath: string, mapping: TargetDirectoryMapping): boolean {
    return mapping.synchronizedRoots.some((dir) => filePath.startsWith(dir + path.sep));
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

// Serialize every pbxproj read-modify-write (watcher ops + reconcile) so they can't clobber each other; a failing op is isolated and never stalls the chain.
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const result = writeChain.then(op);
    writeChain = result.then(() => undefined, () => undefined);
    return result;
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
    const pendingOps = new Map<string, ReturnType<typeof setTimeout>>();

    function scheduleOperation(filePath: string, operation: () => Promise<void>): void {
        const existing = pendingOps.get(filePath);
        if (existing) { clearTimeout(existing); }

        pendingOps.set(filePath, setTimeout(() => {
            pendingOps.delete(filePath);
            enqueueWrite(async () => {
                try {
                    await operation();
                } catch (error) {
                    const message = (error as { message?: string }).message || String(error);
                    log(`[swift-sync] Error: ${message}`);
                }
            });
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

            // Files under a synchronized root group are auto-discovered by Xcode; others in the target still need adding.
            if (isUnderSynchronizedRoot(filePath, mapping)) {
                log(`[swift-sync] ${fileName} under synchronized group in ${mapping.targetName}, skipping`);
                return;
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

            // Skip if file not in pbxproj (covers files under synchronized groups, which have no PBXFileReference entry)
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

const RECONCILE_SKIP_DIRS = new Set(['build', 'DerivedData', 'Pods', 'Carthage', '.build', '.git', 'node_modules']);

async function walkSwiftFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || RECONCILE_SKIP_DIRS.has(entry.name) ||
                    entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcassets') ||
                    entry.name.endsWith('.bundle')) {
                    continue;
                }
                out.push(...await walkSwiftFiles(full));
            } else if (entry.isFile() && entry.name.endsWith('.swift')) {
                out.push(full);
            }
        }
    } catch {
        // Unreadable directory — skip it.
    }
    return out;
}

/** Catch-up scan that registers on-disk Swift files the live watcher missed (added while VS Code was closed, or by git/external tooling). Returns the count added. */
export async function reconcileSwiftFiles(
    rootPath: string,
    log: (message: string) => void
): Promise<number> {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) { return 0; }

    // Read pbxproj inside the lock so we pick up any adds the watcher just applied before computing what's missing.
    return enqueueWrite(async () => {
        let pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const mappings = buildTargetMappings(rootPath, pbxContents, pbxprojPath);
        if (mappings.length === 0) { return 0; }

        // Group tree is stable across file adds (no new groups created), so parse it once.
        const groups = parseGroups(pbxContents);
        const mainGroupId = findMainGroupId(pbxContents);
        if (!mainGroupId) { return 0; }

        // Assign each file to its most-specific (longest-prefix) target so nested-target files don't land in the enclosing target; dedup files reachable under multiple mappings.
        const seen = new Set<string>();
        const candidates: { filePath: string; fileName: string; mapping: TargetDirectoryMapping }[] = [];
        for (const mapping of mappings) {
            const files = await walkSwiftFiles(mapping.absolutePath);
            for (const filePath of files) {
                if (seen.has(filePath)) { continue; }
                seen.add(filePath);
                const owner = findMappingForFile(filePath, mappings) ?? mapping;
                if (isUnderSynchronizedRoot(filePath, owner)) { continue; }
                candidates.push({ filePath, fileName: path.basename(filePath), mapping: owner });
            }
        }

        let added = 0;
        for (const { filePath, fileName, mapping } of candidates) {
            // Re-check against the accumulating contents so we never double-add.
            if (findFileReferenceId(pbxContents, fileName)) { continue; }
            const groupId = resolveGroupForFile(filePath, mapping, groups, mainGroupId);
            if (!groupId) {
                log(`[swift-sync] reconcile: no PBXGroup for ${path.relative(rootPath, filePath)}, skipping`);
                continue;
            }
            pbxContents = addSwiftFileToPbxproj(pbxContents, fileName, groupId, mapping.sourcesBuildPhaseId);
            added++;
            log(`[swift-sync] reconcile: added ${fileName} to ${mapping.targetName}`);
        }

        if (added > 0) {
            await fsp.writeFile(pbxprojPath, pbxContents, 'utf8');
            log(`[swift-sync] reconcile: added ${added} file(s) to the project`);
        }
        return added;
    });
}
