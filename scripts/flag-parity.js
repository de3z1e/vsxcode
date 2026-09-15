#!/usr/bin/env node
/**
 * Flag parity: does the Package.swift we generate make SwiftPM pass the same
 * semantics-affecting flags that xcodebuild passes for the same Xcode target?
 *
 * The setting-to-flag table in src/types/swiftSettingFlags.ts is transcribed from Xcode's
 * Swift.xcspec and rots with every Xcode release; this check makes that rot fail a command
 * instead of surfacing months later as a phantom in-editor diagnostic.
 *
 * KNOWN BLIND SPOT: src/extension.ts imports `vscode` and cannot be loaded here, so its
 * generateSwiftSettings/effectiveSwiftMajor call composition is reproduced below by hand;
 * a wiring regression there stays invisible to this check.
 *
 * Usage: npm run test:flag-parity
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const FIXTURE_TEXT = path.join(__dirname, 'fixtures', 'flag-parity-pbxproj.txt');

const { generateSwiftSettings } = require(path.join(OUT, 'generators/swiftSettings.js'));
const { buildPackageSwift } = require(path.join(OUT, 'generators/packageSwift.js'));
const { getProjectBuildSettings, getBuildSettingsForTarget } = require(path.join(OUT, 'parsers/buildSettings.js'));
const { parseNativeTargets } = require(path.join(OUT, 'parsers/targets.js'));

// ── What counts as a semantics-affecting flag ────────────────────────────────────────
// Compared strictly on both sides. A new upcoming feature or isolation value lands in one
// of these families, which is the way this table actually rots.
const SEMANTIC_FAMILIES = [
    /^-D/, /^-swift-version$/, /^-enable-upcoming-feature$/, /^-enable-experimental-feature$/,
    /^-default-isolation/, /^-strict-/, /^-warnings-as-errors$/, /^-Werror$/, /^-Wwarning$/,
    /^-enable-bare-slash-regex$/, /^-cxx-interoperability-mode/
];

// Flags that take a following value, so the value isn't mistaken for a flag of its own.
const TAKES_VALUE = new Set([
    '-swift-version', '-enable-upcoming-feature', '-enable-experimental-feature',
    '-default-isolation', '-Werror', '-Wwarning', '-D'
]);

// xcodebuild driver flags that are not Swift semantics. Anything on the xcodebuild side
// outside SEMANTIC_FAMILIES and not listed here is reported as a possible new family —
// reported, not fatal, because Xcode adds driver flags routinely and a check that fails
// spuriously gets switched off.
const KNOWN_XCODEBUILD_DRIVER_FLAGS = new Set([
    '-c',                                // compile, not link
    '-j',                                // parallelism
    '-enable-batch-mode',                // scheduling
    '-incremental',                      // scheduling
    '-explicit-module-build',            // module build strategy
    '-validate-clang-modules-once',      // module cache policy
    '-clang-build-session-file',         // module cache policy
    '-emit-const-values',                // extra output product
    '-output-file-map',                  // output plumbing
    '-save-temps',                       // output plumbing
    '-serialize-diagnostics',            // output plumbing
    '-emit-dependencies',                // output plumbing
    '-emit-module',                      // output plumbing
    '-emit-module-path',                 // output plumbing
    '-emit-objc-header',                 // output plumbing
    '-use-frontend-parseable-output',    // log format
    '-no-color-diagnostics',             // log format
    '-parseable-output',                 // log format
    '-disable-cmo',                      // optimizer
    '-experimental-emit-module-separately', // build scheduling
    '-Onone', '-O', '-Osize',            // optimization level, deliberately untranslated
    '-g',                                // debug info
    '-parse-as-library',                 // driver mode
    '-static',                           // product kind
    '-ivfsstatcache',                    // vfs cache
    '-swift-version-independent-apis',   // module emission detail
    '--'                                 // driver separator
]);

// Flags whose *value* is environmental (paths, names, versions). Dropped with their value.
const VALUED_NOISE = new Set([
    '-sdk', '-target', '-target-variant', '-I', '-F', '-L', '-o', '-module-name',
    '-module-cache-path', '-package-name', '-index-store-path', '-resource-dir',
    '-emit-module-doc-path', '-emit-module-source-info-path', '-emit-objc-header-path',
    '-serialize-diagnostics-path', '-emit-dependencies-path', '-emit-const-values-path',
    '-emit-abi-descriptor-path', '-emit-reference-dependencies-path', '-const-gather-protocols-file',
    '-new-driver-path', '-plugin-path', '-external-plugin-path', '-in-process-plugin-server-path',
    '-file-compilation-dir', '-target-sdk-version', '-target-sdk-name', '-working-directory',
    '-num-threads', '-primary-file', '-supplementary-output-file-map', '-stats-output-dir',
    '-Xcc', '-Xllvm', '-Xfrontend', '-frontend-parseable-output',
    // Xcode 27 output plumbing, each followed by a path.
    '-const-gather-protocols-list', '-dependency-scan-serialize-diagnostics-path'
]);

// SwiftPM injects these into every package build; they say nothing about the manifest. `Xcode` arrived with
// SwiftPM 6.4 (Xcode 27).
const SWIFTPM_INJECTED_DEFINES = new Set(['SWIFT_PACKAGE', 'SWIFT_MODULE_RESOURCE_BUNDLE_UNAVAILABLE', 'Xcode']);
// SwiftPM plumbing with no xcodebuild counterpart at this level.
const SWIFTPM_ONLY_FLAGS = new Set(['-enable-testing', '-v', '-frontend', '-empty-abi-descriptor',
    '-enable-objc-interop', '-stack-check', '-enable-anonymous-context-mangled-names',
    '-no-auto-bridging-header-chaining', '-disable-clang-spi', '-index-system-modules',
    '-experimental-skip-non-inlinable-function-bodies-without-types', '-color-diagnostics']);

/**
 * Split a command line into canonical flag tokens. xcodebuild shell-escapes `=`, writes
 * defines attached (`-DFOO`) where SwiftPM splits them (`-D FOO`), and both spell paired
 * flags inconsistently — so everything is normalised to `flag=value` and compared as a set.
 */
function canonicalFlags(commandLine) {
    const raw = commandLine.trim().split(/\s+/).map((token) => token.replace(/\\=/g, '='));
    const semantic = new Set();
    const other = new Set();

    for (let index = 0; index < raw.length; index += 1) {
        const token = raw[index];
        if (VALUED_NOISE.has(token)) { index += 1; continue; }
        if (!token.startsWith('-')) { continue; }

        if (token === '-D') { semantic.add(`-D${raw[index += 1]}`); continue; }
        if (TAKES_VALUE.has(token)) { semantic.add(`${token}=${raw[index += 1]}`); continue; }
        if (SEMANTIC_FAMILIES.some((pattern) => pattern.test(token))) { semantic.add(token); continue; }
        other.add(token.replace(/^(-j)\d+$/, '$1'));
    }
    return { semantic, other };
}

function readDriverLine(logPath, marker) {
    const line = fs.readFileSync(logPath, 'utf8').split('\n').find((entry) => entry.includes(marker));
    if (!line) { throw new Error(`no line matching ${marker} in ${logPath}`); }
    return line;
}

// Output is captured, not inherited: xcodebuild's log would bury the pass/fail lines.
function run(command, args, options) {
    return execFileSync(command, args, {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], ...options
    });
}

// ── The two sides ────────────────────────────────────────────────────────────────────

function xcodebuildFlags(workDir, targetName, swiftVersion, tmp) {
    const args = [
        '-project', 'FlagParity.xcodeproj', '-target', targetName, '-configuration', 'Debug',
        '-sdk', 'iphonesimulator', '-arch', 'arm64',
        `SYMROOT=${path.join(tmp, 'sym', targetName)}`, `OBJROOT=${path.join(tmp, 'obj', targetName)}`,
        'build'
    ];
    const logPath = path.join(tmp, `xcodebuild-${targetName}-${swiftVersion}.log`);
    // Log first, throw second: a failing xcodebuild is exactly when its output is wanted.
    const build = spawnSync('xcodebuild', args, { cwd: workDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(logPath, `${build.stdout || ''}\n${build.stderr || ''}`);
    if (build.status !== 0) {
        throw new Error(`xcodebuild failed for ${targetName}; see ${logPath}`);
    }
    return canonicalFlags(readDriverLine(logPath, 'builtin-SwiftDriver'));
}

function swiftpmFlags(pbxContents, targetName, toolsVersion, tmp) {
    // Mirrors the composition in src/extension.ts — see the blind-spot note at the top.
    const projectSettings = getProjectBuildSettings(pbxContents, 'Debug');
    const nativeTarget = parseNativeTargets(pbxContents).find((entry) => entry.name === targetName);
    const targetSettings = getBuildSettingsForTarget(pbxContents, nativeTarget.buildConfigurationListId, 'Debug');
    const swiftSettings = generateSwiftSettings({
        projectSettings, targetSettings, configurationName: 'Debug',
        fallbackSwiftVersion: toolsVersion, toolsVersion
    });

    const pkgDir = path.join(tmp, `pkg-${targetName}`);
    const sourceDir = path.join(pkgDir, 'Sources', targetName);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'Covered.swift'), 'public struct Covered: Sendable { public init() {} }\n');
    fs.writeFileSync(path.join(pkgDir, 'Package.swift'), buildPackageSwift({
        packageName: targetName,
        swiftVersion: toolsVersion,
        platforms: [{ platform: 'iOS', version: '17.0' }, { platform: 'macOS', version: '15.0' }],
        products: [{ type: '.library', name: targetName, targets: [targetName] }],
        dependencies: [],
        targets: [{ spmType: '.target', name: targetName, path: `Sources/${targetName}`, swiftSettings }]
    }));

    const logPath = path.join(tmp, `swiftpm-${targetName}-${toolsVersion}.log`);
    const build = spawnSync('swift', ['build', '-v', '--scratch-path', path.join(tmp, `scratch-${targetName}`)],
        { cwd: pkgDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(logPath, `${build.stdout || ''}\n${build.stderr || ''}`);
    if (build.status !== 0) {
        throw new Error(`swift build failed for ${targetName}; see ${logPath}`);
    }
    const { semantic, other } = canonicalFlags(readDriverLine(logPath, `-module-name ${targetName}`));
    for (const name of SWIFTPM_INJECTED_DEFINES) { semantic.delete(`-D${name}`); }
    return { semantic, other, swiftSettings };
}

// ── Compare ──────────────────────────────────────────────────────────────────────────

function main() {
    const toolsVersion = run('swift', ['--version']).match(/Apple Swift version (\d+\.\d+)/)?.[1] || '6.2';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-flag-parity-'));
    const workDir = path.join(tmp, 'FlagParity');
    const template = fs.readFileSync(FIXTURE_TEXT, 'utf8');

    let failures = 0;
    const notes = new Set();

    for (const languageMode of ['6.0', '5.0']) {
        const pbxContents = template.replace(/SWIFT_VERSION = [^;]+;/g, `SWIFT_VERSION = ${languageMode};`);
        fs.rmSync(workDir, { recursive: true, force: true });
        for (const dir of ['FlagParity.xcodeproj', 'FlagParityTarget', 'FlagParityInherited']) {
            fs.mkdirSync(path.join(workDir, dir), { recursive: true });
        }
        fs.writeFileSync(path.join(workDir, 'FlagParity.xcodeproj', 'project.pbxproj'), pbxContents);
        fs.writeFileSync(path.join(workDir, 'Shared.xcconfig'), '// Contents intentionally unread; only the pbxproj is parsed.\n');
        fs.writeFileSync(path.join(workDir, 'FlagParityTarget', 'Covered.swift'), 'public struct Covered: Sendable { public init() {} }\n');
        fs.writeFileSync(path.join(workDir, 'FlagParityInherited', 'Inherited.swift'), 'public struct Inherited: Sendable { public init() {} }\n');

        for (const targetName of ['FlagParityTarget', 'FlagParityInherited']) {
            const label = `${targetName} @ Swift ${languageMode}`;
            const xc = xcodebuildFlags(workDir, targetName, languageMode, tmp);
            const spm = swiftpmFlags(pbxContents, targetName, toolsVersion, tmp);

            const missing = [...xc.semantic].filter((flag) => !spm.semantic.has(flag)).sort();
            const extra = [...spm.semantic].filter((flag) => !xc.semantic.has(flag)).sort();

            for (const flag of xc.other) {
                if (!KNOWN_XCODEBUILD_DRIVER_FLAGS.has(flag) && !SWIFTPM_ONLY_FLAGS.has(flag)) {
                    notes.add(flag);
                }
            }

            if (xc.semantic.size === 0) {
                // A flagless driver line means the parse broke, not that the flags agree;
                // without this an empty set on both sides would print a confident PASS.
                failures += 1;
                console.log(`  FAIL  ${label}  no semantic flags parsed from the xcodebuild line`);
            } else if (missing.length === 0 && extra.length === 0) {
                console.log(`  PASS  ${label}  (${xc.semantic.size} flags)`);
            } else {
                failures += 1;
                console.log(`  FAIL  ${label}`);
                for (const flag of missing) { console.log(`          xcodebuild only : ${flag}`); }
                for (const flag of extra) { console.log(`          Package.swift only: ${flag}`); }
                console.log(`        generated swiftSettings:\n          ${spm.swiftSettings.join('\n          ')}`);
            }
        }
    }

    if (notes.size > 0) {
        console.log('\n  NOTE  unclassified xcodebuild flags — new flag family? review the table:');
        for (const flag of [...notes].sort()) { console.log(`          ${flag}`); }
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures > 0) {
        console.log(`\n${failures} parity failure(s). The flag table in src/types/swiftSettingFlags.ts is out of date with this Xcode.`);
        process.exit(1);
    }
    console.log('\nFlag parity OK.');
}

main();
