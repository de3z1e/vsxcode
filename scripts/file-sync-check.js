#!/usr/bin/env node
/**
 * File-sync regression check.
 *
 * Runs the compiled Swift and Core Data sync watchers (out/sync/) in plain Node with `vscode` stubbed. Each scenario
 * lays the fixture project and its sources out in a fresh temp directory, applies real filesystem operations, fires the
 * watcher and rename events VS Code would deliver (a folder's own events for a folder rename, never its contents'), and
 * reads the resulting project through plutil rather than the parsers under test. The entries a scenario names must change
 * as stated; every other Swift file reference and Core Data model must come out unchanged, ids included, nothing else may
 * join a Sources phase, and the project must still lint.
 *
 * VS Code's extension host dispatches a batch's creates before its deletes, so creates-first is the default event
 * order; reversed and duplicated deliveries are scenarios of their own.
 *
 * Usage: npm run test:file-sync
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'file-sync');
const PROJECT_TEXT = fs.readFileSync(path.join(FIXTURE_DIR, 'FixtureApp.pbxproj.txt'), 'utf8');
const SOURCES = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'sources.json'), 'utf8')).files;

// Past the 300 ms Swift batch quiet window and Core Data debounce in src/sync/pbxprojSync.ts (not exported).
const SETTLE_MS = 500;

// ── vscode stub ──────────────────────────────────────────────────────────────────────
// The sync modules touch vscode only through workspace.createFileSystemWatcher and workspace.onDidRenameFiles.

const watchers = new Set();
const renameListeners = new Set();

const vscodeStub = {
    workspace: {
        onDidRenameFiles(listener) {
            renameListeners.add(listener);
            return { dispose: () => renameListeners.delete(listener) };
        },
        createFileSystemWatcher(glob) {
            const pattern = /^\*\*\/\*([^*/]*)$/.exec(glob);
            if (!pattern) { throw new Error(`the vscode stub routes only **/*<suffix> globs, not ${glob}`); }
            const listeners = { create: new Set(), change: new Set(), delete: new Set() };
            const subscribe = (kind) => (listener) => {
                listeners[kind].add(listener);
                return { dispose: () => listeners[kind].delete(listener) };
            };
            const watcher = {
                suffix: pattern[1],
                listeners,
                onDidCreate: subscribe('create'),
                onDidChange: subscribe('change'),
                onDidDelete: subscribe('delete'),
                dispose: () => watchers.delete(watcher)
            };
            watchers.add(watcher);
            return watcher;
        }
    }
};

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? 'vscode' : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

// Writers draw object ids from crypto.randomBytes; a per-scenario counter makes a failure reproduce exactly.
let idCounter = 0;
crypto.randomBytes = (size) => {
    const buffer = Buffer.alloc(size);
    buffer[0] = 0x80;
    buffer.writeUInt32BE(++idCounter, size - 4);
    return buffer;
};

const load = (relative) => require(path.join(OUT, relative));
const { createSwiftFileWatcher, reconcileSwiftFiles } = load('sync/swiftFileSync.js');
const { createDataModelWatcher, reconcileDataModels } = load('sync/dataModelSync.js');
const { enqueueWrite } = load('sync/pbxprojSync.js');

// ── Reading a project ────────────────────────────────────────────────────────────────

const projectPath = (root) => path.join(root, 'FixtureApp.xcodeproj', 'project.pbxproj');

function plutil(args, input) {
    return execFileSync('/usr/bin/plutil', args, { input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function lints(text) {
    try {
        plutil(['-lint', '-'], text);
        return true;
    } catch {
        return false;
    }
}

function canonical(value) {
    if (Array.isArray(value)) { return value.map(canonical); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const show = (value) => (value === undefined ? '(absent)' : JSON.stringify(canonical(value)));

/** Swift file references and XCVersionGroups keyed by Xcode-resolved path, plus dangling Sources entries, Sources entries for anything else, repeated group children, and folders several own-path groups resolve to. */
function readState(text) {
    const { objects, rootObject } = JSON.parse(plutil(['-convert', 'json', '-o', '-', '-'], text));
    const parentOf = new Map();
    // A path resolves through one parent, so a second listing would otherwise leave no trace.
    const duplicateChildren = [];
    for (const [id, object] of Object.entries(objects)) {
        for (const childId of object.children || []) {
            if (parentOf.has(childId)) {
                duplicateChildren.push(`${childId} listed by ${parentOf.get(childId)} and ${id}`);
            } else {
                parentOf.set(childId, id);
            }
        }
    }
    const mainGroupId = objects[rootObject].mainGroup;
    const join = (base, own) => {
        const joined = path.posix.join(base || '.', own || '.');
        return joined === '.' ? '' : joined;
    };
    const resolve = (id, depth = 0) => {
        const object = objects[id];
        if (id === mainGroupId || object.sourceTree === 'SOURCE_ROOT') { return join('', object.path); }
        if (object.sourceTree !== '<group>' || !parentOf.has(id) || depth > 64) { return null; }
        const parent = resolve(parentOf.get(id), depth + 1);
        return parent === null ? null : join(parent, object.path);
    };

    const compiledBy = new Map();
    const dangling = [];
    // A Sources entry for anything but a Swift file or a Core Data model, which a folder mistaken for a file would produce.
    const otherSources = [];
    for (const target of Object.values(objects)) {
        if (target.isa !== 'PBXNativeTarget') { continue; }
        for (const phaseId of target.buildPhases || []) {
            if (!objects[phaseId] || objects[phaseId].isa !== 'PBXSourcesBuildPhase') { continue; }
            for (const buildFileId of objects[phaseId].files || []) {
                const buildFile = objects[buildFileId];
                if (!buildFile || (buildFile.fileRef && !objects[buildFile.fileRef])) {
                    dangling.push(`${target.name} Sources entry ${buildFileId}`);
                    continue;
                }
                if (!buildFile.fileRef) { continue; }
                const file = objects[buildFile.fileRef];
                if (!(file.isa === 'PBXFileReference' && /\.swift$/.test(file.path || '')) && file.isa !== 'XCVersionGroup') {
                    otherSources.push(`${target.name} compiles ${file.isa} ${file.path || file.name || buildFile.fileRef}`);
                }
                const membership = buildFile.settings ? `${target.name} ${JSON.stringify(buildFile.settings)}` : target.name;
                compiledBy.set(buildFile.fileRef, [...(compiledBy.get(buildFile.fileRef) || []), membership]);
            }
        }
    }

    const swift = {};
    const models = {};
    const record = (table, id, details) => {
        const resolved = resolve(id);
        const key = resolved === null ? `(unresolved ${id}) ${objects[id].path}` : resolved;
        const entry = { ids: [id], ...details, targets: (compiledBy.get(id) || []).sort() };
        if (table[key]) {
            entry.ids = [...table[key].ids, id].sort();
            entry.targets = [...table[key].targets, ...entry.targets].sort();
        }
        table[key] = entry;
    };
    const versionPath = (id) => (objects[id] ? objects[id].path : `(missing ${id})`);
    const groupsByFolder = new Map();
    for (const [id, object] of Object.entries(objects)) {
        if (object.isa === 'PBXFileReference' && /\.swift$/.test(object.path || '')) {
            record(swift, id, {});
        } else if (object.isa === 'XCVersionGroup') {
            record(models, id, {
                versions: (object.children || []).map(versionPath).sort(),
                current: object.currentVersion ? versionPath(object.currentVersion) : null
            });
        } else if (object.isa === 'PBXGroup' && object.path) {
            const folder = resolve(id);
            const key = folder === null ? `(unresolved ${id})` : folder;
            groupsByFolder.set(key, (groupsByFolder.get(key) || 0) + 1);
        }
    }
    return {
        swift,
        models,
        dangling: dangling.sort(),
        otherSources: otherSources.sort(),
        duplicateChildren: duplicateChildren.sort(),
        duplicateGroupFolders: [...groupsByFolder].filter(([, count]) => count > 1).map(([folder, count]) => `${folder} (${count} groups)`).sort(),
        ids: new Set(Object.keys(objects))
    };
}

// ── Expectations ─────────────────────────────────────────────────────────────────────

// Id placeholders for entries a scenario creates or re-registers.
const NEW_ID = 'one id that was not in the project before';
const ANY_ID = 'one id';
// A fixture id (`AA`, 18 zeros, suffix), for entries that must keep theirs.
const fixtureId = (suffix) => `AA${'0'.repeat(18)}${suffix}`;
// The nth id a scenario draws from the pinned crypto.randomBytes.
const pinnedId = (n) => `80${'0'.repeat(14)}${n.toString(16).toUpperCase().padStart(8, '0')}`;

function entryMatches(actual, expected, idsBefore) {
    if (!actual || !expected) { return actual === expected; }
    const { ids: actualIds, ...actualDetails } = actual;
    const { ids: expectedIds, ...expectedDetails } = expected;
    if (!same(actualDetails, expectedDetails)) { return false; }
    if (expectedIds === NEW_ID) { return actualIds.length === 1 && !idsBefore.has(actualIds[0]); }
    if (expectedIds === ANY_ID) { return actualIds.length === 1; }
    return same(actualIds, expectedIds);
}

function withChanges(state, changes) {
    const next = {
        swift: { ...state.swift },
        models: { ...state.models },
        dangling: state.dangling,
        otherSources: state.otherSources,
        duplicateChildren: state.duplicateChildren,
        duplicateGroupFolders: state.duplicateGroupFolders
    };
    for (const section of ['swift', 'models']) {
        for (const [key, entry] of Object.entries(changes[section] || {})) {
            if (entry === null) { delete next[section][key]; } else { next[section][key] = entry; }
        }
    }
    return next;
}

function stateProblems(actual, expected, idsBefore) {
    const problems = [];
    for (const section of ['swift', 'models']) {
        const keys = new Set([...Object.keys(actual[section]), ...Object.keys(expected[section])]);
        for (const key of [...keys].sort()) {
            if (!entryMatches(actual[section][key], expected[section][key], idsBefore)) {
                problems.push(`${section} ${key}\n            expected: ${show(expected[section][key])}\n            actual:   ${show(actual[section][key])}`);
            }
        }
    }
    for (const [list, label] of [
        ['dangling', 'dangling Sources entries'],
        ['otherSources', 'Sources entries for anything but Swift files and Core Data models'],
        ['duplicateChildren', 'elements listed as a child more than once'],
        ['duplicateGroupFolders', 'folders more than one group with its own path resolves to']
    ]) {
        if (!same(actual[list], expected[list])) {
            problems.push(`${label}\n            expected: ${show(expected[list])}\n            actual:   ${show(actual[list])}`);
        }
    }
    return problems;
}

// ── Fixture baseline ─────────────────────────────────────────────────────────────────
// Written out so a mistake in the oracle's path resolution fails here instead of passing every scenario vacuously.

const BASELINE_SWIFT = {
    'MyApp/Helpers.swift': ['MyApp'],
    'MyApp/Models/Model.swift': ['MyApp'],
    'MyApp/Services/Service.swift': ['MyApp'],
    'MyApp/Views/Bar.swift': ['MyApp'],
    'MyApp/Views/ContentView.swift': ['MyApp'],
    'MyApp/Views/Rename.swift': ['MyApp'],
    'MyKit/Constants.swift': ['MyKit'],
    'MyKit/Helpers.swift': ['MyKit'],
    'Shared/SharedUtil.swift': ['MyApp', 'MyKit {"COMPILER_FLAGS":"-DSHARED_UTIL"}']
};
const STORE = 'MyApp/Models/Store.xcdatamodeld';
const BASELINE_MODELS = {
    [STORE]: { versions: ['Store.xcdatamodel'], current: 'Store.xcdatamodel', targets: ['MyApp'] }
};

function baselineProblems() {
    const expected = {
        swift: Object.fromEntries(Object.entries(BASELINE_SWIFT).map(([key, targets]) => [key, { ids: ANY_ID, targets }])),
        models: Object.fromEntries(Object.entries(BASELINE_MODELS).map(([key, entry]) => [key, { ids: ANY_ID, ...entry }])),
        dangling: [],
        otherSources: [],
        duplicateChildren: [],
        duplicateGroupFolders: []
    };
    const problems = stateProblems(readState(PROJECT_TEXT), expected, new Set());
    for (const file of [...Object.keys(BASELINE_SWIFT), `${STORE}/.xccurrentversion`, `${STORE}/Store.xcdatamodel/contents`]) {
        if (!(file in SOURCES)) { problems.push(`sources.json has no ${file}`); }
    }
    return problems;
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deliver(kind, fsPath) {
    let delivered = 0;
    for (const watcher of watchers) {
        if (!fsPath.endsWith(watcher.suffix)) { continue; }
        for (const listener of watcher.listeners[kind]) {
            listener({ fsPath });
            delivered++;
        }
    }
    if (delivered === 0) { throw new Error(`no watcher listens for the ${kind} of ${fsPath}`); }
}

function deliverRename(from, to) {
    if (renameListeners.size === 0) { throw new Error(`nothing listens for the rename of ${from}`); }
    for (const listener of renameListeners) {
        listener({ files: [{ oldUri: { fsPath: from }, newUri: { fsPath: to } }] });
    }
}

function scenarioContext(root, log) {
    const at = (relative) => path.join(root, relative);
    const write = (relative, contents) => {
        fs.mkdirSync(path.dirname(at(relative)), { recursive: true });
        fs.writeFileSync(at(relative), contents);
    };
    const context = {
        root,
        log,
        lastEventAt: null,
        write,
        move: (from, to) => {
            fs.mkdirSync(path.dirname(at(to)), { recursive: true });
            fs.renameSync(at(from), at(to));
        },
        remove: (relative) => fs.rmSync(at(relative), { recursive: true }),
        wait: sleep,
        projectText: () => fs.readFileSync(projectPath(root), 'utf8'),
        writeModel: (bundle, versionName) => {
            write(`${bundle}/.xccurrentversion`, SOURCES[`${STORE}/.xccurrentversion`].replace('Store.xcdatamodel', versionName));
            write(`${bundle}/${versionName}/contents`, SOURCES[`${STORE}/Store.xcdatamodel/contents`]);
        },
        fire: (kind, relative) => {
            deliver(kind, at(relative));
            context.lastEventAt = Date.now();
        },
        fireRename: (from, to) => {
            deliverRename(at(from), at(to));
            context.lastEventAt = Date.now();
        }
    };
    return context;
}

const moveModel = (s, from, to, order) => {
    s.move(from, to);
    if (order === 'creates first') {
        s.fire('create', to);
        s.fire('delete', from);
    } else {
        s.fire('delete', from);
        s.fire('create', to);
    }
};

const EVENT_ORDERS = ['creates first', 'deletes first', 'events twice'];

/** A file or folder moved on disk, then its own events (a folder's contents get none): creates first, deletes first, or creates-first delivered twice 100 ms apart. */
const moveEntry = async (s, from, to, order) => {
    s.move(from, to);
    const fire = () => {
        if (order === 'deletes first') {
            s.fire('delete', from);
            s.fire('create', to);
        } else {
            s.fire('create', to);
            s.fire('delete', from);
        }
    };
    fire();
    if (order === 'events twice') {
        await s.wait(100);
        fire();
    }
};

// Rename.swift's entry, AA…0113, following its file to Renamed.swift in the same folder.
const RENAME_KEPT = { swift: { 'MyApp/Views/Rename.swift': null, 'MyApp/Views/Renamed.swift': { ids: [fixtureId('0113')], targets: ['MyApp'] } } };

/** Rewrites the project text for a shape the fixture lacks, then lets the watcher record identities from it, as a project-file change would. */
const rewriteProject = async (s, transform) => {
    fs.writeFileSync(projectPath(s.root), transform(s.projectText()));
    s.fire('change', 'FixtureApp.xcodeproj/project.pbxproj');
    await s.wait(500);
};

/** Bar.swift listed in the MyApp group under a two-component path, the shape Xcode writes for a file outside its group's folder. */
const barUnderMyApp = (text) => text
    .replace('\t\t\t\tAA0000000000000000000112 /* Bar.swift */,\n', '')
    .replace('\t\t\t\tAA0000000000000000000110 /* Helpers.swift */,\n',
        '\t\t\t\tAA0000000000000000000110 /* Helpers.swift */,\n\t\t\t\tAA0000000000000000000112 /* Bar.swift */,\n')
    .replace('path = Bar.swift; sourceTree = "<group>";', 'name = Bar.swift; path = Views/Bar.swift; sourceTree = "<group>";');

/** The Views entries, AA…0111–AA…0113, keyed under another folder. */
const viewsUnder = (folder) => ({
    'MyApp/Views/Bar.swift': null,
    'MyApp/Views/ContentView.swift': null,
    'MyApp/Views/Rename.swift': null,
    [`${folder}/Bar.swift`]: { ids: [fixtureId('0112')], targets: ['MyApp'] },
    [`${folder}/ContentView.swift`]: { ids: [fixtureId('0111')], targets: ['MyApp'] },
    [`${folder}/Rename.swift`]: { ids: [fixtureId('0113')], targets: ['MyApp'] }
});

const SCENARIOS = [
    {
        name: 'new Swift file in a target subfolder',
        run: (s) => {
            s.write('MyApp/Views/NewView.swift', 'struct NewView {}\n');
            s.fire('create', 'MyApp/Views/NewView.swift');
        },
        changes: { swift: { 'MyApp/Views/NewView.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'new Swift file, create delivered twice 100 ms apart',
        run: async (s) => {
            s.write('MyApp/Views/NewView.swift', 'struct NewView {}\n');
            s.fire('create', 'MyApp/Views/NewView.swift');
            await s.wait(100);
            s.fire('create', 'MyApp/Views/NewView.swift');
        },
        changes: { swift: { 'MyApp/Views/NewView.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'uniquely named Swift file deleted',
        run: (s) => {
            s.remove('MyApp/Views/Bar.swift');
            s.fire('delete', 'MyApp/Views/Bar.swift');
        },
        changes: { swift: { 'MyApp/Views/Bar.swift': null } }
    },
    {
        name: 'Swift file compiled by two targets deleted',
        run: (s) => {
            s.remove('Shared/SharedUtil.swift');
            s.fire('delete', 'Shared/SharedUtil.swift');
        },
        // Both build files and both Sources entries go with the reference, so nothing dangles.
        changes: { swift: { 'Shared/SharedUtil.swift': null } }
    },
    ...EVENT_ORDERS.map((order) => ({
        name: `Swift file renamed in its folder (S2), ${order}`,
        run: (s) => moveEntry(s, 'MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift', order),
        changes: RENAME_KEPT
    })),
    ...EVENT_ORDERS.map((order) => ({
        name: `Swift file moved to another folder (S1), ${order}`,
        run: (s) => moveEntry(s, 'MyApp/Views/Bar.swift', 'MyApp/Models/Bar.swift', order),
        changes: { swift: { 'MyApp/Views/Bar.swift': null, 'MyApp/Models/Bar.swift': { ids: [fixtureId('0112')], targets: ['MyApp'] } } }
    })),
    {
        name: 'Swift file moved to another folder (S1), create 500 ms after the delete',
        run: async (s) => {
            s.move('MyApp/Views/Bar.swift', 'MyApp/Models/Bar.swift');
            s.fire('delete', 'MyApp/Views/Bar.swift');
            await s.wait(500);
            s.fire('create', 'MyApp/Models/Bar.swift');
        },
        changes: { swift: { 'MyApp/Views/Bar.swift': null, 'MyApp/Models/Bar.swift': { ids: [fixtureId('0112')], targets: ['MyApp'] } } }
    },
    ...EVENT_ORDERS.map((order) => ({
        name: `Swift file renamed to a name another target uses (S3), ${order}`,
        run: (s) => moveEntry(s, 'MyApp/Views/Rename.swift', 'MyApp/Views/Constants.swift', order),
        changes: { swift: { 'MyApp/Views/Rename.swift': null, 'MyApp/Views/Constants.swift': { ids: [fixtureId('0113')], targets: ['MyApp'] } } }
    })),
    ...['once', 'twice'].map((times) => ({
        name: `one target's same-named Swift file deleted (S4), delete delivered ${times}`,
        run: async (s) => {
            s.remove('MyKit/Helpers.swift');
            s.fire('delete', 'MyKit/Helpers.swift');
            if (times === 'twice') {
                await s.wait(100);
                s.fire('delete', 'MyKit/Helpers.swift');
            }
        },
        changes: { swift: { 'MyKit/Helpers.swift': null } }
    })),
    ...EVENT_ORDERS.map((order) => ({
        name: `Swift file moved while another target has its name (S7), ${order}`,
        run: (s) => moveEntry(s, 'MyApp/Helpers.swift', 'MyApp/Services/Helpers.swift', order),
        changes: { swift: { 'MyApp/Helpers.swift': null, 'MyApp/Services/Helpers.swift': { ids: [fixtureId('0110')], targets: ['MyApp'] } } }
    })),
    {
        name: 'Swift file moved into new folders, groups created',
        run: (s) => moveEntry(s, 'MyApp/Views/ContentView.swift', 'MyApp/Features/Home/ContentView.swift', 'creates first'),
        changes: {
            swift: {
                'MyApp/Views/ContentView.swift': null,
                'MyApp/Features/Home/ContentView.swift': { ids: [fixtureId('0111')], targets: ['MyApp'] }
            }
        }
    },
    {
        name: 'new Swift file in a folder with no group',
        run: (s) => {
            s.write('MyApp/Features/NewFeature.swift', 'struct NewFeature {}\n');
            s.fire('create', 'MyApp/Features/NewFeature.swift');
        },
        changes: { swift: { 'MyApp/Features/NewFeature.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'git checkout-style batch: new folder, deletion and move together',
        run: (s) => {
            s.write('MyApp/Features/First.swift', 'struct First {}\n');
            s.write('MyApp/Features/Second.swift', 'struct Second {}\n');
            s.remove('MyApp/Views/Bar.swift');
            s.move('MyApp/Models/Model.swift', 'MyApp/Features/Model.swift');
            for (const created of ['MyApp/Features/First.swift', 'MyApp/Features/Second.swift', 'MyApp/Features/Model.swift']) {
                s.fire('create', created);
            }
            s.fire('delete', 'MyApp/Views/Bar.swift');
            s.fire('delete', 'MyApp/Models/Model.swift');
        },
        // One Features group serves all three files: the duplicate-group-folder list stays empty.
        changes: {
            swift: {
                'MyApp/Features/First.swift': { ids: NEW_ID, targets: ['MyApp'] },
                'MyApp/Features/Second.swift': { ids: NEW_ID, targets: ['MyApp'] },
                'MyApp/Views/Bar.swift': null,
                'MyApp/Models/Model.swift': null,
                'MyApp/Features/Model.swift': { ids: [fixtureId('0114')], targets: ['MyApp'] }
            }
        }
    },
    {
        name: 'Swift file renamed in letter case only',
        run: (s) => moveEntry(s, 'MyApp/Views/Bar.swift', 'MyApp/Views/bar.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/Bar.swift': null, 'MyApp/Views/bar.swift': { ids: [fixtureId('0112')], targets: ['MyApp'] } } }
    },
    {
        name: 'Swift file with an absolute path renamed in letter case only',
        run: (s) => {
            // The fixture has no <absolute> reference, so Bar.swift's is pointed at its own file first.
            const text = s.projectText().replace('path = Bar.swift; sourceTree = "<group>";',
                `path = "${s.root}/MyApp/Views/Bar.swift"; sourceTree = "<absolute>";`);
            fs.writeFileSync(projectPath(s.root), text);
            return moveEntry(s, 'MyApp/Views/Bar.swift', 'MyApp/Views/bar.swift', 'creates first');
        },
        // The oracle resolves only group-relative and SOURCE_ROOT paths, so the entry reads as unresolved, keyed by its path.
        changes: (before, root) => ({
            swift: {
                'MyApp/Views/Bar.swift': null,
                [`(unresolved ${fixtureId('0112')}) ${root}/MyApp/Views/bar.swift`]: { ids: [fixtureId('0112')], targets: ['MyApp'] }
            }
        })
    },
    {
        name: 'Swift file moved under its name into a group folder that is no target\'s',
        run: (s) => moveEntry(s, 'MyApp/Views/Bar.swift', 'Shared/Bar.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/Bar.swift': null, 'Shared/Bar.swift': { ids: [fixtureId('0112')], targets: ['MyApp'] } } }
    },
    {
        name: 'Swift file compiled by two targets renamed (S5)',
        run: (s) => moveEntry(s, 'Shared/SharedUtil.swift', 'Shared/SharedHelpers.swift', 'creates first'),
        changes: {
            swift: {
                'Shared/SharedUtil.swift': null,
                'Shared/SharedHelpers.swift': { ids: [fixtureId('0310')], targets: ['MyApp', 'MyKit {"COMPILER_FLAGS":"-DSHARED_UTIL"}'] }
            }
        }
    },
    {
        name: 'Swift file renamed while moved to another folder',
        run: (s) => moveEntry(s, 'MyApp/Views/ContentView.swift', 'MyApp/Models/HomeView.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/ContentView.swift': null, 'MyApp/Models/HomeView.swift': { ids: [fixtureId('0111')], targets: ['MyApp'] } } }
    },
    {
        name: 'Swift file renamed while moved into new folders, groups created',
        run: (s) => moveEntry(s, 'MyApp/Views/Bar.swift', 'MyApp/Features/Home/HomeBar.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/Bar.swift': null, 'MyApp/Features/Home/HomeBar.swift': { ids: [fixtureId('0112')], targets: ['MyApp'] } } }
    },
    {
        name: 'Swift file renamed into another target\'s folder keeps its own target',
        run: (s) => moveEntry(s, 'MyKit/Constants.swift', 'MyApp/Views/KitConstants.swift', 'creates first'),
        changes: { swift: { 'MyKit/Constants.swift': null, 'MyApp/Views/KitConstants.swift': { ids: [fixtureId('0211')], targets: ['MyKit'] } } }
    },
    {
        name: 'Swift file renamed out of known places, group created in the main group',
        run: (s) => moveEntry(s, 'MyApp/Views/Rename.swift', 'Tools/Renamed.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/Rename.swift': null, 'Tools/Renamed.swift': { ids: [fixtureId('0113')], targets: ['MyApp'] } } }
    },
    {
        name: 'a renamed file\'s identity wins over a missing entry with its new name',
        run: (s) => {
            s.move('MyApp/Helpers.swift', 'MyApp/Services/Constants.swift');
            s.remove('MyKit/Constants.swift');
            s.fire('create', 'MyApp/Services/Constants.swift');
            s.fire('delete', 'MyApp/Helpers.swift');
            s.fire('delete', 'MyKit/Constants.swift');
        },
        changes: {
            swift: {
                'MyApp/Helpers.swift': null,
                'MyKit/Constants.swift': null,
                'MyApp/Services/Constants.swift': { ids: [fixtureId('0110')], targets: ['MyApp'] }
            }
        }
    },
    {
        name: 'two same-named Swift files moved in one batch keep their own entries',
        run: (s) => {
            s.move('MyApp/Helpers.swift', 'MyApp/Services/Helpers.swift');
            s.move('MyKit/Helpers.swift', 'MyKit/Sub/Helpers.swift');
            s.fire('create', 'MyApp/Services/Helpers.swift');
            s.fire('create', 'MyKit/Sub/Helpers.swift');
            s.fire('delete', 'MyApp/Helpers.swift');
            s.fire('delete', 'MyKit/Helpers.swift');
        },
        changes: {
            swift: {
                'MyApp/Helpers.swift': null,
                'MyKit/Helpers.swift': null,
                'MyApp/Services/Helpers.swift': { ids: [fixtureId('0110')], targets: ['MyApp'] },
                'MyKit/Sub/Helpers.swift': { ids: [fixtureId('0210')], targets: ['MyKit'] }
            }
        }
    },
    {
        name: 'Swift file deleted as an unrelated one is created, not paired',
        run: (s) => {
            s.remove('MyApp/Helpers.swift');
            s.write('MyApp/NewThing.swift', 'struct NewThing {}\n');
            s.fire('create', 'MyApp/NewThing.swift');
            s.fire('delete', 'MyApp/Helpers.swift');
        },
        changes: { swift: { 'MyApp/Helpers.swift': null, 'MyApp/NewThing.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'hard-linked new paths of a renamed Swift file, not paired',
        run: (s) => {
            fs.linkSync(path.join(s.root, 'MyApp/Views/Rename.swift'), path.join(s.root, 'MyApp/Views/RenameA.swift'));
            s.move('MyApp/Views/Rename.swift', 'MyApp/Views/RenameB.swift');
            s.fire('create', 'MyApp/Views/RenameA.swift');
            s.fire('create', 'MyApp/Views/RenameB.swift');
            s.fire('delete', 'MyApp/Views/Rename.swift');
        },
        changes: {
            swift: {
                'MyApp/Views/Rename.swift': null,
                'MyApp/Views/RenameA.swift': { ids: NEW_ID, targets: ['MyApp'] },
                'MyApp/Views/RenameB.swift': { ids: NEW_ID, targets: ['MyApp'] }
            }
        }
    },
    {
        name: 'Swift file renamed over a registered file',
        run: (s) => moveEntry(s, 'MyApp/Views/Rename.swift', 'MyApp/Views/Bar.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/Rename.swift': null } }
    },
    {
        name: 'Swift file renamed into a synchronized root',
        run: (s) => moveEntry(s, 'MyApp/Views/Rename.swift', 'SyncKit/Rename.swift', 'creates first'),
        changes: { swift: { 'MyApp/Views/Rename.swift': null } }
    },
    {
        name: 'Swift file renamed, create 500 ms after the delete',
        run: async (s) => {
            s.move('MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift');
            s.fire('delete', 'MyApp/Views/Rename.swift');
            await s.wait(500);
            s.fire('create', 'MyApp/Views/Renamed.swift');
        },
        changes: RENAME_KEPT
    },
    {
        name: 'Swift file renamed in the editor, watcher events 136 ms later',
        run: async (s) => {
            s.move('MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift');
            s.fireRename('MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift');
            await s.wait(136);
            s.fire('create', 'MyApp/Views/Renamed.swift');
            s.fire('delete', 'MyApp/Views/Rename.swift');
        },
        changes: RENAME_KEPT
    },
    {
        name: 'Swift file renamed in the editor as a copy and delete, rename event only',
        run: (s) => {
            // A new inode, as a rename across volumes gives, so only the rename event can pair it.
            fs.copyFileSync(path.join(s.root, 'MyApp/Views/Rename.swift'), path.join(s.root, 'MyApp/Views/Renamed.swift'));
            s.remove('MyApp/Views/Rename.swift');
            s.fireRename('MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift');
        },
        changes: RENAME_KEPT
    },
    {
        name: 'Swift file renamed in the editor to a name that isn\'t Swift',
        run: async (s) => {
            s.move('MyApp/Views/Rename.swift', 'MyApp/Views/Rename.txt');
            s.fireRename('MyApp/Views/Rename.swift', 'MyApp/Views/Rename.txt');
            s.fire('delete', 'MyApp/Views/Rename.swift');
            await s.wait(SETTLE_MS);
            return s.projectText().includes('Rename.txt');
        },
        result: false,
        changes: { swift: { 'MyApp/Views/Rename.swift': null } }
    },
    {
        name: 'identities recorded between a rename and its events keep it pairable',
        run: async (s) => {
            s.move('MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift');
            s.fire('change', 'FixtureApp.xcodeproj/project.pbxproj');
            await s.wait(700);
            s.fire('create', 'MyApp/Views/Renamed.swift');
            s.fire('delete', 'MyApp/Views/Rename.swift');
        },
        changes: RENAME_KEPT
    },
    ...[['create', 600], ['change', 100]].map(([kind, pause]) => ({
        name: `Swift file replaced (delivered as a ${kind}), then renamed`,
        run: async (s) => {
            // Write-then-rename-over, as an atomic save does: the path gets a new inode.
            s.write('MyApp/Views/Rename.swift.tmp', 'struct Rename {}\n');
            s.move('MyApp/Views/Rename.swift.tmp', 'MyApp/Views/Rename.swift');
            s.fire(kind, 'MyApp/Views/Rename.swift');
            await s.wait(pause);
            await moveEntry(s, 'MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift', 'creates first');
        },
        changes: RENAME_KEPT
    })),
    {
        name: 'Swift file added, then renamed in a later batch',
        run: async (s) => {
            s.write('MyApp/Views/NewView.swift', 'struct NewView {}\n');
            s.fire('create', 'MyApp/Views/NewView.swift');
            await s.wait(600);
            await moveEntry(s, 'MyApp/Views/NewView.swift', 'MyApp/Views/NewScreen.swift', 'creates first');
        },
        // The add draws its build file's id first, so its reference has the second pinned id.
        changes: { swift: { 'MyApp/Views/NewScreen.swift': { ids: [pinnedId(2)], targets: ['MyApp'] } } }
    },
    {
        name: 'Swift file deleted with its folder',
        run: (s) => {
            s.remove('MyApp/Services');
            s.fire('delete', 'MyApp/Services/Service.swift');
        },
        changes: { swift: { 'MyApp/Services/Service.swift': null } }
    },
    ...EVENT_ORDERS.map((order) => ({
        name: `folder renamed (S6), ${order}`,
        run: (s) => moveEntry(s, 'MyApp/Services', 'MyApp/Networking', order),
        changes: { swift: { 'MyApp/Services/Service.swift': null, 'MyApp/Networking/Service.swift': { ids: [fixtureId('0115')], targets: ['MyApp'] } } }
    })),
    {
        name: 'folder renamed in the editor, folder events 136 ms later',
        run: async (s) => {
            s.move('MyApp/Views', 'MyApp/Screens');
            s.fireRename('MyApp/Views', 'MyApp/Screens');
            await s.wait(136);
            s.fire('create', 'MyApp/Screens');
            s.fire('delete', 'MyApp/Views');
        },
        changes: { swift: viewsUnder('MyApp/Screens') }
    },
    {
        name: 'folder renamed in the editor as a copy and delete, rename event only',
        run: (s) => {
            fs.cpSync(path.join(s.root, 'MyApp/Views'), path.join(s.root, 'MyApp/Screens'), { recursive: true });
            s.remove('MyApp/Views');
            s.fireRename('MyApp/Views', 'MyApp/Screens');
        },
        changes: { swift: viewsUnder('MyApp/Screens') }
    },
    {
        name: 'folder holding a Core Data model renamed',
        run: (s) => moveEntry(s, 'MyApp/Models', 'MyApp/Entities', 'creates first'),
        changes: (before) => ({
            swift: { 'MyApp/Models/Model.swift': null, 'MyApp/Entities/Model.swift': { ids: [fixtureId('0114')], targets: ['MyApp'] } },
            models: { [STORE]: null, 'MyApp/Entities/Store.xcdatamodeld': before.models[STORE] }
        })
    },
    {
        name: 'folder holding nested groups renamed',
        run: (s) => moveEntry(s, 'MyApp', 'App', 'creates first'),
        // The target's folder is found by name convention, so its sync breaks; its entries still follow the folder.
        changes: (before) => ({
            swift: Object.fromEntries(Object.entries(before.swift)
                .filter(([key]) => key.startsWith('MyApp/'))
                .flatMap(([key, entry]) => [[key, null], [key.replace(/^MyApp\//, 'App/'), entry]])),
            models: { [STORE]: null, [STORE.replace(/^MyApp\//, 'App/')]: before.models[STORE] }
        })
    },
    {
        name: 'SOURCE_ROOT group folder renamed',
        run: async (s) => {
            await rewriteProject(s, (text) => text.replace('path = Shared;\n\t\t\tsourceTree = "<group>";', 'path = Shared;\n\t\t\tsourceTree = SOURCE_ROOT;'));
            await moveEntry(s, 'Shared', 'Common', 'creates first');
        },
        changes: (before) => ({ swift: { 'Shared/SharedUtil.swift': null, 'Common/SharedUtil.swift': before.swift['Shared/SharedUtil.swift'] } })
    },
    {
        name: 'folder spelled by a group and by another entry\'s path renamed',
        run: async (s) => {
            await rewriteProject(s, barUnderMyApp);
            await moveEntry(s, 'MyApp/Views', 'MyApp/Screens', 'creates first');
        },
        changes: { swift: viewsUnder('MyApp/Screens') }
    },
    {
        name: 'folder spelled after a .. segment renamed',
        run: async (s) => {
            // Rename.swift listed in the Shared group, reaching its file through the parent folder.
            await rewriteProject(s, (text) => text
                .replace('\t\t\t\tAA0000000000000000000113 /* Rename.swift */,\n', '')
                .replace('\t\t\t\tAA0000000000000000000310 /* SharedUtil.swift */,\n',
                    '\t\t\t\tAA0000000000000000000310 /* SharedUtil.swift */,\n\t\t\t\tAA0000000000000000000113 /* Rename.swift */,\n')
                .replace('path = Rename.swift; sourceTree = "<group>";', 'name = Rename.swift; path = ../MyApp/Views/Rename.swift; sourceTree = "<group>";'));
            await moveEntry(s, 'MyApp/Views', 'MyApp/Screens', 'creates first');
        },
        changes: { swift: viewsUnder('MyApp/Screens') }
    },
    {
        name: 'folder whose name repeats earlier in a path renamed',
        run: async (s) => {
            s.move('MyApp/Views/Rename.swift', 'MyApp/Views/Sub/Views/Rename.swift');
            await rewriteProject(s, (text) => text
                .replace('\t\t\t\tAA0000000000000000000113 /* Rename.swift */,\n', '')
                .replace('\t\t\t\tAA0000000000000000000110 /* Helpers.swift */,\n',
                    '\t\t\t\tAA0000000000000000000110 /* Helpers.swift */,\n\t\t\t\tAA0000000000000000000113 /* Rename.swift */,\n')
                .replace('path = Rename.swift; sourceTree = "<group>";', 'name = Rename.swift; path = Views/Sub/Views/Rename.swift; sourceTree = "<group>";'));
            await moveEntry(s, 'MyApp/Views/Sub/Views', 'MyApp/Views/Sub/Screens', 'creates first');
        },
        // Only the component at the renamed folder's position changes; the first `Views` stays.
        changes: { swift: { 'MyApp/Views/Rename.swift': null, 'MyApp/Views/Sub/Screens/Rename.swift': { ids: [fixtureId('0113')], targets: ['MyApp'] } } }
    },
    {
        name: 'folder moved into another target\'s folder keeps its target',
        run: (s) => moveEntry(s, 'MyApp/Services', 'MyKit/Services', 'creates first'),
        changes: { swift: { 'MyApp/Services/Service.swift': null, 'MyKit/Services/Service.swift': { ids: [fixtureId('0115')], targets: ['MyApp'] } } }
    },
    {
        name: 'folder moved into a new folder, group created',
        run: (s) => moveEntry(s, 'MyApp/Services', 'MyApp/Features/Services', 'creates first'),
        changes: { swift: { 'MyApp/Services/Service.swift': null, 'MyApp/Features/Services/Service.swift': { ids: [fixtureId('0115')], targets: ['MyApp'] } } }
    },
    {
        name: 'folder spelled by another entry\'s path moved',
        run: async (s) => {
            await rewriteProject(s, barUnderMyApp);
            await moveEntry(s, 'MyApp/Views', 'UI/Views', 'creates first');
        },
        changes: { swift: viewsUnder('UI/Views') }
    },
    {
        name: 'folder renamed in letter case only',
        run: (s) => moveEntry(s, 'MyApp/Views', 'MyApp/views', 'creates first'),
        changes: { swift: viewsUnder('MyApp/views') }
    },
    {
        name: 'folder moved into a synchronized root',
        run: (s) => moveEntry(s, 'MyApp/Services', 'SyncKit/Services', 'creates first'),
        textUnchanged: true
    },
    {
        name: 'folder renamed while a Swift file is created inside it',
        run: (s) => {
            s.move('MyApp/Views', 'MyApp/Screens');
            s.write('MyApp/Screens/New.swift', 'struct New {}\n');
            s.fire('create', 'MyApp/Screens');
            s.fire('create', 'MyApp/Screens/New.swift');
            s.fire('delete', 'MyApp/Views');
        },
        // One group spells Screens: the duplicate-group-folder list stays empty.
        changes: { swift: { ...viewsUnder('MyApp/Screens'), 'MyApp/Screens/New.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'folder moved while an entry inside it reaches out with ..',
        run: async (s) => {
            s.move('MyApp/Views/Rename.swift', 'MyApp/Rename.swift');
            await rewriteProject(s, (text) => text.replace('path = Rename.swift; sourceTree = "<group>";', 'path = ../Rename.swift; sourceTree = "<group>";'));
            await moveEntry(s, 'MyApp/Views', 'MyApp/Features/Views', 'creates first');
        },
        // Rename.swift's base folder moves with Views, so its path is recomputed to keep pointing at MyApp/Rename.swift.
        changes: {
            swift: {
                'MyApp/Views/Bar.swift': null,
                'MyApp/Views/ContentView.swift': null,
                'MyApp/Views/Rename.swift': null,
                'MyApp/Features/Views/Bar.swift': { ids: [fixtureId('0112')], targets: ['MyApp'] },
                'MyApp/Features/Views/ContentView.swift': { ids: [fixtureId('0111')], targets: ['MyApp'] },
                'MyApp/Rename.swift': { ids: [fixtureId('0113')], targets: ['MyApp'] }
            }
        }
    },
    {
        name: 'folder deleted, delete event only',
        run: (s) => {
            s.remove('MyApp/Services');
            s.fire('delete', 'MyApp/Services');
        },
        textUnchanged: true
    },
    {
        name: 'folder copied with its file, not paired',
        run: (s) => {
            fs.cpSync(path.join(s.root, 'MyApp/Services'), path.join(s.root, 'MyApp/Copied'), { recursive: true });
            s.fire('create', 'MyApp/Copied');
            s.fire('create', 'MyApp/Copied/Service.swift');
        },
        changes: { swift: { 'MyApp/Copied/Service.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'folder renamed inside .build/',
        run: (s) => {
            s.write('.build/checkouts/Dep/Sources/Dep.swift', 'enum Dep {}\n');
            return moveEntry(s, '.build/checkouts/Dep', '.build/checkouts/Dep2', 'creates first');
        },
        textUnchanged: true
    },
    {
        name: 'new Swift file while a registered file\'s folder is already gone',
        run: (s) => {
            s.remove('MyApp/Services');
            s.write('MyApp/Views/NewView.swift', 'struct NewView {}\n');
            s.fire('create', 'MyApp/Views/NewView.swift');
        },
        // Service.swift stays registered, stale, for repair.
        changes: { swift: { 'MyApp/Views/NewView.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: '.build/ event storm doesn\'t hold back a real create',
        run: async (s) => {
            s.write('MyApp/Views/NewView.swift', 'struct NewView {}\n');
            s.fire('create', 'MyApp/Views/NewView.swift');
            const started = Date.now();
            let registeredInTime = false;
            for (let n = 0; Date.now() - started < 1500; n++) {
                s.write(`.build/checkouts/Dep/Sources/Dep${n}.swift`, `enum Dep${n} {}\n`);
                s.fire('create', `.build/checkouts/Dep/Sources/Dep${n}.swift`);
                await s.wait(50);
                if (!registeredInTime && Date.now() - started >= 800) {
                    registeredInTime = s.projectText().includes('NewView.swift');
                }
            }
            return registeredInTime;
        },
        result: true,
        changes: { swift: { 'MyApp/Views/NewView.swift': { ids: NEW_ID, targets: ['MyApp'] } } }
    },
    {
        name: 'steady creates still write within the 2 s cap',
        run: async (s) => {
            const started = Date.now();
            let registeredInTime = false;
            for (let n = 0; Date.now() - started < 3000; n++) {
                s.write(`MyApp/Views/Burst${n}.swift`, `struct Burst${n} {}\n`);
                s.fire('create', `MyApp/Views/Burst${n}.swift`);
                await s.wait(200);
                if (!registeredInTime && Date.now() - started >= 2500) {
                    registeredInTime = s.projectText().includes('Burst0.swift');
                }
            }
            return registeredInTime;
        },
        result: true,
        // Every burst file is registered in the end; the count depends on timing, so it's read back from disk.
        changes: (before, root) => ({
            swift: Object.fromEntries(fs.readdirSync(path.join(root, 'MyApp', 'Views'))
                .filter((name) => /^Burst\d+\.swift$/.test(name))
                .map((name) => [`MyApp/Views/${name}`, { ids: NEW_ID, targets: ['MyApp'] }]))
        })
    },
    {
        name: 'new Swift file under a synchronized root',
        run: (s) => {
            s.write('SyncKit/NewSync.swift', 'struct NewSync {}\n');
            s.fire('create', 'SyncKit/NewSync.swift');
        },
        textUnchanged: true
    },
    {
        name: 'Core Data model created',
        run: (s) => {
            s.writeModel('MyApp/Models/Archive.xcdatamodeld', 'Archive.xcdatamodel');
            s.fire('create', 'MyApp/Models/Archive.xcdatamodeld');
        },
        changes: {
            models: {
                'MyApp/Models/Archive.xcdatamodeld': {
                    ids: NEW_ID, versions: ['Archive.xcdatamodel'], current: 'Archive.xcdatamodel', targets: ['MyApp']
                }
            }
        }
    },
    ...['creates first', 'deletes first'].map((order) => ({
        name: `Core Data model moved to another folder, ${order}`,
        run: (s) => moveModel(s, STORE, 'MyApp/Views/Store.xcdatamodeld', order),
        changes: (before) => ({ models: { [STORE]: null, 'MyApp/Views/Store.xcdatamodeld': before.models[STORE] } })
    })),
    {
        name: 'Core Data model renamed, creates first',
        run: (s) => moveModel(s, STORE, 'MyApp/Models/Archive.xcdatamodeld', 'creates first'),
        changes: {
            models: {
                [STORE]: null,
                'MyApp/Models/Archive.xcdatamodeld': {
                    ids: ANY_ID, versions: ['Store.xcdatamodel'], current: 'Store.xcdatamodel', targets: ['MyApp']
                }
            }
        }
    },
    {
        name: 'Core Data model deleted',
        run: (s) => {
            s.remove(STORE);
            s.fire('delete', STORE);
        },
        changes: { models: { [STORE]: null } }
    },
    {
        name: 'reconcile registers a Swift file added without events',
        run: (s) => {
            s.write('MyKit/Unregistered.swift', 'struct Unregistered {}\n');
            return reconcileSwiftFiles(s.root, s.log);
        },
        result: 1,
        changes: { swift: { 'MyKit/Unregistered.swift': { ids: NEW_ID, targets: ['MyKit'] } } }
    },
    {
        name: 'reconcile registers a Swift file in a folder with no group',
        run: (s) => {
            s.write('MyKit/Sub/Unregistered.swift', 'struct Unregistered {}\n');
            return reconcileSwiftFiles(s.root, s.log);
        },
        result: 1,
        changes: { swift: { 'MyKit/Sub/Unregistered.swift': { ids: NEW_ID, targets: ['MyKit'] } } }
    },
    {
        name: 'reconcile leaves a file whose name a missing same-target entry holds',
        run: (s) => {
            s.remove('MyKit/Constants.swift');
            s.write('MyKit/Sub/Constants.swift', 'enum Constants {}\n');
            return reconcileSwiftFiles(s.root, s.log);
        },
        result: 0,
        changes: {}
    },
    {
        name: 'reconcile removes a Core Data model deleted without events',
        run: (s) => {
            s.remove(STORE);
            return reconcileDataModels(s.root, s.log);
        },
        result: { added: 0, updated: 0, removed: 1 },
        changes: { models: { [STORE]: null } }
    }
];

async function runScenario(scenario) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-file-sync-')));
    const logs = [];
    try {
        fs.mkdirSync(path.dirname(projectPath(root)));
        fs.writeFileSync(projectPath(root), PROJECT_TEXT);
        for (const [relative, contents] of Object.entries(SOURCES)) {
            fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
            fs.writeFileSync(path.join(root, relative), contents);
        }
        idCounter = 0;
        const before = readState(PROJECT_TEXT);
        const log = (message) => logs.push(message);
        const context = scenarioContext(root, log);
        const disposables = [];
        let result;
        try {
            disposables.push(...createSwiftFileWatcher(root, log));
            disposables.push(...createDataModelWatcher(root, log, () => {}));
            // The Swift watcher first records file identities on the write queue; a rename made before that couldn't pair.
            await enqueueWrite(async () => {});
            result = await scenario.run(context);
            if (context.lastEventAt !== null) {
                await sleep(Math.max(0, context.lastEventAt + SETTLE_MS - Date.now()));
            }
        } finally {
            // The write queue is module-wide: even on a throw, drop pending debounces, then drain before the directory goes.
            for (const disposable of disposables) { disposable.dispose(); }
            await enqueueWrite(async () => {});
        }

        const after = fs.readFileSync(projectPath(root), 'utf8');
        if (!lints(after)) { return { problems: ['the project no longer passes plutil -lint'], logs }; }
        const problems = [];
        if (scenario.textUnchanged && after !== PROJECT_TEXT) { problems.push('the project text changed'); }
        if (scenario.result !== undefined && !same(result, scenario.result)) {
            problems.push(`returned ${show(result)}, expected ${show(scenario.result)}`);
        }
        const changes = typeof scenario.changes === 'function' ? scenario.changes(before, root) : scenario.changes || {};
        problems.push(...stateProblems(readState(after), withChanges(before, changes), before.ids));
        return { problems, logs };
    } catch (error) {
        return { problems: [`threw: ${(error && error.stack) || error}`], logs };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────

function report(name, problems, logs = []) {
    if (problems.length === 0) {
        console.log(`  PASS  ${name}`);
        return;
    }
    console.log(`  FAIL  ${name}`);
    for (const problem of problems) { console.log(`        ${problem}`); }
    for (const message of logs.filter((entry) => !entry.endsWith('watcher active'))) {
        console.log(`        log: ${message}`);
    }
}

async function main() {
    let failures = 0;
    const baseline = baselineProblems();
    report('fixture baseline', baseline);
    if (baseline.length > 0) { failures++; }
    for (const scenario of SCENARIOS) {
        const { problems, logs } = await runScenario(scenario);
        report(scenario.name, problems, logs);
        if (problems.length > 0) { failures++; }
    }
    if (failures > 0) {
        console.log(`\n${failures} check(s) failed.`);
        process.exitCode = 1;
        return;
    }
    console.log('\nFile-sync check OK.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
