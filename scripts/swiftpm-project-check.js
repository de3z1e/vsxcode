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
 * Projects in Xcode's JSON format (project.xcproj) get the same choice, listing and backing up project.xcproj. The
 * extension's own handling of the project file is checked through the same activation: a setting command writes only a
 * changed text, which xcprojformatter leaves as it is; a project file appearing in a package checkout, or the workspace
 * project's own file saved atomically, changes nothing; a second definition file in the bundle is reported once, in
 * Xcode's words, after a re-check; and the switch to the JSON file refreshes once. These need Xcode 27.2 or later.
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

function fileTimes(root) {
    const times = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                times[path.relative(root, full)] = fs.statSync(full).mtimeMs;
            }
        }
    };
    walk(root);
    return times;
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
    // Answers for showInputBox and showQuickPick, kept apart from the modal dialogs' so existing steps answer as before.
    let inputs = [];
    let stepStart = {};
    const watchers = [];
    const commands = new Map();
    const disposable = { dispose() {} };
    const readSettings = () => {
        try { return JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8')); } catch { return {}; }
    };
    /** Writes or removes the file an event names, if any, then delivers the event to the live watchers for its glob. */
    const fire = ({ write, remove, glob, event, relative }) => {
        if (write) {
            fs.mkdirSync(path.dirname(path.join(root, write.relative)), { recursive: true });
            fs.writeFileSync(path.join(root, write.relative), write.contents);
        }
        if (remove) { fs.rmSync(path.join(root, remove)); }
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
            showQuickPick: async (items, options) => {
                record('quickPick', { placeHolder: options && options.placeHolder });
                const answer = inputs.shift();
                const labelOf = (item) => (typeof item === 'string' ? item : item && item.label);
                return answer === undefined ? undefined : (await items).find((item) => labelOf(item) === answer);
            },
            // Records only item labels (My Mac's description holds this Mac's name); answered from `inputs` by label, else closed.
            createQuickPick: () => {
                const handlers = { accept: [], hide: [] };
                const quickPick = {
                    items: [], activeItems: [], selectedItems: [], placeholder: '',
                    onDidAccept: (listener) => { handlers.accept.push(listener); return disposable; },
                    onDidHide: (listener) => { handlers.hide.push(listener); return disposable; },
                    onDidChangeSelection: () => disposable,
                    onDidChangeActive: () => disposable,
                    onDidChangeValue: () => disposable,
                    show() {
                        record('createQuickPick', { placeholder: quickPick.placeholder, labels: quickPick.items.map((item) => item.label) });
                        const answer = inputs.shift();
                        const item = answer === undefined ? undefined : quickPick.items.find((candidate) => candidate.label === answer);
                        setImmediate(() => {
                            if (item) {
                                quickPick.selectedItems = [item];
                                for (const listener of handlers.accept) { listener(); }
                            } else {
                                for (const listener of handlers.hide) { listener(); }
                            }
                        });
                    },
                    hide() { for (const listener of handlers.hide) { listener(); } },
                    dispose() {}
                };
                return quickPick;
            },
            showInputBox: async (options) => {
                record('inputBox', { prompt: options && options.prompt, value: options && options.value });
                return inputs.shift();
            },
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
            inputs = [...(step.inputs || [])];
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
                hashes: hashFiles(root),
                times: fileTimes(root)
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

// SyncApp in the JSON format: Xcode's conversion of pbxproj/synchronized.txt.
const SYNC_APP_JSON = fs.readFileSync(path.join(FIXTURES, 'xcproj', 'synchronized.xcproj.txt'), 'utf8');
const SYNC_APP_PBXPROJ = fs.readFileSync(path.join(FIXTURES, 'pbxproj', 'synchronized.txt'), 'utf8');

/** `text` with `from` replaced by `to`, which must occur exactly once. */
function replaceOnce(text, from, to) {
    const count = text.split(from).length - 1;
    if (count !== 1) { throw new Error(`the fixture holds ${count} of ${JSON.stringify(from)}, not one`); }
    return text.replace(from, () => to);
}

/** xcprojformatter's canonical form of a bundle's project.xcproj, or undefined when it rejects the file. */
function xcprojCanonical(bundle) {
    const result = spawnSync('/usr/bin/xcrun', ['xcprojformatter', bundle], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout : undefined;
}

const logLines = (result, text) => (result.log || []).filter((line) => line.includes(text));

/** An available iOS simulator's name, to pick in the device picker. Never printed: simulators can carry custom names. */
function availableSimulatorName() {
    const result = spawnSync('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' });
    if (result.status !== 0) { return undefined; }
    for (const [runtime, devices] of Object.entries(JSON.parse(result.stdout).devices)) {
        if (/iOS/.test(runtime) && devices.length > 0) { return devices[0].name; }
    }
    return undefined;
}

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
    } else if (kind === 'swiftpm-json') {
        write('SampleKit.xcodeproj/project.xcproj', fs.readFileSync(path.join(FIXTURES, 'xcproj', 'generated-ids.xcproj.txt'), 'utf8'));
        write('Sources/SampleKit/SampleKit.swift', 'public struct SampleKit {}\n');
        write('Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n\nlet package = Package(name: "SampleKit", targets: [.target(name: "SampleKit")])\n');
        write('.vscode/settings.json', '{\n    "editor.tabSize": 4\n}\n');
        write('.vscode/.swift-format', '{\n    "version": 1,\n    "lineLength": 120\n}\n');
    } else if (kind === 'ordinary-json') {
        write('SyncApp.xcodeproj/project.xcproj', SYNC_APP_JSON);
        write('SyncApp/ContentView.swift', 'struct ContentView {}\n');
        write('Extras/Helper.swift', 'enum Helper {}\n');
        write('Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n\nlet package = Package(name: "SyncApp")\n');
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
    },
    {
        name: 'SwiftPM project in the JSON format, used fully: project.xcproj listed and backed up',
        run() {
            const workspace = makeWorkspace('swiftpm-json');
            const initial = hashFiles(workspace.root);
            const [open] = runSteps(workspace, [{ kind: 'activate', answers: [FULLY] }]);
            const expect = expectations('JSON fully');
            checkNoCrash(open, expect);
            const dialogs = of(open, 'dialog');
            expect.that(dialogs.length === 1, `expected one dialog, saw ${dialogs.length}`);
            if (dialogs[0]) {
                expect.that(dialogs[0].detail.includes(path.join(workspace.root, 'SampleKit.xcodeproj', 'project.xcproj')), "the dialog doesn't list project.xcproj");
                expect.that(dialogs[0].detail.includes('project.xcproj_backup'), "the dialog doesn't name project.xcproj_backup");
                expect.that(!dialogs[0].detail.includes('project.pbxproj'), 'the dialog lists a project.pbxproj the bundle lacks');
            }
            expect.that(open.hashes['SampleKit.xcodeproj/project.xcproj_backup'] === initial['SampleKit.xcodeproj/project.xcproj'],
                "project.xcproj_backup doesn't hold the original project.xcproj");
            expect.that(open.changed.includes('Package.swift'), 'Package.swift not regenerated');
            expect.that(SYNC_WATCHERS.every((glob) => syncWatchers(open).includes(glob)), `sync watchers not started (${syncWatchers(open)})`);
            return { workspace, problems: expect.problems, logs: [open] };
        }
    },
    {
        name: 'JSON project: a setting command writes only a changed text, which xcprojformatter leaves as it is',
        run() {
            const workspace = makeWorkspace('ordinary-json');
            const projectFile = 'SyncApp.xcodeproj/project.xcproj';
            // The file gets a bundle id the sidebar hasn't seen, so the command's own early return can't hide a write.
            const renamed = replaceOnce(SYNC_APP_JSON, '"com.example.SyncApp"', '"com.example.Renamed"');
            const [open, edited, unchanged, changed] = runSteps(workspace, [
                { kind: 'activate' },
                { kind: 'fire', write: { relative: projectFile, contents: renamed } },
                { kind: 'command', id: 'vsxcode.sidebar.changeBundleId', inputs: ['com.example.Renamed'] },
                { kind: 'command', id: 'vsxcode.sidebar.changeBundleId', inputs: ['com.example.BrandNew'] }
            ]);
            const expect = expectations('setting');
            for (const result of [open, edited, unchanged, changed]) { checkNoCrash(result, expect); }
            expect.that(of(unchanged, 'inputBox').length === 1 && of(changed, 'inputBox').length === 1, 'the command asked for no bundle id');
            expect.that(!unchanged.changed.includes(projectFile), 'the unchanged value rewrote project.xcproj');
            expect.that(unchanged.times[projectFile] === edited.times[projectFile], 'the unchanged value touched project.xcproj');
            // With nothing written there's no watcher event, so the command reloads the sidebar's data itself.
            expect.that(logLines(unchanged, 'already holds that value').length === 1 && logLines(unchanged, '[sidebar] project data loaded').length === 1,
                "the unchanged value didn't reload the sidebar");
            expect.that(changed.changed.includes(projectFile), 'the new value was not written');
            const text = fs.readFileSync(path.join(workspace.root, projectFile), 'utf8');
            expect.that(text.includes('"com.example.BrandNew"') && !text.includes('"com.example.Renamed"'), 'project.xcproj misses the new bundle id');
            expect.that(xcprojCanonical(path.join(workspace.root, 'SyncApp.xcodeproj')) === text, 'xcprojformatter changes the written project.xcproj');
            for (const result of [unchanged, changed]) {
                expect.that(of(result, 'notice').length === 0 && of(result, 'error').length === 0,
                    `the command warned: ${[...of(result, 'notice'), ...of(result, 'error')].map((event) => event.message)}`);
            }
            return { workspace, problems: expect.problems, logs: [open, edited, unchanged, changed] };
        }
    },
    {
        name: "a bundle id formula, as in Xcode 27's untitled app projects: the box edits the formula and notes the resolved id",
        run() {
            const workspace = makeWorkspace('ordinary-json');
            const projectFile = 'SyncApp.xcodeproj/project.xcproj';
            const formula = 'devplaceholder.$(PROJECT_UNIQUE_VALUE:identifier).$(PRODUCT_NAME:rfc1034identifier)';
            // Recorded from xcodebuild -showBuildSettings on Xcode 27.2: :identifier turns a leading digit and punctuation into `_`.
            const resolved = 'devplaceholder._F3c_41e2_Sample.SyncApp';
            const text = replaceOnce(replaceOnce(SYNC_APP_JSON, '"com.example.SyncApp"', JSON.stringify(formula)),
                '    "IPHONEOS_DEPLOYMENT_TARGET": "18.0",\n', '    "IPHONEOS_DEPLOYMENT_TARGET": "18.0",\n    "PROJECT_UNIQUE_VALUE": "9F3c-41e2.Sample",\n');
            fs.writeFileSync(path.join(workspace.root, projectFile), text);
            const [open, ask] = runSteps(workspace, [
                { kind: 'activate' },
                // Escape: the box's contents are the check, and nothing may be written.
                { kind: 'command', id: 'vsxcode.sidebar.changeBundleId', inputs: [] }
            ]);
            const expect = expectations('formula');
            for (const result of [open, ask]) { checkNoCrash(result, expect); }
            const box = of(ask, 'inputBox')[0];
            expect.that(box !== undefined, 'the command showed no input box');
            if (box) {
                expect.that(box.value === formula, `the box opened with ${JSON.stringify(box.value)}, not the formula`);
                expect.that(box.prompt === `Bundle Identifier · Resolved: ${resolved}`, `the box's prompt was ${JSON.stringify(box.prompt)}`);
            }
            expect.that(logLines(open, `bundle id resolved: ${resolved}`).length === 1, 'the sidebar logged no resolved bundle id');
            expect.that(!ask.changed.includes(projectFile), 'escaping the box changed project.xcproj');
            return { workspace, problems: expect.problems, logs: [open, ask] };
        }
    },
    {
        name: 'the device picker opened while the sidebar reloads still lists My Mac',
        run() {
            const workspace = makeWorkspace('ordinary-json');
            const projectFile = 'SyncApp.xcodeproj/project.xcproj';
            // A project that builds for macOS too, so the picker owes it a My Mac entry.
            fs.writeFileSync(path.join(workspace.root, projectFile), replaceOnce(SYNC_APP_JSON, '    "SDKROOT": "iphoneos",\n',
                '    "SDKROOT": "iphoneos",\n    "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator macosx",\n'));
            const [open, changed, picker] = runSteps(workspace, [
                { kind: 'activate' },
                // Drops the sidebar's data, and with no tree drawn nothing reloads it, as with the view hidden.
                { kind: 'fire', glob: '**/*.xcproj', event: 'change', relative: projectFile },
                { kind: 'command', id: 'vsxcode.sidebar.selectSimulator', inputs: [] }
            ]);
            const expect = expectations('device picker');
            for (const result of [open, changed, picker]) { checkNoCrash(result, expect); }
            const pickers = of(picker, 'createQuickPick');
            expect.that(pickers.length === 1, `expected one picker, saw ${pickers.length}`);
            if (pickers[0]) {
                // A count, not labels: the other entries are this Mac's paired devices, whose names are private.
                expect.that(pickers[0].labels.includes('My Mac'), `the picker lists no My Mac among its ${pickers[0].labels.length} entries`);
            }
            return { workspace, problems: expect.problems, logs: [open, changed, picker] };
        }
    },
    {
        name: 'picking a device redraws the sidebar with its data in place',
        run() {
            const workspace = makeWorkspace('ordinary-json');
            const simulator = availableSimulatorName();
            const expect = expectations('device pick');
            if (!simulator) {
                expect.that(false, 'no available iOS simulator to pick');
                return { workspace, problems: expect.problems, logs: [] };
            }
            const [open, picked, toggled] = runSteps(workspace, [
                { kind: 'activate' },
                { kind: 'command', id: 'vsxcode.sidebar.selectSimulator', inputs: [simulator] },
                // The dev toggle's log line reads the sidebar's data directly: had the pick dropped it, it would name no bundle id.
                { kind: 'command', id: 'vsxcode.sidebar.toggleDevBundleId' }
            ]);
            for (const result of [open, picked, toggled]) { checkNoCrash(result, expect); }
            const stored = JSON.parse(fs.readFileSync(workspace.statePath, 'utf8')).buildTaskConfig || {};
            expect.that(stored.simulatorDevice === simulator, 'the picked simulator was not stored');
            expect.that(logLines(toggled, 'builds install as com.example.SyncApp-dev').length === 1,
                `the sidebar's data was gone after the pick: ${JSON.stringify(logLines(toggled, '[dev-bundle-id]'))}`);
            return { workspace, problems: expect.problems, logs: [open, picked, toggled] };
        }
    },
    {
        name: 'project file events: checkouts and atomic saves change nothing, two definition files are reported once, a switch refreshes once',
        run() {
            const workspace = makeWorkspace('ordinary');
            // The JSON file names another deployment version, so the regeneration after the switch shows in Package.swift.
            const json = replaceOnce(SYNC_APP_JSON, '"IPHONEOS_DEPLOYMENT_TARGET": "18.0"', '"IPHONEOS_DEPLOYMENT_TARGET": "16.0"');
            const [open, checkout, save, second, again, removed] = runSteps(workspace, [
                { kind: 'activate' },
                {
                    kind: 'fire', glob: '**/*.pbxproj', event: 'create', relative: 'Packages/Kit/Kit.xcodeproj/project.pbxproj',
                    write: { relative: 'Packages/Kit/Kit.xcodeproj/project.pbxproj', contents: SYNC_APP_PBXPROJ }
                },
                {
                    kind: 'fire', glob: '**/*.pbxproj', event: 'create', relative: 'SyncApp.xcodeproj/project.pbxproj',
                    write: { relative: 'SyncApp.xcodeproj/project.pbxproj', contents: SYNC_APP_PBXPROJ }
                },
                {
                    kind: 'fire', glob: '**/*.xcproj', event: 'create', relative: 'SyncApp.xcodeproj/project.xcproj',
                    write: { relative: 'SyncApp.xcodeproj/project.xcproj', contents: json }
                },
                { kind: 'fire', glob: '**/*.xcproj', event: 'create', relative: 'SyncApp.xcodeproj/project.xcproj' },
                {
                    kind: 'fire', glob: '**/*.pbxproj', event: 'delete', relative: 'SyncApp.xcodeproj/project.pbxproj',
                    remove: 'SyncApp.xcodeproj/project.pbxproj'
                }
            ]);
            const expect = expectations('events');
            for (const result of [open, checkout, save, second, again, removed]) { checkNoCrash(result, expect); }
            expect.that(fs.readFileSync(path.join(workspace.root, 'Package.swift'), 'utf8') !== '' && open.changed.includes('Package.swift'), 'Package.swift not generated on open');
            for (const [label, result] of [['a package checkout\'s create', checkout], ['an atomic save', save]]) {
                expect.that(logLines(result, '[file-watcher]').length === 0, `${label} logged ${logLines(result, '[file-watcher]')}`);
                expect.that(!result.changed.includes('Package.swift'), `${label} regenerated Package.swift`);
            }
            const multiple = (result) => of(result, 'error').filter((event) => event.message.includes('has multiple project definition files'));
            expect.that(multiple(second).length === 1, `expected one "multiple project definition files" message, saw ${multiple(second).length}`);
            if (multiple(second)[0]) {
                const message = multiple(second)[0].message;
                expect.that(message.includes('SyncApp.xcodeproj/project.xcproj') && message.includes('SyncApp.xcodeproj/project.pbxproj'),
                    `the message names neither file: ${message}`);
            }
            expect.that(multiple(again).length === 0 && logLines(again, '[file-watcher]').length === 0, 'a second create reported again');
            expect.that(logLines(removed, '[file-watcher]').length === 1 && logLines(removed, 'now uses project.xcproj').length === 1,
                `the switch logged ${JSON.stringify(logLines(removed, '[file-watcher]'))}`);
            expect.that(removed.changed.includes('Package.swift') && fs.readFileSync(path.join(workspace.root, 'Package.swift'), 'utf8').includes('.iOS(.v16)'),
                'Package.swift not regenerated from project.xcproj after the switch');
            expect.that(of(removed, 'error').length === 0, `the switch showed ${of(removed, 'error').map((event) => event.message)}`);
            return { workspace, problems: expect.problems, logs: [open, checkout, save, second, again, removed] };
        }
    }
];

/** Whether Xcode 27.2 or later is selected: the JSON cases need xcprojformatter. */
function hasJsonXcode() {
    const result = spawnSync('/usr/bin/xcrun', ['-f', 'xcprojformatter'], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim() !== '';
}

function main() {
    if (!hasJsonXcode()) {
        console.error('test:swiftpm-project needs Xcode 27.2 or later selected for its JSON cases: `xcrun -f xcprojformatter` found nothing.');
        process.exitCode = 1;
        return;
    }
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
