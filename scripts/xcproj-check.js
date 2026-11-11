#!/usr/bin/env node
/**
 * JSON project file check: does VSXcode read Xcode 27.2's `project.xcproj` exactly as Xcode does?
 *
 * Xcode reads project.xcproj with Foundation's JSON5 parser. The reader in src/parsers/xcprojText.ts must give the
 * same accept and reject verdict as xcprojformatter (Xcode's own reader) for every case below, keep the first of a
 * duplicated key as Xcode does, and decode the values plutil reports wherever plutil agrees with Xcode (plutil keeps
 * the last duplicate and rejects Infinity and NaN). Every node's offsets must re-read to the same value, and pointers
 * must reach their nodes.
 *
 * The JSON project is then lowered into the same project index a pbxproj gives (src/parsers/xcprojIndex.ts). For every
 * valid fixture, what VSXcode reads from that index must equal what it reads from Xcode's own conversion of the file
 * (`xcodebuild -convert-project pbxproj` on a temp copy, offline); every invalid fixture must be refused both by Xcode and
 * by the reader, for the reason its header names; and every parser's output is compared with reviewed goldens.
 *
 * Inputs:
 *  - scripts/fixtures/xcproj/: each pbxproj fixture converted by `xcodebuild -convert-project xcproj` and stored as
 *    Xcode wrote it; json5-syntax, a hand-written project in the JSON5 syntax Xcode accepts; features, a project using
 *    every construct the lowering handles, stored in xcprojformatter's canonical form; and invalid-*, one fault each that
 *    Xcode 27.2 refuses. The files end in .txt so the extension never activates on this repository.
 *  - scripts/fixtures/xcproj/goldens/: every parser's output on each valid fixture.
 *  - A table of syntax cases recorded on Xcode 27.2, each embedded in a valid project as Xcode would see it, and a few
 *    whole texts. The verdicts aren't stored: each case runs through xcprojformatter, so a newer Xcode that reads JSON5
 *    differently fails this check.
 *
 * Requires Xcode 27.2 or later (xcprojformatter). Re-run after every Xcode upgrade.
 * Usage: npm run test:xcproj                  check
 *        npm run test:xcproj -- --update      rewrite the goldens, then review the diff
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'xcproj');
const { parseJson5Text, nodeAt, valueOf, duplicateKeys } = require(path.join(REPO, 'out', 'parsers', 'xcprojText.js'));

let failures = 0;
function report(ok, label, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
    if (!ok) { failures += 1; }
}

let formatter = '';
try {
    formatter = execFileSync('/usr/bin/xcrun', ['-f', 'xcprojformatter'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
    // Reported below.
}
if (!formatter) {
    console.error('test:xcproj needs Xcode 27.2 or later selected: `xcrun -f xcprojformatter` found nothing.');
    process.exit(1);
}

const TEMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vsxcode-xcproj-')));
process.on('exit', () => fs.rmSync(TEMP, { recursive: true, force: true }));
let bundles = 0;

/** A fresh `.xcodeproj` holding the text as its project.xcproj. */
function bundleWith(text) {
    const bundle = path.join(TEMP, `case-${bundles++}`, 'App.xcodeproj');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'project.xcproj'), text);
    return bundle;
}

/** Whether Xcode's own reader accepts the text as a project file. */
function xcodeAccepts(text) {
    return spawnSync(formatter, [bundleWith(text)], { stdio: 'ignore' }).status === 0;
}

/** Xcode's canonical form of the text, or undefined when it rejects the text. */
function xcodeCanonical(text) {
    const result = spawnSync(formatter, [bundleWith(text)], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout : undefined;
}

/** plutil's reading of the text, or undefined when plutil rejects it. */
function plutilValue(text) {
    const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: text, encoding: 'utf8' });
    return result.status === 0 ? JSON.parse(result.stdout) : undefined;
}

/** Deep equality that tells negative zero from zero, as the reader must. */
function same(a, b) {
    if (typeof a === 'number' && typeof b === 'number') { return Object.is(a, b); }
    if (Array.isArray(a)) { return Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index])); }
    if (a !== null && typeof a === 'object') {
        if (b === null || typeof b !== 'object' || Array.isArray(b)) { return false; }
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length &&
            keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
    }
    return a === b;
}

/** JSON for a failure message, with negative zero shown as -0. */
function show(value) {
    return JSON.stringify(value, (_key, item) => (Object.is(item, -0) ? '-0' : item));
}

/** Reads without letting an exception escape, which the reader must never raise. */
function read(text) {
    try {
        return { root: parseJson5Text(text), threw: false };
    } catch (error) {
        return { root: undefined, threw: String(error) };
    }
}

/** Every node and key whose own text doesn't re-read to the same value. */
function spanProblems(text, node, where = '') {
    const problems = [];
    const again = parseJson5Text(text.slice(node.start, node.end));
    if (!again || !same(valueOf(again), valueOf(node))) { problems.push(where || '(root)'); }
    if (node.kind === 'object') {
        for (const member of node.members) {
            const keyRoot = parseJson5Text(`{${text.slice(member.keyStart, member.keyEnd)}:0}`);
            if (!keyRoot || keyRoot.kind !== 'object' || keyRoot.members[0]?.key !== member.key) {
                problems.push(`${where}/${member.key} (key)`);
            }
            if (member.start !== member.keyStart || member.end !== member.value.end) {
                problems.push(`${where}/${member.key} (member span)`);
            }
            problems.push(...spanProblems(text, member.value, `${where}/${member.key}`));
        }
    } else if (node.kind === 'array') {
        node.elements.forEach((element, index) => problems.push(...spanProblems(text, element, `${where}/${index}`)));
    }
    return problems;
}

// ── Fixtures ──────────────────────────────────────────────

const fixtures = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.xcproj.txt')).sort();
const texts = new Map(fixtures.map((name) => [name, fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')]));
// invalid-* hold one fault each that Xcode refuses (the refusals section below); every other fixture is a valid project.
const validFixtures = fixtures.filter((name) => !name.startsWith('invalid-'));
const invalidFixtures = fixtures.filter((name) => name.startsWith('invalid-'));

console.log('fixtures');
for (const name of validFixtures) {
    const text = texts.get(name);
    const { root, threw } = read(text);
    report(root !== undefined && !threw, `${name} reads`, threw || undefined);
    if (!root) { continue; }
    report(xcodeAccepts(text), `${name} is accepted by xcprojformatter`);
    const problems = spanProblems(text, root);
    report(problems.length === 0, `${name}: every offset re-reads to its value`, problems.slice(0, 3).join(', ') || undefined);
    if (name === 'json5-syntax.xcproj.txt') { continue; }
    report(same(valueOf(root), plutilValue(text)), `${name}: values match plutil`);
}

console.log('json5-syntax: duplicate keys read as Xcode reads them');
{
    const text = texts.get('json5-syntax.xcproj.txt');
    const root = parseJson5Text(text);
    const ours = root ? valueOf(root) : undefined;
    const canonical = plutilValue(xcodeCanonical(text) ?? '');
    const settings = (value) => value?.targets?.[0]?.['build-settings'];
    report(ours?.['default-configuration'] === 'Debug' && canonical?.['default-configuration'] === 'Debug',
        'default-configuration is the first given, as xcprojformatter prints it', `${ours?.['default-configuration']} / ${canonical?.['default-configuration']}`);
    report(settings(ours)?.SWIFT_VERSION === '5.0' && settings(canonical)?.SWIFT_VERSION === '5.0',
        'SWIFT_VERSION is the first given, as xcprojformatter prints it', `${settings(ours)?.SWIFT_VERSION} / ${settings(canonical)?.SWIFT_VERSION}`);
    const settingsNode = root ? nodeAt(root, ['targets', 0, 'build-settings']) : undefined;
    report(root?.kind === 'object' && duplicateKeys(root).includes('default-configuration') &&
        settingsNode?.kind === 'object' && duplicateKeys(settingsNode).includes('SWIFT_VERSION'), 'duplicateKeys names both');
    // plutil keeps the last duplicate; with those two put back, the rest must match it exactly.
    const expected = plutilValue(text);
    if (expected) {
        expected['default-configuration'] = ours?.['default-configuration'];
        settings(expected).SWIFT_VERSION = settings(ours)?.SWIFT_VERSION;
    }
    report(expected !== undefined && same(ours, expected), 'every other value matches plutil');
    const bundle = bundleWith(text);
    const list = spawnSync('/usr/bin/xcrun', ['xcodebuild', '-list', '-project', bundle], { encoding: 'utf8' });
    report(/Targets:/.test(list.stdout), 'xcodebuild -list opens it');
}

console.log('pointers');
{
    const text = texts.get('explicit-app.xcproj.txt');
    const root = parseJson5Text(text);
    const at = (pointer) => (root ? nodeAt(root, pointer) : undefined);
    const name = at(['targets', 0, 'name']);
    report(name?.value === 'SampleApp' && text.slice(name.start, name.end) === '"SampleApp"', 'targets/0/name reaches "SampleApp" and its span is its text');
    report(at(['files', 0, 'children', 0, 'path'])?.value === 'AppDelegate.swift', 'files/0/children/0/path reaches AppDelegate.swift');
    report(at(['targets', 0, 'build-settings', 'HEADER_SEARCH_PATHS', 1])?.value === '$(SRCROOT)/Vendor/include', 'an array element inside build settings');
    report(at(['targets', 99]) === undefined && at(['files', 'name']) === undefined && at(['no-such-key']) === undefined,
        'missing steps and mismatched step types reach nothing');
}

// ── Syntax cases ──────────────────────────────────────────

const BS = '\\';
const cp = (point) => String.fromCodePoint(point);
const hex = (point) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
const dq = (body) => `"${body}"`;
const sq = (body) => `'${body}'`;
const REST = '"default-configuration": "Release", "configurations": ["Debug", "Release"], "localizations": { "development": "en" }, ' +
    '"files": [ { "kind": "group", "name": "Products", "children": [ { "path": "<PRODUCTS>/App.app", "id": "AAAAAAAAAAAAAAAAAAAAAAAA", ' +
    '"type": "wrapper.application", "index": false } ] } ], "targets": [ { "name": "App", "id": "BBBBBBBBBBBBBBBBBBBBBBBB", ' +
    '"product": "Products/App.app", "product-type": "application", "build-phases": ["compile-sources"] } ] }';
const PROJECT_KEYS = new Set(['default-configuration', 'configurations', 'localizations', 'files', 'targets']);

/**
 * Each case: its text, how to pick the decoded part out of a value (the extra key, or the "zzz" value), whether it is
 * written with an escape (so it must contain a backslash), and whether plutil can't vouch for its value.
 */
const cases = [];
function keyCase(label, key, escape = false) {
    cases.push({ label: `key ${label}`, text: `{ ${key}: 1, ${REST}`, pick: (value) => Object.keys(value).find((k) => !PROJECT_KEYS.has(k)), escape });
}
function valueCase(label, value, escape = false, plutilCannotRead = false) {
    cases.push({ label: `value ${label}`, text: `{ "zzz": ${value}, ${REST}`, pick: (v) => v.zzz, escape, plutilCannotRead });
}
function textCase(label, text, plutilCannotRead = false) {
    cases.push({ label, text, plutilCannotRead });
}

// Unquoted keys: the first character.
for (const character of '!#$%&()*+-.0123456789;<=>?@^_`|~AZaz') { keyCase(`first ${JSON.stringify(character)}`, `${character}zz`); }
for (const point of [0xfc, 0xe9, 0x20ac, 0x2192, 0x1f600, 0xa0, 0x200d, 0x1c5, 0x216b, 0x663, 0x4e2d, 0xaa, 0x2b0, 0x301, 0xb7, 0x3a9, 0xdf, 0xfb01]) {
    keyCase(`first ${hex(point)}`, `${cp(point)}zz`);
}
keyCase('first, a backslash that starts no escape', `${BS}zz`, true);
// Unquoted keys: the characters after it.
for (const character of '!#$%&()*+-.0123456789;<=>?@^_`|~"\',{}[]/') { keyCase(`next ${JSON.stringify(character)}`, `z${character}z`); }
for (const point of [0x09, 0x0b, 0x0c, 0x0d, 0x01, 0xfc, 0x20ac, 0x2192, 0x1f600, 0xa0, 0x200d, 0x200c, 0x663, 0x301, 0x2028, 0x3000]) {
    keyCase(`next ${hex(point)}`, `z${cp(point)}z`);
}
keyCase('hyphenated', 'x-y');
keyCase('dollar and underscore', '$x_y');
// Unquoted keys: escapes, decoded whatever character they give.
keyCase('first, escape u0041', `${BS}u0041zz`, true);
keyCase('next, escape u0041', `zz${BS}u0041`, true);
keyCase('first, escape x41', `${BS}x41zz`, true);
keyCase('next, escape x41', `zz${BS}x41`, true);
keyCase('first, escape n', `${BS}nzz`, true);
keyCase('next, escape n', `zz${BS}n`, true);
keyCase('next, escape q', `zz${BS}q`, true);
keyCase('first, escape u0031 (a digit)', `${BS}u0031zz`, true);
keyCase('first, escape x2D (a hyphen)', `${BS}x2Dzz`, true);
keyCase('next, escape u002d', `z${BS}u002dz`, true);
keyCase('next, escape u0000 (NUL)', `z${BS}u0000z`, true);
keyCase('next, escape x00 (NUL)', `z${BS}x00z`, true);
keyCase('next, escape u0001', `z${BS}u0001z`, true);
// Unquoted keys: what ends one.
keyCase('a block comment before the colon', 'zz/*c*/');
keyCase('a line comment before the colon', 'zz//c\n');
keyCase('a space before the colon', 'zz ');
keyCase('a block comment inside', 'z/*c*/z');

// Strings.
for (const [label, text, escape] of [
    ['escape a', dq(`${BS}a`), true], ['escape 8', dq(`${BS}8`), true], ['escape 9', dq(`${BS}9`), true],
    ['escape 0', dq(`${BS}0`), true], ['escape v', dq(`${BS}v`), true],
    ['short escape x', dq(`${BS}x4`), true], ['escape x41', dq(`${BS}x41`), true], ['short escape u', dq(`${BS}u12`), true],
    ['lone high surrogate', dq(`${BS}uD800`), true], ['lone low surrogate', dq(`${BS}uDC00`), true],
    ['surrogate pair', dq(`${BS}uD83D${BS}uDE00`), true],
    ['escape u0000 (NUL)', dq(`a${BS}u0000b`), true], ['escape x00 (NUL)', sq(`a${BS}x00`), true],
    ['escape u0001', dq(`a${BS}u0001b`), true], ['escape x01', dq(`a${BS}x01`), true],
    ['the single-character escapes', dq(`${BS}b${BS}f${BS}n${BS}r${BS}t${BS}/${BS}${BS}`), true],
    ['an escaped single quote in double quotes', dq(`a${BS}'b`), true],
    ['an escaped double quote in single quotes', sq(`a${BS}"b`), true],
    ['an escaped single quote in single quotes', sq(`it${BS}'s`), true],
    ['continuation over LF', dq(`ab${BS}\ncd`), true], ['continuation over CRLF', dq(`ab${BS}\r\ncd`), true],
    ['continuation over CR', dq(`ab${BS}\rcd`), true], ['continuation over U+2028', dq(`ab${BS}${cp(0x2028)}cd`), true],
    ['raw tab', dq('a\tb'), false], ['raw LF', dq('a\nb'), false], ['raw CR', dq('a\rb'), false],
    ['raw NUL', dq(`a${cp(0)}b`), false], ['raw U+001F', dq(`a${cp(0x1f)}b`), false],
    ['raw U+2028', dq(`a${cp(0x2028)}b`), false], ['raw U+2029', dq(`a${cp(0x2029)}b`), false],
    ['empty single-quoted', "''", false], ['empty double-quoted', '""', false]
]) {
    valueCase(`string ${label}`, text, escape);
}

// Numbers and literals; plutil can't write Infinity or NaN as JSON, so only Xcode's verdict counts for them.
for (const literal of [
    '0', '-0', '+1', '01', '00', '08', '1e5', '1E5', '1e+5', '1e-5', '1.e5', '.5', '5.', '-.5', '+.5', '.e5',
    '0x1F', '0X1F', '-0x1F', '+0x1F', '0x', '0x1.5', 'Infinity', '-Infinity', '+Infinity', 'NaN', '-NaN', '+NaN',
    '1_000', '0b101', '0o17', '1..2', '--1', '+-1', '-+1', '++1', '+-Infinity', '12345678901234567890', '1e400',
    '-0x0', '-0x00', '-0.0', '-0.', '-.0', '-0e0', '-0E5', '0.0',
    // Hex is a 64-bit integer to Xcode; a decimal may be any size.
    '0x00000000000000001', '0x00000000000000000', '0x10000000000000000', '-0x8000000000000001', '-0xFFFFFFFFFFFFFFFF',
    '0xFFFFFFFFFFFFFFFF', '+0xFFFFFFFFFFFFFFFF', '-0x8000000000000000', '0x0000000000000001', '-0x0000000000000000',
    '18446744073709551616', '-9223372036854775809', '99999999999999999999999',
    'true', 'false', 'null', 'True', 'undefined', 'infinity'
]) {
    valueCase(`number or literal ${literal}`, literal, false, /Infinity|NaN/.test(literal));
}

// Whitespace between tokens.
for (const point of [0x0b, 0x0c, 0xa0, 0xfeff, 0x2028, 0x2029, 0x3000, 0x1680]) {
    textCase(`whitespace ${hex(point)} between tokens`, `{${cp(point)}"zzz": 1, ${REST}`);
}
textCase('carriage returns alone as line breaks', `{\r"zzz": 1,\r${REST}`);
textCase('CRLF line breaks', `{\r\n"zzz": 1,\r\n${REST}`);
textCase('a byte-order mark at the start', `${cp(0xfeff)}{ "zzz": 1, ${REST}`);

// Structure.
textCase('a comment between key and colon', `{ "zzz" /*c*/ : 1, ${REST}`);
textCase('a comment between colon and value', `{ "zzz": /*c*/ 1, ${REST}`);
textCase('a line comment at the end without a newline', `{ "zzz": 1, ${REST} // end`);
textCase('a trailing comma in an object', `{ "zzz": 1, ${REST.replace(/ \}$/, ', }')}`);
textCase('a double comma', `{ "zzz": 1,, ${REST}`);
textCase('a leading comma in an array', `{ "zzz": [,1], ${REST}`);
textCase('an array of just a comma', `{ "zzz": [,], ${REST}`);
textCase('an unterminated block comment', `{ "zzz": 1, ${REST} /* end`);
textCase('an unterminated string', `{ "zzz": "abc, ${REST}`.replace(/"abc, .*/s, '"abc'));
textCase('two roots', `{ "zzz": 1, ${REST} {}`);
textCase('text after the root', `{ "zzz": 1, ${REST} x`);
textCase('the empty text', '');

console.log('syntax cases: the same verdict as xcprojformatter, and plutil\'s values where it can read them');
for (const testCase of cases) {
    if (testCase.escape && !testCase.text.includes(BS)) {
        report(false, `${testCase.label}: the case text keeps its backslash`);
        continue;
    }
    const { root, threw } = read(testCase.text);
    if (threw) {
        report(false, `${testCase.label}: never throws`, threw);
        continue;
    }
    const xcode = xcodeAccepts(testCase.text);
    if (xcode !== (root !== undefined)) {
        report(false, `${testCase.label}: verdict`, `xcprojformatter ${xcode ? 'accepts' : 'rejects'}, the reader ${root ? 'accepts' : 'rejects'}`);
        continue;
    }
    if (!root || !testCase.pick || testCase.plutilCannotRead) {
        report(true, `${testCase.label}: ${xcode ? 'accepted' : 'rejected'}`);
        continue;
    }
    const theirs = plutilValue(testCase.text);
    const ok = theirs !== undefined && same(testCase.pick(valueOf(root)), testCase.pick(theirs));
    report(ok, `${testCase.label}: accepted, value matches plutil`,
        ok ? undefined : `reader ${show(testCase.pick(valueOf(root)))}, plutil ${theirs === undefined ? 'rejects' : show(testCase.pick(theirs))}`);
}

console.log('texts with no value: read as an empty object, as plutil reads them; Xcode refuses them for lacking `files`');
for (const [label, text] of [['a comment alone', '// only a comment\n'], ['whitespace alone', '  \n\t \n']]) {
    const { root } = read(text);
    const empty = root?.kind === 'object' && root.members.length === 0;
    report(empty && same(plutilValue(text), {}) && !xcodeAccepts(text), `${label}`);
}

console.log('duplicate keys: the first is kept, as xcprojformatter prints it');
{
    const text = `{ "default-configuration": "Debug", ${REST.replace('"name": "App",', '"name": "App", "build-settings": { "SWIFT_VERSION": "5.0", "SWIFT_VERSION": "6.0" },')}`;
    const root = parseJson5Text(text);
    const ours = root ? valueOf(root) : undefined;
    const canonical = plutilValue(xcodeCanonical(text) ?? '');
    report(ours?.['default-configuration'] === 'Debug' && canonical?.['default-configuration'] === 'Debug', 'default-configuration');
    report(ours?.targets?.[0]?.['build-settings']?.SWIFT_VERSION === '5.0' &&
        canonical?.targets?.[0]?.['build-settings']?.SWIFT_VERSION === '5.0', 'a target build setting');
    report(plutilValue(text)?.['default-configuration'] === 'Release', 'plutil keeps the last, which is why it is not the reference here');
}

// ── Lowering into the project index ───────────────────────

const UPDATE = process.argv.includes('--update');
const GOLDEN_DIR = path.join(FIXTURE_DIR, 'goldens');
// Where resolvedPath and groupForFolder place a fixture project, as in the pbxproj check.
const PROJECT_DIR = '/project';
const CONFIGURATIONS = ['Debug', 'Release'];
const load = (relative) => require(path.join(REPO, 'out', relative));
const projectIndex = load('parsers/projectIndex.js');
const xcprojIndex = load('parsers/xcprojIndex.js');
const targets = load('parsers/targets.js');
const groups = load('parsers/groups.js');
const buildSettings = load('parsers/buildSettings.js');
const packages = load('parsers/packages.js');
const frameworks = load('parsers/frameworks.js');
const resources = load('parsers/resources.js');
const versionGroups = load('parsers/versionGroups.js');
const project = load('parsers/project.js');
const writers = load('writers/pbxproj.js');

/** Keys sorted at every level, so two readings compare by content. */
function canonical(value) {
    if (Array.isArray(value)) { return value.map(canonical); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
    }
    return value;
}

/**
 * Xcode's own conversion of the text to a pbxproj (`xcodebuild -convert-project pbxproj` on a temp copy, which resolves no
 * packages and needs no network): `{ text }`, or `{ refused }` when Xcode can't read the project. The result bundle an
 * error writes goes into the temp folder rather than the system's.
 */
function xcodeConversion(text) {
    const bundle = bundleWith(text);
    const result = spawnSync('/usr/bin/xcrun', ['xcodebuild', '-convert-project', 'pbxproj', '-project', bundle,
        '-resultBundlePath', path.join(path.dirname(bundle), 'result.xcresult')], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    if (/Unable to read project/.test(output)) { return { refused: true }; }
    const converted = path.join(bundle, 'project.pbxproj');
    if (result.status !== 0 || !fs.existsSync(converted)) {
        return { error: output.split('\n').filter((line) => line.trim()).slice(-2).join(' ') };
    }
    return { text: fs.readFileSync(converted, 'utf8') };
}

const SCANNED_ISAS = ['PBXGroup', 'PBXVariantGroup', 'PBXFileReference', 'XCVersionGroup', 'PBXFileSystemSynchronizedRootGroup',
    'PBXFileSystemSynchronizedBuildFileExceptionSet', 'XCBuildConfiguration', 'XCRemoteSwiftPackageReference',
    'XCLocalSwiftPackageReference', 'XCSwiftPackageProductDependency', 'PBXBuildFile'];

/**
 * Everything VSXcode reads from a project index, with ids replaced by stable descriptions (a tree path, a target name),
 * so the lowering and Xcode's conversion compare by content. Lists keep their order, except packageProductDependencies,
 * whose order Xcode varies from run to run. lastKnownFileType is left out: Xcode reads it from the disk.
 */
function dump(index) {
    const O = index.objects;
    const str = (value) => (typeof value === 'string' ? value : undefined);
    const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
    const asSet = (items) => items.map((item) => JSON.stringify(canonical(item))).sort();

    const names = new Map([[index.mainGroupId, '<main>']]);
    const walk = (id, prefix) => {
        const seen = new Map();
        for (const child of list(O[id]?.children)) {
            const name = projectIndex.displayName(O[child]);
            const count = seen.get(name) ?? 0;
            seen.set(name, count + 1);
            const description = `${prefix}/${name}${count > 0 ? `#${count}` : ''}`;
            if (!names.has(child)) {
                names.set(child, description);
                walk(child, description);
            }
        }
    };
    walk(index.mainGroupId, '');
    const references = Array.isArray(index.project?.projectReferences) ? index.project.projectReferences : [];
    for (const reference of references) {
        names.set(reference.ProductGroup, `${names.get(reference.ProjectRef) ?? '?'} (Products)`);
    }
    const allTargets = ['PBXNativeTarget', 'PBXAggregateTarget', 'PBXLegacyTarget'].flatMap((isa) => index.objectsOfIsa(isa));
    const phaseOfBuildFile = new Map();
    for (const { object: target } of allTargets) {
        for (const phase of list(target.buildPhases)) {
            names.set(phase, `${target.name}/${O[phase]?.isa}${O[phase]?.name !== undefined ? `:${O[phase].name}` : ''}`);
            for (const buildFile of list(O[phase]?.files)) { phaseOfBuildFile.set(buildFile, phase); }
        }
    }
    const describe = (id) => (id === undefined ? undefined : names.get(id) ?? (O[id]
        ? `${O[id].isa}:${O[id].name ?? O[id].productName ?? O[id].repositoryURL ?? O[id].relativePath ?? '?'}`
        : `missing:${id}`));
    const packageOf = (id) => (O[id] ? {
        isa: O[id].isa, repositoryURL: str(O[id].repositoryURL), requirement: O[id].requirement, relativePath: str(O[id].relativePath)
    } : undefined);
    const productOf = (id) => ({ productName: str(O[id]?.productName), package: packageOf(O[id]?.package) });
    const buildFileOf = (id) => ({
        file: describe(O[id]?.fileRef), product: O[id]?.productRef ? str(O[O[id].productRef]?.productName) : undefined, settings: O[id]?.settings
    });
    const configurations = (listId) => list(O[listId]?.buildConfigurations).map((id) => ({
        name: O[id]?.name,
        buildSettings: O[id]?.buildSettings,
        base: describe(O[id]?.baseConfigurationReference),
        anchor: O[id]?.baseConfigurationReferenceAnchor === undefined ? undefined
            : `${describe(O[id].baseConfigurationReferenceAnchor)} + ${O[id].baseConfigurationReferenceRelativePath}`
    }));
    const element = (id) => {
        const object = O[id] ?? {};
        const out = { isa: object.isa, name: str(object.name), path: str(object.path), sourceTree: str(object.sourceTree), explicitFileType: str(object.explicitFileType) };
        if (object.isa === 'XCVersionGroup') {
            out.currentVersion = describe(object.currentVersion);
            out.versionGroupType = str(object.versionGroupType);
        }
        if (object.isa === 'PBXFileSystemSynchronizedRootGroup') {
            out.exceptions = list(object.exceptions).map((setId) => ({
                isa: O[setId]?.isa, target: str(O[O[setId]?.target]?.name), buildPhase: describe(O[setId]?.buildPhase),
                membershipExceptions: list(O[setId]?.membershipExceptions)
            }));
        }
        if (object.children !== undefined) { out.children = list(object.children).map(element); }
        return out;
    };
    const targetsOf = (isa) => index.objectsOfIsa(isa).map(({ object: target }) => ({
        name: target.name,
        productName: target.productName,
        productType: target.productType,
        product: describe(target.productReference),
        configurations: configurations(target.buildConfigurationList),
        defaultConfiguration: O[target.buildConfigurationList]?.defaultConfigurationName,
        phases: list(target.buildPhases).map((phase) => ({ isa: O[phase]?.isa, name: str(O[phase]?.name), files: list(O[phase]?.files).map(buildFileOf) })),
        dependencies: list(target.dependencies).map((id) => (O[id]?.target ? `target:${O[O[id].target]?.name}`
            : O[id]?.productRef ? `product:${O[O[id].productRef]?.productName}` : `proxy:${O[O[id]?.targetProxy]?.remoteInfo}`)),
        packageProductDependencies: asSet(list(target.packageProductDependencies).map(productOf)),
        fileSystemSynchronizedGroups: list(target.fileSystemSynchronizedGroups).map(describe)
    }));
    const scanned = (isa, id, object) => {
        switch (isa) {
            case 'XCBuildConfiguration': return { name: object.name, buildSettings: object.buildSettings, base: describe(object.baseConfigurationReference) };
            case 'PBXFileSystemSynchronizedBuildFileExceptionSet': return { target: str(O[object.target]?.name), membershipExceptions: list(object.membershipExceptions) };
            case 'XCRemoteSwiftPackageReference':
            case 'XCLocalSwiftPackageReference': return packageOf(id);
            case 'XCSwiftPackageProductDependency': return productOf(id);
            case 'PBXBuildFile': return { phase: describe(phaseOfBuildFile.get(id)), ...buildFileOf(id) };
            default: return { at: describe(id), name: str(object.name), path: str(object.path), sourceTree: str(object.sourceTree) };
        }
    };
    const P = index.project ?? {};
    return {
        developmentRegion: P.developmentRegion,
        knownRegions: P.knownRegions,
        productRefGroup: describe(P.productRefGroup),
        projectReferences: references.map((reference) => ({ project: describe(reference.ProjectRef), products: describe(reference.ProductGroup) })),
        mainGroup: element(index.mainGroupId),
        projectConfigurations: configurations(P.buildConfigurationList),
        projectDefaultConfiguration: O[P.buildConfigurationList]?.defaultConfigurationName,
        // Definition order, exactly: Package.swift's target order and the auto-configured target come from it.
        nativeTargets: targetsOf('PBXNativeTarget'),
        aggregateTargets: targetsOf('PBXAggregateTarget'),
        legacyTargets: targetsOf('PBXLegacyTarget'),
        testHosts: Object.entries(P.attributes?.TargetAttributes ?? {})
            .filter(([, attributes]) => attributes?.TestTargetID)
            .map(([id, attributes]) => `${O[id]?.name} -> ${O[attributes.TestTargetID]?.name}`).sort(),
        scans: Object.fromEntries(SCANNED_ISAS.map((isa) => [isa, asSet(index.objectsOfIsa(isa).map(({ id, object }) => scanned(isa, id, object)))]))
    };
}

/** Where two dumps differ, as `path: ours / xcode` lines. */
function differences(ours, theirs, at = '', out = []) {
    if (JSON.stringify(canonical(ours)) === JSON.stringify(canonical(theirs))) { return out; }
    if (ours && theirs && typeof ours === 'object' && typeof theirs === 'object') {
        for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) { differences(ours[key], theirs[key], `${at}/${key}`, out); }
        return out;
    }
    out.push(`${at}: ours ${JSON.stringify(ours)}, xcode ${JSON.stringify(theirs)}`);
    return out;
}

console.log('lowering: each valid fixture reads as Xcode\'s own conversion of it reads');
for (const name of validFixtures) {
    const text = texts.get(name);
    const ours = projectIndex.readProject(text);
    if (typeof ours === 'string') {
        report(false, `${name}: reads`, `${ours}: ${xcprojIndex.describeXcprojProblem(text)}`);
        continue;
    }
    const conversion = xcodeConversion(text);
    if (conversion.text === undefined) {
        report(false, `${name}: Xcode converts it`, conversion.refused ? 'refused' : conversion.error);
        continue;
    }
    const theirs = projectIndex.readProject(conversion.text);
    const found = typeof theirs === 'string' ? [`Xcode's conversion reads ${theirs}`] : differences(dump(ours), dump(theirs));
    report(ours.format === 'xcproj' && found.length === 0, `${name}: matches Xcode's conversion`, found.slice(0, 4).join('; ') || undefined);
}

console.log('refusals: every invalid fixture is refused by Xcode and by the reader, for the reason its header names');
for (const name of invalidFixtures) {
    const text = texts.get(name);
    const expected = /^\/\/ VSXcode: (.+)$/m.exec(text)?.[1];
    const problem = xcprojIndex.describeXcprojProblem(text);
    const read = projectIndex.readProject(text);
    const conversion = xcodeConversion(text);
    const ok = expected !== undefined && read === 'unparseable' && problem !== undefined && problem.includes(expected) && conversion.refused === true;
    report(ok, name, ok ? undefined : `reader: ${read === 'unparseable' ? 'refuses' : 'reads'} (${problem}); Xcode: ${conversion.refused ? 'refuses' : 'reads'}`);
}

console.log('syntax independence: json5-syntax lowers exactly as its canonical form does');
{
    const text = texts.get('json5-syntax.xcproj.txt');
    const canonicalText = xcodeCanonical(text);
    const lower = (input) => xcprojIndex.lowerXcproj(xcprojIndex.xcprojRoot(input));
    const ours = lower(text);
    const theirs = canonicalText === undefined ? undefined : lower(canonicalText);
    const ok = theirs !== undefined && !('problem' in ours) && !('problem' in theirs) &&
        same(ours.objects, theirs.objects) && same(ours.order, theirs.order) && same(ours.rootObject, theirs.rootObject) &&
        same([...ours.sources], [...theirs.sources]);
    report(ok, 'objects, ids, definition order and source pointers are equal');
}

console.log('stable ids: a letter-case fix or an added sibling leaves every other object its id and isa');
{
    const text = texts.get('explicit-app.xcproj.txt');
    const original = projectIndex.readProject(text);
    const variant = (label, from, to) => [label, text.split(from).length === 2 ? text.replace(from, to) : undefined];
    for (const [label, changed] of [
        variant('a group path in other letter case', '"path": "Views",', '"path": "VIEWS",'),
        variant('a compiled file path in other letter case', '{ "path": "AppDelegate.swift",', '{ "path": "APPDELEGATE.swift",'),
        variant('a file added ahead of its siblings', '{ "path": "AppDelegate.swift",', '{ "path": "Zed.swift" },\n        { "path": "AppDelegate.swift",')
    ]) {
        const index = changed === undefined ? 'no such text' : projectIndex.readProject(changed);
        const lost = typeof original === 'string' || typeof index === 'string' ? ['the text'] :
            Object.keys(original.objects).filter((id) => index.objects[id]?.isa !== original.objects[id].isa);
        report(lost.length === 0, label, lost.length === 0 ? undefined : `${typeof index === 'string' ? index : `${lost.length} ids lost`}: ${lost.slice(0, 3).join(', ')}`);
    }
}

console.log('SwiftPM-generated ids: only generated-ids is recognized');
for (const name of validFixtures) {
    const expected = name === 'generated-ids.xcproj.txt';
    report(project.usesSwiftPMObjectIds(texts.get(name)) === expected, `${name}: ${expected ? 'recognized' : 'not recognized'}`);
}

console.log('models: explicit-app\'s version groups, located in the JSON text');
{
    const text = texts.get('explicit-app.xcproj.txt');
    const models = versionGroups.parseVersionGroups(text);
    const located = models.every((model) => {
        const node = parseJson5Text(text.slice(model.startIndex, model.endIndex));
        return node?.kind === 'object' && valueOf(node).kind === 'version-group';
    });
    report(models.length === 2 && located, 'two models, each spanning its own JSON object', models.map((model) => model.path).join(', '));
}

console.log('guards: the pbxproj writers leave JSON text alone');
for (const name of validFixtures) {
    const text = texts.get(name);
    const index = projectIndex.readProject(text);
    const configuration = typeof index === 'string' ? undefined : index.objectsOfIsa('XCBuildConfiguration')[0]?.id;
    const ok = writers.beginProjectEdit(text) === null &&
        writers.updateBuildSetting(text, configuration ?? 'none', 'SWIFT_VERSION', '6.0') === text;
    report(ok, `${name}: beginProjectEdit gives null and updateBuildSetting the text unchanged`);
}

console.log('never throws: a project nested deeper than the stack reads as unparseable');
{
    const depth = 200000;
    const text = `{ "zzz": ${'['.repeat(depth)}${']'.repeat(depth)}, ${REST}`;
    let outcome;
    try {
        outcome = projectIndex.readProject(text);
    } catch (error) {
        outcome = `threw ${String(error).split('\n')[0]}`;
    }
    report(outcome === 'unparseable' || (outcome && typeof outcome === 'object'), 'readProject returns', typeof outcome === 'string' ? outcome : 'an index');
}

// ── Writer ────────────────────────────────────────────────

const edits = load('writers/projectEdit.js');

/** A fixture's objects, found by the lowered fields VSXcode reads. */
function finder(index) {
    const O = index.objects;
    const ids = Object.keys(O);
    return {
        byPath: (value) => ids.find((id) => O[id].path === value),
        byName: (value) => ids.find((id) => O[id].name === value),
        sources: (targetName) => {
            const target = index.objectsOfIsa('PBXNativeTarget').find(({ object }) => object.name === targetName)?.object;
            return (target?.buildPhases ?? []).filter((id) => O[id].isa === 'PBXSourcesBuildPhase');
        }
    };
}

/** Every element id under `ids` in an index, with the build files, exception sets and project-reference groups keyed by them. */
function subtreeIds(index, ids) {
    const O = index.objects;
    const out = new Set();
    const walk = (id) => {
        if (!O[id] || out.has(id)) { return; }
        out.add(id);
        for (const child of O[id].children ?? []) { walk(child); }
        for (const set of O[id].exceptions ?? []) { out.add(set); }
    };
    ids.forEach(walk);
    for (const [id, object] of Object.entries(O)) {
        if (object.isa === 'PBXBuildFile' && out.has(object.fileRef)) { out.add(id); }
    }
    for (const reference of index.project?.projectReferences ?? []) {
        if (out.has(reference.ProjectRef)) { out.add(reference.ProductGroup); }
    }
    return out;
}

/**
 * One writer case: the output must read as a project with the expected change, keep every other input object's id and
 * isa, be left unchanged by xcprojformatter (when the input is in its canonical form), and convert with Xcode's loader.
 */
function writerCase(label, input, { run, expect, edited = [], canonical = true }) {
    const before = projectIndex.readProject(input);
    const logs = [];
    const edit = edits.beginProjectEdit(input, (message) => logs.push(message));
    if (typeof before === 'string' || !edit) {
        report(false, label, 'the input doesn\'t read');
        return undefined;
    }
    const result = run(edit, finder(before), before);
    const output = edits.projectEditText(edit);
    const after = projectIndex.readProject(output);
    const problems = [];
    if (typeof after === 'string') {
        problems.push(`the output reads ${after}`);
    } else {
        const expectation = expect(after, finder(after), result, logs, output);
        if (expectation !== true) { problems.push(expectation || 'the expected change is missing'); }
        const skip = subtreeIds(before, edited);
        const lost = Object.keys(before.objects).filter((id) => !skip.has(id) && after.objects[id]?.isa !== before.objects[id].isa);
        if (lost.length > 0) { problems.push(`${lost.length} other ids lost, e.g. ${lost.slice(0, 2).join(', ')}`); }
    }
    if (canonical && output !== input) {
        const formatted = xcodeCanonical(output);
        if (formatted !== output) {
            const ours = output.split('\n');
            const theirs = (formatted ?? '').split('\n');
            const line = ours.findIndex((text, position) => text !== theirs[position]);
            problems.push(formatted === undefined ? 'xcprojformatter rejects it' : `xcprojformatter changes line ${line + 1}: ${JSON.stringify(ours[line])} → ${JSON.stringify(theirs[line])}`);
        }
    }
    if (output !== input) {
        const conversion = xcodeConversion(output);
        if (conversion.text === undefined) { problems.push(`Xcode ${conversion.refused ? 'refuses it' : `fails: ${conversion.error}`}`); }
    }
    report(problems.length === 0, label, problems.join('; ') || undefined);
    return { output, logs, result };
}

/** The element ids holding a path value in an index's children, from the main group down a chain of display names. */
function childNamed(index, parentId, name) {
    return (index.objects[parentId]?.children ?? []).find((id) => projectIndex.displayName(index.objects[id]) === name);
}

function pathOf(index, names) {
    let current = index.mainGroupId;
    for (const name of names) {
        current = childNamed(index, current, name);
        if (!current) { return undefined; }
    }
    return current;
}

/** The phase files of a Sources phase, as file reference ids. */
function phaseFiles(index, phaseId) {
    return (index.objects[phaseId]?.files ?? []).map((id) => index.objects[id]?.fileRef);
}

console.log('writer: single operations, each checked against xcprojformatter and Xcode\'s loader');
{
    const app = texts.get('FixtureApp.xcproj.txt');
    const index = projectIndex.readProject(app);
    const f = finder(index);
    const views = f.byPath('Views');
    writerCase('addSwiftFile into a group, sorted among its Swift files', app, {
        run: (edit, found) => edits.addSwiftFile(edit, 'Cat.swift', views, found.sources('MyApp')[0]),
        expect: (after, _found, id) => {
            const group = pathOf(after, ['MyApp', 'Views']);
            const names = after.objects[group].children.map((child) => projectIndex.displayName(after.objects[child]));
            return id !== undefined && after.objects[id]?.path === 'Cat.swift' && names.join() === 'Bar.swift,Cat.swift,ContentView.swift,Rename.swift' &&
                phaseFiles(after, finder(after).sources('MyApp')[0]).includes(id) || `children ${names}`;
        }
    });
    writerCase('removeSwiftFile, the only child of its group', app, {
        run: (edit, found) => edits.removeSwiftFile(edit, found.byPath('Service.swift')),
        expect: (after) => pathOf(after, ['MyApp', 'Services']) !== undefined && pathOf(after, ['MyApp', 'Services', 'Service.swift']) === undefined,
        edited: [f.byPath('Service.swift')]
    });
    writerCase('renameSwiftFile, keeping its memberships', app, {
        run: (edit, found) => edits.renameSwiftFile(edit, found.byPath('Rename.swift'), 'Renamed.swift'),
        expect: (after) => {
            const id = pathOf(after, ['MyApp', 'Views', 'Renamed.swift']);
            return id !== undefined && phaseFiles(after, finder(after).sources('MyApp')[0]).includes(id);
        },
        edited: [f.byPath('Rename.swift')]
    });
    writerCase('rehomeSwiftFile into another group under a new name', app, {
        run: (edit, found) => edits.rehomeSwiftFile(edit, found.byPath('Rename.swift'), found.byPath('Services'), 'Moved.swift'),
        expect: (after) => pathOf(after, ['MyApp', 'Services', 'Moved.swift']) !== undefined && pathOf(after, ['MyApp', 'Views', 'Rename.swift']) === undefined,
        edited: [f.byPath('Rename.swift')]
    });
    writerCase('moveElement of a multi-line group into another group', app, {
        run: (edit, found) => edits.moveElement(edit, found.byPath('Views'), found.byPath('MyKit'), 'Views', 'Views', edits.anyEntry),
        expect: (after) => pathOf(after, ['MyKit', 'Views', 'Bar.swift']) !== undefined && pathOf(after, ['MyApp', 'Views']) === undefined,
        edited: [f.byPath('Views')]
    });
    writerCase('setFileReferencePath', app, {
        run: (edit, found) => edits.setFileReferencePath(edit, found.byPath('Bar.swift'), 'BAR.swift'),
        expect: (after) => pathOf(after, ['MyApp', 'Views', 'BAR.swift']) !== undefined,
        edited: [f.byPath('Bar.swift')]
    });
    writerCase('setElementPaths on a group and a file', app, {
        run: (edit, found) => edits.setElementPaths(edit, [{ id: found.byPath('Views'), path: 'Screens' }, { id: found.byPath('Helpers.swift'), path: 'Helper.swift' }]),
        expect: (after) => pathOf(after, ['MyApp', 'Screens', 'Bar.swift']) !== undefined && pathOf(after, ['MyApp', 'Helper.swift']) !== undefined,
        edited: [f.byPath('Views'), f.byPath('Helpers.swift')]
    });
    writerCase('addGroupPath of two levels, then a file in the deepest', app, {
        run: (edit, found) => {
            const group = edits.addGroupPath(edit, found.byPath('MyApp'), ['Features', 'Deep']);
            return edits.addSwiftFile(edit, 'Deep.swift', group, found.sources('MyApp')[0]);
        },
        expect: (after, _found, id) => id !== undefined && pathOf(after, ['MyApp', 'Features', 'Deep', 'Deep.swift']) === id
    });
    writerCase('addSwiftFile at the top level (the main group)', app, {
        run: (edit, found, input) => edits.addSwiftFile(edit, 'Top.swift', input.mainGroupId, found.sources('MyApp')[0]),
        expect: (after, _found, id) => id !== undefined && childNamed(after, after.mainGroupId, 'Top.swift') === id
    });
}

console.log('writer: the sync\'s sequences, references re-encoded where a path changes');
{
    const features = texts.get('features.xcproj.txt');
    const index = projectIndex.readProject(features);
    const f = finder(index);
    const configs = f.byPath('Configs');
    const base = (after) => {
        const id = pathOf(after, ['Settings', 'Base.xcconfig']) ?? pathOf(after, ['App', 'Configs', 'Base.xcconfig']) ?? pathOf(after, ['Configs', 'Base.xcconfig']);
        return id;
    };
    const configurationsUsing = (after, id) => after.objectsOfIsa('XCBuildConfiguration').filter(({ object }) => object.baseConfigurationReference === id).length;
    const before = configurationsUsing(index, pathOf(index, ['Configs', 'Base.xcconfig']));
    writerCase('a folder rename under a referenced xcconfig: references follow', features, {
        run: (edit) => edits.setElementPaths(edit, [{ id: configs, path: 'Settings' }]),
        expect: (after) => {
            const id = pathOf(after, ['Settings', 'Base.xcconfig']);
            return id !== undefined && configurationsUsing(after, id) === before || `${configurationsUsing(after, id)} of ${before} configurations keep it`;
        },
        edited: [configs]
    });
    writerCase('a folder move under a referenced xcconfig: references follow', features, {
        run: (edit, found) => edits.moveElement(edit, configs, found.byPath('App'), 'Configs', 'Configs', edits.anyEntry),
        expect: (after) => {
            const id = pathOf(after, ['App', 'Configs', 'Base.xcconfig']);
            return id !== undefined && configurationsUsing(after, id) === before || `${configurationsUsing(after, id)} of ${before} configurations keep it`;
        },
        edited: [configs]
    });
    writerCase('a rename of a file a ".." reference walks through', features, {
        run: (edit, found) => edits.renameSwiftFile(edit, found.byPath('AppMain.swift'), 'Main.swift'),
        expect: (after) => configurationsUsing(after, base(after)) === before || 'the Staging xcconfig no longer resolves',
        edited: [f.byPath('AppMain.swift')]
    });
    writerCase('a letter-case fix of a file', features, {
        run: (edit, found) => edits.setFileReferencePath(edit, found.byPath('Kit.swift'), 'KIT.swift'),
        expect: (after) => pathOf(after, ['Kit', 'KIT.swift']) !== undefined,
        edited: [f.byPath('Kit.swift')]
    });
    writerCase('a folder move of a <PROJECT>/-based group stays group-relative', features, {
        run: (edit, found) => {
            const vendor = found.byPath('Vendor');
            edits.beginChange(edit);
            edits.moveElement(edit, vendor, found.byPath('App'), 'Vendor', 'Vendor', edits.anyEntry);
            edits.setElementPaths(edit, [{ id: vendor, path: 'Vendor' }]);
            return edits.endChange(edit);
        },
        expect: (after, _found, landed) => {
            const id = pathOf(after, ['App', 'Vendor']);
            return landed && id !== undefined && after.objects[id].sourceTree === '<group>' || `sourceTree ${id && after.objects[id].sourceTree}`;
        },
        edited: [f.byPath('Vendor')]
    });
    writerCase('a folder move into a folder that has no group yet', features, {
        run: (edit, found) => {
            edits.beginChange(edit);
            const home = edits.addGroupPath(edit, found.byPath('App'), ['Home']);
            edits.moveElement(edit, found.byPath('Kit'), home, 'Kit', 'Kit', edits.anyEntry);
            return edits.endChange(edit);
        },
        expect: (after, _found, landed) => landed && pathOf(after, ['App', 'Home', 'Kit', 'Kit.swift']) !== undefined,
        edited: [f.byPath('Kit')]
    });
}

console.log('writer: references in parts the lowering doesn\'t read');
{
    // An imported product names its project's file reference; Xcode refuses the project when that names nothing.
    const features = texts.get('features.xcproj.txt');
    const imported = xcodeCanonical(features.replace('\n  "targets": [', '\n  "imported-products": [\n    { "name": "libOtherKit.a", "project": "Other.xcodeproj", "target": "OtherKit", "product-id": "D1D1D1D1D1D1D1D1D1D1D1D1", "target-membership": [ "App/frameworks" ] },\n  ],\n  "targets": ['));
    const index = projectIndex.readProject(imported ?? '');
    if (!imported || typeof index === 'string') {
        report(false, 'a project with an imported product reads');
    } else {
        const f = finder(index);
        const other = f.byPath('Other/Other.xcodeproj');
        writerCase('moving a project file reference: its imported product and dependency follow', imported, {
            run: (edit, found) => edits.moveElement(edit, other, found.byPath('App'), 'Other.xcodeproj', 'Other.xcodeproj', edits.anyEntry),
            expect: (_after, _found, _result, _logs, output) => (output.match(/"project": "App\/Other\.xcodeproj"/g) ?? []).length === 2 ||
                'both references should read "App/Other.xcodeproj"',
            edited: [other]
        });
    }
}

console.log('writer: a hand-written object closing on its last member\'s line');
{
    // A group written across lines that closes on its last member's line: a name added to it must go after that member.
    const app = texts.get('FixtureApp.xcproj.txt');
    const anchor = '    { "kind": "folder", "path": "SyncKit", "target-membership": [ "SyncKit" ] },';
    const handWritten = app.replace(anchor, `${anchor}\n    {\n      "kind": "group",\n      "path": "Loose" },`);
    const index = projectIndex.readProject(handWritten);
    if (handWritten === app || typeof index === 'string') {
        report(false, 'the hand-written variant reads');
    } else {
        const loose = finder(index).byPath('Loose');
        writerCase('a field added after the last member, not inside it', handWritten, {
            canonical: false,
            run: (edit) => edits.setElementPaths(edit, [{ id: loose, path: 'Loose2', name: 'Shown' }]),
            expect: (after, found) => {
                const id = found.byName('Shown');
                return id !== undefined && after.objects[id].path === 'Loose2' || 'the renamed group doesn\'t read as written';
            },
            edited: [loose]
        });
    }
}

console.log('writer: paths Xcode reads only when escaped or prefixed');
{
    const features = texts.get('features.xcproj.txt');
    const index = projectIndex.readProject(features);
    const f = finder(index);
    const app = f.byPath('App');
    const sources = f.sources('App')[0];
    for (const [label, name, written] of [
        ['a "<"', 'a<b.swift', 'a\\<b.swift'],
        ['a backslash', 'back\\slash.swift', 'back\\\\slash.swift'],
        ['a leading "~"', '~tilde.swift', './~tilde.swift'],
        ['a non-ASCII name', `Caf${String.fromCodePoint(0xe9)}Views.swift`, `Caf${String.fromCodePoint(0xe9)}Views.swift`]
    ]) {
        writerCase(`addSwiftFile with ${label}`, features, {
            run: (edit) => edits.addSwiftFile(edit, name, app, sources),
            expect: (after, _found, id, _logs, output) => id !== undefined && output.includes(JSON.stringify(written)) || 'not written as Xcode writes it'
        });
    }
    writerCase('a leading "~" after <PROJECT>/', features, {
        run: (edit, found) => edits.setElementPaths(edit, [{ id: found.byPath('Vendor'), path: '~Vendor' }]),
        expect: (_after, _found, _result, _logs, output) => output.includes('"<PROJECT>/./~Vendor"') || 'not written <PROJECT>/./~Vendor',
        edited: [f.byPath('Vendor')]
    });
    writerCase('addSwiftFile under a <PROJECT>/-based group', features, {
        run: (edit, found) => edits.addSwiftFile(edit, 'Extra.swift', found.byPath('Vendor'), sources),
        expect: (after, _found, id) => id !== undefined && after.objects[id].path === 'Extra.swift' && after.objects[id].sourceTree === '<group>'
    });
}

console.log('writer: membership forms');
{
    const features = texts.get('features.xcproj.txt');
    const f = finder(projectIndex.readProject(features));
    writerCase('one Sources phase: "<Target>/compile-sources"', features, {
        run: (edit) => edits.addSwiftFile(edit, 'Plain.swift', f.byPath('App'), f.sources('App')[0]),
        expect: (_after, _found, id, _logs, output) => id !== undefined && output.includes('{ "path": "Plain.swift", "target-membership": [ "App/compile-sources" ] }')
    });
    writerCase('two Sources phases: "id:<phase id>"', features, {
        run: (edit) => edits.addSwiftFile(edit, 'Second.swift', f.byPath('Kit'), 'C2C2C2C2C2C2C2C2C2C2C2C2'),
        expect: (_after, _found, id, _logs, output) => id !== undefined && output.includes('"target-membership": [ "id:C2C2C2C2C2C2C2C2C2C2C2C2" ]')
    });
    const special = (targetName, phases = ['compile-sources']) => `${JSON.stringify({
        'default-configuration': 'Release', configurations: ['Debug', 'Release'], localizations: { development: 'en' },
        files: [ { kind: 'group', path: 'Sources', children: [ { path: 'A.swift' } ] },
            { kind: 'group', name: 'Products', children: [ { path: '<PRODUCTS>/App.app', id: 'A0A0A0A0A0A0A0A0A0A0A0A0', type: 'wrapper.application', index: false } ] } ],
        targets: [ { name: targetName, id: 'B0B0B0B0B0B0B0B0B0B0B0B0', product: 'Products/App.app', 'product-type': 'application', 'build-phases': phases } ]
    }, null, 2)}\n`;
    for (const name of ['A/B', 'id:x']) {
        const input = xcodeCanonical(special(name));
        const index = projectIndex.readProject(input ?? '');
        if (!input || typeof index === 'string') {
            report(false, `a target named ${name} reads`);
            continue;
        }
        const found = finder(index);
        writerCase(`a target named ${JSON.stringify(name)}: the object form`, input, {
            run: (edit) => edits.addSwiftFile(edit, 'New.swift', found.byPath('Sources'), found.sources(name)[0]),
            expect: (after, _found, id) => id !== undefined && phaseFiles(after, finder(after).sources(name)[0]).includes(id)
        });
    }
    const twoPhases = xcodeCanonical(special('Two', ['compile-sources', 'compile-sources']));
    const twoIndex = projectIndex.readProject(twoPhases ?? '');
    if (twoPhases && typeof twoIndex !== 'string') {
        const logs = [];
        const edit = edits.beginProjectEdit(twoPhases, (message) => logs.push(message));
        const id = edits.addSwiftFile(edit, 'New.swift', finder(twoIndex).byPath('Sources'), finder(twoIndex).sources('Two')[0]);
        report(id === undefined && edits.projectEditText(edit) === twoPhases && logs.some((line) => line.includes('several Sources phases')),
            'two Sources phases without ids: declined, text unchanged, logged', logs[0]);
    } else {
        report(false, 'a target with two unnamed Sources phases reads');
    }
}

console.log('writer: declines undo their change, and only it');
{
    const app = texts.get('FixtureApp.xcproj.txt');
    // Rename.swift's object repeats a key: Xcode reads the first, and the writer never edits such an object.
    const repeated = app.replace('{ "path": "Rename.swift", "target-membership"', '{ "path": "Rename.swift", "index": true, "index": true, "target-membership"');
    const index = projectIndex.readProject(repeated);
    const f = finder(index);
    const views = f.byPath('Views');
    const sources = f.sources('MyApp')[0];
    writerCase('a change declining midway is undone whole; the changes around it land', repeated, {
        canonical: false,
        run: (edit) => {
            const landed = [];
            edits.beginChange(edit);
            edits.addSwiftFile(edit, 'One.swift', views, sources);
            landed.push(edits.endChange(edit));
            edits.beginChange(edit);
            const made = edits.addGroupPath(edit, views, ['Made']);
            edits.moveElement(edit, f.byPath('Rename.swift'), made, 'Rename.swift', 'Rename.swift', edits.anyEntry);
            const afterDecline = edits.addSwiftFile(edit, 'Lost.swift', views, sources);
            landed.push(edits.endChange(edit));
            edits.beginChange(edit);
            const again = edits.addGroupPath(edit, views, ['Made']);
            edits.addSwiftFile(edit, 'Three.swift', again, sources);
            landed.push(edits.endChange(edit));
            return { landed, made, again, afterDecline };
        },
        expect: (after, _found, { landed, afterDecline }) => {
            const ok = landed.join() === 'true,false,true' && afterDecline === undefined &&
                pathOf(after, ['MyApp', 'Views', 'One.swift']) !== undefined && pathOf(after, ['MyApp', 'Views', 'Made', 'Three.swift']) !== undefined &&
                pathOf(after, ['MyApp', 'Views', 'Rename.swift']) !== undefined && pathOf(after, ['MyApp', 'Views', 'Lost.swift']) === undefined;
            return ok || `landed ${landed}`;
        }
    });
    const features = texts.get('features.xcproj.txt');
    const ff = finder(projectIndex.readProject(features));
    for (const [label, run, reason] of [
        ['removing an element a reference names', (edit) => edits.removeSwiftFile(edit, ff.byPath('Base.xcconfig')), 'removes'],
        ['adding a sibling that makes a reference ambiguous', (edit, index) => edits.addGroupPath(edit, index.mainGroupId, ['Configs']), 'more than one'],
        ['editing an object with a repeated key', (edit) => edits.renameSwiftFile(edit, f.byPath('Rename.swift'), 'Other.swift'), 'repeats']
    ]) {
        const input = reason === 'repeats' ? repeated : features;
        const inputIndex = projectIndex.readProject(input);
        const logs = [];
        const edit = edits.beginProjectEdit(input, (message) => logs.push(message));
        const result = run(edit, inputIndex);
        report(result === undefined && edits.projectEditText(edit) === input && logs.some((line) => line.includes(reason)),
            `${label}: declined, text unchanged, logged`, logs[0]);
    }
    const logs = [];
    const edit = edits.beginProjectEdit(app, (message) => logs.push(message));
    edits.addSwiftFile(edit, 'Gate.swift', views === undefined ? '' : finder(projectIndex.readProject(app)).byPath('Views'), finder(projectIndex.readProject(app)).sources('MyApp')[0]);
    edit.contents = edit.contents.replace('"files"', '"filez"');
    report(edits.projectEditText(edit) === app && edits.editDeclined(edit) !== undefined && logs.some((line) => line.includes('left unchanged')),
        'a session text that no longer reads: the input is written back, and why is logged', logs[logs.length - 1]);
}

console.log('writer: new handles never take an input id');
{
    const app = texts.get('FixtureApp.xcproj.txt');
    const index = projectIndex.readProject(app);
    const f = finder(index);
    writerCase('a file renamed, then one added under its old name', app, {
        run: (edit) => {
            edits.renameSwiftFile(edit, f.byPath('Rename.swift'), 'Renamed.swift');
            return edits.addSwiftFile(edit, 'Rename.swift', f.byPath('Views'), f.sources('MyApp')[0]);
        },
        expect: (after, _found, id) => id !== undefined && index.objects[id] === undefined &&
            pathOf(after, ['MyApp', 'Views', 'Renamed.swift']) !== undefined && pathOf(after, ['MyApp', 'Views', 'Rename.swift']) !== undefined,
        edited: [f.byPath('Rename.swift')]
    });
    writerCase('a folder renamed, then a group added under its old name', app, {
        run: (edit) => {
            edits.setElementPaths(edit, [{ id: f.byPath('Views'), path: 'Screens' }]);
            return edits.addGroupPath(edit, f.byPath('MyApp'), ['Views']);
        },
        expect: (after, _found, id) => id !== undefined && index.objects[id] === undefined &&
            pathOf(after, ['MyApp', 'Screens', 'Bar.swift']) !== undefined && pathOf(after, ['MyApp', 'Views']) !== undefined,
        edited: [f.byPath('Views')]
    });
}

console.log('writer: a hand-written project keeps its bytes outside the edit');
{
    const text = texts.get('json5-syntax.xcproj.txt');
    const index = projectIndex.readProject(text);
    const f = finder(index);
    const edit = edits.beginProjectEdit(text);
    edits.addSwiftFile(edit, 'C.swift', f.byPath('App'), f.sources('App')[0]);
    const output = edits.projectEditText(edit);
    let prefix = 0;
    while (prefix < text.length && text[prefix] === output[prefix]) { prefix++; }
    let suffix = 0;
    while (suffix < text.length - prefix && text[text.length - 1 - suffix] === output[output.length - 1 - suffix]) { suffix++; }
    const removed = text.slice(prefix, text.length - suffix);
    const read = projectIndex.readProject(output);
    report(typeof read !== 'string' && removed === '' && output.startsWith(text.slice(0, prefix)) && output.includes('// Fixture for') &&
        !/[^\r]\n/.test(output), 'nothing of the input is replaced, the comments and BOM stay, and every line still ends in CRLF', JSON.stringify(removed));
}

console.log('writer: cost');
{
    const groups = [];
    for (let group = 0; group < 50; group++) {
        const children = [];
        for (let file = 0; file < 100; file++) { children.push({ path: `File${group}_${file}.swift`, 'target-membership': ['App/compile-sources'] }); }
        groups.push({ kind: 'group', path: `Group${group}`, children });
    }
    const big = xcodeCanonical(`${JSON.stringify({
        'default-configuration': 'Release', configurations: ['Debug', 'Release'], localizations: { development: 'en' },
        files: [...groups, { kind: 'group', name: 'Products', children: [ { path: '<PRODUCTS>/App.app', id: 'A0A0A0A0A0A0A0A0A0A0A0A0', type: 'wrapper.application', index: false } ] }],
        targets: [ { name: 'App', id: 'B0B0B0B0B0B0B0B0B0B0B0B0', product: 'Products/App.app', 'product-type': 'application', 'build-phases': ['compile-sources'] } ]
    })}\n`);
    const index = projectIndex.readProject(big ?? '');
    if (!big || typeof index === 'string') {
        report(false, 'the synthetic project reads');
    } else {
        const f = finder(index);
        const sources = f.sources('App')[0];
        const started = Date.now();
        const edit = edits.beginProjectEdit(big);
        let added = 0;
        for (let count = 0; count < 300; count++) {
            if (edits.addSwiftFile(edit, `Added${count}.swift`, f.byPath(`Group${count % 50}`), sources) !== undefined) { added++; }
        }
        const output = edits.projectEditText(edit);
        const seconds = (Date.now() - started) / 1000;
        report(added === 300 && output !== big && seconds < 5, '300 adds, each its own change, in a 5,000-file project, within 5 s', `${seconds.toFixed(2)} s`);
    }
}

// ── Goldens ───────────────────────────────────────────────

const normalize = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const mapEntries = (map) => [...map.entries()];

function capture(compute) {
    try {
        return normalize(compute());
    } catch (error) {
        return { threw: String((error && error.message) || error).split('\n')[0] };
    }
}

/**
 * Every parser's output on a JSON project, with inputs taken from its own index: each native target, configuration list,
 * Frameworks and Resources phase, up to four Swift file references, each group folder and the index helpers on them.
 */
function parserEntries(text) {
    const entries = {};
    const record = (key, compute) => { entries[key] = capture(compute); };
    const index = projectIndex.readProject(text);
    if (typeof index === 'string') { return { readProject: index }; }
    const nativeTargets = index.objectsOfIsa('PBXNativeTarget').map(({ object }) => object);
    const phases = nativeTargets.flatMap((target) => (Array.isArray(target.buildPhases) ? target.buildPhases : []));
    const phasesOfIsa = (isa) => phases.filter((id) => index.objects[id]?.isa === isa);
    const lists = [index.project?.buildConfigurationList, ...nativeTargets.map((target) => target.buildConfigurationList)].filter(Boolean);
    const swiftFiles = index.objectsOfIsa('PBXFileReference').map(({ id }) => id)
        .filter((id) => /\.swift$/.test(index.objects[id].path ?? '')).slice(0, 4);
    const groupFolders = [...groups.buildGroupDirectories(text, PROJECT_DIR).entries()];
    const folders = [...new Set(groupFolders.map(([, folder]) => path.posix.relative(PROJECT_DIR, folder)))].sort();

    record('parseNativeTargets', () => targets.parseNativeTargets(text));
    record('parseTargetDependencies', () => mapEntries(targets.parseTargetDependencies(text)));
    for (const name of [...nativeTargets.map((target) => target.name), 'NoSuchTarget']) {
        record(`parseBuildPhaseIds ${name}`, () => targets.parseBuildPhaseIds(text, name));
        record(`parseExcludedFiles ${name}`, () => project.parseExcludedFiles(text, name));
    }
    record('parseBuildConfigurations', () => mapEntries(buildSettings.parseBuildConfigurations(text)));
    for (const listId of lists) {
        record(`resolveConfigurationListId ${listId}`, () => buildSettings.resolveConfigurationListId(text, listId));
        for (const configuration of CONFIGURATIONS) {
            record(`getBuildSettingsForTarget ${listId} ${configuration}`, () => buildSettings.getBuildSettingsForTarget(text, listId, configuration));
        }
    }
    for (const configuration of CONFIGURATIONS) {
        record(`getProjectBuildSettings ${configuration}`, () => buildSettings.getProjectBuildSettings(text, configuration));
    }
    record('parseSwiftPackageReferences', () => mapEntries(packages.parseSwiftPackageReferences(text)));
    record('parseSwiftPackageProductDependencies', () => mapEntries(packages.parseSwiftPackageProductDependencies(text)));
    record('parseGroups', () => mapEntries(groups.parseGroups(text)));
    record('findMainGroupId', () => groups.findMainGroupId(text));
    record('buildGroupDirectories', () => groupFolders);
    for (const relativePath of [...folders.filter((folder) => folder !== ''), 'Missing']) {
        record(`resolveGroupForPath ${relativePath}`, () => groups.resolveGroupForPath(groups.parseGroups(text), groups.findMainGroupId(text), relativePath));
    }
    record('parseVersionGroups', () => versionGroups.parseVersionGroups(text));
    record('parseSwiftVersion', () => project.parseSwiftVersion(text));
    record('parseDeploymentTargets', () => project.parseDeploymentTargets(text));
    record('parseDefaultLocalization', () => project.parseDefaultLocalization(text));
    record('usesSwiftPMObjectIds', () => project.usesSwiftPMObjectIds(text));
    for (const phaseId of phasesOfIsa('PBXFrameworksBuildPhase')) {
        record(`parseFrameworksBuildPhase ${phaseId}`, () => frameworks.parseFrameworksBuildPhase(text, phaseId));
        record(`parseLinkedFrameworksForTarget ${phaseId}`, () => frameworks.parseLinkedFrameworksForTarget(text, phaseId));
    }
    for (const phaseId of phasesOfIsa('PBXResourcesBuildPhase')) {
        record(`parseResourcesBuildPhase ${phaseId}`, () => resources.parseResourcesBuildPhase(text, phaseId));
        record(`parseResourcesForTarget ${phaseId}`, () => resources.parseResourcesForTarget(text, phaseId));
    }
    record('folderSpellings', () => projectIndex.folderSpellings(index, PROJECT_DIR));
    for (const id of swiftFiles) {
        record(`findFileReferencePath ${id}`, () => writers.findFileReferencePath(text, id));
        record(`findBuildFileId ${id}`, () => writers.findBuildFileId(text, id));
        record(`displayName ${id}`, () => projectIndex.displayName(index.object(id)));
        record(`buildFilesFor ${id}`, () => projectIndex.buildFilesFor(index, id));
        record(`phasesOf ${id}`, () => Object.fromEntries(projectIndex.buildFilesFor(index, id).map((buildFile) => [buildFile, projectIndex.phasesOf(index, buildFile)])));
    }
    for (const id of [...groupFolders.map(([id]) => id), ...swiftFiles]) {
        record(`parentOf ${id}`, () => projectIndex.parentOf(index, id));
        record(`resolvedPath ${id}`, () => projectIndex.resolvedPath(index, id, PROJECT_DIR));
    }
    for (const phaseId of phases) {
        record(`targetOfPhase ${phaseId}`, () => projectIndex.targetOfPhase(index, phaseId));
    }
    for (const folder of [...folders, 'Missing']) {
        record(`groupForFolder ${folder || '.'}`, () => projectIndex.groupForFolder(index, path.posix.join(PROJECT_DIR, folder), PROJECT_DIR));
    }
    return entries;
}

console.log(`goldens: every parser over every valid fixture${UPDATE ? ' (rewriting)' : ''}`);
for (const name of validFixtures) {
    const entries = parserEntries(texts.get(name));
    const goldenPath = path.join(GOLDEN_DIR, name.replace(/\.xcproj\.txt$/, '.json'));
    if (UPDATE) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(goldenPath, `${JSON.stringify({ fixture: path.relative(REPO, path.join(FIXTURE_DIR, name)), entries }, null, 2)}\n`);
        report(true, `${name}: golden rewritten`, `${Object.keys(entries).length} entries`);
        continue;
    }
    if (!fs.existsSync(goldenPath)) {
        report(false, `${name}: golden exists`, 'run npm run test:xcproj -- --update');
        continue;
    }
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')).entries;
    const changed = [...new Set([...Object.keys(golden), ...Object.keys(entries)])]
        .filter((key) => JSON.stringify(golden[key]) !== JSON.stringify(entries[key]));
    report(changed.length === 0, `${name}: matches its golden`, changed.length === 0 ? `${Object.keys(entries).length} entries` : changed.slice(0, 5).join(', '));
}

console.log(failures === 0 ? '\nAll JSON project file checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
