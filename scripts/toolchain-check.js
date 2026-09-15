#!/usr/bin/env node
/**
 * Toolchain check: does the compiled extension describe each installed Xcode correctly and pick
 * the right way to show a simulator?
 *
 * Xcode 27 replaced Simulator.app with Device Hub and its `devices:` URL scheme, and the
 * behaviour is gated on the selected Xcode's version. This runs the compiled
 * src/utils/xcodeToolchain.ts under every Xcode found among XCODE_APPS (via DEVELOPER_DIR,
 * which `xcode-select -p` honors), so both branches are exercised on a Mac that has both
 * Xcodes installed and neither is silently skipped when only one is.
 *
 * Usage: npm run test:toolchain
 *        VSXCODE_XCODE_APPS=/path/Xcode-27.app:/path/Xcode-26.app npm run test:toolchain
 *        (colon-separated bundles, for Xcodes installed somewhere other than the defaults)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const XCODE_APPS = (process.env.VSXCODE_XCODE_APPS || '/Applications/Xcode.app:/Applications/Xcode_26.app')
    .split(':').filter((entry) => entry.length > 0);
const DEVICE_HUB_MIN_MAJOR = 27;

const toolchain = require(path.join(OUT, 'utils/xcodeToolchain.js'));

let failures = 0;
function report(ok, label, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
    if (!ok) { failures += 1; }
}

// ── Pure helpers, no Xcode needed ────────────────────────────────────────────────────

function checkHelpers() {
    console.log('helpers');
    report(JSON.stringify(toolchain.parseXcodeVersion('Xcode 27.0\nBuild version 27A266a')) === '{"major":27,"minor":0}',
        'parseXcodeVersion reads "Xcode 27.0"');
    report(JSON.stringify(toolchain.parseXcodeVersion('Xcode 26.6\nBuild version 17F113')) === '{"major":26,"minor":6}',
        'parseXcodeVersion reads "Xcode 26.6"');
    report(toolchain.parseXcodeVersion('xcodebuild: error: ...') === null, 'parseXcodeVersion rejects garbage');
    report(toolchain.xcodeAppPath('/Applications/Xcode.app/Contents/Developer') === '/Applications/Xcode.app',
        'xcodeAppPath strips Contents/Developer');
    report(toolchain.xcodeAppPath('/Library/Developer/CommandLineTools') === null, 'xcodeAppPath rejects a non-bundle directory');

    const dev = '/Applications/Any.app/Contents/Developer';
    const hub = '/Applications/Any.app/Contents/Applications/DeviceHub.app';
    const sim = `${dev}/Applications/Simulator.app`;
    const only = (...present) => (candidate) => present.includes(candidate);
    report(toolchain.resolveSimulatorUI(dev, { major: 27, minor: 0 }, only(hub))?.kind === 'deviceHub',
        'Xcode 27 with DeviceHub.app → deviceHub');
    report(toolchain.resolveSimulatorUI(dev, { major: 27, minor: 0 }, only(sim))?.kind === 'simulatorApp',
        'Xcode 27 without DeviceHub.app falls back to Simulator.app when present');
    report(toolchain.resolveSimulatorUI(dev, { major: 26, minor: 6 }, only(hub, sim))?.kind === 'simulatorApp',
        'Xcode 26 → Simulator.app even if a DeviceHub.app exists');
    report(toolchain.resolveSimulatorUI(dev, null, only(sim))?.kind === 'simulatorApp',
        'unknown version → Simulator.app when present');
    report(toolchain.resolveSimulatorUI(dev, { major: 27, minor: 0 }, only()) === null, 'nothing installed → null');
    report(toolchain.resolveSimulatorUI('', null, only(hub, sim)) === null, 'no developer directory → null');

    const noUI = { developerDir: dev, appPath: '/Applications/Any.app', version: { major: 27, minor: 0 }, simulatorUI: null };
    report(toolchain.revealSimulatorCommand('ABCD-1234', noUI) === 'true', 'no simulator UI → no-op snippet');
    const hubUI = { ...noUI, simulatorUI: { kind: 'deviceHub', appPath: hub } };
    report(toolchain.revealSimulatorCommand('not a udid; rm -rf /', hubUI) === 'true', 'malformed udid → no-op snippet');
    const quoted = { ...noUI, simulatorUI: { kind: 'simulatorApp', appPath: "/Volumes/It's here/Xcode.app/Contents/Developer/Applications/Simulator.app" } };
    report(toolchain.revealSimulatorCommand('ABCD-1234', quoted) === "open '/Volumes/It'\\''s here/Xcode.app/Contents/Developer/Applications/Simulator.app'",
        'app paths are single-quoted for zsh');
}

// ── Each installed Xcode ─────────────────────────────────────────────────────────────

async function checkXcode(appPath) {
    const developerDir = path.join(appPath, 'Contents', 'Developer');
    console.log(`${appPath}`);
    process.env.DEVELOPER_DIR = developerDir;

    const detected = await toolchain.detectXcodeToolchain();
    report(detected.developerDir === developerDir, 'developerDir follows DEVELOPER_DIR', detected.developerDir);
    report(detected.appPath === appPath, 'appPath is the bundle', detected.appPath);
    report(detected.version !== null, 'version parsed', JSON.stringify(detected.version));
    if (!detected.version) { return; }

    const expectedKind = detected.version.major >= DEVICE_HUB_MIN_MAJOR ? 'deviceHub' : 'simulatorApp';
    report(detected.simulatorUI && detected.simulatorUI.kind === expectedKind, `simulator UI is ${expectedKind}`, detected.simulatorUI && detected.simulatorUI.kind);
    report(detected.simulatorUI && fs.existsSync(detected.simulatorUI.appPath), 'simulator UI app exists', detected.simulatorUI && detected.simulatorUI.appPath);

    report(toolchain.currentXcodeToolchain() === detected, 'sync path serves the primed cache');

    const udid = 'ABCD1234-0000-4000-8000-00000000ABCD';
    const snippet = toolchain.revealSimulatorCommand(udid, detected);
    if (expectedKind === 'deviceHub') {
        report(snippet.startsWith(`{ open -a '${detected.simulatorUI.appPath}' 'devices://device/open?id=${udid}'`),
            'snippet hands the device URL to the selected DeviceHub.app', snippet);
        report(snippet.includes(`|| open '${detected.simulatorUI.appPath}'`), 'snippet falls back to opening DeviceHub.app');
    } else {
        report(snippet === `open '${detected.simulatorUI.appPath}'`, 'snippet opens Simulator.app by path', snippet);
    }
    report(!/open -a '?Simulator'?\b|open -a '?DeviceHub'?\b/.test(snippet), 'snippet never opens by name');
}

async function main() {
    checkHelpers();
    const installed = XCODE_APPS.filter((app) => fs.existsSync(path.join(app, 'Contents', 'Developer')));
    if (installed.length === 0) {
        console.log('  FAIL  no Xcode found among ' + XCODE_APPS.join(', '));
        failures += 1;
    }
    const previous = process.env.DEVELOPER_DIR;
    try {
        for (const app of installed) {
            await checkXcode(app);
        }
    } finally {
        if (previous === undefined) { delete process.env.DEVELOPER_DIR; } else { process.env.DEVELOPER_DIR = previous; }
    }
    if (failures > 0) {
        console.log(`\n${failures} toolchain check failure(s).`);
        process.exit(1);
    }
    console.log('\nToolchain check OK.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
