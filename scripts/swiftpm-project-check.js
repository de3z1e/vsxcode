#!/usr/bin/env node
/**
 * SwiftPM-generated project check.
 *
 * Runs the compiled extension's activate() in plain Node against a stubbed `vscode`, on temp workspaces, and records
 * what the extension does: dialogs, QuickPicks, setting and state updates, watchers and their disposal, and every file
 * in the workspace. A project with SwiftPM's `OBJ_n` ids must get the modal choice before VSXcode changes anything, each
 * answer must do exactly what the dialog says, and an ordinary project must behave as before.
 *
 * Each activation runs in its own child process, so module state never carries over; workspace state persists between
 * them in a JSON file. Activation runs real tools (xcodebuild -list, simctl), so a full Xcode is required.
 *
 * Usage: npm run test:swiftpm-project
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const FIXTURES = path.join(__dirname, 'fixtures');

const FULLY = 'Use VSXcode fully';
const KEEP = 'Keep it a SwiftPM package';
// The file-sync watchers; `**/*` is the Swift sync's folder watcher, and no other part of the extension creates one.
const SYNC_WATCHERS = ['**/*.swift', '**/*', '**/*.xcdatamodeld', '**/*.xcdatamodeld/**'];
const QUIET_MS = 2000;
const MAX_WAIT_MS = 30000;

// ── Workspace files ──────────────────────────────────────────────────────────────────

function hashFiles(root) {
    const hashes = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                hashes[path.relative(root, full)] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
            }
        }
    };
    walk(root);
    return hashes;
}

function changedFiles(before, after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((key) => before[key] !== after[key]).sort();
}

// ── Child: one activation against the stub ───────────────────────────────────────────

function runChild({ root, statePath, steps }) {
    const events = [];
    let lastActivity = Date.now();
    const record = (type, detail) => {
        events.push({ type, ...detail });
        lastActivity = Date.now();
    };

    const universal = (name) => new Proxy(function () {}, {
        get(target, prop) {
            if (prop === 'then') { return undefined; }
            if (prop === Symbol.toPrimitive) { return () => `[${name}]`; }
            if (prop === Symbol.iterator) { return function* () {}; }
            if (prop === 'prototype') { return target.prototype; }
            if (prop in target) { return target[prop]; }
            return universal(`${name}.${String(prop)}`);
        },
        set(target, prop, value) { target[prop] = value; return true; },
        apply() { return universal(`${name}()`); },
        construct() {
            return new Proxy({}, {
                get(store, prop) {
                    if (prop === 'then') { return undefined; }
                    if (prop === Symbol.toPrimitive) { return () => `[new ${name}]`; }
                    if (prop === Symbol.iterator) { return function* () {}; }
                    if (prop in store) { return store[prop]; }
                    return universal(`new ${name}.${String(prop)}`);
                },
                set(store, prop, value) { store[prop] = value; return true; }
            });
        }
    });

    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    const workspaceState = {
        get: (key, fallback) => (key in state ? state[key] : fallback),
        update: async (key, value) => {
            if (value === undefined) { delete state[key]; } else { state[key] = value; }
            fs.writeFileSync(statePath, JSON.stringify(state));
            record('state', { key });
        },
        keys: () => Object.keys(state)
    };
    const globalValues = {};
    const globalState = {
        get: (key, fallback) => (key in globalValues ? globalValues[key] : fallback),
        update: async (key, value) => { globalValues[key] = value; },
        keys: () => Object.keys(globalValues),
        setKeysForSync: () => {}
    };

    let answers = [];
    let stepStart = {};
    const watchers = [];
    const commands = new Map();
    const disposable = { dispose() {} };
    const readSettings = () => {
        try { return JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8')); } catch { return {}; }
    };
    /** Writes the file an event names, if any, then delivers the event to the live watchers for its glob. */
    const fire = ({ write, glob, event, relative }) => {
        if (write) {
            fs.mkdirSync(path.dirname(path.join(root, write.relative)), { recursive: true });
            fs.writeFileSync(path.join(root, write.relative), write.contents);
        }
        for (const watcher of watchers.filter((candidate) => candidate.label === glob && !candidate.disposed)) {
            for (const listener of watcher.listeners[event]) { listener({ fsPath: path.join(root, relative) }); }
        }
    };

    const api = {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: root, path: root, scheme: 'file' }, name: path.basename(root), index: 0 }],
            workspaceFile: undefined,
            getConfiguration: (section) => ({
                get: (key, fallback) => fallback,
                has: () => false,
                inspect: (key) => ({ key: `${section}.${key}`, globalValue: undefined, workspaceValue: readSettings()[`${section}.${key}`] }),
                update: async (key) => { record('setting', { key: `${section}.${key}` }); }
            }),
            createFileSystemWatcher: (glob) => {
                const label = typeof glob === 'string' ? glob : '(relative pattern)';
                const watcher = { label, listeners: { create: [], change: [], delete: [] } };
                const on = (kind) => (listener) => { watcher.listeners[kind].push(listener); return disposable; };
                Object.assign(watcher, {
                    onDidCreate: on('create'), onDidChange: on('change'), onDidDelete: on('delete'),
                    dispose: () => { watcher.disposed = true; record('watcherDisposed', { glob: label }); }
                });
                watchers.push(watcher);
                record('watcher', { glob: label });
                return watcher;
            },
            openTextDocument: async () => universal('document'),
            onDidChangeConfiguration: () => disposable
        },
        window: {
            createOutputChannel: () => ({ appendLine: (line) => record('log', { line: String(line) }), append() {}, show() {}, clear() {}, dispose() {} }),
            showWarningMessage: async (message, ...rest) => {
                const options = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest[0] : undefined;
                if (!options || !options.modal) {
                    record('notice', { message: String(message) });
                    return undefined;
                }
                // An answer is a button label, null to dismiss, or { answer, during } to deliver an event while the dialog is open.
                const next = answers.shift();
                const { answer, during } = next !== null && typeof next === 'object' ? next : { answer: next };
                record('dialog', {
                    message: String(message),
                    detail: String(options.detail || ''),
                    items: rest.slice(1),
                    changedBeforeAnswer: changedFiles(stepStart, hashFiles(root)),
                    effectsBeforeAnswer: events.filter((event) => ['setting', 'state'].includes(event.type) ||
                        (event.type === 'watcher' && SYNC_WATCHERS.includes(event.glob))).length,
                    answer: answer === undefined ? null : answer
                });
                if (during) {
                    fire(during);
                    // Whatever the event starts gets queued before the answer arrives.
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
                return answer === null ? undefined : answer;
            },
            showInformationMessage: async (message) => { record('info', { message: String(message) }); return undefined; },
            showErrorMessage: async (message) => { record('error', { message: String(message) }); return undefined; },
            showQuickPick: async (items, options) => { record('quickPick', { placeHolder: options && options.placeHolder }); return undefined; },
            showTextDocument: async () => universal('editor')
        },
        commands: {
            registerCommand: (id, handler) => { commands.set(id, handler); return disposable; },
            executeCommand: async () => undefined
        },
        Uri: {
            file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` }),
            parse: (s) => ({ fsPath: s, path: s, scheme: String(s).split(':')[0], toString: () => s })
        },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
    };
    const withApi = (stub, extra) => new Proxy(stub, {
        get(target, prop) {
            if (!(prop in extra)) { return target[prop]; }
            const value = extra[prop];
            const plainObject = value && typeof value === 'object' && !Array.isArray(value) && !('fsPath' in value) && !('Global' in value);
            return plainObject ? withApi(universal(String(prop)), value) : value;
        }
    });
    const vscode = withApi(universal('vscode'), api);
    const resolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        return request === 'vscode' ? 'vscode' : resolveFilename.call(this, request, ...rest);
    };
    require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };
    process.on('unhandledRejection', (reason) => record('rejection', { reason: String((reason && reason.stack) || reason) }));

    const context = {
        subscriptions: [],
        workspaceState,
        globalState,
        extensionUri: { fsPath: REPO, path: REPO, scheme: 'file' },
        extensionPath: REPO,
        asAbsolutePath: (p) => path.join(REPO, p)
    };

    const waitForQuiet = async () => {
        const started = Date.now();
        while (Date.now() - lastActivity < QUIET_MS && Date.now() - started < MAX_WAIT_MS) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    };

    (async () => {
        const results = [];
        const extension = require(path.join(OUT, 'extension.js'));
        for (const step of steps) {
            const firstEvent = events.length;
            stepStart = hashFiles(root);
            answers = [...(step.answers || [])];
            try {
                if (step.kind === 'activate') {
                    extension.activate(context);
                } else if (step.kind === 'command') {
                    await commands.get(step.id)();
                } else if (step.kind === 'fire') {
                    fire(step);
                }
            } catch (error) {
                record('threw', { error: String((error && error.stack) || error) });
            }
            lastActivity = Date.now();
            await waitForQuiet();
            const stepEvents = events.slice(firstEvent);
            results.push({
                kind: step.kind,
                events: stepEvents.filter((event) => event.type !== 'log'),
                log: stepEvents.filter((event) => event.type === 'log').map((event) => event.line),
                changed: changedFiles(stepStart, hashFiles(root)),
                hashes: hashFiles(root)
            });
        }
        for (const subscription of context.subscriptions) {
            try { if (subscription && typeof subscription.dispose === 'function') { subscription.dispose(); } } catch { /* ignore */ }
        }
        process.stdout.write(`${JSON.stringify(results)}\n`);
        process.exit(0);
    })().catch((error) => {
        process.stdout.write(`${JSON.stringify([{ kind: 'harness', events: [{ type: 'threw', error: String(error.stack || error) }] }])}\n`);
        process.exit(0);
    });
}

// ── Parent: fixtures and assertions ──────────────────────────────────────────────────

function makeWorkspace(kind) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-swiftpm-project-')));
    const write = (relative, contents) => {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), contents);
    };
    if (kind === 'swiftpm') {
        write('SampleKit.xcodeproj/project.pbxproj', fs.readFileSync(path.join(FIXTURES, 'pbxproj', 'generated-ids.txt'), 'utf8'));
        write('Sources/SampleKit/SampleKit.swift', 'public struct SampleKit {}\n');
        write('Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n\nlet package = Package(name: "SampleKit", targets: [.target(name: "SampleKit")])\n');
        write('.vscode/settings.json', '{\n    "editor.tabSize": 4\n}\n');
        write('.vscode/.swift-format', '{\n    "version": 1,\n    "lineLength": 120\n}\n');
    } else if (kind === 'ordinary') {
        write('SyncApp.xcodeproj/project.pbxproj', fs.readFileSync(path.join(FIXTURES, 'pbxproj', 'synchronized.txt'), 'utf8'));
        write('SyncApp/ContentView.swift', 'struct ContentView {}\n');
        write('Extras/Helper.swift', 'enum Helper {}\n');
        write('Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n\nlet package = Package(name: "SyncApp")\n');
        // With a config file the profile is set to local, a state update the check can see; the default, global, is a no-op.
        write('.vscode/.swift-format', '{\n    "version": 1,\n    "lineLength": 120\n}\n');
    } else {
        // No project yet; the scenario creates one. The config file makes the profile step visible, as above.
        write('.vscode/.swift-format', '{\n    "version": 1,\n    "lineLength": 120\n}\n');
    }
    return { root, statePath: path.join(root, '..', `${path.basename(root)}-state.json`) };
}

function runSteps(workspace, steps) {
    const child = spawnSync(process.execPath, [__filename, '--child', JSON.stringify({ ...workspace, steps })], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240000
    });
    const lines = (child.stdout || '').trim().split('\n');
    try {
        return JSON.parse(lines[lines.length - 1]);
    } catch {
        return [{ kind: 'harness', events: [{ type: 'threw', error: `child produced no result: ${(child.stderr || '').slice(0, 400)}` }] }];
    }
}

const of = (result, type) => (result.events || []).filter((event) => event.type === type);
const syncWatchers = (result) => of(result, 'watcher').filter((event) => SYNC_WATCHERS.includes(event.glob)).map((event) => event.glob);

function expectations(label) {
    const problems = [];
    return {
        problems,
        that(condition, message) { if (!condition) { problems.push(`${label}: ${message}`); } }
    };
}

function checkNoCrash(result, expect) {
    for (const event of [...of(result, 'threw'), ...of(result, 'rejection')]) {
        expect.that(false, `threw: ${(event.error || event.reason).split('\n')[0]}`);
    }
}

const SCENARIOS = [
    {
        name: 'ordinary project: no dialog, everything as before',
        run() {
            const workspace = makeWorkspace('ordinary');
            const [open] = runSteps(workspace, [{ kind: 'activate' }]);
            const expect = expectations('open');
            checkNoCrash(open, expect);
            expect.that(of(open, 'dialog').length === 0, 'showed the SwiftPM dialog');
            expect.that(SYNC_WATCHERS.every((glob) => syncWatchers(open).includes(glob)), `sync watchers not started (${syncWatchers(open)})`);
            expect.that(of(open, 'setting').some((event) => event.key === 'terminal.integrated.commandsToSkipShell'), 'terminal skip list not updated');
            expect.that(of(open, 'state').some((event) => event.key === 'buildTaskConfig'), 'build tasks not configured');
            expect.that(of(open, 'state').some((event) => event.key === 'swiftFormatProfileMode'), 'swift-format profile not set');
            expect.that(open.changed.includes('Package.swift'), 'Package.swift not regenerated');
            return { workspace, problems: expect.problems, logs: [open] };
        }
    },
    {
        name: 'project created deeper in the tree after the folder opens: set up as before',
        run() {
            const workspace = makeWorkspace('no-project');
            const [open, created] = runSteps(workspace, [
                { kind: 'activate' },
                {
                    kind: 'fire', glob: '**/*.xcodeproj', event: 'create', relative: 'ios/SyncApp.xcodeproj',
                    write: { relative: 'ios/SyncApp.xcodeproj/project.pbxproj', contents: fs.readFileSync(path.join(FIXTURES, 'pbxproj', 'synchronized.txt'), 'utf8') }
                }
            ]);
            const expect = expectations('nested');
            for (const result of [open, created]) { checkNoCrash(result, expect); }
            expect.that(of(created, 'dialog').length === 0, 'showed the SwiftPM dialog');
            expect.that(of(created, 'setting').some((event) => event.key === 'terminal.integrated.commandsToSkipShell'), 'terminal skip list not updated');
            expect.that(of(created, 'state').some((event) => event.key === 'swiftFormatProfileMode'), 'swift-format profile not set');
            // With no project at the root only the model-contents watcher starts; the Swift and Core Data watchers skip.
            expect.that(syncWatchers(created).includes('**/*.xcdatamodeld/**'), `file sync not started (${syncWatchers(created)})`);
            return { workspace, problems: expect.problems, logs: [open, created] };
        }
    },
    {
        name: 'SwiftPM project, dismissed: nothing changes, asked again',
        run() {
            const workspace = makeWorkspace('swiftpm');
            const initial = hashFiles(workspace.root);
            const [open] = runSteps(workspace, [{ kind: 'activate', answers: [null] }]);
            const [reopen] = runSteps(workspace, [{ kind: 'activate', answers: [null] }]);
            const problems = [];
            for (const [label, result] of [['open', open], ['reopen', reopen]]) {
                const expect = expectations(label);
                checkNoCrash(result, expect);
                const dialogs = of(result, 'dialog');
                expect.that(dialogs.length === 1, `expected one dialog, saw ${dialogs.length}`);
                if (dialogs[0]) {
                    const { detail, items, changedBeforeAnswer, effectsBeforeAnswer } = dialogs[0];
                    expect.that(JSON.stringify(items) === JSON.stringify([FULLY, KEEP]), `options were ${JSON.stringify(items)}`);
                    for (const [relative, backup] of [
                        ['Package.swift', 'Package.swift_backup'],
                        ['.vscode/settings.json', 'settings.json_backup'],
                        ['.vscode/.swift-format', '.swift-format_backup'],
                        ['SampleKit.xcodeproj/project.pbxproj', 'project.pbxproj_backup']
                    ]) {
                        expect.that(detail.includes(path.join(workspace.root, relative)), `detail doesn't list ${relative}`);
                        expect.that(detail.includes(backup), `detail doesn't name ${backup}`);
                    }
                    expect.that(changedBeforeAnswer.length === 0, `files changed before the answer: ${changedBeforeAnswer}`);
                    expect.that(effectsBeforeAnswer === 0, 'settings, state or sync watchers changed before the answer');
                }
                expect.that(of(result, 'setting').length === 0, `setting updates: ${of(result, 'setting').map((event) => event.key)}`);
                expect.that(of(result, 'state').length === 0, `state updates: ${of(result, 'state').map((event) => event.key)}`);
                expect.that(syncWatchers(result).length === 0, `sync watchers started: ${syncWatchers(result)}`);
                problems.push(...expect.problems);
            }
            const after = changedFiles(initial, hashFiles(workspace.root));
            if (after.length > 0) { problems.push(`files changed: ${after}`); }
            return { workspace, problems, logs: [open, reopen] };
        }
    },
    {
        name: 'SwiftPM project, kept: nothing changes, remembered',
        run() {
            const workspace = makeWorkspace('swiftpm');
            const initial = hashFiles(workspace.root);
            const [open, pbxprojEdit, newSwiftFile] = runSteps(workspace, [
                { kind: 'activate', answers: [KEEP] },
                { kind: 'fire', glob: '**/*.pbxproj', event: 'change', relative: 'SampleKit.xcodeproj/project.pbxproj' },
                { kind: 'fire', glob: '**/*.swift', event: 'create', relative: 'Sources/SampleKit/Added.swift', write: { relative: 'Sources/SampleKit/Added.swift', contents: 'struct Added {}\n' } }
            ]);
            const [reopen] = runSteps(workspace, [{ kind: 'activate' }]);
            const expect = expectations('kept');
            for (const result of [open, pbxprojEdit, newSwiftFile, reopen]) { checkNoCrash(result, expect); }
            expect.that(of(open, 'dialog').length === 1, `expected one dialog, saw ${of(open, 'dialog').length}`);
            expect.that(JSON.stringify(JSON.parse(fs.readFileSync(workspace.statePath, 'utf8')).swiftPMProjectChoices) ===
                JSON.stringify({ 'SampleKit.xcodeproj': 'keep' }), 'choice not stored as keep');
            expect.that(syncWatchers(open).length === 0 && syncWatchers(reopen).length === 0, 'sync watchers started');
            expect.that(of(open, 'setting').length === 0 && of(reopen, 'setting').length === 0, 'settings were updated');
            expect.that(pbxprojEdit.changed.length === 0, `a project-file change changed ${pbxprojEdit.changed}`);
            expect.that(newSwiftFile.changed.join() === 'Sources/SampleKit/Added.swift', `a new Swift file changed ${newSwiftFile.changed}`);
            expect.that(of(reopen, 'dialog').length === 0, 'asked again after keep');
            const after = changedFiles(initial, hashFiles(workspace.root)).filter((file) => file !== 'Sources/SampleKit/Added.swift');
            expect.that(after.length === 0, `files changed: ${after}`);
            return { workspace, problems: expect.problems, logs: [open, pbxprojEdit, newSwiftFile, reopen] };
        }
    },
    {
        name: 'SwiftPM project, used fully: backups first, then everything on',
        run() {
            const workspace = makeWorkspace('swiftpm');
            const initial = hashFiles(workspace.root);
            const [open, added] = runSteps(workspace, [
                { kind: 'activate', answers: [FULLY] },
                // File sync handles SwiftPM's ids: a new file in the target folder is registered, once.
                {
                    kind: 'fire', glob: '**/*.swift', event: 'create', relative: 'Sources/SampleKit/Added.swift',
                    write: { relative: 'Sources/SampleKit/Added.swift', contents: 'struct Added {}\n' }
                }
            ]);
            const registered = fs.readFileSync(path.join(workspace.root, 'SampleKit.xcodeproj', 'project.pbxproj'), 'utf8');
            const firstBackups = hashFiles(workspace.root);
            const handWritten = fs.readFileSync(path.join(workspace.root, 'Package.swift_backup'), 'utf8');
            const [reopen, generateFully, restore, generateKeep] = runSteps(workspace, [
                { kind: 'activate' },
                { kind: 'command', id: 'vsxcode.createFromXcodeproj', answers: [FULLY] },
                // The user puts their own manifest back, then switches to keep while a project change arrives during the dialog.
                { kind: 'fire', write: { relative: 'Package.swift', contents: handWritten } },
                {
                    kind: 'command', id: 'vsxcode.createFromXcodeproj',
                    answers: [{ answer: KEEP, during: { glob: '**/*.pbxproj', event: 'change', relative: 'SampleKit.xcodeproj/project.pbxproj' } }]
                }
            ]);
            const expect = expectations('fully');
            for (const result of [open, added, reopen, generateFully, restore, generateKeep]) { checkNoCrash(result, expect); }

            const pairs = [
                ['Package.swift', 'Package.swift_backup'],
                ['.vscode/settings.json', '.vscode/settings.json_backup'],
                ['.vscode/.swift-format', '.vscode/.swift-format_backup'],
                ['SampleKit.xcodeproj/project.pbxproj', 'SampleKit.xcodeproj/project.pbxproj_backup']
            ];
            expect.that(of(open, 'dialog').length === 1, `expected one dialog on open, saw ${of(open, 'dialog').length}`);
            for (const [original, backup] of pairs) {
                expect.that(firstBackups[backup] === initial[original], `${backup} doesn't hold the original ${original}`);
                expect.that(fs.existsSync(path.join(workspace.root, original)), `${original} is gone`);
            }
            expect.that(open.changed.includes('Package.swift'), 'Package.swift not regenerated');
            // File sync must never register the project's files a second time; the backup is a separate file.
            expect.that(!open.changed.includes('SampleKit.xcodeproj/project.pbxproj'), 'opening the folder changed project.pbxproj');
            const occurrences = (pattern) => (registered.match(pattern) || []).length;
            expect.that(added.changed.includes('SampleKit.xcodeproj/project.pbxproj'), 'the new Swift file was not registered');
            expect.that(occurrences(/path = Added\.swift;/g) === 1 && occurrences(/Added\.swift in Sources \*\/ = \{isa = PBXBuildFile;/g) === 1,
                `Added.swift has ${occurrences(/path = Added\.swift;/g)} reference(s) and ${occurrences(/Added\.swift in Sources \*\/ = \{isa = PBXBuildFile;/g)} build file(s)`);
            expect.that(occurrences(/path = SampleKit\.swift;/g) === 1, 'SampleKit.swift is no longer registered exactly once');
            expect.that(of(open, 'quickPick').length === 0, 'asked to overwrite after backing up');
            expect.that(SYNC_WATCHERS.every((glob) => syncWatchers(open).includes(glob)), `sync watchers not started (${syncWatchers(open)})`);
            expect.that(of(open, 'state').some((event) => event.key === 'buildTaskConfig'), 'build tasks not configured');
            expect.that(of(open, 'setting').some((event) => event.key === 'terminal.integrated.commandsToSkipShell'), 'terminal skip list not updated');
            expect.that(of(open, 'state').some((event) => event.key === 'swiftFormatProfileMode'), 'swift-format profile not set');

            expect.that(of(reopen, 'dialog').length === 0, 'asked again after choosing fully');
            expect.that(SYNC_WATCHERS.every((glob) => syncWatchers(reopen).includes(glob)), 'sync watchers not started on reopen');

            expect.that(of(generateFully, 'dialog').length === 1, 'the Generate command did not ask');
            expect.that(of(generateFully, 'quickPick').length === 0, 'the Generate command asked to overwrite after backing up');
            for (const [original, backup] of pairs) {
                expect.that(generateFully.hashes[`${backup}-2`] !== undefined, `no ${backup}-2`);
                expect.that(generateFully.hashes[backup] === firstBackups[backup], `${backup} changed`);
            }

            expect.that(of(generateKeep, 'dialog').length === 1, 'the Generate command did not ask again');
            const disposed = of(generateKeep, 'watcherDisposed').map((event) => event.glob);
            expect.that(SYNC_WATCHERS.every((glob) => disposed.includes(glob)), `sync watchers not stopped (${disposed})`);
            // The regeneration the project change queued during the dialog must not write once keep is chosen.
            expect.that(generateKeep.changed.length === 0, `keep changed ${generateKeep.changed}`);
            expect.that(JSON.parse(fs.readFileSync(workspace.statePath, 'utf8')).swiftPMProjectChoices['SampleKit.xcodeproj'] === 'keep',
                'switching to keep was not stored');
            return { workspace, problems: expect.problems, logs: [open, added, reopen, generateFully, restore, generateKeep] };
        }
    },
    {
        name: 'SwiftPM project, used fully from Generate while the project changes: Package.swift follows the change',
        run() {
            const workspace = makeWorkspace('swiftpm');
            const original = fs.readFileSync(path.join(workspace.root, 'SampleKit.xcodeproj', 'project.pbxproj'), 'utf8');
            // An iOS deployment target, which Package.swift lists as a platform. Build settings don't reach Package.swift for
            // this project's ids yet, and generation replaces the macOS version with the host's.
            const edited = original.replace('MACOSX_DEPLOYMENT_TARGET = 10.13;', 'MACOSX_DEPLOYMENT_TARGET = 10.13;\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;');
            const projectChange = { glob: '**/*.pbxproj', event: 'change', relative: 'SampleKit.xcodeproj/project.pbxproj' };
            const [open, generate] = runSteps(workspace, [
                { kind: 'activate', answers: [null] },
                // Xcode saves the edit while the Generate dialog is open.
                {
                    kind: 'command', id: 'vsxcode.createFromXcodeproj',
                    answers: [{ answer: FULLY, during: { ...projectChange, write: { relative: projectChange.relative, contents: edited } } }]
                }
            ]);
            const expect = expectations('fully from Generate');
            for (const result of [open, generate]) { checkNoCrash(result, expect); }
            expect.that(edited !== original, 'the project edit matched nothing');
            expect.that(of(generate, 'dialog').length === 1, `expected one dialog, saw ${of(generate, 'dialog').length}`);
            expect.that(fs.readFileSync(path.join(workspace.root, 'Package.swift'), 'utf8').includes('.iOS('),
                'Package.swift misses the project edit saved while the dialog was open');
            return { workspace, problems: expect.problems, logs: [open, generate] };
        }
    }
];

function main() {
    let failures = 0;
    for (const scenario of SCENARIOS) {
        let outcome;
        try {
            outcome = scenario.run();
        } catch (error) {
            outcome = { problems: [`threw: ${error.stack || error}`], logs: [] };
        }
        if (outcome.problems.length === 0) {
            console.log(`  PASS  ${scenario.name}`);
        } else {
            failures++;
            console.log(`  FAIL  ${scenario.name}`);
            for (const problem of outcome.problems) { console.log(`        ${problem}`); }
            for (const [index, result] of outcome.logs.entries()) {
                for (const line of (result.log || []).slice(-12)) { console.log(`        log ${index}: ${line.slice(0, 160)}`); }
            }
        }
        if (outcome.workspace) {
            fs.rmSync(outcome.workspace.root, { recursive: true, force: true });
            fs.rmSync(outcome.workspace.statePath, { force: true });
        }
    }
    if (failures > 0) {
        console.log(`\n${failures} scenario(s) failed.`);
        process.exitCode = 1;
        return;
    }
    console.log('\nSwiftPM project check OK.');
}

if (process.argv[2] === '--child') {
    runChild(JSON.parse(process.argv[3]));
} else {
    main();
}
