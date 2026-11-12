#!/usr/bin/env node
/**
 * Sidebar data check.
 *
 * Runs the compiled SidebarProvider (out/providers/sidebarProvider.js) in plain Node against a stubbed `vscode`, on a temp
 * copy of the JSON SyncApp fixture, changing the target's Swift version with VSXcode's own writers. The tree asks for its
 * children after every change event, as VS Code does, and chosen `xcodebuild -list` calls are delayed so that the order in
 * which overlapping loads finish is fixed rather than left to timing.
 *
 * The refresh cases change the version twice and call `refresh()` after each change, as the project-file watcher does.
 * Whatever order the loads finish in, the Swift Language Version row must end on the value the project file holds: a load
 * overtaken by a refresh or a newer load may have read the file before the last change, so it must not publish what it read.
 * The other cases change it once: a written value must show at once without a load (`applyWrittenSetting`), a command during
 * a reload must wait for that load rather than start another (`ensureProjectData`), and a load that read the file before a
 * write must not paint the older value back. In every case the row must never go blank and no load may run more than one
 * first-launch check. Last, with no Xcode identity a first-launch pass must not be shared.
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
// A load publishes only after its probes, which start once `xcodebuild -list` is done (only a bundle id formula's
// `-showBuildSettings` starts before it), so delaying `-list` delays the load's publish.

let listDelays = [];
let firstLaunchChecks = 0;
let failXcodeSelect = false;
const realExecFile = cp.execFile;
// Arguments pass through as given (exec, for one, calls execFile without an argument list).
function execFileWithDelays(...args) {
    const [file, list] = args;
    if (failXcodeSelect && file === 'xcode-select') {
        const callback = args.find((arg) => typeof arg === 'function');
        setImmediate(() => callback(Object.assign(new Error('xcode-select: no developer directory'), { code: 2 }), '', ''));
        return undefined;
    }
    const xcodebuild = file === 'xcodebuild' && Array.isArray(list);
    if (xcodebuild && list[0] === '-checkFirstLaunchStatus') { firstLaunchChecks++; }
    if (xcodebuild && list[0] === '-list') {
        const delay = listDelays.length > 0 ? listDelays.shift() : 0;
        setTimeout(() => realExecFile(...args), delay);
        return undefined;
    }
    return realExecFile(...args);
}
execFileWithDelays[util.promisify.custom] = (...args) => new Promise((resolve, reject) => {
    execFileWithDelays(...args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
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
    { name: 'loads one after the other', listDelays: [0, 2500, 0], between: 'settle' },
    // A written value shows at once, without a load; the reload its file change starts then keeps it.
    { name: 'a written setting shows at once', listDelays: [0, 0], flow: 'written', expected: '5.0' },
    // A command during a reload waits for that load instead of starting another, and gets the file's value.
    { name: 'a command during a reload waits for it', listDelays: [0, 1500], flow: 'ensure', expected: '5.0' },
    // A load that read the file before a write (one no refresh started, as after a setting already in the file) must not
    // paint the older value over the written one when it finishes.
    { name: 'a load that read the file before a write keeps the written value', listDelays: [0, 1500], flow: 'stale-load', expected: '5.0' },
    // A command acting on what a load works out from the selection waits for the running load, unlike one that only needs data.
    { name: 'a command that needs the settled data waits for the running load', listDelays: [0, 1500], flow: 'settled', expected: '5.0' }
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

        firstLaunchChecks = 0;
        await render();
        await settled();
        const problems = [];
        if (testCase.flow === 'written') {
            const before = loads.length;
            await setSwiftVersion('5.0');
            provider.applyWrittenSetting('SyncApp', 'SWIFT_VERSION', '5.0');
            await sleep(50);
            if (shown[shown.length - 1] !== 'Swift 5') { problems.push(`50 ms after the write the row showed ${JSON.stringify(shown[shown.length - 1])}`); }
            if (loads.length !== before) { problems.push('showing the written value started a load'); }
            // The project-file watcher's refresh.
            provider.refresh();
            await settled();
        } else if (testCase.flow === 'stale-load') {
            const running = provider.loadProjectData(config);
            await sleep(200);
            await setSwiftVersion('5.0');
            provider.applyWrittenSetting('SyncApp', 'SWIFT_VERSION', '5.0');
            await running;
            await settled();
        } else if (testCase.flow === 'settled') {
            await setSwiftVersion('5.0');
            const running = provider.loadProjectData(config);
            await sleep(200);
            const before = loads.length;
            const current = await provider.ensureProjectData(config);
            if (current?.swiftVersionByTarget.SyncApp !== '6.0') { problems.push(`ensureProjectData returned ${current?.swiftVersionByTarget.SyncApp}, not the data in place (6.0)`); }
            const afterLoad = await provider.settledProjectData(config);
            if (afterLoad?.swiftVersionByTarget.SyncApp !== '5.0') { problems.push(`settledProjectData returned ${afterLoad?.swiftVersionByTarget.SyncApp}, not the running load's 5.0`); }
            if (loads.length !== before) { problems.push(`waiting started ${loads.length - before} load(s)`); }
            await running;
            await settled();
        } else if (testCase.flow === 'ensure') {
            await setSwiftVersion('5.0');
            provider.refresh();
            await sleep(200);
            const before = loads.length;
            const data = await provider.ensureProjectData(config);
            if (loads.length !== before) { problems.push(`the command started ${loads.length - before} load(s) instead of waiting for the running one`); }
            if (data?.swiftVersionByTarget.SyncApp !== '5.0') { problems.push(`the command got ${data?.swiftVersionByTarget.SyncApp}, not 5.0`); }
            await settled();
        } else {
            await setSwiftVersion('5.0');
            provider.refresh();
            if (testCase.between === 'settle') { await settled(); } else { await sleep(testCase.between); }
            await setSwiftVersion('6.0');
            provider.refresh();
            await settled();
        }

        const text = fs.readFileSync(projectFile, 'utf8');
        const target = parseNativeTargets(text).find((candidate) => candidate.name === 'SyncApp');
        const inFile = getBuildSettingsForTarget(text, target.buildConfigurationListId, 'Debug').swiftVersion;
        const inSidebar = provider.getProjectData()?.swiftVersionByTarget.SyncApp;
        const expected = testCase.expected || '6.0';
        if (inFile !== expected) { problems.push(`the project file holds ${inFile}, not ${expected}`); }
        if (inSidebar !== inFile) { problems.push(`the sidebar holds ${inSidebar} while the project file holds ${inFile}`); }
        if (shown[shown.length - 1] !== `Swift ${expected.replace(/\.0$/, '')}`) { problems.push(`the row last showed ${JSON.stringify(shown[shown.length - 1])}`); }
        // The tree waits for the newest load, so the row never goes blank in between.
        if (shown.includes('')) { problems.push(`the row went blank: ${JSON.stringify(shown)}`); }
        // One first-launch check serves a whole load, or none when a recent pass is still trusted.
        if (firstLaunchChecks > loads.length) { problems.push(`${firstLaunchChecks} first-launch checks for ${loads.length} load(s)`); }
        // One load to start and one per refresh: the fixture already holds 6.0, so without them the refresh cases would pass
        // on the first load alone. Then the order of the refreshes' two loads, so a timing change can't let the first case pass
        // without the older finishing last.
        if (!testCase.flow && loads.length < 3) { problems.push(`expected a load to start and one per refresh, saw ${loads.length}`); }
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
    // With no Xcode identity (xcode-select failing) a first-launch pass isn't shared: nothing ties it to one Xcode.
    const { isXcodeFirstLaunchComplete } = require(path.join(OUT, 'utils', 'version.js'));
    failXcodeSelect = true;
    firstLaunchChecks = 0;
    try {
        await isXcodeFirstLaunchComplete();
        await isXcodeFirstLaunchComplete();
    } finally {
        failXcodeSelect = false;
    }
    if (firstLaunchChecks === 2) {
        console.log('  PASS  with no Xcode identity, a first-launch pass is not shared');
    } else {
        failures++;
        console.log('  FAIL  with no Xcode identity, a first-launch pass is not shared');
        console.log(`        ${firstLaunchChecks} first-launch check(s) for two calls, not 2`);
    }
    console.log(failures === 0 ? '\nSidebar check OK.' : `\n${failures} case(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
})();
