#!/usr/bin/env node
/**
 * Device-support check: does the symbols lookup find Xcode's extracted device symbols in both
 * folder layouts?
 *
 * Xcode 26 and earlier finish a device's folder under ~/Library/Developer/Xcode/iOS DeviceSupport
 * with `.finalized`, `Info.plist` and `Symbols/` at its root; Xcode 27 nests the same three under an
 * architecture folder (`arm64e/`). This runs the compiled src/utils/deviceSupport.ts over temp
 * folders laid out each way, over the partial states an interrupted or in-progress copy leaves
 * behind, and — when this Mac has one — over the real tree, where every device folder must resolve
 * to what an independent restatement of the rule picks. It also reads `xcodebuild
 * -prepareDeviceSupport` transcripts recorded from Xcode 27.0 and 26.6 (device names and ids
 * replaced by placeholders), whole and cut mid-line, through the output parser the runner uses.
 *
 * Usage: npm run test:device-support
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(path.resolve(__dirname, '..'), 'out');
const { DEVICE_SUPPORT_ROOT, deviceSupportFolderName, findDeviceSymbols, parsePrepareOutput } = require(path.join(OUT, 'utils/deviceSupport.js'));

let failures = 0;
function report(ok, label, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
    if (!ok) { failures += 1; }
}

const DEVICE = { productType: 'iPhone18,2', osVersion: '27.0', osBuildVersion: '24A437' };
const FOLDER = 'iPhone18,2 27.0 (24A437)';

/** Lays `files` (paths relative to the device folder; a trailing slash makes a directory) out under a fresh temp root. */
function layout(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-device-support-'));
    for (const file of files) {
        const target = path.join(root, FOLDER, file);
        if (file.endsWith('/')) {
            fs.mkdirSync(target, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, '');
        }
    }
    return root;
}

// What Xcode leaves behind: `.copying_lock` stays in finished folders of both layouts.
const FLAT = ['.copying_lock', '.finalized', 'Info.plist', 'Symbols/System/', 'Symbols/usr/'];
const ARM64E = ['.copying_lock', '.processed_dyld_shared_cache_arm64e', 'arm64e/.finalized', 'arm64e/Info.plist', 'arm64e/Symbols/System/', 'arm64e/Symbols/usr/'];

async function expectSymbols(label, files, expected, device = DEVICE) {
    const root = layout(files);
    try {
        const found = await findDeviceSymbols(device, root);
        const want = expected === undefined ? undefined : path.join(root, FOLDER, expected);
        report(found === want, label, found === undefined ? 'none' : path.relative(root, found));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function checkNames() {
    console.log('folder names');
    report(deviceSupportFolderName(DEVICE) === FOLDER, 'product type, version and build spell the folder', deviceSupportFolderName(DEVICE));
    report(deviceSupportFolderName({ productType: 'iPhone18,2', osVersion: '26.3.1', osBuildVersion: '23D771330a' }) === 'iPhone18,2 26.3.1 (23D771330a)',
        'a build with a letter suffix is kept verbatim');
    report(deviceSupportFolderName({ ...DEVICE, osBuildVersion: '' }) === undefined, 'a missing build yields no name');
}

async function checkLayouts() {
    console.log('temp layouts');
    await expectSymbols('flat layout (Xcode 26 and earlier) → Symbols at the root', FLAT, 'Symbols');
    await expectSymbols('per-architecture layout (Xcode 27) → arm64e/Symbols', ARM64E, path.join('arm64e', 'Symbols'));
    await expectSymbols('both layouts → the architecture folder wins', [...FLAT, ...ARM64E], path.join('arm64e', 'Symbols'));
    await expectSymbols('arm64 and arm64e both finished → arm64e', [...ARM64E, 'arm64/.finalized', 'arm64/Symbols/System/'], path.join('arm64e', 'Symbols'));
    await expectSymbols('another architecture alone → its folder', ['arm64/.finalized', 'arm64/Symbols/System/'], path.join('arm64', 'Symbols'));
    await expectSymbols('arm64e/Symbols without .finalized (extraction in progress) → none', ['.copying_lock', 'arm64e/Symbols/System/'], undefined);
    await expectSymbols('.finalized without Symbols → none', ['.finalized', 'Info.plist'], undefined);
    await expectSymbols('copy in progress (.copying_lock and .tmp only) → none', ['.copying_lock', '.tmp/usr/lib/'], undefined);
    await expectSymbols('a dot folder is never read as an architecture', ['.copying_lock', '.tmp/.finalized', '.tmp/Symbols/'], undefined);
    await expectSymbols('device folder absent → none', [], undefined);
    await expectSymbols('device without a build → none', FLAT, undefined, { ...DEVICE, osBuildVersion: '' });
}

/** The rule restated on its own: finished architecture folders (arm64e first, then by name), else the flat root. */
function expectedOnDisk(folder) {
    const finished = (dir) => {
        try {
            fs.accessSync(path.join(dir, '.finalized'));
            return fs.statSync(path.join(dir, 'Symbols')).isDirectory();
        } catch {
            return false;
        }
    };
    const architectures = fs.readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'Symbols')
        .map((entry) => entry.name)
        .sort((a, b) => (a === 'arm64e' ? -1 : b === 'arm64e' ? 1 : a.localeCompare(b)));
    for (const architecture of architectures) {
        if (finished(path.join(folder, architecture))) { return path.join(folder, architecture, 'Symbols'); }
    }
    return finished(folder) ? path.join(folder, 'Symbols') : undefined;
}

async function checkRealTree() {
    console.log(`this Mac's tree: ${DEVICE_SUPPORT_ROOT}`);
    let names;
    try {
        names = fs.readdirSync(DEVICE_SUPPORT_ROOT);
    } catch {
        console.log('  skip  no iOS DeviceSupport folder on this Mac');
        return;
    }
    let checked = 0;
    for (const name of names) {
        const match = /^(\S+) (\S+) \((\S+)\)$/.exec(name);
        if (!match) { continue; }
        const folder = path.join(DEVICE_SUPPORT_ROOT, name);
        const found = await findDeviceSymbols({ productType: match[1], osVersion: match[2], osBuildVersion: match[3] });
        report(found === expectedOnDisk(folder), name, found ? path.relative(folder, found) : 'none');
        checked += 1;
    }
    if (checked === 0) { console.log('  skip  no device folders to check'); }
}


// ── xcodebuild -prepareDeviceSupport transcripts ─────────────────────────────────────
//
// Recorded 2026-09-19. Progress is appended to one line without newlines, so every prefix of a
// transcript is something the runner really sees mid-way.

const COPY_RUN_27 = `Starting Device Support Preparation
-----------------------------------
Searching for 30.0 seconds with ["id": "00000000-0000-4000-8000-000000000001", "platform": "iOS"]
Located My iPhone 00008150-000000000000000A
[My iPhone] Copying ....100%
[My iPhone] Extracting .....80%...80%...80%...98%...98%
[My iPhone] Finished
`;
const EXISTING_27 = `Starting Device Support Preparation
-----------------------------------
Searching for 60.0 seconds with ["id": "00008150-000000000000000A", "platform": "iOS"]
Located My iPhone 00008150-000000000000000A
Existing Device Support '/Users/me/Library/Developer/Xcode/iOS DeviceSupport/iPhone18,2 27.0 (24A437)/arm64e/Symbols'
[My iPhone] Finished
`;
// Xcode 26.6: two DVTDeviceOperation lines and no closing quote after the path.
const EXISTING_26 = `Starting Device Support Preparation
-----------------------------------
Searching for 60.0 seconds with [:]
Located My iPhone 00008150-000000000000000A
2026-09-19 14:33:10.677 xcodebuild[74325:51231267]  DVTDeviceOperation: Encountered a build number "" that is incompatible with DVTBuildVersion.
2026-09-19 14:33:10.677 xcodebuild[74325:51231256] [MT] DVTDeviceOperation: Encountered a build number "" that is incompatible with DVTBuildVersion.
Existing Device Support '/Users/me/Library/Developer/Xcode/iOS DeviceSupport/iPhone18,2 26.6.2 (23G90)/Symbols
[My iPhone] Finished
`;
const NOT_FOUND = `Starting Device Support Preparation
-----------------------------------
Searching for 5.0 seconds with ["id": "00000000-000000000000000A", "platform": "iOS"]
No matches found for locator: CoreDevice
No matches found for locator: CoreDevice
No matches found for locator: CoreDevice
No matches found
`;
// The literal exists in Xcode3Core; the reason text is a placeholder.
const CACHING_FAILED = COPY_RUN_27.split('[My iPhone] Extracting')[0] + 'Symbol caching failed: The device disconnected.\n';

function prefixUpTo(transcript, marker) {
    const index = transcript.indexOf(marker);
    if (index < 0) { throw new Error(`marker not in transcript: ${marker}`); }
    return transcript.slice(0, index + marker.length);
}

function expectParsed(label, output, expected) {
    const parsed = parsePrepareOutput(output);
    const mismatches = Object.keys(expected).filter((key) => parsed[key] !== expected[key]);
    report(mismatches.length === 0, label, mismatches.length === 0 ? `${parsed.phase} ${parsed.percent}%` : JSON.stringify(parsed));
}

function checkOutputParsing() {
    console.log('xcodebuild -prepareDeviceSupport output');
    expectParsed('a finished copy run: located, finished', COPY_RUN_27, { deviceName: 'My iPhone', phase: 'finished', existingSymbolsPath: undefined, failure: undefined });
    expectParsed('cut before any progress: searching', prefixUpTo(COPY_RUN_27, 'Located My iPhone 00008150-000000000000000A\n'), { deviceName: 'My iPhone', phase: 'searching', percent: 0 });
    expectParsed('cut inside the first percentage (Copying ....10): copying 0%', prefixUpTo(COPY_RUN_27, 'Copying ....10'), { phase: 'copying', percent: 0 });
    expectParsed('cut after the copy completed: copying 100%', prefixUpTo(COPY_RUN_27, 'Copying ....100%'), { phase: 'copying', percent: 100 });
    expectParsed('cut inside a later percentage (…80%...9): extracting 80%', prefixUpTo(COPY_RUN_27, 'Extracting .....80%...80%...80%...9'), { phase: 'extracting', percent: 80 });
    expectParsed('cut at the end of extraction: extracting 98%', prefixUpTo(COPY_RUN_27, '...98%...98%'), { phase: 'extracting', percent: 98 });
    expectParsed('Xcode 27 existing folder: path between quotes', EXISTING_27, { phase: 'finished', existingSymbolsPath: '/Users/me/Library/Developer/Xcode/iOS DeviceSupport/iPhone18,2 27.0 (24A437)/arm64e/Symbols' });
    expectParsed('Xcode 26.6 existing folder: path without a closing quote, noise ignored', EXISTING_26, { deviceName: 'My iPhone', phase: 'finished', existingSymbolsPath: '/Users/me/Library/Developer/Xcode/iOS DeviceSupport/iPhone18,2 26.6.2 (23G90)/Symbols', failure: undefined });
    expectParsed('unknown device: failure "No matches found", still searching', NOT_FOUND, { deviceName: undefined, phase: 'searching', failure: 'No matches found' });
    expectParsed('symbol caching failure: its reason', CACHING_FAILED, { phase: 'copying', percent: 100, failure: 'The device disconnected.' });
    expectParsed('empty output: searching', '', { deviceName: undefined, phase: 'searching', percent: 0, failure: undefined });
    const bracketed = COPY_RUN_27.split('My iPhone').join('My iPhone [work]');
    expectParsed('a device name holding brackets still parses', prefixUpTo(bracketed, 'Copying ....100%'), { deviceName: 'My iPhone [work]', phase: 'copying', percent: 100 });
}

async function main() {
    checkNames();
    await checkLayouts();
    await checkRealTree();
    checkOutputParsing();
    if (failures > 0) {
        console.log(`\n${failures} device-support check failure(s).`);
        process.exit(1);
    }
    console.log('\nDevice-support check OK.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
