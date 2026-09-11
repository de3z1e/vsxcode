#!/usr/bin/env node
/**
 * File-sync regression check.
 *
 * Runs the compiled Swift and Core Data sync watchers (out/sync/) in plain Node with `vscode` stubbed. Each scenario
 * lays the fixture project and its sources out in a fresh temp directory, applies real filesystem operations, fires the
 * watcher events VS Code would deliver, and reads the resulting project through plutil rather than the parsers under
 * test. The entries a scenario names must change as stated; every other Swift file reference and Core Data model must
 * come out unchanged, ids included, and the project must still lint.
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

// Past the scheduler's 300 ms per-path debounce (DEBOUNCE_MS in src/sync/pbxprojSync.ts, not exported).
const SETTLE_MS = 500;

// ── vscode stub ──────────────────────────────────────────────────────────────────────
// The sync modules touch vscode only through workspace.createFileSystemWatcher.

const watchers = new Set();

const vscodeStub = {
    workspace: {
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

/** Swift file references and XCVersionGroups keyed by Xcode-resolved path, plus dangling Sources entries and repeated group children. */
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
    for (const [id, object] of Object.entries(objects)) {
        if (object.isa === 'PBXFileReference' && /\.swift$/.test(object.path || '')) {
            record(swift, id, {});
        } else if (object.isa === 'XCVersionGroup') {
            record(models, id, {
                versions: (object.children || []).map(versionPath).sort(),
                current: object.currentVersion ? versionPath(object.currentVersion) : null
            });
        }
    }
    return {
        swift,
        models,
        dangling: dangling.sort(),
        duplicateChildren: duplicateChildren.sort(),
        ids: new Set(Object.keys(objects))
    };
}

// ── Expectations ─────────────────────────────────────────────────────────────────────

// Id placeholders for entries a scenario creates or re-registers.
const NEW_ID = 'one id that was not in the project before';
const ANY_ID = 'one id';

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
        duplicateChildren: state.duplicateChildren
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
    for (const [list, label] of [['dangling', 'dangling Sources entries'], ['duplicateChildren', 'elements listed as a child more than once']]) {
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
        duplicateChildren: []
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
        move: (from, to) => fs.renameSync(at(from), at(to)),
        remove: (relative) => fs.rmSync(at(relative), { recursive: true }),
        wait: sleep,
        writeModel: (bundle, versionName) => {
            write(`${bundle}/.xccurrentversion`, SOURCES[`${STORE}/.xccurrentversion`].replace('Store.xcdatamodel', versionName));
            write(`${bundle}/${versionName}/contents`, SOURCES[`${STORE}/Store.xcdatamodel/contents`]);
        },
        fire: (kind, relative) => {
            deliver(kind, at(relative));
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

const renameSwift = (s, order) => {
    s.move('MyApp/Views/Rename.swift', 'MyApp/Views/Renamed.swift');
    if (order === 'creates first') {
        s.fire('create', 'MyApp/Views/Renamed.swift');
        s.fire('delete', 'MyApp/Views/Rename.swift');
    } else {
        s.fire('delete', 'MyApp/Views/Rename.swift');
        s.fire('create', 'MyApp/Views/Renamed.swift');
    }
};

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
    ...['creates first', 'deletes first'].map((order) => ({
        name: `Swift file renamed in its folder, ${order}`,
        run: (s) => renameSwift(s, order),
        // Registered again under the new name; which ids it keeps is not asserted.
        changes: { swift: { 'MyApp/Views/Rename.swift': null, 'MyApp/Views/Renamed.swift': { ids: ANY_ID, targets: ['MyApp'] } } }
    })),
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
        const changes = typeof scenario.changes === 'function' ? scenario.changes(before) : scenario.changes || {};
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
