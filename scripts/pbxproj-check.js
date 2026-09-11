#!/usr/bin/env node
/**
 * pbxproj parser and writer regression check.
 *
 * Every exported project parser, plus a fixed set of writer edits, runs over the fixtures in
 * scripts/fixtures/pbxproj/ and is diffed against the reviewed goldens in scripts/fixtures/pbxproj/goldens/,
 * so a change that shifts parser output or corrupts an edit fails a command instead of surfacing later as a
 * wrong Package.swift or a damaged project.
 *
 * Every fixture must also lint with its comments stripped, entries named in COMMENT_FREE must reproduce the
 * commented golden there, and every writer edit's output must lint.
 *
 * Usage:
 *   npm run test:pbxproj                  compare with the goldens
 *   npm run test:pbxproj -- --update      rewrite the goldens, then review the diff
 *
 *   VSXCODE_PBXPROJ_CORPUS=<file listing project.pbxproj paths>
 *   VSXCODE_PBXPROJ_CORPUS_GOLDENS=<directory outside this repository>
 *     also run the parsers and two writer edits over local projects. Output is counts and list indexes
 *     only, and the goldens directory must be outside the repository because it holds private project data.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'pbxproj');
const GOLDEN_DIR = path.join(FIXTURE_DIR, 'goldens');
const UPDATE = process.argv.includes('--update');

const load = (relative) => require(path.join(OUT, relative));
const targets = load('parsers/targets.js');
const groups = load('parsers/groups.js');
const buildSettings = load('parsers/buildSettings.js');
const packages = load('parsers/packages.js');
const frameworks = load('parsers/frameworks.js');
const resources = load('parsers/resources.js');
const versionGroups = load('parsers/versionGroups.js');
const project = load('parsers/project.js');
const version = load('utils/version.js');
const projectIndex = load('parsers/projectIndex.js');
const writers = load('writers/pbxproj.js');

// Entry families — the name before the first space, or `writer <function>` for edits — whose output on the
// comment-stripped fixture must equal the commented golden.
const COMMENT_FREE = new Set([
    'parseNativeTargets', 'parseTargetDependencies', 'parseBuildPhaseIds', 'usesSwiftPMObjectIds',
    'parseGroups', 'findMainGroupId', 'buildGroupDirectories', 'resolveGroupForPath', 'parseVersionGroups',
    'findFileReferencePath', 'findBuildFileId',
    'displayName', 'buildFilesFor', 'phasesOf', 'locateList', 'locateListEntry',
    'parentOf', 'resolvedPath', 'groupForFolder', 'targetOfPhase', 'locateKey',
    'writer addSwiftFileToPbxproj', 'writer removeSwiftFile', 'writer rehomeSwiftFile', 'writer setFileReferencePath',
    'writer addGroupPath', 'writer addDataModelToPbxproj', 'writer updateVersionGroupVersions',
    'writer moveVersionGroupToGroup', 'writer removeDataModelFromPbxproj', 'writer updateBuildSetting'
]);

// Families whose entries carry text offsets, each with how they map back from the stripped fixture before comparing.
const TEXT_OFFSET_FAMILIES = new Map([
    ['parseVersionGroups', offsetsInOriginal],
    ['locateList', listOffsetsInOriginal],
    ['locateListEntry', entryOffsetsInOriginal],
    ['locateKey', keyOffsetsInOriginal]
]);

const CONFIGURATIONS = ['Debug', 'Release'];
const MAX_DIFF_LINES = 500;
// Where resolvedPath and groupForFolder place a fixture project.
const PROJECT_DIR = '/project';

// ── Fixture table ────────────────────────────────────────────────────────────────────
// Ids are written out rather than read back through a parser, so a parser change moves only its own goldens
// and those of outputs that compose it internally (buildGroupDirectories, the version-group writers).
// `helpers` names literal inputs for the index helpers: `lists` as `[ownerId, key, entryId]` for the list locators (the
// group and Sources phase the add edit targets, plus special cases, each with its first entry as written, none when the
// list is empty); `elements` for parentOf and resolvedPath; `phases` for targetOfPhase; project-relative `folders` for
// groupForFolder; and `keys` as `[ownerId, key]` for locateKey.

const hexId = (prefix, suffix) => prefix + '0'.repeat(18) + suffix;

/** Runs session steps on a text; the edited text, or null when the text can't be read. */
const inSession = (text, steps) => {
    const edit = writers.beginProjectEdit(text);
    if (!edit) { return null; }
    steps(edit);
    return edit.contents;
};

const FIXTURES = [
    {
        name: 'explicit-app',
        file: path.join(FIXTURE_DIR, 'explicit-app.txt'),
        targets: ['SampleApp', 'SampleAppTests', 'SampleAppUITests', 'NoSuchTarget'],
        configurationLists: [hexId('5A', '0A01'), hexId('C3', '0A04'), hexId('5A', '0A07'), hexId('C3', '0A0A')],
        frameworksPhases: [hexId('C3', '0702'), hexId('5A', '0705')],
        resourcesPhases: [hexId('5A', '0703'), hexId('C3', '0706')],
        groupPaths: ['SampleApp', 'SampleApp/Views', 'SampleApp/Views/Rows', 'Shared', 'SampleApp/Shared', 'Support', 'SampleApp/Missing'],
        fileReferenceIds: [hexId('C3', '0102'), hexId('5A', '0105'), hexId('5A', '0107'), hexId('C3', '0108')],
        helpers: {
            lists: [[hexId('5A', '0011'), 'children', hexId('5A', '0103')], [hexId('5A', '0701'), 'files', hexId('5A', '0201')]],
            elements: [hexId('5A', '0002'), hexId('5A', '0010'), hexId('C3', '0013'), hexId('C3', '0014'), hexId('C3', '0108'),
                hexId('5A', '0107'), hexId('5A', '010E'), hexId('C3', '0115'), hexId('5A', '0501')],
            phases: [hexId('5A', '0701'), hexId('C3', '0704'), hexId('5A', '0707')],
            folders: ['', 'SampleApp', 'SampleApp/Views', 'SampleApp/Views/Rows', 'Shared', 'SampleApp/Shared', 'Support', 'SampleApp/Missing'],
            // Keys inline in a single-line reference, one at line start in a multi-line group, and an absent one.
            keys: [[hexId('5A', '0107'), 'name'], [hexId('5A', '0107'), 'path'], [hexId('C3', '0014'), 'sourceTree'],
                [hexId('5A', '0107'), 'explicitFileType']]
        },
        writers: {
            'addSwiftFileToPbxproj AddedView.swift': (text) =>
                writers.addSwiftFileToPbxproj(text, 'AddedView.swift', hexId('5A', '0011'), hexId('5A', '0701')),
            [`removeSwiftFile ${hexId('C3', '0108')}`]: (text) =>
                inSession(text, (edit) => writers.removeSwiftFile(edit, hexId('C3', '0108'))),
            'rehomeSwiftFile Legacy.swift into Views': (text) =>
                inSession(text, (edit) => writers.rehomeSwiftFile(edit, hexId('5A', '0107'), hexId('5A', '0011'), 'Legacy.swift')),
            'addGroupPath SampleApp/Views/Cells/Compact': (text) =>
                inSession(text, (edit) => writers.addGroupPath(edit, hexId('5A', '0011'), ['Cells', 'Compact'])),
            'addDataModelToPbxproj Added.xcdatamodeld': (text) =>
                writers.addDataModelToPbxproj(text, 'Added.xcdatamodeld', ['Added.xcdatamodel'], 'Added.xcdatamodel',
                    hexId('5A', '0010'), hexId('5A', '0701')),
            'updateVersionGroupVersions Archive.xcdatamodeld': (text) =>
                writers.updateVersionGroupVersions(text, hexId('D1', '0402'),
                    ['Archive.xcdatamodel', 'Archive 2.xcdatamodel', 'Archive 3.xcdatamodel'], 'Archive 3.xcdatamodel'),
            'moveVersionGroupToGroup Model.xcdatamodeld': (text) =>
                writers.moveVersionGroupToGroup(text, hexId('3B', '0401'), hexId('5A', '0011'), 'Model.xcdatamodeld'),
            'removeDataModelFromPbxproj Archive.xcdatamodeld': (text) =>
                writers.removeDataModelFromPbxproj(text, hexId('D1', '0402')),
            'updateBuildSetting existing key': (text) =>
                writers.updateBuildSetting(text, hexId('5A', '0A05'), 'SWIFT_STRICT_CONCURRENCY', 'complete'),
            'updateBuildSetting new key': (text) =>
                writers.updateBuildSetting(text, hexId('C3', '0A08'), 'SWIFT_STRICT_CONCURRENCY', 'minimal')
        }
    },
    {
        name: 'synchronized',
        file: path.join(FIXTURE_DIR, 'synchronized.txt'),
        targets: ['SyncApp', 'NoSuchTarget'],
        configurationLists: [hexId('A1', '0A01'), hexId('E7', '0A04')],
        frameworksPhases: [hexId('A1', '0702')],
        resourcesPhases: [hexId('E7', '0703')],
        groupPaths: ['SyncApp', 'Extras'],
        fileReferenceIds: [hexId('E7', '0101')],
        helpers: {
            lists: [[hexId('A1', '0012'), 'children', hexId('E7', '0101')], [hexId('E7', '0701'), 'files', hexId('A1', '0201')]],
            // A10…0010 is the synchronized root.
            elements: [hexId('A1', '0002'), hexId('A1', '0010'), hexId('A1', '0012'), hexId('E7', '0101')],
            phases: [hexId('E7', '0701')],
            folders: ['', 'SyncApp', 'Extras']
        },
        writers: {
            'addSwiftFileToPbxproj Added.swift': (text) =>
                writers.addSwiftFileToPbxproj(text, 'Added.swift', hexId('A1', '0012'), hexId('E7', '0701')),
            [`removeSwiftFile ${hexId('E7', '0101')}`]: (text) =>
                inSession(text, (edit) => writers.removeSwiftFile(edit, hexId('E7', '0101'))),
            'addDataModelToPbxproj Store.xcdatamodeld': (text) =>
                writers.addDataModelToPbxproj(text, 'Store.xcdatamodeld', ['Store.xcdatamodel'], 'Store.xcdatamodel',
                    hexId('A1', '0012'), hexId('E7', '0701')),
            'updateBuildSetting SWIFT_VERSION': (text) =>
                writers.updateBuildSetting(text, hexId('A1', '0A05'), 'SWIFT_VERSION', '5.0')
        }
    },
    {
        name: 'generated-ids',
        file: path.join(FIXTURE_DIR, 'generated-ids.txt'),
        targets: ['SampleKit'],
        configurationLists: ['OBJ_2', 'OBJ_12'],
        frameworksPhases: ['OBJ_17'],
        resourcesPhases: [],
        groupPaths: ['Sources', 'SampleKit'],
        fileReferenceIds: ['OBJ_9', 'OBJ_6'],
        // OBJ_10's first child is a quoted id; OBJ_7 has `path = ""`, and OBJ_8 is a SOURCE_ROOT group.
        helpers: {
            lists: [['OBJ_8', 'children', 'OBJ_9'], ['OBJ_15', 'files', 'OBJ_16'], ['OBJ_10', 'children', 'SampleKit::SampleKit::Product']],
            elements: ['OBJ_5', 'OBJ_7', 'OBJ_8', 'OBJ_9', 'OBJ_10', 'SampleKit::SampleKit::Product'],
            phases: ['OBJ_15', 'OBJ_17'],
            folders: ['', 'Sources', 'Sources/SampleKit', 'SampleKit'],
            keys: [['OBJ_8', 'path']]
        },
        writers: {
            'addSwiftFileToPbxproj Added.swift': (text) =>
                writers.addSwiftFileToPbxproj(text, 'Added.swift', 'OBJ_8', 'OBJ_15'),
            'removeSwiftFile OBJ_9': (text) =>
                inSession(text, (edit) => writers.removeSwiftFile(edit, 'OBJ_9')),
            'setFileReferencePath OBJ_9 samplekit.swift': (text) =>
                inSession(text, (edit) => writers.setFileReferencePath(edit, 'OBJ_9', 'samplekit.swift')),
            'addGroupPath Sources/SampleKit/Feature': (text) =>
                inSession(text, (edit) => writers.addGroupPath(edit, 'OBJ_8', ['Feature'])),
            'updateBuildSetting SWIFT_VERSION': (text) =>
                writers.updateBuildSetting(text, 'OBJ_13', 'SWIFT_VERSION', '5.9')
        }
    },
    {
        name: 'no-build-files',
        file: path.join(FIXTURE_DIR, 'no-build-files.txt'),
        targets: ['EmptyKit'],
        configurationLists: [hexId('7F', '0A01'), hexId('B2', '0A04')],
        frameworksPhases: [hexId('B2', '0702')],
        resourcesPhases: [],
        groupPaths: ['EmptyKit'],
        fileReferenceIds: [hexId('B2', '0101')],
        // The Sources phase's list is empty and multi-line.
        helpers: {
            lists: [[hexId('7F', '0010'), 'children', hexId('B2', '0101')], [hexId('7F', '0701'), 'files']],
            elements: [hexId('7F', '0010'), hexId('B2', '0101')],
            phases: [hexId('7F', '0701')],
            folders: ['', 'EmptyKit']
        },
        writers: {
            'addSwiftFileToPbxproj First.swift': (text) =>
                writers.addSwiftFileToPbxproj(text, 'First.swift', hexId('7F', '0010'), hexId('7F', '0701')),
            'addGroupPath EmptyKit/Sub': (text) =>
                inSession(text, (edit) => writers.addGroupPath(edit, hexId('7F', '0010'), ['Sub'])),
            'updateBuildSetting SKIP_INSTALL': (text) =>
                writers.updateBuildSetting(text, hexId('7F', '0A05'), 'SKIP_INSTALL', 'NO')
        }
    },
    {
        name: 'flag-parity',
        file: path.join(__dirname, 'fixtures', 'flag-parity-pbxproj.txt'),
        targets: ['FlagParityTarget', 'FlagParityInherited'],
        configurationLists: [hexId('AA', '000C'), hexId('AA', '0009'), hexId('AA', '0017')],
        frameworksPhases: [hexId('AA', '0004'), hexId('AA', '0014')],
        resourcesPhases: [],
        groupPaths: ['FlagParityTarget', 'FlagParityInherited'],
        fileReferenceIds: [hexId('AA', '0002'), hexId('AA', '0012')],
        // Single-line lists and objects; the Frameworks phase's list is empty.
        helpers: {
            lists: [[hexId('AA', '0006'), 'children', hexId('AA', '0002')], [hexId('AA', '000A'), 'files', hexId('AA', '0001')], [hexId('AA', '0004'), 'files']],
            elements: [hexId('AA', '0006'), hexId('AA', '0002')],
            phases: [hexId('AA', '000A'), hexId('AA', '0018')],
            folders: ['', 'FlagParityTarget', 'FlagParityInherited'],
            keys: [[hexId('AA', '0006'), 'path']]
        },
        writers: {
            'addSwiftFileToPbxproj Added.swift': (text) =>
                writers.addSwiftFileToPbxproj(text, 'Added.swift', hexId('AA', '0006'), hexId('AA', '000A')),
            'addSwiftFileToPbxproj Zed.swift': (text) =>
                writers.addSwiftFileToPbxproj(text, 'Zed.swift', hexId('AA', '0006'), hexId('AA', '000A')),
            [`removeSwiftFile ${hexId('AA', '0002')}`]: (text) =>
                inSession(text, (edit) => writers.removeSwiftFile(edit, hexId('AA', '0002'))),
            'addGroupPath FlagParityTarget/Nested': (text) =>
                inSession(text, (edit) => writers.addGroupPath(edit, hexId('AA', '0006'), ['Nested'])),
            'updateBuildSetting SWIFT_VERSION': (text) =>
                writers.updateBuildSetting(text, hexId('AA', '000F'), 'SWIFT_VERSION', '5.0')
        }
    }
];

// ── Helpers ──────────────────────────────────────────────────────────────────────────

const normalize = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const mapEntries = (map) => [...map.entries()];
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const entryFamily = (key) => (key.startsWith('writer ') ? key.split(' ').slice(0, 2).join(' ') : key.split(' ')[0]);

function capture(compute) {
    try {
        return normalize(compute());
    } catch (error) {
        return { threw: String((error && error.message) || error).split('\n')[0] };
    }
}

function plutil(args, input) {
    return execFileSync('/usr/bin/plutil', args, { input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function lint(text) {
    try {
        plutil(['-lint', '-'], text);
        return 'OK';
    } catch {
        return 'FAIL';
    }
}

function canonical(value) {
    if (Array.isArray(value)) { return value.map(canonical); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

function objectGraph(text) {
    try {
        return canonical(JSON.parse(plutil(['-convert', 'json', '-o', '-', '-'], text)));
    } catch {
        return { unparseable: true };
    }
}

/**
 * Removes every block comment outside quoted strings; `//` line comments stay as written. `origin[k]` is the original
 * index of stripped character k, with a final entry holding the original length.
 */
function stripComments(text) {
    const kept = [];
    const origin = [];
    const keep = (from, to) => {
        kept.push(text.slice(from, to));
        for (let k = from; k < to; k++) { origin.push(k); }
    };
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            const start = i;
            for (i++; i < text.length && text[i] !== '"'; i++) {
                if (text[i] === '\\') { i++; }
            }
            keep(start, Math.min(i + 1, text.length));
        } else if (char === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i);
            const stop = end === -1 ? text.length : end;
            keep(i, stop);
            i = stop - 1;
        } else if (char === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 1;
        } else {
            keep(i, i + 1);
        }
    }
    origin.push(text.length);
    return { text: kept.join(''), origin };
}

// Stripped-text offsets map back to the original; an exclusive end maps through the character before it, since a
// removed comment can follow.
const startInOriginal = (offset, origin) => origin[offset];
const endInOriginal = (offset, origin) => (offset === 0 ? 0 : origin[offset - 1] + 1);

/** A `{ startIndex, endIndex }` entry mapped back; anything else, such as null, as it is. */
function entryOffsetsInOriginal(entry, origin) {
    if (!entry || typeof entry !== 'object') { return entry; }
    return { ...entry, startIndex: startInOriginal(entry.startIndex, origin), endIndex: endInOriginal(entry.endIndex, origin) };
}

function offsetsInOriginal(value, origin) {
    return Array.isArray(value) ? value.map((entry) => entryOffsetsInOriginal(entry, origin)) : value;
}

/** A located list mapped back: `openIndex` and entry ends as ends, `closeIndex` and entry starts as starts. */
function listOffsetsInOriginal(list, origin) {
    if (!list || typeof list !== 'object') { return list; }
    return {
        ...list,
        openIndex: endInOriginal(list.openIndex, origin),
        closeIndex: startInOriginal(list.closeIndex, origin),
        entries: offsetsInOriginal(list.entries, origin)
    };
}

/** A located key mapped back: `startIndex` and `valueStart` as starts, `endIndex` and `valueEnd` as ends. */
function keyOffsetsInOriginal(location, origin) {
    if (!location || typeof location !== 'object') { return location; }
    return {
        ...location,
        startIndex: startInOriginal(location.startIndex, origin),
        endIndex: endInOriginal(location.endIndex, origin),
        valueStart: startInOriginal(location.valueStart, origin),
        valueEnd: endInOriginal(location.valueEnd, origin)
    };
}

/**
 * Writers draw object ids from crypto.randomBytes; pinning it makes their output reproducible. The 0x80 lead
 * byte sorts new ids between explicit-app's 5A- and C3-prefixed ids, so its insertions land between existing entries.
 */
function withPinnedIds(run) {
    const original = crypto.randomBytes;
    let counter = 0;
    crypto.randomBytes = (size) => {
        const buffer = Buffer.alloc(size);
        buffer[0] = 0x80;
        buffer.writeUInt32BE(++counter, size - 4);
        return buffer;
    };
    try {
        return run();
    } finally {
        crypto.randomBytes = original;
    }
}

/**
 * An edit as `-<line>: text` / `+<line>: text` lines, numbered against the original. Myers' shortest edit script,
 * whose cost follows the number of changed lines rather than the file's length, so corpus-sized projects stay cheap.
 */
function lineDiff(before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    // The diagonal a d-step path extends from: k + 1 is a step down (an inserted line), k - 1 a step right (a removed one).
    const source = (reach, d, k) => (k === -d || (k !== d && reach.get(k - 1) < reach.get(k + 1)) ? k + 1 : k - 1);
    const furthest = new Map([[1, 0]]);
    const trace = [];
    search:
    for (let d = 0; ; d++) {
        if (d > MAX_DIFF_LINES) { return [`more than ${MAX_DIFF_LINES} changed lines`]; }
        trace.push(new Map(furthest));
        for (let k = -d; k <= d; k += 2) {
            const from = source(furthest, d, k);
            let x = from === k + 1 ? furthest.get(from) : furthest.get(from) + 1;
            let y = x - k;
            while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
            furthest.set(k, x);
            if (x >= a.length && y >= b.length) { break search; }
        }
    }
    const lines = [];
    let x = a.length;
    let y = b.length;
    for (let d = trace.length - 1; d > 0; d--) {
        const fromK = source(trace[d], d, x - y);
        const fromX = trace[d].get(fromK);
        const fromY = fromX - fromK;
        while (x > fromX && y > fromY) { x--; y--; }
        lines.push(x === fromX ? `+${fromX + 1}: ${b[fromY]}` : `-${fromX + 1}: ${a[fromX]}`);
        x = fromX;
        y = fromY;
    }
    return lines.reverse();
}

// ── Entries ──────────────────────────────────────────────────────────────────────────

function parserEntries(text, inputs) {
    const entries = {};
    const record = (key, compute) => { entries[key] = capture(compute); };
    const withGroups = (run) => {
        const mainGroupId = groups.findMainGroupId(text);
        return mainGroupId ? run(groups.parseGroups(text), mainGroupId) : null;
    };

    record('parseNativeTargets', () => targets.parseNativeTargets(text));
    record('parseTargetDependencies', () => mapEntries(targets.parseTargetDependencies(text)));
    for (const name of inputs.targets) {
        record(`parseBuildPhaseIds ${name}`, () => targets.parseBuildPhaseIds(text, name));
        record(`parseExcludedFiles ${name}`, () => project.parseExcludedFiles(text, name));
    }
    record('parseBuildConfigurations', () => mapEntries(buildSettings.parseBuildConfigurations(text)));
    for (const listId of inputs.configurationLists) {
        record(`resolveConfigurationListId ${listId}`, () => buildSettings.resolveConfigurationListId(text, listId));
        for (const configuration of CONFIGURATIONS) {
            record(`getBuildSettingsForTarget ${listId} ${configuration}`,
                () => buildSettings.getBuildSettingsForTarget(text, listId, configuration));
        }
    }
    for (const configuration of CONFIGURATIONS) {
        record(`getProjectBuildSettings ${configuration}`, () => buildSettings.getProjectBuildSettings(text, configuration));
    }
    record('parseSwiftPackageReferences', () => mapEntries(packages.parseSwiftPackageReferences(text)));
    record('parseSwiftPackageProductDependencies', () => mapEntries(packages.parseSwiftPackageProductDependencies(text)));
    record('parseGroups', () => mapEntries(groups.parseGroups(text)));
    record('findMainGroupId', () => groups.findMainGroupId(text));
    record('buildGroupDirectories', () => mapEntries(groups.buildGroupDirectories(text, PROJECT_DIR)));
    for (const relativePath of inputs.groupPaths) {
        record(`resolveGroupForPath ${relativePath}`, () =>
            withGroups((groupMap, mainGroupId) => groups.resolveGroupForPath(groupMap, mainGroupId, relativePath)));
    }
    record('parseVersionGroups', () => versionGroups.parseVersionGroups(text));
    record('findVersionGroupSection', () => versionGroups.findVersionGroupSection(text));
    record('parseSwiftVersion', () => version.parseSwiftVersion(text));
    record('parseDeploymentTargets', () => project.parseDeploymentTargets(text));
    record('parseDefaultLocalization', () => project.parseDefaultLocalization(text));
    record('usesSwiftPMObjectIds', () => project.usesSwiftPMObjectIds(text));
    for (const phaseId of inputs.frameworksPhases) {
        record(`parseFrameworksBuildPhase ${phaseId}`, () => frameworks.parseFrameworksBuildPhase(text, phaseId));
        record(`parseLinkedFrameworksForTarget ${phaseId}`, () => frameworks.parseLinkedFrameworksForTarget(text, phaseId));
    }
    for (const phaseId of inputs.resourcesPhases) {
        record(`parseResourcesBuildPhase ${phaseId}`, () => resources.parseResourcesBuildPhase(text, phaseId));
        record(`parseResourcesForTarget ${phaseId}`, () => resources.parseResourcesForTarget(text, phaseId));
    }
    for (const fileReferenceId of inputs.fileReferenceIds) {
        record(`findFileReferencePath ${fileReferenceId}`, () => writers.findFileReferencePath(text, fileReferenceId));
        record(`findBuildFileId ${fileReferenceId}`, () => writers.findBuildFileId(text, fileReferenceId));
    }
    // Index helpers come only from a fixture's helpers table, so corpus mode records none.
    if (inputs.helpers) {
        const read = projectIndex.readProject(text);
        const withIndex = (compute) => () => (typeof read === 'string' ? read : compute(read));
        for (const fileReferenceId of inputs.fileReferenceIds) {
            record(`displayName ${fileReferenceId}`, withIndex((index) => projectIndex.displayName(index.object(fileReferenceId))));
            record(`buildFilesFor ${fileReferenceId}`, withIndex((index) => projectIndex.buildFilesFor(index, fileReferenceId)));
            record(`phasesOf ${fileReferenceId}`, withIndex((index) => Object.fromEntries(projectIndex.buildFilesFor(index, fileReferenceId)
                .map((buildFileId) => [buildFileId, projectIndex.phasesOf(index, buildFileId)]))));
        }
        for (const [ownerId, key, entryId] of inputs.helpers.lists) {
            record(`locateList ${ownerId} ${key}`, () => projectIndex.locateList(text, ownerId, key));
            if (entryId !== undefined) {
                record(`locateListEntry ${ownerId} ${key} ${entryId}`, () => projectIndex.locateListEntry(text, ownerId, key, entryId));
            }
        }
        for (const id of inputs.helpers.elements) {
            record(`parentOf ${id}`, withIndex((index) => projectIndex.parentOf(index, id)));
            record(`resolvedPath ${id}`, withIndex((index) => projectIndex.resolvedPath(index, id, PROJECT_DIR)));
        }
        for (const phaseId of inputs.helpers.phases) {
            record(`targetOfPhase ${phaseId}`, withIndex((index) => projectIndex.targetOfPhase(index, phaseId)));
        }
        for (const folder of inputs.helpers.folders) {
            record(`groupForFolder ${folder || '.'}`,
                withIndex((index) => projectIndex.groupForFolder(index, path.posix.join(PROJECT_DIR, folder), PROJECT_DIR)));
        }
        for (const [ownerId, key] of inputs.helpers.keys || []) {
            record(`locateKey ${ownerId} ${key}`, () => projectIndex.locateKey(text, ownerId, key));
        }
    }
    return entries;
}

function writerEntries(text, inputs) {
    const entries = {};
    for (const [label, edit] of Object.entries(inputs.writers)) {
        entries[`writer ${label}`] = capture(() => {
            const output = withPinnedIds(() => edit(text));
            return output === null || output === undefined
                ? { output: null }
                : { lint: lint(output), diff: lineDiff(text, output) };
        });
    }
    return entries;
}

function commentFreeProblems(inputs, text, stripped, origin, goldenEntries) {
    const problems = [];
    if (COMMENT_FREE.size === 0) { return problems; }
    for (const [key, value] of Object.entries(parserEntries(stripped, inputs))) {
        const family = entryFamily(key);
        if (!COMMENT_FREE.has(family)) { continue; }
        const mapBack = TEXT_OFFSET_FAMILIES.get(family);
        const actual = mapBack ? mapBack(value, origin) : value;
        if (!sameValue(actual, goldenEntries[key])) {
            problems.push({ key: `${key} [comments stripped]`, expected: goldenEntries[key], actual });
        }
    }
    for (const [label, edit] of Object.entries(inputs.writers)) {
        const key = `writer ${label}`;
        if (!COMMENT_FREE.has(entryFamily(key))) { continue; }
        const commented = capture(() => withPinnedIds(() => edit(text)));
        const bare = capture(() => withPinnedIds(() => edit(stripped)));
        const expected = typeof commented === 'string' ? objectGraph(commented) : commented;
        const actual = typeof bare === 'string' ? objectGraph(bare) : bare;
        if (!sameValue(expected, actual)) {
            problems.push({ key: `${key} [comments stripped, object graph]`, expected, actual });
        }
    }
    return problems;
}

// ── Reporting ────────────────────────────────────────────────────────────────────────

function describe(problem) {
    const expected = (JSON.stringify(problem.expected, null, 2) ?? 'undefined').split('\n');
    const actual = (JSON.stringify(problem.actual, null, 2) ?? 'undefined').split('\n');
    let line = 0;
    while (line < expected.length && line < actual.length && expected[line] === actual[line]) { line++; }
    const excerpt = (lines) => lines.slice(Math.max(0, line - 2), line + 3)
        .map((text) => text.slice(0, 160)).join('\n                    ');
    return `        ${problem.key}\n          expected: ${excerpt(expected)}\n          actual:   ${excerpt(actual)}`;
}

function report(name, problems, summary) {
    if (problems.length === 0) {
        console.log(`  ${UPDATE ? 'DONE' : 'PASS'}  ${name}  (${summary})`);
        return;
    }
    console.log(`  FAIL  ${name}  (${problems.length} problem${problems.length === 1 ? '' : 's'}; ${summary})`);
    for (const problem of problems) { console.log(describe(problem)); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

function checkFixture(fixture, producedKeys) {
    const text = fs.readFileSync(fixture.file, 'utf8');
    const { text: stripped, origin } = stripComments(text);
    const problems = [];
    if (lint(text) !== 'OK') {
        problems.push({ key: 'fixture passes plutil -lint', expected: 'OK', actual: 'FAIL' });
    }
    if (lint(stripped) !== 'OK') {
        problems.push({ key: 'comment-stripped fixture passes plutil -lint', expected: 'OK', actual: 'FAIL' });
    }

    const entries = { ...parserEntries(text, fixture), ...writerEntries(text, fixture) };
    producedKeys.push(...Object.keys(entries));
    for (const [key, value] of Object.entries(entries)) {
        if (key.startsWith('writer ') && value && value.lint === 'FAIL') {
            problems.push({ key: `${key} output passes plutil -lint`, expected: 'OK', actual: 'FAIL' });
        }
    }
    const goldenPath = path.join(GOLDEN_DIR, `${fixture.name}.json`);
    const entryCount = Object.keys(entries).length;

    if (UPDATE) {
        const previous = fs.existsSync(goldenPath) ? JSON.parse(fs.readFileSync(goldenPath, 'utf8')).entries : {};
        const changed = [...new Set([...Object.keys(previous), ...Object.keys(entries)])]
            .filter((key) => !(key in previous) || !(key in entries) || !sameValue(previous[key], entries[key]));
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(goldenPath, `${JSON.stringify({ fixture: path.relative(REPO, fixture.file), entries }, null, 2)}\n`);
        problems.push(...commentFreeProblems(fixture, text, stripped, origin, entries));
        report(fixture.name, problems, `golden rewritten; ${changed.length} of ${entryCount} entries changed`);
        for (const key of changed) { console.log(`          changed: ${key}`); }
        return problems.length;
    }

    if (!fs.existsSync(goldenPath)) {
        problems.push({ key: 'golden file', expected: path.relative(REPO, goldenPath), actual: 'missing; run npm run test:pbxproj -- --update' });
    } else {
        const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')).entries;
        for (const key of new Set([...Object.keys(golden), ...Object.keys(entries)])) {
            if (!(key in golden)) {
                problems.push({ key: `${key} (not in golden)`, expected: undefined, actual: entries[key] });
            } else if (!(key in entries)) {
                problems.push({ key: `${key} (no longer produced)`, expected: golden[key], actual: undefined });
            } else if (!sameValue(golden[key], entries[key])) {
                problems.push({ key, expected: golden[key], actual: entries[key] });
            }
        }
        problems.push(...commentFreeProblems(fixture, text, stripped, origin, golden));
    }
    report(fixture.name, problems, `${entryCount} entries`);
    return problems.length;
}

// ── Local corpus ─────────────────────────────────────────────────────────────────────

/** Inputs for a real project, read from plutil's object graph so they don't move with the parsers under test. */
function corpusInputs(text) {
    const { objects, rootObject } = JSON.parse(plutil(['-convert', 'json', '-o', '-', '-'], text));
    const idsOf = (isa) => Object.keys(objects).filter((key) => objects[key].isa === isa).sort();
    const nativeTargets = idsOf('PBXNativeTarget').map((key) => objects[key]);
    const phasesOf = (isa) => nativeTargets.flatMap((target) =>
        (target.buildPhases || []).filter((phase) => objects[phase] && objects[phase].isa === isa));
    const swiftReferences = idsOf('PBXFileReference').filter((key) => /\.swift$/.test(objects[key].path || '')).slice(0, 3);
    const root = objects[rootObject] || {};
    const firstSources = phasesOf('PBXSourcesBuildPhase')[0];
    const edits = {};
    if (root.mainGroup && firstSources) {
        edits['addSwiftFileToPbxproj probe'] = (input) =>
            writers.addSwiftFileToPbxproj(input, 'CorpusProbe.swift', root.mainGroup, firstSources);
    }
    if (swiftReferences.length > 0) {
        edits['removeSwiftFile first Swift file'] = (input) =>
            inSession(input, (edit) => writers.removeSwiftFile(edit, swiftReferences[0]));
    }
    return {
        targets: nativeTargets.map((target) => target.name),
        configurationLists: [root.buildConfigurationList, ...nativeTargets.map((target) => target.buildConfigurationList)].filter(Boolean),
        frameworksPhases: phasesOf('PBXFrameworksBuildPhase'),
        resourcesPhases: phasesOf('PBXResourcesBuildPhase'),
        groupPaths: [],
        fileReferenceIds: swiftReferences,
        writers: edits
    };
}

/**
 * `target` with symlinks and letter case resolved through its longest existing ancestor, so a goldens directory can be
 * checked against the repository before it is created.
 */
function realPath(target) {
    const missing = [];
    let existing = path.resolve(target);
    while (!fs.existsSync(existing)) {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
    }
    return path.join(fs.realpathSync.native(existing), ...missing);
}

function checkCorpus() {
    const listFile = process.env.VSXCODE_PBXPROJ_CORPUS;
    const goldenDirectory = process.env.VSXCODE_PBXPROJ_CORPUS_GOLDENS;
    if (!listFile && !goldenDirectory) { return 0; }
    if (!listFile || !goldenDirectory) {
        console.log('\n  FAIL  corpus  (set both VSXCODE_PBXPROJ_CORPUS and VSXCODE_PBXPROJ_CORPUS_GOLDENS)');
        return 1;
    }
    const relative = path.relative(realPath(REPO), realPath(goldenDirectory));
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        console.log('\n  FAIL  corpus  (VSXCODE_PBXPROJ_CORPUS_GOLDENS must be outside the repository: its goldens hold private project data)');
        return 1;
    }
    fs.mkdirSync(goldenDirectory, { recursive: true });

    const files = fs.readFileSync(listFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    const differing = [];
    const unreadable = [];
    files.forEach((file, index) => {
        let entries;
        try {
            const text = fs.readFileSync(file, 'utf8');
            const inputs = corpusInputs(text);
            entries = { ...parserEntries(text, inputs), ...writerEntries(text, inputs) };
        } catch {
            unreadable.push(index);
            return;
        }
        const goldenPath = path.join(goldenDirectory, `${index}.json`);
        if (UPDATE) {
            fs.writeFileSync(goldenPath, JSON.stringify(entries));
            return;
        }
        if (!fs.existsSync(goldenPath)) {
            differing.push(index);
            return;
        }
        const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
        const keys = new Set([...Object.keys(golden), ...Object.keys(entries)]);
        if ([...keys].some((key) => !(key in golden) || !(key in entries) || !sameValue(golden[key], entries[key]))) {
            differing.push(index);
        }
    });

    const listed = (label, indexes) => `${label} ${indexes.length}${indexes.length ? ` (#${indexes.join(', #')})` : ''}`;
    const failed = unreadable.length > 0 || (!UPDATE && differing.length > 0);
    const outcome = UPDATE ? 'goldens captured' : listed('differ', differing);
    console.log(`\n  ${failed ? 'FAIL' : UPDATE ? 'DONE' : 'PASS'}  corpus  (${files.length} projects; ${outcome}; ${listed('unreadable', unreadable)})`);
    return failed ? 1 : 0;
}

// ── Project index cases ──────────────────────────────────────────────────────────────

/** `text` padded with generated file references past `bytes`, so plutil's JSON outgrows execFileSync's default buffer. */
function paddedProject(text, bytes) {
    const marker = '/* End PBXFileReference section */';
    const lines = [];
    for (let n = 0, size = text.length; size < bytes; n++) {
        const id = `F0${n.toString(16).toUpperCase().padStart(22, '0')}`;
        const line = `\t\t${id} /* Padding${n}.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; ` +
            `path = Padding${n}.swift; sourceTree = "<group>"; };\n`;
        lines.push(line);
        size += line.length;
    }
    return text.replace(marker, `${lines.join('')}${marker}`);
}

/** The index-backed readers on a project too large for plutil's default output buffer, and on one plutil rejects. */
function indexCaseProblems() {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, 'explicit-app.txt'), 'utf8');
    const problems = [];

    const expected = capture(() => targets.parseNativeTargets(text));
    const large = paddedProject(text, 3 * 1024 * 1024);
    const actual = capture(() => targets.parseNativeTargets(large));
    if (!Array.isArray(actual) || actual.length === 0 || !sameValue(actual, expected)) {
        problems.push({ key: `parseNativeTargets on explicit-app padded to ${(large.length / 1e6).toFixed(1)} MB`, expected, actual });
    }

    const conflicted = text.replace('\tobjects = {\n', '<<<<<<< HEAD\n\tobjects = {\n');
    const empty = {
        parseNativeTargets: [], parseTargetDependencies: [], parseBuildPhaseIds: {},
        parseGroups: [], findMainGroupId: null, parseVersionGroups: []
    };
    const read = capture(() => ({
        parseNativeTargets: targets.parseNativeTargets(conflicted),
        parseTargetDependencies: mapEntries(targets.parseTargetDependencies(conflicted)),
        parseBuildPhaseIds: targets.parseBuildPhaseIds(conflicted, 'SampleApp'),
        parseGroups: mapEntries(groups.parseGroups(conflicted)),
        findMainGroupId: groups.findMainGroupId(conflicted),
        parseVersionGroups: versionGroups.parseVersionGroups(conflicted)
    }));
    if (!sameValue(read, empty)) {
        problems.push({ key: 'index-backed readers on explicit-app with a merge conflict marker', expected: empty, actual: read });
    }
    return problems;
}

// ── Main ─────────────────────────────────────────────────────────────────────────────

function main() {
    const producedKeys = [];
    let failures = 0;
    for (const fixture of FIXTURES) {
        if (checkFixture(fixture, producedKeys) > 0) { failures++; }
    }
    const indexProblems = indexCaseProblems();
    report('project index cases', indexProblems, 'a 3 MB project and a merge-conflicted one');
    if (indexProblems.length > 0) { failures++; }
    const families = new Set(producedKeys.map(entryFamily));
    const unknown = [...COMMENT_FREE].filter((family) => !families.has(family));
    if (unknown.length > 0) {
        console.log(`\n  FAIL  COMMENT_FREE names entry families no fixture produces: ${unknown.join(', ')}`);
        failures++;
    }
    failures += checkCorpus();
    if (failures > 0) {
        console.log(`\n${failures} check(s) failed.`);
        process.exit(1);
    }
    console.log(UPDATE ? '\nGoldens rewritten; review the diff before committing.' : '\npbxproj check OK.');
}

main();
