#!/usr/bin/env node
/**
 * SourceKit-LSP arguments check: does the editor type-check the side of
 * `#if targetEnvironment(simulator)` that the selected destination builds?
 *
 * VSXcode puts a block of SourceKit-LSP arguments for the run destination in the workspace's
 * swift.buildArguments: the iPhoneSimulator SDK and a `-simulator` triple for a simulator, the iPhoneOS
 * SDK and a device triple for a physical device. This runs the compiled src/utils/sourceKitLSP.ts: the
 * simulator block must stay exactly what earlier versions wrote, the device block must name the iPhoneOS
 * platform, and a stored list must compare equal only to the same list. Merging must strip every block
 * VSXcode wrote (any destination, Xcode or deployment version) and nothing else, keep the user's own
 * arguments in order, carry the user setting over while the workspace has no value of its own, and leave
 * a value that isn't a list of strings alone.
 * Under every Xcode found among XCODE_APPS it then checks that each path in both lists exists and
 * type-checks probes with the arguments after a host `-target` and `-sdk`, as SwiftPM passes them: the
 * device list must reach the `#else` branch and the simulator list must not, and `import XCTest` must
 * resolve for both with a test target's simulator search paths, which the generated Package.swift adds
 * whatever the destination, on either side of the list.
 *
 * Usage: npm run test:sourcekit-lsp
 *        VSXCODE_XCODE_APPS=/path/Xcode-27.app:/path/Xcode-26.app npm run test:sourcekit-lsp
 *        (colon-separated bundles, for Xcodes installed somewhere other than the defaults)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const XCODE_APPS = (process.env.VSXCODE_XCODE_APPS || '/Applications/Xcode.app:/Applications/Xcode_26.app')
    .split(':').filter((entry) => entry.length > 0);
const IOS_VERSION = '18.0';
const HOST_TARGET = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`;

const { sourceKitLSPArguments, sameArguments, withoutDestinationArguments, destinationBuildArguments } = require(path.join(REPO, 'out', 'utils/sourceKitLSP.js'));

let failures = 0;
function report(ok, label, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
    if (!ok) { failures += 1; }
}

const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ── The lists, no Xcode needed ───────────────────────────────────────────────────────

function checkLists() {
    console.log('argument lists');
    const dev = '/Applications/Xcode.app/Contents/Developer';
    const sim = `${dev}/Platforms/iPhoneSimulator.platform/Developer`;
    const phone = `${dev}/Platforms/iPhoneOS.platform/Developer`;
    // What 3.12.0 and earlier wrote for every iOS destination.
    const simulatorBefore = [
        '-Xswiftc', '-sdk', '-Xswiftc', `${sim}/SDKs/iPhoneSimulator.sdk`,
        '-Xswiftc', '-target', '-Xswiftc', 'arm64-apple-ios17.0-simulator',
        '-Xswiftc', '-F', '-Xswiftc', `${sim}/SDKs/iPhoneSimulator.sdk/System/Library/Frameworks`,
        '-Xswiftc', '-F', '-Xswiftc', `${sim}/Library/Frameworks`,
        '-Xswiftc', '-I', '-Xswiftc', `${sim}/usr/lib`,
        '-Xswiftc', '-enable-testing'
    ];
    const device = [
        '-Xswiftc', '-sdk', '-Xswiftc', `${phone}/SDKs/iPhoneOS.sdk`,
        '-Xswiftc', '-target', '-Xswiftc', 'arm64-apple-ios17.0',
        '-Xswiftc', '-F', '-Xswiftc', `${phone}/SDKs/iPhoneOS.sdk/System/Library/Frameworks`,
        '-Xswiftc', '-F', '-Xswiftc', `${phone}/Library/Frameworks`,
        '-Xswiftc', '-I', '-Xswiftc', `${phone}/usr/lib`,
        '-Xswiftc', '-enable-testing'
    ];
    const simulatorNow = sourceKitLSPArguments('simulator', dev, '17.0');
    const deviceNow = sourceKitLSPArguments('device', dev, '17.0');
    const shown = (ok, list) => (ok ? undefined : JSON.stringify(list));
    const simulatorSame = sameList(simulatorNow, simulatorBefore);
    report(simulatorSame, 'a simulator gets the list earlier versions wrote', shown(simulatorSame, simulatorNow));
    const deviceSame = sameList(deviceNow, device);
    report(deviceSame, 'a device gets the iPhoneOS SDK, search paths and a device triple', shown(deviceSame, deviceNow));

    console.log('comparing a stored value');
    report(sameArguments(undefined, undefined), 'no value and none wanted');
    report(sameArguments([...device], device), 'an equal list');
    report(!sameArguments(simulatorBefore, device), 'the simulator list against the device list');
    report(!sameArguments(undefined, device), 'no value against a list');
    report(!sameArguments(device, undefined), 'a list against none wanted, which is cleared');
    report(!sameArguments([], undefined), 'an empty list against none wanted, which is cleared');
    report(!sameArguments(device.slice(0, -1), device), 'a shorter list');
    report(!sameArguments(device.join(' '), device), 'a string, which the setting never holds');

    console.log('stripping the blocks VSXcode wrote');
    const otherXcode = sourceKitLSPArguments('simulator', '/Applications/Xcode-26.app/Contents/Developer', '16.4');
    const own = ['-Xswiftc', '-DFOO', '--build-system', 'native'];
    const expect = (label, actual, expected) => report(sameList(actual, expected), label, sameList(actual, expected) ? undefined : JSON.stringify(actual));
    expect('no value is no arguments', withoutDestinationArguments(undefined), []);
    expect('a lone block goes', withoutDestinationArguments(device), []);
    expect('blocks from another Xcode and version go too', withoutDestinationArguments([...otherXcode, ...device]), []);
    expect('the user\'s arguments around a block stay, in order',
        withoutDestinationArguments(['-Xswiftc', '-DFOO', ...simulatorBefore, '--build-system', 'native']), own);
    expect('a lone -Xswiftc -enable-testing of the user\'s stays', withoutDestinationArguments(['-Xswiftc', '-enable-testing']), ['-Xswiftc', '-enable-testing']);
    const altered = [...device];
    altered[7] = 'arm64-apple-macosx14.0';
    expect('a block with a non-iOS triple is the user\'s and stays whole', withoutDestinationArguments(altered), altered);
    expect('a string is left alone', withoutDestinationArguments('-Xswiftc -DFOO'), null);
    expect('a list holding a non-string is left alone', withoutDestinationArguments(['-Xswiftc', 3]), null);

    console.log('the workspace swift.buildArguments to write');
    expect('a device with nothing set', destinationBuildArguments(undefined, undefined, device), device);
    expect('the user setting is carried over, since a workspace value replaces it',
        destinationBuildArguments(undefined, ['--build-system', 'native'], device), [...device, '--build-system', 'native']);
    expect('the workspace value\'s own arguments win over the user setting',
        destinationBuildArguments([...simulatorBefore, '-Xswiftc', '-DFOO'], ['--build-system', 'native'], device), [...device, '-Xswiftc', '-DFOO']);
    expect('My Mac removes a value holding only the block', destinationBuildArguments(device, undefined, undefined), undefined);
    expect('My Mac removes a value only repeating the user setting',
        destinationBuildArguments([...device, '--build-system', 'native'], ['--build-system', 'native'], undefined), undefined);
    expect('My Mac keeps the workspace\'s own arguments', destinationBuildArguments([...device, '-Xswiftc', '-DFOO'], undefined, undefined), ['-Xswiftc', '-DFOO']);
    expect('My Mac with nothing set writes nothing', destinationBuildArguments(undefined, undefined, undefined), undefined);
    expect('My Mac keeps an empty workspace value set to override the user setting',
        destinationBuildArguments([], ['--build-system', 'native'], undefined), []);
    expect('My Mac keeps a workspace value with no block, even one repeating the user setting',
        destinationBuildArguments(['--build-system', 'native'], ['--build-system', 'native'], undefined), ['--build-system', 'native']);
    expect('a workspace value that isn\'t a list of strings is left alone', destinationBuildArguments('oops', undefined, device), null);
    expect('a user setting that isn\'t a list of strings counts as none', destinationBuildArguments(undefined, 'oops', device), device);
}

// ── Live type-checks under each Xcode ────────────────────────────────────────────────

const PROBE = [
    'enum Probe {',
    '#if targetEnvironment(simulator)',
    '    static let value = 1',
    '#else',
    '    static let value: Int = "not an int"',
    '#endif',
    '}',
    ''
].join('\n');
const PROBE_ELSE_LINE = 5;

const TESTS_PROBE = [
    'import XCTest',
    '',
    'final class ProbeTests: XCTestCase {',
    '    func testProbe() { XCTAssertEqual(1, 1) }',
    '}',
    ''
].join('\n');

/** The values the list hands swiftc: every other entry, after each `-Xswiftc`. */
function compilerArguments(list) {
    return list.filter((_, index) => index % 2 === 1);
}

function listedPaths(args) {
    return args.filter((_, index) => index > 0 && ['-sdk', '-F', '-I'].includes(args[index - 1]));
}

function checkXcode(appPath, workDir) {
    const developerDir = path.join(appPath, 'Contents', 'Developer');
    const env = { ...process.env, DEVELOPER_DIR: developerDir };
    console.log(appPath);
    const hostSDK = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { env, encoding: 'utf8' }).trim();
    const typecheck = (file, before, after) => spawnSync(
        'xcrun',
        ['swiftc', '-typecheck', '-target', HOST_TARGET, '-sdk', hostSDK, ...before, path.join(workDir, file), ...after],
        { env, encoding: 'utf8' }
    );

    const simulator = compilerArguments(sourceKitLSPArguments('simulator', developerDir, IOS_VERSION));
    const device = compilerArguments(sourceKitLSPArguments('device', developerDir, IOS_VERSION));
    for (const [name, args] of [['simulator', simulator], ['device', device]]) {
        const missing = listedPaths(args).filter((entry) => !fs.existsSync(entry));
        report(missing.length === 0, `every path in the ${name} list exists`, missing.length > 0 ? missing.join(', ') : undefined);
    }

    const simulatorProbe = typecheck('Probe.swift', [], simulator);
    report(simulatorProbe.status === 0, 'the simulator list type-checks the simulator branch only', simulatorProbe.stderr.trim() || undefined);
    const deviceProbe = typecheck('Probe.swift', [], device);
    const elseError = new RegExp(`Probe\\.swift:${PROBE_ELSE_LINE}:\\d+: error:`);
    report(deviceProbe.status !== 0 && elseError.test(deviceProbe.stderr),
        'the device list reports the error in the #else branch', deviceProbe.stderr.split('\n')[0] || `exit ${deviceProbe.status}`);

    // The generated Package.swift gives every test target the simulator's XCTest search paths.
    const testTarget = ['-F', `${developerDir}/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks`,
        '-I', `${developerDir}/Platforms/iPhoneSimulator.platform/Developer/usr/lib`, '-enable-testing'];
    const cases = [
        ['simulator, test-target paths first', testTarget, simulator],
        ['device, test-target paths first', testTarget, device],
        ['device, test-target paths last', [], [...device, ...testTarget]]
    ];
    for (const [label, before, after] of cases) {
        const result = typecheck('ProbeTests.swift', before, after);
        report(result.status === 0, `import XCTest resolves: ${label}`, result.stderr.trim().split('\n')[0] || undefined);
    }
}

function main() {
    checkLists();
    const installed = XCODE_APPS.filter((app) => fs.existsSync(path.join(app, 'Contents', 'Developer')));
    if (installed.length === 0) {
        console.log('  FAIL  no Xcode found among ' + XCODE_APPS.join(', '));
        failures += 1;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-sourcekit-lsp-'));
    try {
        fs.writeFileSync(path.join(workDir, 'Probe.swift'), PROBE);
        fs.writeFileSync(path.join(workDir, 'ProbeTests.swift'), TESTS_PROBE);
        for (const app of installed) {
            checkXcode(app, workDir);
        }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
    if (failures > 0) {
        console.log(`\n${failures} SourceKit-LSP arguments check failure(s).`);
        process.exit(1);
    }
    console.log('\nSourceKit-LSP arguments check OK.');
}

main();
