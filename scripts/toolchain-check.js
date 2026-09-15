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

// ── devicectl device lists ───────────────────────────────────────────────────────────
//
// JSON version 5 (Xcode 27's CoreDevice) lists simulators next to hardware and moves the deprecated top-level keys under `properties`; values are placeholders.

function checkDevicectlParsing() {
    console.log('devicectl device lists');
    const { parsePhysicalDevices } = require(path.join(OUT, 'utils/simulator.js'));
    const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

    const v5 = {
        info: { jsonVersion: 5 },
        result: {
            devices: [
                {
                    identifier: 'CORE0000-0000-4000-8000-000000000001',
                    properties: {
                        hardware: { platform: 'iOS', reality: 'physical', udid: '00001111-000A0B0C0D0E0F10', productType: 'iPhone18,2' },
                        connection: { pairingState: 'paired', transportType: 'localNetwork' },
                        software: { osVersionNumber: { stringValue: '26.6.2' }, osBuildVersions: { buildVersion: { name: '23G90' } } },
                        state: { name: 'Sample iPhone', visibilityClass: 'default' }
                    }
                },
                {
                    identifier: 'A0000000-0000-4000-8000-00000000000A',
                    properties: {
                        hardware: { platform: 'iOS', reality: 'simulated', udid: 'A0000000-0000-4000-8000-00000000000A', productType: 'iPhone18,1' },
                        connection: { pairingState: 'paired', transportType: 'sameMachine' },
                        software: { osVersionNumber: { stringValue: '27.0' } },
                        state: { name: 'iPhone 17 Pro', visibilityClass: 'simulators' }
                    }
                },
                {
                    identifier: 'CORE0000-0000-4000-8000-000000000003',
                    properties: {
                        hardware: { platform: 'watchOS', udid: '00002222-000A0B0C0D0E0F10', productType: 'Watch7,12' },
                        connection: { pairingState: 'paired', transportType: 'localNetwork' },
                        state: { name: 'Sample Watch' }
                    }
                },
                {
                    identifier: 'CORE0000-0000-4000-8000-000000000004',
                    properties: {
                        hardware: { platform: 'iOS', reality: 'physical', udid: '00003333-000A0B0C0D0E0F10' },
                        connection: { pairingState: 'unpaired', transportType: 'wired' },
                        state: { name: 'Unpaired iPhone' }
                    }
                },
                {
                    identifier: 'CORE0000-0000-4000-8000-000000000005',
                    properties: {
                        hardware: { platform: 'iOS', reality: 'physical', udid: '00004444-000A0B0C0D0E0F10' },
                        connection: { pairingState: 'paired' },
                        state: { name: 'Unreachable iPhone' }
                    }
                },
                {
                    // A v5 document entry without `properties` is read through the deprecated keys.
                    identifier: 'CORE0000-0000-4000-8000-000000000006',
                    hardwareProperties: { platform: 'iOS', udid: '00005555-000A0B0C0D0E0F10', productType: 'iPhone17,1' },
                    connectionProperties: { pairingState: 'paired', transportType: 'wired' },
                    deviceProperties: { osVersionNumber: '18.6', osBuildUpdate: '22G86' }
                },
                {
                    // No `reality` at all: kept, as the legacy shape would keep it.
                    identifier: 'CORE0000-0000-4000-8000-000000000007',
                    properties: {
                        hardware: { platform: 'iOS', udid: '00006666-000A0B0C0D0E0F10', productType: 'iPhone16,1' },
                        connection: { pairingState: 'paired', transportType: 'localNetwork' },
                        software: { osVersionNumber: { stringValue: '18.6' }, osBuildVersions: { buildVersion: { name: '22G86' } } },
                        state: { name: 'Older iPhone' }
                    }
                }
            ]
        }
    };
    const fromV5 = parsePhysicalDevices(v5);
    report(same(fromV5.map((d) => d.name), ['Sample iPhone', 'Unknown Device', 'Older iPhone']),
        'v5: hardware kept, simulator, watch, unpaired and unreachable entries dropped', JSON.stringify(fromV5.map((d) => d.name)));
    report(same(fromV5[0], {
        name: 'Sample iPhone', udid: '00001111-000A0B0C0D0E0F10', deviceIdentifier: 'CORE0000-0000-4000-8000-000000000001',
        osVersion: '26.6.2', connectionType: 'localNetwork', productType: 'iPhone18,2', osBuildVersion: '23G90'
    }), 'v5: every field read from properties', JSON.stringify(fromV5[0]));
    report(same(fromV5[1], {
        name: 'Unknown Device', udid: '00005555-000A0B0C0D0E0F10', deviceIdentifier: 'CORE0000-0000-4000-8000-000000000006',
        osVersion: '18.6', connectionType: 'wired', productType: 'iPhone17,1', osBuildVersion: '22G86'
    }), 'v5: an entry without properties falls back to the deprecated keys', JSON.stringify(fromV5[1]));

    const legacy = {
        info: { jsonVersion: 4 },
        result: {
            devices: [
                {
                    identifier: 'CORE0000-0000-4000-8000-000000000010',
                    hardwareProperties: { platform: 'iOS', udid: '00007777-000A0B0C0D0E0F10', productType: 'iPhone16,1' },
                    connectionProperties: { pairingState: 'paired', transportType: 'wired' },
                    deviceProperties: { name: 'Legacy iPhone', osVersionNumber: '18.6', osBuildUpdate: '22G86' }
                },
                {
                    identifier: 'CORE0000-0000-4000-8000-000000000011',
                    hardwareProperties: { platform: 'iOS', udid: '00008888-000A0B0C0D0E0F10' },
                    connectionProperties: { pairingState: 'paired' },
                    deviceProperties: { name: 'Legacy unreachable' }
                },
                {
                    // The deprecated hardware block carries `reality` too, so a simulator is dropped on this branch as well.
                    identifier: 'B0000000-0000-4000-8000-00000000000B',
                    hardwareProperties: { platform: 'iOS', reality: 'simulated', udid: 'B0000000-0000-4000-8000-00000000000B' },
                    connectionProperties: { pairingState: 'paired', transportType: 'sameMachine' },
                    deviceProperties: { name: 'iPhone 17' }
                }
            ]
        }
    };
    const fromLegacy = parsePhysicalDevices(legacy);
    report(same(fromLegacy, [{
        name: 'Legacy iPhone', udid: '00007777-000A0B0C0D0E0F10', deviceIdentifier: 'CORE0000-0000-4000-8000-000000000010',
        osVersion: '18.6', connectionType: 'wired', productType: 'iPhone16,1', osBuildVersion: '22G86'
    }]), 'legacy (jsonVersion 4): deprecated keys read as before, simulator dropped there too', JSON.stringify(fromLegacy));

    report(same(parsePhysicalDevices(null), []), 'null document → no devices');
    report(same(parsePhysicalDevices({ info: { jsonVersion: 5 } }), []), 'document without result → no devices');
    report(same(parsePhysicalDevices({ result: { devices: 'nope' } }), []), 'malformed devices list → no devices');
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
    checkDevicectlParsing();
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
