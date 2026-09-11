import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

import { buildFilesFor, groupForFolder, phasesOf, readProject, resolvedPath, stringValue, targetOfPhase } from '../parsers/projectIndex';
import type { ProjectIndex } from '../parsers/projectIndex';
import {
    addGroupPath,
    addSwiftFile,
    beginProjectEdit,
    rehomeSwiftFile,
    removeSwiftFile,
    renameSwiftFile,
    setFileReferencePath
} from '../writers/pbxproj';
import type { ProjectEdit } from '../writers/pbxproj';
import {
    buildTargetMappings,
    canonicalPath,
    createBatchScheduler,
    createOperationScheduler,
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

/** A file's identity on its volume: a rename keeps it, while a replace or a new file gets another. */
interface FileIdentity {
    dev: bigint;
    ino: bigint;
}

/** A registered file's identity, taken while the file existed. */
interface RecordedIdentity extends FileIdentity {
    /** The reference's `recordedPath` when taken; the entry counts only while the reference still records that place. */
    recordedPath: string;
    /** The same place in on-disk form, which change events are matched by. */
    path: string;
}

/** Identities of registered Swift files by reference id, kept by a watcher across batches. */
type Identities = Map<string, RecordedIdentity>;

/** A rename VS Code reported, both paths in on-disk form. */
interface Rename {
    from: string;
    to: string;
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
    identities: Identities;
    /** Identities statted during the pass, by on-disk path. */
    statted: Map<string, FileIdentity | undefined>;
    log: (message: string) => void;
    groupFolders?: Set<string>;
    synchronizedFolders?: string[];
    unregistered?: Promise<string[]>;
}

/** canonicalPath, remembered per path. */
function canonicalForms(): (target: string) => string {
    const forms = new Map<string, string>();
    return (target) => {
        let value = forms.get(target);
        if (value === undefined) {
            value = canonicalPath(target);
            forms.set(target, value);
        }
        return value;
    };
}

/** The project's registered Swift files, in recorded and on-disk form. */
function swiftReferences(index: ProjectIndex, root: string, canonical: (target: string) => string): SwiftReference[] {
    const references: SwiftReference[] = [];
    for (const { id, object } of index.objectsOfIsa('PBXFileReference')) {
        const ownPath = stringValue(object.path);
        const recordedPath = ownPath?.endsWith('.swift') ? resolvedPath(index, id, root) : undefined;
        if (ownPath === undefined || recordedPath === undefined) { continue; }
        references.push({
            id,
            recordedPath,
            path: canonical(recordedPath),
            ownPath,
            fileName: path.posix.basename(ownPath),
            exists: fs.existsSync(recordedPath)
        });
    }
    return references;
}

/** Reads the project once for a pass: its Swift references and target mappings, in on-disk form; null when unreadable. */
function openPass(
    root: string,
    pbxprojPath: string,
    contents: string,
    log: (message: string) => void,
    identities: Identities
): SyncPass | null {
    const edit = beginProjectEdit(contents);
    if (!edit) {
        log(`${LOG_PREFIX} ${path.basename(path.dirname(pbxprojPath))} can't be read, skipping`);
        return null;
    }
    const canonical = canonicalForms();

    const { index } = edit;
    const references = swiftReferences(index, root, canonical);
    const byPath = new Map<string, SwiftReference[]>();
    for (const reference of references) {
        byPath.set(reference.path, [...(byPath.get(reference.path) ?? []), reference]);
    }

    const mappings = buildTargetMappings(root, contents, pbxprojPath).map((mapping) => ({
        ...mapping,
        absolutePath: canonical(mapping.absolutePath),
        synchronizedRoots: mapping.synchronizedRoots.map(canonical)
    }));
    return {
        root, index, edit, mappings, references, byPath, canonical,
        createdGroups: new Map(), rehomed: new Set(), identities, statted: new Map(), log
    };
}

function relativeTo(pass: SyncPass, target: string): string {
    return path.relative(pass.root, target) || '.';
}

// ── File identities ──────────────────────────────────────

function identityOf(filePath: string): FileIdentity | undefined {
    try {
        const stats = fs.statSync(filePath, { bigint: true });
        return stats.isFile() ? { dev: stats.dev, ino: stats.ino } : undefined;
    } catch {
        return undefined;
    }
}

function sameFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
    return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

/** A path's identity, statted at most once per pass. */
function statOnce(pass: SyncPass, filePath: string): FileIdentity | undefined {
    if (!pass.statted.has(filePath)) { pass.statted.set(filePath, identityOf(filePath)); }
    return pass.statted.get(filePath);
}

/** A missing file's entry survives while its reference records the same place, so a rename whose events are pending stays pairable. */
function recordIdentities(identities: Identities, references: SwiftReference[]): void {
    const recorded: Identities = new Map();
    for (const reference of references) {
        const identity = reference.exists ? identityOf(reference.recordedPath) : undefined;
        const previous = identities.get(reference.id);
        if (identity) {
            recorded.set(reference.id, { ...identity, recordedPath: reference.recordedPath, path: reference.path });
        } else if (previous && previous.recordedPath === reference.recordedPath) {
            recorded.set(reference.id, previous);
        }
    }
    identities.clear();
    for (const [id, entry] of recorded) { identities.set(id, entry); }
}

/** Records identities from the project file as it is on disk; an unreadable project leaves them as they were. */
async function recordProjectIdentities(root: string, pbxprojPath: string, identities: Identities): Promise<void> {
    const index = readProject(await fsp.readFile(pbxprojPath, 'utf8'));
    if (typeof index === 'string') { return; }
    recordIdentities(identities, swiftReferences(index, root, canonicalForms()));
}

/** Retakes a registered file's identity: an atomic save arrives as a create and gives the path a new inode. */
function refreshIdentity(identities: Identities, reference: SwiftReference): void {
    const identity = identityOf(reference.recordedPath);
    if (identity) { identities.set(reference.id, { ...identity, recordedPath: reference.recordedPath, path: reference.path }); }
}

/** Retakes the identities recorded at a path, for a change event: VS Code folds a delete-then-create of one path into a change. */
function refreshIdentitiesAt(identities: Identities, filePath: string): void {
    for (const entry of identities.values()) {
        if (entry.path !== filePath) { continue; }
        const identity = identityOf(filePath);
        if (identity) {
            entry.dev = identity.dev;
            entry.ino = identity.ino;
        }
    }
}

// ── Places ───────────────────────────────────────────────

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

/** Whether a path is under a mapping's synchronized root or any PBXFileSystemSynchronizedRootGroup's folder, where an explicit entry would compile the file twice in that root's target. */
function isInSynchronizedFolder(pass: SyncPass, filePath: string): boolean {
    if (!pass.synchronizedFolders) {
        pass.synchronizedFolders = pass.index.objectsOfIsa('PBXFileSystemSynchronizedRootGroup')
            .map(({ id }) => resolvedPath(pass.index, id, pass.root))
            .filter((folder): folder is string => folder !== undefined)
            .map(pass.canonical);
    }
    return pass.mappings.some((mapping) => isUnderSynchronizedRoot(filePath, mapping)) ||
        pass.synchronizedFolders.some((folder) => filePath.startsWith(folder + path.sep));
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

/** Lists a reference under the path it now stands for, so the rest of the pass sees that path registered and its old one free. */
function relist(pass: SyncPass, reference: SwiftReference, destination: string, ownPath: string): void {
    const others = (pass.byPath.get(reference.path) ?? []).filter((other) => other !== reference);
    if (others.length > 0) { pass.byPath.set(reference.path, others); } else { pass.byPath.delete(reference.path); }
    Object.assign(reference, { recordedPath: destination, path: destination, ownPath, fileName: path.basename(destination), exists: true });
    pass.byPath.set(destination, [...(pass.byPath.get(destination) ?? []), reference]);
}

// ── Decisions ────────────────────────────────────────────

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

/** Moves references whose file is gone to the file's new path, keeping their ids, build files and settings: renamed in place within the same folder, re-homed into the destination's group otherwise. */
function moveReferences(pass: SyncPass, references: SwiftReference[], destination: string): void {
    const fileName = path.basename(destination);
    const folder = path.dirname(destination);
    for (const reference of references) {
        const oldName = reference.fileName;
        if (path.dirname(reference.path) === folder) {
            renameSwiftFile(pass.edit, reference.id, fileName);
            pass.rehomed.add(reference.id);
            relist(pass, reference, destination, [...reference.ownPath.split('/').slice(0, -1), fileName].join('/'));
            pass.log(`${LOG_PREFIX} ${oldName} renamed to ${fileName}, kept its entry`);
            continue;
        }
        const groupId = destinationGroup(pass, folder);
        if (!groupId) {
            pass.log(`${LOG_PREFIX} No PBXGroup for ${relativeTo(pass, folder)}, leaving ${oldName} to the name rules`);
            continue;
        }
        rehomeSwiftFile(pass.edit, reference.id, groupId, fileName);
        pass.rehomed.add(reference.id);
        relist(pass, reference, destination, fileName);
        pass.log(`${LOG_PREFIX} ${oldName} moved to ${relativeTo(pass, folder)}${oldName === fileName ? '' : ` as ${fileName}`}, kept its entry`);
    }
}

/** Whether a path can take over a gone file's entry: an existing Swift file that isn't registered and isn't under a synchronized root. */
function pairableDestination(pass: SyncPass, filePath: string): boolean {
    return filePath.endsWith('.swift') && !pass.byPath.has(filePath) && fs.existsSync(filePath) && !isInSynchronizedFolder(pass, filePath);
}

/** Registered references whose file is gone and whose recorded identity is `identity`. */
function missingReferencesWith(pass: SyncPass, identity: FileIdentity | undefined): SwiftReference[] {
    return pass.references.filter((reference) => {
        if (reference.exists || pass.rehomed.has(reference.id)) { return false; }
        const recorded = pass.identities.get(reference.id);
        return recorded !== undefined && recorded.recordedPath === reference.recordedPath && sameFile(recorded, identity);
    });
}

/** VS Code's renames pair exactly: the references at the old path whose file is gone follow it to the new one. */
function followRenames(pass: SyncPass, renames: Rename[]): void {
    for (const { from, to } of renames) {
        if (!pairableDestination(pass, to)) { continue; }
        const moving = (pass.byPath.get(from) ?? []).filter((reference) => !reference.exists && !pass.rehomed.has(reference.id));
        if (moving.length > 0) { moveReferences(pass, moving, to); }
    }
}

/** Pairs the batch's unregistered paths with gone registered files by identity, which a rename keeps. Paths sharing one identity (hard links) are skipped. */
function pairByIdentity(pass: SyncPass, present: string[]): void {
    const pathsByIdentity = new Map<string, string[]>();
    for (const filePath of present.filter((candidate) => pairableDestination(pass, candidate))) {
        const identity = statOnce(pass, filePath);
        if (!identity) { continue; }
        const key = `${identity.dev}:${identity.ino}`;
        pathsByIdentity.set(key, [...(pathsByIdentity.get(key) ?? []), filePath]);
    }
    for (const paths of pathsByIdentity.values()) {
        const moving = missingReferencesWith(pass, statOnce(pass, paths[0]));
        if (moving.length === 0) { continue; }
        if (paths.length > 1) {
            pass.log(`${LOG_PREFIX} ${paths.map((filePath) => relativeTo(pass, filePath)).join(' and ')} are one file, leaving ${moving[0].fileName} to the name rules`);
            continue;
        }
        moveReferences(pass, moving, paths[0]);
    }
}

/** Decides a path that exists: registered (with a letter-case fix when needed), re-homed from one missing same-named entry, or added. */
function placePresentFile(pass: SyncPass, filePath: string): void {
    const registered = pass.byPath.get(filePath);
    if (registered) {
        for (const reference of registered) {
            fixLetterCase(pass, reference);
            if (!pass.rehomed.has(reference.id)) { refreshIdentity(pass.identities, reference); }
        }
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
        relist(pass, stale[0], filePath, fileName);
        pass.log(`${LOG_PREFIX} ${fileName} moved to ${relativeTo(pass, folder)}, re-homed its entry`);
    } else if (mapping) {
        const id = addSwiftFile(pass.edit, fileName, groupId, mapping.sourcesBuildPhaseId);
        const added: SwiftReference = { id, recordedPath: filePath, path: filePath, ownPath: fileName, fileName, exists: true };
        pass.references.push(added);
        pass.byPath.set(filePath, [added]);
        pass.log(`${LOG_PREFIX} Added ${fileName} to ${mapping.targetName}`);
    }
}

/** Every Swift file that was unregistered in a known place when walked, at most once per pass; callers skip files registered since. */
function unregisteredInKnownPlaces(pass: SyncPass): Promise<string[]> {
    if (!pass.unregistered) {
        pass.unregistered = (async () => {
            const found = new Set<string>();
            const consider = (candidate: string): void => {
                const filePath = pass.canonical(candidate);
                if (!pass.byPath.has(filePath) && isKnownPlace(pass, filePath)) { found.add(filePath); }
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
            return [...found];
        })();
    }
    return pass.unregistered;
}

/** Decides a path that is gone: its entries follow the file when it is found elsewhere by identity, stay while a same-named file in a known place can take them over, and are removed otherwise. */
async function settleMissingFile(pass: SyncPass, filePath: string): Promise<void> {
    const waiting = (): SwiftReference[] => (pass.byPath.get(filePath) ?? []).filter((reference) => !pass.rehomed.has(reference.id));
    if (waiting().length === 0) { return; }
    const walked = await unregisteredInKnownPlaces(pass);
    const unregistered = (): string[] => walked.filter((candidate) => !pass.byPath.has(candidate));

    // A rename whose create comes in a later batch: the file already sits at its new path, with the identity it had.
    for (const reference of waiting()) {
        const recorded = pass.identities.get(reference.id);
        if (!recorded || recorded.recordedPath !== reference.recordedPath || pass.rehomed.has(reference.id)) { continue; }
        const matches = unregistered().filter((candidate) => sameFile(statOnce(pass, candidate), recorded) && !isInSynchronizedFolder(pass, candidate));
        if (matches.length === 1) {
            moveReferences(pass, missingReferencesWith(pass, recorded), matches[0]);
        } else if (matches.length > 1) {
            pass.log(`${LOG_PREFIX} ${matches.length} files have ${reference.fileName}'s identity, leaving it to the name rules`);
        }
    }
    const remaining = waiting();
    if (remaining.length === 0) { return; }

    const fileName = path.basename(filePath);
    const elsewhere = unregistered().find((candidate) => path.basename(candidate) === fileName);
    if (elsewhere) {
        pass.log(`${LOG_PREFIX} ${relativeTo(pass, filePath)} is gone but ${fileName} exists in ${relativeTo(pass, path.dirname(elsewhere))}, keeping its entry`);
        return;
    }
    for (const reference of remaining) { removeSwiftFile(pass.edit, reference.id); }
    pass.log(`${LOG_PREFIX} Removed ${fileName} from pbxproj`);
}

/** One batch of paths in on-disk form, plus the renames VS Code reported for them; pairs are decided before existing paths, existing before missing, with one write. */
async function syncBatch(
    root: string,
    pbxprojPath: string,
    paths: string[],
    log: (message: string) => void,
    identities: Identities,
    renames: Rename[] = []
): Promise<void> {
    const contents = await fsp.readFile(pbxprojPath, 'utf8');
    const pass = openPass(root, pbxprojPath, contents, log, identities);
    if (!pass) { return; }

    const unique = [...new Set(paths)];
    const present = unique.filter((filePath) => fs.existsSync(filePath));
    followRenames(pass, renames);
    pairByIdentity(pass, present);
    for (const filePath of present) {
        placePresentFile(pass, filePath);
    }
    for (const filePath of unique.filter((candidate) => !present.includes(candidate))) {
        await settleMissingFile(pass, filePath);
    }

    if (pass.edit.contents !== contents) {
        await fsp.writeFile(pbxprojPath, pass.edit.contents, 'utf8');
        const written = readProject(pass.edit.contents);
        if (typeof written !== 'string') { recordIdentities(identities, swiftReferences(written, root, pass.canonical)); }
    }
}

/** Runs a job on the shared write queue and logs its failure, since nothing awaits it and enqueueWrite hands a rejection to its caller. */
function queueLogged(log: (message: string) => void, job: () => Promise<void>): void {
    enqueueWrite(async () => {
        try {
            await job();
        } catch (error) {
            const message = (error as { message?: string }).message || String(error);
            log(`${LOG_PREFIX} Error: ${message}`);
        }
    });
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
    const identities: Identities = new Map();
    queueLogged(log, () => recordProjectIdentities(root, pbxprojPath, identities));

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.swift');
    const batches = createBatchScheduler(root, log, LOG_PREFIX, (paths) => syncBatch(root, pbxprojPath, paths, log, identities));
    // A batch decides each path from disk, so the event kind isn't kept.
    const queue = (uri: vscode.Uri): void => batches.add(canonicalPath(uri.fsPath));
    const onCreate = watcher.onDidCreate(queue);
    const onDelete = watcher.onDidDelete(queue);
    // An edit in place keeps the inode; only a replace folded into a change needs its identity taken again.
    const onChange = watcher.onDidChange((uri) => refreshIdentitiesAt(identities, canonicalPath(uri.fsPath)));

    // Renames made in the editor pair exactly and run at once; the watcher's events for them arrive later and find nothing to do.
    const onRename = vscode.workspace.onDidRenameFiles((event) => {
        const reported = event.files
            .map(({ oldUri, newUri }) => ({ from: canonicalPath(oldUri.fsPath), to: canonicalPath(newUri.fsPath) }))
            .filter(({ from, to }) => from.endsWith('.swift') && to.endsWith('.swift') &&
                !isFilteredPath(root, from) && !isFilteredPath(root, to));
        if (reported.length === 0) { return; }
        // A letter-case rename maps both paths to one on-disk path, which the batch's case fix handles without a pair.
        const renames = reported.filter(({ from, to }) => from !== to);
        const paths = reported.flatMap(({ from, to }) => [from, to]);
        queueLogged(log, () => syncBatch(root, pbxprojPath, paths, log, identities, renames));
    });

    // Entries registered from outside (Xcode, git) get their identities shortly after the project file changes.
    const projectFile = canonicalPath(pbxprojPath);
    const records = createOperationScheduler(log, LOG_PREFIX);
    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.pbxproj');
    const onProjectEvent = (uri: vscode.Uri): void => {
        if (canonicalPath(uri.fsPath) === projectFile) {
            records.schedule(projectFile, () => recordProjectIdentities(root, pbxprojPath, identities));
        }
    };
    const onProjectChange = projectWatcher.onDidChange(onProjectEvent);
    const onProjectCreate = projectWatcher.onDidCreate(onProjectEvent);

    log(`${LOG_PREFIX} Swift file watcher active`);
    return [watcher, onCreate, onDelete, onChange, onRename, batches, projectWatcher, onProjectChange, onProjectCreate, records];
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
        const pass = openPass(root, pbxprojPath, contents, log, new Map());
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
