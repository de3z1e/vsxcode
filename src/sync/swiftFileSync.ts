import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

import { buildFilesFor, groupForFolder, phasesOf, resolvedPath, stringValue, targetOfPhase } from '../parsers/projectIndex';
import type { ProjectIndex } from '../parsers/projectIndex';
import {
    addGroupPath,
    addSwiftFile,
    beginProjectEdit,
    rehomeSwiftFile,
    removeSwiftFile,
    setFileReferencePath
} from '../writers/pbxproj';
import type { ProjectEdit } from '../writers/pbxproj';
import {
    buildTargetMappings,
    canonicalPath,
    createBatchScheduler,
    enqueueWrite,
    findMappingForFile,
    findPbxprojPath,
    isFilteredPath,
    isUnderSynchronizedRoot,
    walkTargetDirectory
} from './pbxprojSync';
import type { TargetDirectoryMapping } from './pbxprojSync';

const LOG_PREFIX = '[swift-sync]';

/** A registered Swift file: a PBXFileReference whose `path` ends in `.swift`. */
interface SwiftReference {
    id: string;
    /** Where the reference points, spelled as the project records it. */
    recordedPath: string;
    /** The same place in on-disk form (canonicalPath), which files are matched by. */
    path: string;
    /** The reference's own `path` value. */
    ownPath: string;
    /** The file's name: the last component of `path`, not the display name. */
    fileName: string;
    exists: boolean;
}

/** One read of the project for a batch or a reconcile, and the edits made on it. */
interface SyncPass {
    root: string;
    index: ProjectIndex;
    edit: ProjectEdit;
    mappings: TargetDirectoryMapping[];
    references: SwiftReference[];
    byPath: Map<string, SwiftReference[]>;
    canonical: (target: string) => string;
    /** The deepest group created for a folder during the pass, by on-disk folder. */
    createdGroups: Map<string, string>;
    rehomed: Set<string>;
    log: (message: string) => void;
    groupFolders?: Set<string>;
    unregistered?: Promise<Map<string, string>>;
}

/** Reads the project once for a pass: its Swift references and target mappings, in on-disk form; null when unreadable. */
function openPass(root: string, pbxprojPath: string, contents: string, log: (message: string) => void): SyncPass | null {
    const edit = beginProjectEdit(contents);
    if (!edit) {
        log(`${LOG_PREFIX} ${path.basename(path.dirname(pbxprojPath))} can't be read, skipping`);
        return null;
    }
    const resolvedForms = new Map<string, string>();
    const canonical = (target: string): string => {
        let value = resolvedForms.get(target);
        if (value === undefined) {
            value = canonicalPath(target);
            resolvedForms.set(target, value);
        }
        return value;
    };

    const { index } = edit;
    const references: SwiftReference[] = [];
    const byPath = new Map<string, SwiftReference[]>();
    for (const { id, object } of index.objectsOfIsa('PBXFileReference')) {
        const ownPath = stringValue(object.path);
        const recordedPath = ownPath?.endsWith('.swift') ? resolvedPath(index, id, root) : undefined;
        if (ownPath === undefined || recordedPath === undefined) { continue; }
        const reference: SwiftReference = {
            id,
            recordedPath,
            path: canonical(recordedPath),
            ownPath,
            fileName: path.posix.basename(ownPath),
            exists: fs.existsSync(recordedPath)
        };
        references.push(reference);
        byPath.set(reference.path, [...(byPath.get(reference.path) ?? []), reference]);
    }

    const mappings = buildTargetMappings(root, contents, pbxprojPath).map((mapping) => ({
        ...mapping,
        absolutePath: canonical(mapping.absolutePath),
        synchronizedRoots: mapping.synchronizedRoots.map(canonical)
    }));
    return { root, index, edit, mappings, references, byPath, canonical, createdGroups: new Map(), rehomed: new Set(), log };
}

function relativeTo(pass: SyncPass, target: string): string {
    return path.relative(pass.root, target) || '.';
}

/** The folders PBXGroups resolve to, in on-disk form. */
function groupFolders(pass: SyncPass): Set<string> {
    if (!pass.groupFolders) {
        const folders = new Set<string>();
        for (const { id } of pass.index.objectsOfIsa('PBXGroup')) {
            const folder = resolvedPath(pass.index, id, pass.root);
            if (folder !== undefined) { folders.add(pass.canonical(folder)); }
        }
        pass.groupFolders = folders;
    }
    return pass.groupFolders;
}

/** Mapped target folders with their subfolders, and each folder a PBXGroup resolves to without its subfolders; never under a synchronized root or in a filtered folder. */
function isKnownPlace(pass: SyncPass, filePath: string): boolean {
    if (isFilteredPath(pass.root, filePath)) { return false; }
    if (pass.mappings.some((mapping) => isUnderSynchronizedRoot(filePath, mapping))) { return false; }
    return findMappingForFile(filePath, pass.mappings) !== null || groupFolders(pass).has(path.dirname(filePath));
}

/** The group for a folder: its own, one created earlier in the pass, or new groups under the deepest ancestor folder that has one. */
function destinationGroup(pass: SyncPass, folder: string): string | undefined {
    const missing: string[] = [];
    for (let current = folder; ; current = path.dirname(current)) {
        const group = pass.createdGroups.get(current) ?? groupForFolder(pass.index, current, pass.root, pass.canonical);
        if (group) {
            if (missing.length === 0) { return group; }
            const created = addGroupPath(pass.edit, group, missing);
            pass.createdGroups.set(folder, created);
            return created;
        }
        if (current === pass.root || path.dirname(current) === current) { return undefined; }
        missing.unshift(path.basename(current));
    }
}

/** Corrects a letter-case difference inside the reference's own `path`; one above it is left for repair. */
function fixLetterCase(pass: SyncPass, reference: SwiftReference): void {
    if (reference.recordedPath === reference.path) { return; }
    const recorded = reference.recordedPath.split(path.sep);
    const actual = reference.path.split(path.sep);
    const own = reference.ownPath.split('/').filter(Boolean);
    if (recorded.length !== actual.length || reference.recordedPath.toLowerCase() !== reference.path.toLowerCase() ||
        own.includes('..') || own.includes('.')) {
        return;
    }
    const firstOwn = recorded.length - own.length;
    const differing = recorded.map((part, position) => (part === actual[position] ? -1 : position)).filter((position) => position >= 0);
    if (differing.some((position) => position < firstOwn)) {
        pass.log(`${LOG_PREFIX} ${relativeTo(pass, reference.path)} differs from the project in letter case above its own path, leaving it`);
        return;
    }
    // An <absolute> path keeps its leading "/", which the split above left as an empty first part.
    const ownPath = actual.slice(firstOwn).join('/');
    setFileReferencePath(pass.edit, reference.id, reference.ownPath.startsWith('/') ? `/${ownPath}` : ownPath);
    pass.log(`${LOG_PREFIX} ${reference.fileName} renamed to ${path.basename(reference.path)}, updated its path`);
}

/** Decides a path that exists: registered (with a letter-case fix when needed), re-homed from one missing same-named entry, or added. */
function placePresentFile(pass: SyncPass, filePath: string): void {
    const registered = pass.byPath.get(filePath);
    if (registered) {
        for (const reference of registered) { fixLetterCase(pass, reference); }
        return;
    }
    if (!isKnownPlace(pass, filePath)) { return; }

    const fileName = path.basename(filePath);
    const stale = pass.references.filter((reference) =>
        !reference.exists && reference.fileName === fileName && !pass.rehomed.has(reference.id));
    if (stale.length > 1) {
        pass.log(`${LOG_PREFIX} ${relativeTo(pass, filePath)} matches ${stale.length} missing entries named ${fileName}, skipping`);
        return;
    }
    const mapping = findMappingForFile(filePath, pass.mappings);
    if (stale.length === 0 && !mapping) { return; }

    const folder = path.dirname(filePath);
    const groupId = destinationGroup(pass, folder);
    if (!groupId) {
        pass.log(`${LOG_PREFIX} No PBXGroup for ${relativeTo(pass, folder)}, skipping ${fileName}`);
        return;
    }
    if (stale.length === 1) {
        rehomeSwiftFile(pass.edit, stale[0].id, groupId, fileName);
        pass.rehomed.add(stale[0].id);
        pass.log(`${LOG_PREFIX} ${fileName} moved to ${relativeTo(pass, folder)}, re-homed its entry`);
    } else if (mapping) {
        addSwiftFile(pass.edit, fileName, groupId, mapping.sourcesBuildPhaseId);
        pass.log(`${LOG_PREFIX} Added ${fileName} to ${mapping.targetName}`);
    }
}

/** Every unregistered Swift file in a known place, by file name (the first found), walked at most once per pass. */
function unregisteredInKnownPlaces(pass: SyncPass): Promise<Map<string, string>> {
    if (!pass.unregistered) {
        pass.unregistered = (async () => {
            const found = new Map<string, string>();
            const consider = (candidate: string): void => {
                const filePath = pass.canonical(candidate);
                const fileName = path.basename(filePath);
                if (pass.byPath.has(filePath) || found.has(fileName) || !isKnownPlace(pass, filePath)) { return; }
                found.set(fileName, filePath);
            };
            for (const mapping of pass.mappings) {
                for (const filePath of await walkSwiftFiles(mapping.absolutePath)) { consider(filePath); }
            }
            for (const folder of groupFolders(pass)) {
                let entries: fs.Dirent[];
                try {
                    entries = await fsp.readdir(folder, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.swift')) { consider(path.join(folder, entry.name)); }
                }
            }
            return found;
        })();
    }
    return pass.unregistered;
}

/** Decides a path that is gone: its entries are removed, unless a same-named file in a known place is there to take them over. */
async function settleMissingFile(pass: SyncPass, filePath: string): Promise<void> {
    const registered = (pass.byPath.get(filePath) ?? []).filter((reference) => !pass.rehomed.has(reference.id));
    if (registered.length === 0) { return; }
    const fileName = path.basename(filePath);
    const elsewhere = (await unregisteredInKnownPlaces(pass)).get(fileName);
    if (elsewhere) {
        pass.log(`${LOG_PREFIX} ${relativeTo(pass, filePath)} is gone but ${fileName} exists in ${relativeTo(pass, path.dirname(elsewhere))}, keeping its entry`);
        return;
    }
    for (const reference of registered) { removeSwiftFile(pass.edit, reference.id); }
    pass.log(`${LOG_PREFIX} Removed ${fileName} from pbxproj`);
}

/** One batch of event paths, in on-disk form: existing paths are decided before missing ones, then the project is written once. */
async function syncBatch(root: string, pbxprojPath: string, paths: string[], log: (message: string) => void): Promise<void> {
    const contents = await fsp.readFile(pbxprojPath, 'utf8');
    const pass = openPass(root, pbxprojPath, contents, log);
    if (!pass) { return; }

    const unique = [...new Set(paths)];
    const present = unique.filter((filePath) => fs.existsSync(filePath));
    for (const filePath of present) {
        placePresentFile(pass, filePath);
    }
    for (const filePath of unique.filter((candidate) => !present.includes(candidate))) {
        await settleMissingFile(pass, filePath);
    }

    if (pass.edit.contents !== contents) {
        await fsp.writeFile(pbxprojPath, pass.edit.contents, 'utf8');
    }
}

export function createSwiftFileWatcher(
    rootPath: string,
    log: (message: string) => void
): vscode.Disposable[] {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) {
        log(`${LOG_PREFIX} No xcodeproj found, skipping Swift file watcher`);
        return [];
    }

    const root = canonicalPath(rootPath);
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.swift');
    const batches = createBatchScheduler(root, log, LOG_PREFIX, (paths) => syncBatch(root, pbxprojPath, paths, log));
    // A batch decides each path from disk, so the event kind isn't kept.
    const queue = (uri: vscode.Uri): void => batches.add(canonicalPath(uri.fsPath));
    const onCreate = watcher.onDidCreate(queue);
    const onDelete = watcher.onDidDelete(queue);

    log(`${LOG_PREFIX} Swift file watcher active`);
    return [watcher, onCreate, onDelete, batches];
}

function walkSwiftFiles(dir: string): Promise<string[]> {
    return walkTargetDirectory(dir, (name, isDirectory) => !isDirectory && name.endsWith('.swift'));
}

/** Whether a Swift entry named `fileName` whose file is missing is compiled by the target. */
function hasMissingEntryInTarget(pass: SyncPass, fileName: string, targetName: string): boolean {
    return pass.references.some((reference) => !reference.exists && reference.fileName === fileName &&
        buildFilesFor(pass.index, reference.id).some((buildFileId) => phasesOf(pass.index, buildFileId).some((phaseId) => {
            const targetId = targetOfPhase(pass.index, phaseId);
            return targetId !== undefined && stringValue(pass.index.object(targetId)?.name) === targetName;
        })));
}

/** Catch-up scan that registers on-disk Swift files the live watcher missed (added while VS Code was closed, or by git/external tooling), by path. Returns the count added. */
export async function reconcileSwiftFiles(
    rootPath: string,
    log: (message: string) => void
): Promise<number> {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) { return 0; }
    const root = canonicalPath(rootPath);

    // Read pbxproj inside the lock so we pick up any adds the watcher just applied before computing what's missing.
    return enqueueWrite(async () => {
        const contents = await fsp.readFile(pbxprojPath, 'utf8');
        const pass = openPass(root, pbxprojPath, contents, log);
        if (!pass || pass.mappings.length === 0) { return 0; }

        // Assign each file to its most-specific (longest-prefix) target so nested-target files don't land in the enclosing target; dedup files reachable under multiple mappings.
        const seen = new Set<string>();
        let added = 0;
        for (const mapping of pass.mappings) {
            for (const found of await walkSwiftFiles(mapping.absolutePath)) {
                const filePath = pass.canonical(found);
                if (seen.has(filePath) || pass.byPath.has(filePath)) { continue; }
                seen.add(filePath);
                const owner = findMappingForFile(filePath, pass.mappings) ?? mapping;
                if (isUnderSynchronizedRoot(filePath, owner)) { continue; }
                const fileName = path.basename(filePath);
                if (hasMissingEntryInTarget(pass, fileName, owner.targetName)) {
                    log(`${LOG_PREFIX} reconcile: ${relativeTo(pass, filePath)} shares its name with a missing ${owner.targetName} entry, leaving it`);
                    continue;
                }
                const groupId = destinationGroup(pass, path.dirname(filePath));
                if (!groupId) {
                    log(`${LOG_PREFIX} reconcile: no PBXGroup for ${relativeTo(pass, filePath)}, skipping`);
                    continue;
                }
                addSwiftFile(pass.edit, fileName, groupId, owner.sourcesBuildPhaseId);
                added++;
                log(`${LOG_PREFIX} reconcile: added ${fileName} to ${owner.targetName}`);
            }
        }

        if (added > 0) {
            await fsp.writeFile(pbxprojPath, pass.edit.contents, 'utf8');
            log(`${LOG_PREFIX} reconcile: added ${added} file(s) to the project`);
        }
        return added;
    });
}
