#!/usr/bin/env node
/**
 * Sidebar data check.
 *
 * Runs the compiled SidebarProvider (out/providers/sidebarProvider.js) in plain Node against a stubbed `vscode`, on a temp
 * copy of the JSON SyncApp fixture. Each case changes the target's Swift version twice with VSXcode's own writers, calls
 * `refresh()` after each change as the project-file watcher does, and lets the tree ask for its children after every change
 * event as VS Code does. Chosen `xcodebuild -list` calls are delayed so that the order in which two overlapping loads finish
 * is fixed rather than left to timing. Whatever the order, the Swift Language Version row must end on the value the project
 * file holds: a load overtaken by a refresh or a newer load may have read the file before the last change, so it must not
 * publish what it read.
 *
 * Requires a full Xcode: the loads run the real xcodebuild, simctl and devicectl probes.
 *
 * Usage: npm run test:sidebar
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const cp = require('child_process');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'xcproj', 'synchronized.xcproj.txt'), 'utf8');

// ── Delayed xcodebuild -list ─────────────────────────────────────────────────────────
// The sidebar runs `xcodebuild -list` before its other probes, so delaying it delays that load as a whole.

let listDelays = [];
const realExecFile = cp.execFile;
function execFileWithDelays(file, args, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (file === 'xcodebuild' && Array.isArray(args) && args[0] === '-list') {
        const delay = listDelays.length > 0 ? listDelays.shift() : 0;
        setTimeout(() => realExecFile(file, args, options, callback), delay);
        return undefined;
    }
    return realExecFile(file, args, options, callback);
}
execFileWithDelays[util.promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
    execFileWithDelays(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
});
// Before any compiled module loads, since each promisifies execFile when it loads.
cp.execFile = execFileWithDelays;

// ── vscode stub ──────────────────────────────────────────────────────────────────────

let workspaceRoot = '';
class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; };
    }
    fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
    dispose() {}
}
const disposable = { dispose() {} };
const vscodeStub = {
    EventEmitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    workspace: { get workspaceFolders() { return [{ uri: { fsPath: workspaceRoot } }]; } },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
        onDidChangeTerminalShellIntegration: () => disposable,
        onDidCloseTerminal: () => disposable
    },
    commands: { executeCommand: async () => undefined }
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? 'vscode' : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const { SidebarProvider } = require(path.join(OUT, 'providers', 'sidebarProvider.js'));
const { updateBuildSetting } = require(path.join(OUT, 'writers', 'projectEdit.js'));
const { getBuildSettingsForTarget, resolveConfigurationListId } = require(path.join(OUT, 'parsers', 'buildSettings.js'));
const { parseNativeTargets } = require(path.join(OUT, 'parsers', 'targets.js'));
const { writeProjectFile } = require(path.join(OUT, 'utils', 'projectFile.js'));

// ── Cases ────────────────────────────────────────────────────────────────────────────

const CASES = [
    // The bug this check pins: the second refresh comes while the first load runs, and the first load finishes last.
    { name: 'overlapping loads, the older finishing last', listDelays: [0, 2500, 0], between: 300, olderFinishesLast: true },
    { name: 'overlapping loads, the newer finishing last', listDelays: [0, 0, 2500], between: 300, olderFinishesLast: false },
    { name: 'loads one after the other', listDelays: [0, 2500, 0], between: 'settle' }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCase(testCase) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-sidebar-')));
    workspaceRoot = root;
    listDelays = [...testCase.listDelays];
    const logs = [];
    try {
        const bundle = path.join(root, 'SyncApp.xcodeproj');
        fs.mkdirSync(bundle);
        fs.writeFileSync(path.join(bundle, 'project.xcproj'), FIXTURE);
        fs.mkdirSync(path.join(root, 'SyncApp'));
        fs.writeFileSync(path.join(root, 'SyncApp', 'ContentView.swift'), 'struct ContentView {}\n');

        const config = { projectFile: 'SyncApp.xcodeproj', targetName: 'SyncApp', schemeName: 'SyncApp', simulatorDevice: 'none' };
        const workspaceState = { get: (key) => (key === 'buildTaskConfig' ? config : undefined), update: async () => {}, keys: () => [] };
        const provider = new SidebarProvider(workspaceState, (message) => logs.push(message));

        // Every load, in start order, with when it finished; getChildren calls this.loadProjectData, so the wrapper sees all.
        const loads = [];
        let finished = 0;
        const load = provider.loadProjectData.bind(provider);
        provider.loadProjectData = async (...args) => {
            const record = { finishedAs: undefined };
            loads.push(record);
            try { return await load(...args); } finally { record.finishedAs = finished++; }
        };
        const settled = async () => {
            await sleep(50);
            while (loads.some((record) => record.finishedAs === undefined)) { await sleep(50); }
            await sleep(200);
        };

        // The tree asks for its children after every change event, as VS Code does.
        const shown = [];
        const render = async () => {
            const [section] = await provider.getChildren();
            const items = await provider.getChildren(section);
            shown.push((items.find((item) => item.itemType === 'config-swiftVersion') || {}).description);
        };
        provider.onDidChangeTreeData(() => setImmediate(() => { render().catch((error) => shown.push(`threw ${error}`)); }));

        const projectFile = path.join(bundle, 'project.xcproj');
        const setSwiftVersion = async (value) => {
            const original = fs.readFileSync(projectFile, 'utf8');
            const target = parseNativeTargets(original).find((candidate) => candidate.name === 'SyncApp');
            let text = original;
            for (const configId of resolveConfigurationListId(original, target.buildConfigurationListId)) {
                text = updateBuildSetting(text, configId, 'SWIFT_VERSION', value);
            }
            if (!await writeProjectFile(bundle, 'xcproj', text, (message) => logs.push(message))) { throw new Error(`${value} wasn't written`); }
        };

        await render();
        await settled();
        await setSwiftVersion('5.0');
        provider.refresh();
        if (testCase.between === 'settle') { await settled(); } else { await sleep(testCase.between); }
        await setSwiftVersion('6.0');
        provider.refresh();
        await settled();

        const problems = [];
        const text = fs.readFileSync(projectFile, 'utf8');
        const target = parseNativeTargets(text).find((candidate) => candidate.name === 'SyncApp');
        const inFile = getBuildSettingsForTarget(text, target.buildConfigurationListId, 'Debug').swiftVersion;
        const inSidebar = provider.getProjectData()?.swiftVersionByTarget.SyncApp;
        if (inFile !== '6.0') { problems.push(`the project file holds ${inFile}, not 6.0`); }
        if (inSidebar !== inFile) { problems.push(`the sidebar holds ${inSidebar} while the project file holds ${inFile}`); }
        if (shown[shown.length - 1] !== 'Swift 6') { problems.push(`the row last showed ${JSON.stringify(shown[shown.length - 1])}`); }
        // One load to start and one per refresh: the fixture already holds 6.0, so without them every case would pass on the
        // first load alone. Then the order of the refreshes' two loads, so a timing change can't let the first case pass
        // without the older finishing last.
        if (loads.length < 3) { problems.push(`expected a load to start and one per refresh, saw ${loads.length}`); }
        const [older, newer] = loads.slice(-2);
        if (testCase.olderFinishesLast !== undefined && older && newer) {
            const olderLast = older.finishedAs > newer.finishedAs;
            if (olderLast !== testCase.olderFinishesLast) {
                problems.push(`the ${testCase.olderFinishesLast ? 'older' : 'newer'} load didn't finish last, so the case didn't run as planned`);
            }
        }
        return { problems, logs, shown };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────

(async () => {
    let failures = 0;
    for (const testCase of CASES) {
        let outcome;
        try {
            outcome = await runCase(testCase);
        } catch (error) {
            outcome = { problems: [`threw: ${(error && error.stack) || error}`], logs: [], shown: [] };
        }
        if (outcome.problems.length === 0) {
            console.log(`  PASS  ${testCase.name}`);
            continue;
        }
        failures++;
        console.log(`  FAIL  ${testCase.name}`);
        for (const problem of outcome.problems) { console.log(`        ${problem}`); }
        console.log(`        rows shown: ${JSON.stringify(outcome.shown)}`);
        for (const message of outcome.logs.slice(-8)) { console.log(`        log: ${message}`); }
    }
    console.log(failures === 0 ? '\nSidebar check OK.' : `\n${failures} case(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
})();
