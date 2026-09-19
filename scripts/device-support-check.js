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
 * to what an independent restatement of the rule picks.
 *
 * Usage: npm run test:device-support
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(path.resolve(__dirname, '..'), 'out');
const { DEVICE_SUPPORT_ROOT, deviceSupportFolderName, findDeviceSymbols } = require(path.join(OUT, 'utils/deviceSupport.js'));

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

async function main() {
    checkNames();
    await checkLayouts();
    await checkRealTree();
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
