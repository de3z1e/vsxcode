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
 * Inputs:
 *  - scripts/fixtures/xcproj/: each pbxproj fixture converted by `xcodebuild -convert-project xcproj` and stored as
 *    Xcode wrote it, plus json5-syntax, a hand-written project in the JSON5 syntax Xcode accepts. The files end in .txt
 *    so the extension never activates on this repository.
 *  - A table of syntax cases recorded on Xcode 27.2, each embedded in a valid project as Xcode would see it, and a few
 *    whole texts. The verdicts aren't stored: each case runs through xcprojformatter, so a newer Xcode that reads JSON5
 *    differently fails this check.
 *
 * Requires Xcode 27.2 or later (xcprojformatter). Re-run after every Xcode upgrade.
 * Usage: npm run test:xcproj
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

console.log('fixtures');
for (const name of fixtures) {
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

console.log(failures === 0 ? '\nAll JSON project file checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
