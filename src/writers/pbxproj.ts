import * as crypto from 'crypto';

import {
    buildFilesFor,
    displayName,
    locateDictionary,
    locateList,
    locateListEntry,
    locateObject,
    locateObjects,
    locateObjectsClose,
    phasesOf,
    readProject,
    stringList,
    stringValue
} from '../parsers/projectIndex';
import type { ListEntryLocation, ProjectIndex } from '../parsers/projectIndex';
import { VERSION_GROUP_SECTION_BEGIN, VERSION_GROUP_SECTION_END } from '../parsers/versionGroups';

// ── ID Generation ────────────────────────────────────────

export function collectExistingIds(pbxContents: string): Set<string> {
    const ids = new Set<string>();
    const idRegex = /\b([A-F0-9]{24})\b/g;
    let match: RegExpExecArray | null;
    while ((match = idRegex.exec(pbxContents)) !== null) {
        ids.add(match[1]);
    }
    return ids;
}

export function generateUniqueId(existingIds: Set<string>): string {
    let id: string;
    do {
        id = crypto.randomBytes(12).toString('hex').toUpperCase();
    } while (existingIds.has(id));
    return id;
}

// ── Helpers ──────────────────────────────────────────────

function needsQuoting(value: string): boolean {
    return /[^A-Za-z0-9._]/.test(value);
}

function formatPath(fileName: string): string {
    return needsQuoting(fileName) ? `"${fileName}"` : fileName;
}

/** An object id as written in the file: quoted when it needs it, as a path is. */
const formatId = formatPath;

/** One writer call: the text as it changes, and what was read from the call's input. */
interface Edit {
    contents: string;
    /** Read once, on the call's input; offsets always come from `contents`. */
    index: ProjectIndex;
    /** Whether the file uses section markers, in which case comments are written. */
    commented: boolean;
    /** Display names of objects inserted during the call, which the index doesn't know. */
    insertedNames: Map<string, string>;
}

const SECTION_MARKER = /^\/\* Begin [A-Za-z]+ section \*\//m;

/** Starts an edit; null when plutil can't read the text, which writers then leave unchanged. */
function beginEdit(pbxContents: string): Edit | null {
    const index = readProject(pbxContents);
    if (typeof index === 'string') { return null; }
    return { contents: pbxContents, index, commented: SECTION_MARKER.test(pbxContents), insertedNames: new Map() };
}

function comment(edit: Edit, text: string): string {
    return edit.commented ? ` /* ${text} */` : '';
}

function splice(edit: Edit, start: number, end: number, insert: string): void {
    edit.contents = edit.contents.slice(0, start) + insert + edit.contents.slice(end);
}

/** `offset` moved back over the spaces and tabs before it, when only those precede it on its line. */
function lineStartIfBlank(contents: string, offset: number): number {
    let start = offset;
    while (start > 0 && (contents[start - 1] === ' ' || contents[start - 1] === '\t')) { start--; }
    return start === 0 || contents[start - 1] === '\n' ? start : offset;
}

/** The spaces and tabs at `start`, the indentation of the line it begins. */
function indentAt(contents: string, start: number): string {
    let end = start;
    while (contents[end] === ' ' || contents[end] === '\t') { end++; }
    return contents.slice(start, end);
}

interface Section {
    /** Offset of the `/* Begin … *\/` marker. */
    beginIndex: number;
    /** Offset of the `/* End … *\/` marker, where the section's entries stop. */
    bodyEnd: number;
}

function findSection(contents: string, isa: string): Section | null {
    const beginIndex = contents.indexOf(`/* Begin ${isa} section */`);
    if (beginIndex === -1) { return null; }
    const bodyEnd = contents.indexOf(`/* End ${isa} section */`, beginIndex);
    return bodyEnd === -1 ? null : { beginIndex, bodyEnd };
}

/** Indentation of the entries in `isa`'s section; of any entry when the file has no such section; else two tabs. */
function objectIndent(contents: string, isa: string): string {
    const entries = locateObjects(contents);
    const section = findSection(contents, isa);
    const sample = section
        ? entries.find(({ location }) => location.startIndex > section.beginIndex && location.startIndex < section.bodyEnd)
        : entries[0];
    return sample ? indentAt(contents, sample.location.startIndex) : '\t\t';
}

/** Offset just past the last `/* End <isa> section *\/` line, where a section that sorts last belongs. */
function findLastSectionEnd(pbxContents: string): number {
    const markerRegex = /^\/\* End [A-Za-z]+ section \*\/[ \t]*\r?\n/gm;
    let insertAt = -1;
    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(pbxContents)) !== null) {
        insertAt = match.index + match[0].length;
    }
    return insertAt;
}

/** In its isa's section by id order; else a new section in isa order, in Xcode's blank-line layout; else before `objects` closes. */
function insertObject(edit: Edit, isa: string, id: string, entry: string): void {
    const contents = edit.contents;
    const section = findSection(contents, isa);
    if (section) {
        // The section's entries as the text holds them now, so earlier edits in this call are accounted for.
        const next = locateObjects(contents).find(({ id: other, location }) =>
            location.startIndex > section.beginIndex && location.startIndex < section.bodyEnd && other > id);
        const at = next ? next.location.startIndex : section.bodyEnd;
        splice(edit, at, at, entry);
        return;
    }
    if (edit.commented) {
        const following = [...contents.matchAll(/^\/\* Begin ([A-Za-z]+) section \*\/[ \t]*\r?\n/gm)]
            .find((match) => match[1] > isa);
        if (following?.index !== undefined) {
            splice(edit, following.index, following.index, `/* Begin ${isa} section */\n${entry}/* End ${isa} section */\n\n`);
            return;
        }
        const lastEnd = findLastSectionEnd(contents);
        if (lastEnd !== -1) {
            splice(edit, lastEnd, lastEnd, `\n/* Begin ${isa} section */\n${entry}/* End ${isa} section */\n`);
            return;
        }
    }
    const close = locateObjectsClose(contents);
    if (close === undefined) { return; }
    const at = lineStartIfBlank(contents, close);
    splice(edit, at, at, entry);
}

/** Removes an object definition, whole. */
function removeObject(edit: Edit, id: string): void {
    const location = locateObject(edit.contents, id);
    if (location) { splice(edit, location.startIndex, location.endIndex, ''); }
}

/** Comparable-entry filter matching the .swift children `addToGroup` sorts among by default. */
function isSwiftEntry(name: string): boolean {
    return name.endsWith('.swift') || name.includes('.swift ');
}

/** Comparable-entry filter that sorts among every named child, the way Xcode orders a group. */
export function anyEntry(): boolean {
    return true;
}

/** With `comparable`, sorts case-insensitively by display name among accepted, named entries; otherwise, or when none are, appends. */
function insertListEntry(
    edit: Edit,
    ownerId: string,
    key: string,
    entryId: string,
    entryComment: string,
    name: string,
    comparable: ((name: string) => boolean) | null
): void {
    const list = locateList(edit.contents, ownerId, key);
    if (!list) { return; }

    let at: number | undefined;
    if (comparable) {
        let lastBefore: ListEntryLocation | undefined;
        for (const entry of list.entries) {
            const entryName = edit.insertedNames.get(entry.id) ?? displayName(edit.index.object(entry.id));
            if (entryName === '' || !comparable(entryName)) { continue; }
            if (entryName.localeCompare(name, undefined, { sensitivity: 'base' }) > 0) {
                at = entry.startIndex;
                break;
            }
            lastBefore = entry;
        }
        if (at === undefined && lastBefore) { at = lastBefore.endIndex; }
    }

    const text = `${formatId(entryId)}${comment(edit, entryComment)}`;
    if (list.multiLine) {
        const indent = list.entries.length > 0 ? indentAt(edit.contents, list.entries[0].startIndex) : '\t\t\t\t';
        const position = at ?? lineStartIfBlank(edit.contents, list.closeIndex);
        splice(edit, position, position, `${indent}${text},\n`);
    } else {
        const position = at ?? list.closeIndex;
        splice(edit, position, position, `${text}, `);
    }
}

type ListKey = 'children' | 'files';

/** Removes `id` from every `children` list, or every build phase's `files` list, that holds it per the call's index. */
function removeFromLists(edit: Edit, id: string, key: ListKey): void {
    const owners = key === 'files'
        ? phasesOf(edit.index, id)
        : edit.index.ids.filter((ownerId) => stringList(edit.index.objects[ownerId].children).includes(id));
    for (const ownerId of owners) {
        // Once per listing, in case a list names the id more than once.
        const listings = stringList(edit.index.objects[ownerId][key]).filter((entryId) => entryId === id).length;
        for (let removed = 0; removed < listings; removed++) {
            const entry = locateListEntry(edit.contents, ownerId, key, id);
            if (!entry) { break; }
            splice(edit, entry.startIndex, entry.endIndex, '');
        }
    }
}

/** The first PBXFileReference, in definition order, whose display name is `fileName`. */
function fileReferenceNamed(index: ProjectIndex, fileName: string): string | undefined {
    return index.objectsOfIsa('PBXFileReference').find(({ object }) => displayName(object) === fileName)?.id;
}

// ── Adding a File ────────────────────────────────────────

function addFileReferenceTo(edit: Edit, fileRefId: string, fileName: string, lastKnownFileType: string): void {
    const indent = objectIndent(edit.contents, 'PBXFileReference');
    const entry = `${indent}${formatId(fileRefId)}${comment(edit, fileName)} = {isa = PBXFileReference; lastKnownFileType = ${lastKnownFileType}; path = ${formatPath(fileName)}; sourceTree = "<group>"; };\n`;
    insertObject(edit, 'PBXFileReference', fileRefId, entry);
    edit.insertedNames.set(fileRefId, fileName);
}

function addBuildFileTo(edit: Edit, buildFileId: string, fileRefId: string, fileName: string): void {
    const indent = objectIndent(edit.contents, 'PBXBuildFile');
    const entry = `${indent}${formatId(buildFileId)}${comment(edit, `${fileName} in Sources`)} = {isa = PBXBuildFile; fileRef = ${formatId(fileRefId)}${comment(edit, fileName)}; };\n`;
    insertObject(edit, 'PBXBuildFile', buildFileId, entry);
}

export function addFileReference(
    pbxContents: string,
    fileRefId: string,
    fileName: string,
    lastKnownFileType: string = 'sourcecode.swift'
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    addFileReferenceTo(edit, fileRefId, fileName, lastKnownFileType);
    return edit.contents;
}

export function addBuildFile(
    pbxContents: string,
    buildFileId: string,
    fileRefId: string,
    fileName: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    addBuildFileTo(edit, buildFileId, fileRefId, fileName);
    return edit.contents;
}

export function addToGroup(
    pbxContents: string,
    groupId: string,
    fileRefId: string,
    fileName: string,
    comparable: (name: string) => boolean = isSwiftEntry
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    insertListEntry(edit, groupId, 'children', fileRefId, fileName, fileName, comparable);
    return edit.contents;
}

export function addToSourcesBuildPhase(
    pbxContents: string,
    sourcesBuildPhaseId: string,
    buildFileId: string,
    fileName: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    insertListEntry(edit, sourcesBuildPhaseId, 'files', buildFileId, `${fileName} in Sources`, fileName, null);
    return edit.contents;
}

export function addSwiftFileToPbxproj(
    pbxContents: string,
    fileName: string,
    groupId: string,
    sourcesBuildPhaseId: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    const existingIds = collectExistingIds(pbxContents);
    const buildFileId = generateUniqueId(existingIds);
    existingIds.add(buildFileId);
    const fileRefId = generateUniqueId(existingIds);

    addBuildFileTo(edit, buildFileId, fileRefId, fileName);
    addFileReferenceTo(edit, fileRefId, fileName, 'sourcecode.swift');
    insertListEntry(edit, groupId, 'children', fileRefId, fileName, fileName, isSwiftEntry);
    insertListEntry(edit, sourcesBuildPhaseId, 'files', buildFileId, `${fileName} in Sources`, fileName, null);
    return edit.contents;
}

// ── Finding entries for removal ──────────────────────────

/** The first PBXFileReference, in definition order, whose display name (`name`, else the path's last component) is `fileName`. */
export function findFileReferenceId(
    pbxContents: string,
    fileName: string
): string | null {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? null : fileReferenceNamed(index, fileName) ?? null;
}

/** The `path` of a PBXFileReference, for checking a recorded entry against disk. */
export function findFileReferencePath(
    pbxContents: string,
    fileRefId: string
): string | null {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? null : stringValue(index.object(fileRefId)?.path) ?? null;
}

export function findBuildFileId(
    pbxContents: string,
    fileRefId: string
): string | null {
    const index = readProject(pbxContents);
    return typeof index === 'string' ? null : buildFilesFor(index, fileRefId)[0] ?? null;
}

// ── Removing a File ──────────────────────────────────────

export function removeFileReference(
    pbxContents: string,
    fileRefId: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    removeObject(edit, fileRefId);
    return edit.contents;
}

export function removeBuildFile(
    pbxContents: string,
    buildFileId: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    removeObject(edit, buildFileId);
    return edit.contents;
}

export function removeFromGroup(
    pbxContents: string,
    fileRefId: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    removeFromLists(edit, fileRefId, 'children');
    return edit.contents;
}

export function removeFromSourcesBuildPhase(
    pbxContents: string,
    buildFileId: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    removeFromLists(edit, buildFileId, 'files');
    return edit.contents;
}

export function updateBuildSetting(
    pbxContents: string,
    configId: string,
    key: string,
    value: string
): string {
    const block = locateDictionary(pbxContents, configId, 'buildSettings');
    if (!block) { return pbxContents; }

    const settingsBlock = pbxContents.slice(block.openIndex, block.closeIndex);
    const settingRegex = new RegExp(`([ \\t]*)${key} = [^;]*;`);
    const existingMatch = settingRegex.exec(settingsBlock);

    let newSettings: string;
    if (existingMatch) {
        newSettings = settingsBlock.replace(settingRegex, `${existingMatch[1]}${key} = ${value};`);
    } else {
        // Insert new setting before the closing of buildSettings block
        const indentMatch = /^([ \t]+)\w/.exec(settingsBlock.split('\n').find(l => /^\s+\w/.test(l)) || '');
        const indent = indentMatch ? indentMatch[1] : '\t\t\t\t';
        const newLine = `\n${indent}${key} = ${value};`;
        // Try inserting before trailing whitespace, or append before end
        const trailingMatch = /(\n)([ \t]*$)/.exec(settingsBlock);
        if (trailingMatch) {
            newSettings = settingsBlock.replace(/(\n)([ \t]*$)/, `${newLine}\n$2`);
        } else {
            newSettings = settingsBlock + newLine + '\n';
        }
    }

    return pbxContents.slice(0, block.openIndex) + newSettings + pbxContents.slice(block.closeIndex);
}

export function removeSwiftFileFromPbxproj(
    pbxContents: string,
    fileName: string
): string | null {
    const edit = beginEdit(pbxContents);
    if (!edit) { return null; }
    const fileRefId = fileReferenceNamed(edit.index, fileName);
    if (!fileRefId) { return null; }

    // A file compiled by several targets has one build file per target, so drain them all.
    for (const buildFileId of buildFilesFor(edit.index, fileRefId)) {
        removeFromLists(edit, buildFileId, 'files');
        removeObject(edit, buildFileId);
    }
    removeFromLists(edit, fileRefId, 'children');
    removeObject(edit, fileRefId);
    return edit.contents;
}

// ── Core Data Models (XCVersionGroup) ────────────────────
// A `.xcdatamodeld` bundle goes in the Sources phase, not Resources, because momc compiles it.

const DATA_MODEL_VERSION_FILE_TYPE = 'wrapper.xcdatamodel';

export interface DataModelVersion {
    id: string;
    /** Version bundle name, e.g. "MyApp.xcdatamodel". */
    name: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An empty section is invalid for Xcode to round-trip, so a removal takes the markers with the last entry.
const EMPTY_VERSION_GROUP_SECTION = new RegExp(
    `(?:(?<=\\n)\\r?\\n)?${escapeRegExp(VERSION_GROUP_SECTION_BEGIN)}[ \\t]*\\r?\\n` +
    `${escapeRegExp(VERSION_GROUP_SECTION_END)}[ \\t]*\\r?\\n`
);

function formatVersionGroupEntry(
    edit: Edit,
    versionGroupId: string,
    bundleName: string,
    versions: DataModelVersion[],
    currentVersionId: string | undefined,
    indent: string,
    name?: string,
    sourceTree: string = '<group>'
): string {
    const inner = indent + '\t';
    const child = inner + '\t';
    const lines = [
        `${indent}${formatId(versionGroupId)}${comment(edit, bundleName)} = {`,
        `${inner}isa = XCVersionGroup;`,
        `${inner}children = (`,
        ...versions.map((version) => `${child}${formatId(version.id)}${comment(edit, version.name)},`),
        `${inner});`
    ];

    const current = versions.find((version) => version.id === currentVersionId);
    if (current) {
        lines.push(`${inner}currentVersion = ${formatId(current.id)}${comment(edit, current.name)};`);
    }
    if (name !== undefined) {
        lines.push(`${inner}name = ${formatPath(name)};`);
    }
    lines.push(
        `${inner}path = ${formatPath(bundleName)};`,
        `${inner}sourceTree = ${formatPath(sourceTree)};`,
        `${inner}versionGroupType = ${DATA_MODEL_VERSION_FILE_TYPE};`,
        `${indent}};`
    );
    return lines.join('\n') + '\n';
}

function addVersionGroupTo(
    edit: Edit,
    versionGroupId: string,
    bundleName: string,
    versions: DataModelVersion[],
    currentVersionId: string | undefined
): void {
    // Indented like the file references, the section a new XCVersionGroup section's entries would match.
    const indent = objectIndent(edit.contents, 'PBXFileReference');
    insertObject(edit, 'XCVersionGroup', versionGroupId,
        formatVersionGroupEntry(edit, versionGroupId, bundleName, versions, currentVersionId, indent));
    edit.insertedNames.set(versionGroupId, bundleName);
}

/** Removes an XCVersionGroup entry, and its section markers once the last entry is gone. False when it isn't one. */
function removeVersionGroupFrom(edit: Edit, versionGroupId: string): boolean {
    if (edit.index.object(versionGroupId)?.isa !== 'XCVersionGroup') { return false; }
    const location = locateObject(edit.contents, versionGroupId);
    if (!location) { return false; }
    splice(edit, location.startIndex, location.endIndex, '');
    edit.contents = edit.contents.replace(EMPTY_VERSION_GROUP_SECTION, '');
    return true;
}

/** Insert an XCVersionGroup in ascending ID order, creating the section when the project has none. */
export function addVersionGroup(
    pbxContents: string,
    versionGroupId: string,
    bundleName: string,
    versions: DataModelVersion[],
    currentVersionId: string | undefined
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    addVersionGroupTo(edit, versionGroupId, bundleName, versions, currentVersionId);
    return edit.contents;
}

/** Remove an XCVersionGroup entry, dropping the section markers once the last entry is gone. */
export function removeVersionGroup(pbxContents: string, versionGroupId: string): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    removeVersionGroupFrom(edit, versionGroupId);
    return edit.contents;
}

/** Rewrite an XCVersionGroup's versions in place, so its id, section position, and every target's PBXBuildFile, group child, and Sources entry survive. */
export function updateVersionGroupVersions(
    pbxContents: string,
    versionGroupId: string,
    versionNames: string[],
    currentVersionName: string | undefined
): string | null {
    if (versionNames.length === 0) { return null; }
    const edit = beginEdit(pbxContents);
    const group = edit?.index.object(versionGroupId);
    if (!edit || group?.isa !== 'XCVersionGroup' || !locateObject(pbxContents, versionGroupId)) { return null; }

    for (const childId of stringList(group.children)) {
        removeObject(edit, childId);
    }

    const existingIds = collectExistingIds(edit.contents);
    const versions: DataModelVersion[] = versionNames.map((name) => {
        const id = generateUniqueId(existingIds);
        existingIds.add(id);
        return { id, name };
    });
    for (const version of versions) {
        addFileReferenceTo(edit, version.id, version.name, DATA_MODEL_VERSION_FILE_TYPE);
    }
    const current = versions.find((version) => version.name === currentVersionName) ?? versions[0];

    // Offsets moved with the edits above; identity fields survive verbatim from the index, only children and currentVersion change.
    const location = locateObject(edit.contents, versionGroupId);
    const groupPath = stringValue(group.path);
    const groupName = stringValue(group.name);
    const bundleName = groupPath ?? groupName;
    if (!location || !bundleName) { return null; }
    const entry = formatVersionGroupEntry(
        edit, versionGroupId, bundleName, versions, current.id, objectIndent(edit.contents, 'PBXFileReference'),
        groupPath !== undefined ? groupName : undefined, stringValue(group.sourceTree) ?? '<group>'
    );
    splice(edit, location.startIndex, location.endIndex, entry);
    return edit.contents;
}

/** Move an XCVersionGroup's child entry to another PBXGroup, leaving every other structure alone. */
export function moveVersionGroupToGroup(
    pbxContents: string,
    versionGroupId: string,
    newGroupId: string,
    bundleName: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    removeFromLists(edit, versionGroupId, 'children');
    insertListEntry(edit, newGroupId, 'children', versionGroupId, bundleName, bundleName, anyEntry);

    // The new parent group maps to the bundle's own directory, so a path that
    // carried directory components must collapse to the plain bundle name or
    // the entry would resolve to a directory that no longer exists.
    const groupPath = stringValue(edit.index.object(versionGroupId)?.path);
    const location = locateObject(edit.contents, versionGroupId);
    if (location && groupPath !== undefined && groupPath !== bundleName) {
        const entryText = edit.contents.slice(location.startIndex, location.endIndex)
            .replace(/(\bpath\s*=\s*)[^;]+;/, `$1${formatPath(bundleName)};`);
        splice(edit, location.startIndex, location.endIndex, entryText);
    }
    return edit.contents;
}

/** Register a `.xcdatamodeld` bundle: all five structures, in one pass. */
export function addDataModelToPbxproj(
    pbxContents: string,
    bundleName: string,
    versionNames: string[],
    currentVersionName: string | undefined,
    groupId: string,
    sourcesBuildPhaseId: string
): string {
    const edit = beginEdit(pbxContents);
    if (!edit) { return pbxContents; }
    const existingIds = collectExistingIds(pbxContents);
    const takeId = (): string => {
        const id = generateUniqueId(existingIds);
        existingIds.add(id);
        return id;
    };

    const buildFileId = takeId();
    const versionGroupId = takeId();
    const versions: DataModelVersion[] = versionNames.map((name) => ({ id: takeId(), name }));
    const currentVersion =
        versions.find((version) => version.name === currentVersionName) ?? versions[0];

    // The build file's fileRef is the XCVersionGroup — the bundle has no PBXFileReference of its own.
    addBuildFileTo(edit, buildFileId, versionGroupId, bundleName);
    for (const version of versions) {
        addFileReferenceTo(edit, version.id, version.name, DATA_MODEL_VERSION_FILE_TYPE);
    }
    insertListEntry(edit, groupId, 'children', versionGroupId, bundleName, bundleName, anyEntry);
    insertListEntry(edit, sourcesBuildPhaseId, 'files', buildFileId, `${bundleName} in Sources`, bundleName, null);
    addVersionGroupTo(edit, versionGroupId, bundleName, versions, currentVersion?.id);
    return edit.contents;
}

/** Unregister a `.xcdatamodeld` bundle; null when the XCVersionGroup is absent, so callers can tell "nothing to do" from "removed". */
export function removeDataModelFromPbxproj(
    pbxContents: string,
    versionGroupId: string
): string | null {
    const edit = beginEdit(pbxContents);
    const group = edit?.index.object(versionGroupId);
    if (!edit || group?.isa !== 'XCVersionGroup' || !locateObject(pbxContents, versionGroupId)) { return null; }

    // A model shared by several targets has one PBXBuildFile per target, so drain them all.
    for (const buildFileId of buildFilesFor(edit.index, versionGroupId)) {
        removeFromLists(edit, buildFileId, 'files');
        removeObject(edit, buildFileId);
    }
    // Drops the group child entry; the XCVersionGroup body is removed whole below.
    removeFromLists(edit, versionGroupId, 'children');
    removeVersionGroupFrom(edit, versionGroupId);
    for (const childId of stringList(group.children)) {
        removeObject(edit, childId);
    }
    return edit.contents;
}
