import { execFileSync } from 'child_process';
import * as path from 'path';

/** One entry of a project's `objects` dictionary as plutil renders it: strings, lists and dictionaries. */
export interface ProjectObject {
    isa?: string;
    [key: string]: unknown;
}

export interface ProjectIndex {
    objects: Readonly<Record<string, ProjectObject>>;
    /** Every object id, in the order the project file defines them. */
    ids: readonly string[];
    /** The root PBXProject object. */
    project: ProjectObject | undefined;
    mainGroupId: string | undefined;
    object(id: unknown): ProjectObject | undefined;
    /** Objects of one isa, in the order the project file defines them. */
    objectsOfIsa(isa: string): ReadonlyArray<{ readonly id: string; readonly object: ProjectObject }>;
}

/** Why plutil produced no index: the text isn't a property list (a merge conflict, say), or its JSON is too large. */
export type ProjectReadError = 'unparseable' | 'too-large';

// plutil's JSON runs about 0.7× the project file, so execFileSync's default 1 MiB buffer overflows past ~1.4 MB of input.
const MAX_JSON_BYTES = 256 * 1024 * 1024;

let lastContents: string | undefined;
let lastResult: ProjectIndex | ProjectReadError | undefined;

/** The project read through /usr/bin/plutil; the result is reused while callers pass the same contents. */
export function readProject(contents: string): ProjectIndex | ProjectReadError {
    if (lastResult === undefined || contents !== lastContents) {
        lastResult = buildIndex(contents);
        lastContents = contents;
    }
    return lastResult;
}

function buildIndex(contents: string): ProjectIndex | ProjectReadError {
    let graph: { objects?: unknown; rootObject?: unknown } | null;
    try {
        const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
            input: contents,
            maxBuffer: MAX_JSON_BYTES,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        graph = JSON.parse(json.toString('utf8'));
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOBUFS' ? 'too-large' : 'unparseable';
    }
    if (!graph || typeof graph.objects !== 'object' || graph.objects === null) {
        return 'unparseable';
    }
    const objects = graph.objects as Record<string, ProjectObject>;
    const order = objectOrder(contents, objects);
    const project = typeof graph.rootObject === 'string' ? objects[graph.rootObject] : undefined;
    const byIsa = new Map<string, { id: string; object: ProjectObject }[]>();
    return {
        objects,
        ids: order,
        project,
        mainGroupId: stringValue(project?.mainGroup),
        object: (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(objects, id) ? objects[id] : undefined),
        objectsOfIsa: (isa) => {
            let entries = byIsa.get(isa);
            if (!entries) {
                entries = order.filter((id) => objects[id].isa === isa).map((id) => ({ id, object: objects[id] }));
                byIsa.set(isa, entries);
            }
            return entries;
        }
    };
}

/**
 * Object ids in definition order. plutil's JSON doesn't keep the file's order, so it comes from the text; when the
 * tokenizer can't follow it or disagrees with plutil, id order stands in, which is how Xcode writes each section.
 */
function objectOrder(contents: string, objects: Record<string, ProjectObject>): string[] {
    const ids = Object.keys(objects);
    try {
        const order = definitionOrder(contents);
        if (order.length === ids.length && new Set(order).size === order.length &&
            order.every((id) => Object.prototype.hasOwnProperty.call(objects, id))) {
            return order;
        }
    } catch {
    }
    return ids.sort();
}

/** What Xcode shows for a file or group: its `name`, else the last component of its `path`; empty when it has neither. */
export function displayName(object: ProjectObject | undefined): string {
    const name = stringValue(object?.name);
    if (name !== undefined) { return name; }
    return stringValue(object?.path)?.split('/').pop() ?? '';
}

/** The PBXBuildFiles whose `fileRef` is the id, in definition order. */
export function buildFilesFor(index: ProjectIndex, fileReferenceId: string): string[] {
    return index.objectsOfIsa('PBXBuildFile')
        .filter(({ object }) => object.fileRef === fileReferenceId)
        .map(({ id }) => id);
}

/** The build phases whose `files` list holds the id, in definition order. */
export function phasesOf(index: ProjectIndex, buildFileId: string): string[] {
    return index.ids.filter((id) => {
        const object = index.objects[id];
        return (object.isa ?? '').endsWith('BuildPhase') && stringList(object.files).includes(buildFileId);
    });
}

/** The target whose `buildPhases` lists the phase. */
export function targetOfPhase(index: ProjectIndex, phaseId: string): string | undefined {
    return index.ids.find((id) => stringList(index.objects[id].buildPhases).includes(phaseId));
}

/**
 * The names of a build phase's files in list order — each build file's element display name, or its package product's
 * name — skipping build files with neither; empty unless the phase has the isa, so a Sources phase id reads nothing.
 */
export function phaseFileNames(index: ProjectIndex, phaseId: string, isa: string): string[] {
    const phase = index.object(phaseId);
    if (phase?.isa !== isa) { return []; }
    const names: string[] = [];
    for (const buildFileId of stringList(phase.files)) {
        const buildFile = index.object(buildFileId);
        const name = buildFile?.fileRef !== undefined
            ? displayName(index.object(buildFile.fileRef))
            : stringValue(index.object(buildFile?.productRef)?.productName) ?? '';
        if (name) { names.push(name); }
    }
    return names;
}

// ── Element paths ────────────────────────────────────────

interface Relations {
    /** Each listed element's parent: the first object, in definition order, whose `children` holds it. */
    parents: Map<string, string>;
    /** Every object whose `children` lists an element, in definition order. */
    owners: Map<string, string[]>;
    /** Resolved paths by project folder, then by id. */
    resolved: Map<string, Map<string, string | undefined>>;
    /** Folder spellings by project folder. */
    spellings: Map<string, FolderSpelling[]>;
}

const relationsByIndex = new WeakMap<ProjectIndex, Relations>();

function relationsOf(index: ProjectIndex): Relations {
    let relations = relationsByIndex.get(index);
    if (!relations) {
        const parents = new Map<string, string>();
        const owners = new Map<string, string[]>();
        for (const id of index.ids) {
            for (const child of stringList(index.objects[id].children)) {
                if (!parents.has(child)) { parents.set(child, id); }
                owners.set(child, [...(owners.get(child) ?? []), id]);
            }
        }
        relations = { parents, owners, resolved: new Map(), spellings: new Map() };
        relationsByIndex.set(index, relations);
    }
    return relations;
}

/** The object whose `children` lists the id; undefined for the main group and for anything no list holds. */
export function parentOf(index: ProjectIndex, id: string): string | undefined {
    return relationsOf(index).parents.get(id);
}

/** Every object whose `children` lists the id, in definition order; normally one. */
export function ownersOf(index: ProjectIndex, id: string): readonly string[] {
    return relationsOf(index).owners.get(id) ?? [];
}

/** The elements from `id` up to the main group, or undefined when the chain doesn't reach it. */
function lineageOf(index: ProjectIndex, id: string): string[] | undefined {
    const { parents } = relationsOf(index);
    const lineage: string[] = [];
    for (let current: string | undefined = id; current !== undefined; current = parents.get(current)) {
        if (lineage.includes(current)) { return undefined; }
        lineage.push(current);
        if (current === index.mainGroupId) { return lineage; }
    }
    return undefined;
}

/**
 * The folder or file an element stands for, per Xcode's source trees: `<group>` joins the parent's folder and `path` (no
 * `path`, or "", keeps the parent's), SOURCE_ROOT joins the project folder, `<absolute>` takes `path`. The main group's
 * parent folder is the project folder. Undefined outside the main group's tree, in any other tree (build products,
 * SDKs), and under an undefined parent.
 */
export function resolvedPath(index: ProjectIndex, id: string, projectDir: string): string | undefined {
    const relations = relationsOf(index);
    let byId = relations.resolved.get(projectDir);
    if (!byId) {
        byId = new Map();
        relations.resolved.set(projectDir, byId);
    }
    if (byId.has(id)) { return byId.get(id); }

    const lineage = lineageOf(index, id);
    let folder: string | undefined = lineage ? projectDir : undefined;
    for (const current of (lineage ?? []).reverse()) {
        const object = index.objects[current];
        const own = stringValue(object.path);
        switch (stringValue(object.sourceTree)) {
            case '<group>':
                folder = folder === undefined ? undefined : own ? path.join(folder, own) : folder;
                break;
            case 'SOURCE_ROOT':
                folder = own ? path.join(projectDir, own) : projectDir;
                break;
            case '<absolute>':
                folder = own ? path.normalize(own) : undefined;
                break;
            default:
                folder = undefined;
        }
    }
    byId.set(id, folder);
    return folder;
}

/** The folder an element's own `path` starts from: the parent's folder in the `<group>` tree, the project folder for SOURCE_ROOT; undefined for other trees and unresolvable parents. */
export function baseFolder(index: ProjectIndex, id: string, projectDir: string): string | undefined {
    switch (stringValue(index.objects[id]?.sourceTree)) {
        case '<group>': {
            const parent = parentOf(index, id);
            return parent === undefined ? projectDir : resolvedPath(index, parent, projectDir);
        }
        case 'SOURCE_ROOT':
            return projectDir;
        default:
            return undefined;
    }
}

const BUNDLE_EXTENSIONS = ['.xcdatamodeld', '.xcdatamodel', '.lproj', '.xcassets', '.bundle', '.framework', '.app', '.xcframework'];

/** Whether a folder name is a bundle Xcode treats as one item, whose rename is no folder rename. */
export function isBundleName(name: string): boolean {
    const lower = name.toLowerCase();
    return BUNDLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** One component of an element's own `path` that names a folder. */
export interface FolderSpelling {
    id: string;
    /** The component's index in `path.split('/')`. */
    position: number;
    /** The folder the component reaches, resolved like `resolvedPath`. */
    folder: string;
}

const PATH_ELEMENT_ISAS = new Set(['PBXGroup', 'PBXVariantGroup', 'PBXFileSystemSynchronizedRootGroup', 'PBXFileReference', 'XCVersionGroup']);
const FOLDER_ISAS = new Set(['PBXGroup', 'PBXVariantGroup', 'PBXFileSystemSynchronizedRootGroup']);

/**
 * Every component of an element's own `path` that names a folder, walked from `baseFolder`: the last component of a group,
 * synchronized root or folder reference, and each earlier component of any element. `..`, `.` and empty components move
 * the walk but name nothing, bundle components name nothing, and elements outside the `<group>` and SOURCE_ROOT trees or
 * that don't resolve are left out. Memoized per index and project folder.
 */
export function folderSpellings(index: ProjectIndex, projectDir: string): readonly FolderSpelling[] {
    const relations = relationsOf(index);
    let spellings = relations.spellings.get(projectDir);
    if (spellings) { return spellings; }
    spellings = [];
    for (const id of index.ids) {
        const object = index.objects[id];
        if (!PATH_ELEMENT_ISAS.has(object.isa ?? '')) { continue; }
        const own = stringValue(object.path);
        const base = own ? baseFolder(index, id, projectDir) : undefined;
        if (!own || base === undefined || resolvedPath(index, id, projectDir) === undefined) { continue; }
        const namesFolder = FOLDER_ISAS.has(object.isa ?? '') ||
            stringValue(object.lastKnownFileType) === 'folder' || stringValue(object.explicitFileType) === 'folder';
        const components = own.split('/');
        let current = base;
        components.forEach((component, position) => {
            current = path.join(current, component);
            if (component === '' || component === '.' || component === '..' || isBundleName(component)) { return; }
            if (position === components.length - 1 && !namesFolder) { return; }
            spellings!.push({ id, position, folder: current });
        });
    }
    relations.spellings.set(projectDir, spellings);
    return spellings;
}

/**
 * The PBXGroup standing for a folder: among the groups whose resolved folder equals it, both passed through `canonical`,
 * the one with its own non-empty `path`, else the one fewest steps below the main group, then the first defined.
 */
export function groupForFolder(
    index: ProjectIndex,
    folder: string,
    projectDir: string,
    canonical: (target: string) => string = (target) => target
): string | undefined {
    const wanted = canonical(folder);
    let best: { id: string; ownPath: boolean; depth: number } | undefined;
    for (const { id, object } of index.objectsOfIsa('PBXGroup')) {
        const resolved = resolvedPath(index, id, projectDir);
        if (resolved === undefined || canonical(resolved) !== wanted) { continue; }
        const candidate = { id, ownPath: Boolean(stringValue(object.path)), depth: lineageOf(index, id)?.length ?? 0 };
        if (!best || (candidate.ownPath && !best.ownPath) ||
            (candidate.ownPath === best.ownPath && candidate.depth < best.depth)) {
            best = candidate;
        }
    }
    return best?.id;
}

// ── Text locators ────────────────────────────────────────

interface Token {
    /** A punctuation character, or `string` for quoted and bare values. */
    type: string;
    value: string;
    start: number;
    /** Just past the token. */
    end: number;
}

interface Tokenizer {
    next(): Token | null;
    expect(type: string): Token;
    /** The next token, which must exist. */
    value(): Token;
    /** Skips the value `first` begins and returns its last token: `first` itself for a string, else the matching close. */
    skipValue(first: Token): Token;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const PUNCTUATION = new Set(['{', '}', '(', ')', '=', ';', ',']);

/** Tokens of the OpenStep text from `start`, past whitespace and comments; `expect`, `value` and `skipValue` throw where the text doesn't follow the grammar. */
function tokenizer(contents: string, start: number): Tokenizer {
    const length = contents.length;
    let position = start;

    const next = (): Token | null => {
        for (;;) {
            while (position < length && WHITESPACE.has(contents[position])) { position++; }
            if (contents.startsWith('//', position)) {
                const end = contents.indexOf('\n', position);
                position = end === -1 ? length : end + 1;
            } else if (contents.startsWith('/*', position)) {
                const end = contents.indexOf('*/', position + 2);
                position = end === -1 ? length : end + 2;
            } else {
                break;
            }
        }
        if (position >= length) { return null; }
        const tokenStart = position;
        const character = contents[position];
        if (PUNCTUATION.has(character)) {
            position++;
            return { type: character, value: character, start: tokenStart, end: position };
        }
        if (character === '"') {
            let value = '';
            for (position++; position < length && contents[position] !== '"'; position++) {
                if (contents[position] === '\\') { position++; }
                value += contents[position];
            }
            position++;
            return { type: 'string', value, start: tokenStart, end: position };
        }
        // A bare value ends only at whitespace, punctuation or a quote: plutil reads `foo//bar` as one value.
        while (position < length && !WHITESPACE.has(contents[position]) && !PUNCTUATION.has(contents[position]) &&
            contents[position] !== '"') {
            position++;
        }
        return { type: 'string', value: contents.slice(tokenStart, position), start: tokenStart, end: position };
    };

    const expect = (type: string): Token => {
        const token = next();
        if (!token || token.type !== type) {
            throw new Error(`expected "${type}" at ${token ? token.start : 'the end'}`);
        }
        return token;
    };

    const value = (): Token => {
        const token = next();
        if (!token) { throw new Error('missing value'); }
        return token;
    };

    const skipValue = (first: Token): Token => {
        if (first.type === 'string') { return first; }
        if (first.type !== '{' && first.type !== '(') { throw new Error(`unexpected "${first.type}" at ${first.start}`); }
        for (let depth = 1; ;) {
            const token = next();
            if (!token) { throw new Error('unterminated value'); }
            if (token.type === '{' || token.type === '(') {
                depth++;
            } else if ((token.type === '}' || token.type === ')') && --depth === 0) {
                return token;
            }
        }
    };

    return { next, expect, value, skipValue };
}

/** Where one root `objects` entry sits in the project text. */
export interface ObjectLocation {
    /** The start of the entry's line. */
    startIndex: number;
    /** Just past the entry's `};`, any spaces or tabs after it, and its line break. */
    endIndex: number;
}

/** Where one entry of a list sits in the project text. */
export interface ListEntryLocation {
    id: string;
    /** In a multi-line list, the start of the entry's line; in a single-line list, its token. */
    startIndex: number;
    /**
     * In a multi-line list, just past the entry's `,`, any spaces or tabs, and one line break; in a single-line list, the
     * next token: the following entry or `)`.
     */
    endIndex: number;
}

/** Where a list value sits in the project text. */
export interface ListLocation {
    /** Just past the list's `(`. */
    openIndex: number;
    /** At the list's `)`. */
    closeIndex: number;
    /** Whether a line break lies between `(` and the first entry, or `)` in an empty list. */
    multiLine: boolean;
    entries: ListEntryLocation[];
}

/** Where a dictionary value sits in the project text. */
export interface DictionaryLocation {
    /** Just past the dictionary's `{`. */
    openIndex: number;
    /** At the dictionary's `}`. */
    closeIndex: number;
}

/** Where one top-level `key = value;` of an object sits in the project text. */
export interface KeyLocation {
    /** The start of the key's line when the key starts it; otherwise the key itself. */
    startIndex: number;
    /** Just past the `;`, any spaces or tabs, and one line break when the key starts its line; otherwise the next token. */
    endIndex: number;
    /** The value's first token. */
    valueStart: number;
    /** Just past the value's last token. */
    valueEnd: number;
}

/**
 * The keys of the root `objects` dictionary, in the order the OpenStep text defines them. Values are skipped by nesting
 * depth, so ids that reappear as keys further down (a project's TargetAttributes) are never counted.
 */
export function definitionOrder(contents: string): string[] {
    const walk = walked(contents);
    if (walk.error) { throw walk.error; }
    return walk.entries.map((entry) => entry.id);
}

/** The offsets of one root `objects` entry; undefined when the id isn't an entry or the text can't be walked. */
export function locateObject(contents: string, id: string): ObjectLocation | undefined {
    return walked(contents).byId.get(id)?.location;
}

/** Every root `objects` entry with its offsets, in text order; empty when the text can't be walked. */
export function locateObjects(contents: string): ReadonlyArray<{ readonly id: string; readonly location: ObjectLocation }> {
    return walked(contents).entries;
}

/** The offset of the `}` that closes the root `objects` dictionary; undefined when the text can't be walked. */
export function locateObjectsClose(contents: string): number | undefined {
    return walked(contents).objectsClose;
}

/**
 * The owner's top-level `key = ( … );` list of strings, such as a group's `children` or a build phase's `files`;
 * undefined for an unknown owner, a missing key, a value that isn't such a list, or text the walk can't follow.
 */
export function locateList(contents: string, ownerId: string, key: string): ListLocation | undefined {
    const value = valueOf(contents, ownerId, key);
    if (!value || value.first.type !== '(') { return undefined; }
    const listed = listItems(value.tokens);
    if (!listed) { return undefined; }
    const { items, close } = listed;
    const open = value.first;
    const multiLine = contents.slice(open.end, items.length > 0 ? items[0].token.start : close.start).includes('\n');
    const entries = items.map(({ token, comma }, position): ListEntryLocation => ({
        id: token.value,
        startIndex: multiLine ? lineStart(contents, token.start) : token.start,
        endIndex: multiLine
            ? pastLineBreak(contents, (comma ?? token).end)
            : position + 1 < items.length ? items[position + 1].token.start : close.start
    }));
    return { openIndex: open.end, closeIndex: close.start, multiLine, entries };
}

/** The first entry of the owner's `key` list whose id is `entryId`; undefined when there's none. */
export function locateListEntry(contents: string, ownerId: string, key: string, entryId: string): ListEntryLocation | undefined {
    return locateList(contents, ownerId, key)?.entries.find((entry) => entry.id === entryId);
}

/** The owner's top-level `key = { … };` dictionary, such as a configuration's `buildSettings`; undefined when there's none. */
export function locateDictionary(contents: string, ownerId: string, key: string): DictionaryLocation | undefined {
    const value = valueOf(contents, ownerId, key);
    if (!value || value.first.type !== '{') { return undefined; }
    try {
        return { openIndex: value.first.end, closeIndex: value.tokens.skipValue(value.first).start };
    } catch {
        return undefined;
    }
}

/** The owner's top-level `key = value;`, with the span that removes it; undefined when there's none. */
export function locateKey(contents: string, ownerId: string, key: string): KeyLocation | undefined {
    const value = valueOf(contents, ownerId, key);
    if (!value) { return undefined; }
    try {
        const last = value.tokens.skipValue(value.first);
        const semicolon = value.tokens.expect(';');
        const start = lineStart(contents, value.key.start);
        const span = { valueStart: value.first.start, valueEnd: last.end };
        if (start === 0 || contents[start - 1] === '\n') {
            return { startIndex: start, endIndex: pastLineBreak(contents, semicolon.end), ...span };
        }
        const following = value.tokens.next();
        return { startIndex: value.key.start, endIndex: following ? following.start : semicolon.end, ...span };
    } catch {
        return undefined;
    }
}

interface WalkedObject {
    id: string;
    location: ObjectLocation;
    /** Where the entry's value, its `{`, starts. */
    valueStart: number;
}

interface Walk {
    entries: WalkedObject[];
    byId: Map<string, WalkedObject>;
    objectsClose: number | undefined;
    /** Why the text couldn't be walked, when it couldn't; the walk is then empty. */
    error?: Error;
}

let lastWalkedContents: string | undefined;
let lastWalk: Walk = { entries: [], byId: new Map(), objectsClose: undefined };

/** The walk of `contents`, reused while callers pass the same contents. */
function walked(contents: string): Walk {
    if (contents !== lastWalkedContents) {
        try {
            const { entries, objectsClose } = walkObjects(contents);
            lastWalk = { entries, byId: new Map(entries.map((entry) => [entry.id, entry])), objectsClose };
        } catch (error) {
            lastWalk = { entries: [], byId: new Map(), objectsClose: undefined, error: error instanceof Error ? error : new Error(String(error)) };
        }
        lastWalkedContents = contents;
    }
    return lastWalk;
}

/** Every root `objects` entry with its offsets, in text order, and where `objects` closes; throws where the text doesn't follow the grammar. */
function walkObjects(contents: string): { entries: WalkedObject[]; objectsClose: number | undefined } {
    const tokens = tokenizer(contents, 0);
    tokens.expect('{');
    for (;;) {
        const key = tokens.next();
        if (!key || key.type === '}') { return { entries: [], objectsClose: undefined }; }
        tokens.expect('=');
        const value = tokens.value();
        if (key.type === 'string' && key.value === 'objects' && value.type === '{') {
            const entries: WalkedObject[] = [];
            for (;;) {
                const objectKey = tokens.next();
                if (!objectKey) { throw new Error('unterminated objects dictionary'); }
                if (objectKey.type === '}') { return { entries, objectsClose: objectKey.start }; }
                tokens.expect('=');
                const objectValue = tokens.value();
                tokens.skipValue(objectValue);
                const semicolon = tokens.expect(';');
                entries.push({
                    id: objectKey.value,
                    location: { startIndex: lineStart(contents, objectKey.start), endIndex: pastLineBreak(contents, semicolon.end) },
                    valueStart: objectValue.start
                });
            }
        }
        tokens.skipValue(value);
        tokens.expect(';');
    }
}

/** A tokenizer just past the first token of the owner's top-level `key` value, with the key's token and that first token; undefined when there's none. */
function valueOf(contents: string, ownerId: string, key: string): { tokens: Tokenizer; key: Token; first: Token } | undefined {
    const owner = walked(contents).byId.get(ownerId);
    if (!owner) { return undefined; }
    const tokens = tokenizer(contents, owner.valueStart);
    try {
        tokens.expect('{');
        for (;;) {
            const keyToken = tokens.next();
            if (!keyToken || keyToken.type === '}') { return undefined; }
            tokens.expect('=');
            const first = tokens.value();
            if (keyToken.type === 'string' && keyToken.value === key) { return { tokens, key: keyToken, first }; }
            tokens.skipValue(first);
            tokens.expect(';');
        }
    } catch {
        return undefined;
    }
}

/** A list's string items, each with the `,` after it when there is one, through its `)`; undefined for anything else. */
function listItems(tokens: Tokenizer): { items: { token: Token; comma: Token | undefined }[]; close: Token } | undefined {
    const items: { token: Token; comma: Token | undefined }[] = [];
    for (;;) {
        const token = tokens.next();
        if (token?.type === ')') { return { items, close: token }; }
        if (token?.type !== 'string') { return undefined; }
        const after = tokens.next();
        if (after?.type === ')') {
            items.push({ token, comma: undefined });
            return { items, close: after };
        }
        if (after?.type !== ',') { return undefined; }
        items.push({ token, comma: after });
    }
}

/** The start of `offset`'s line, when only spaces or tabs precede it there. */
function lineStart(contents: string, offset: number): number {
    let start = offset;
    while (start > 0 && (contents[start - 1] === ' ' || contents[start - 1] === '\t')) { start--; }
    return start;
}

/** `offset` moved past any spaces or tabs and one line break. */
function pastLineBreak(contents: string, offset: number): number {
    let index = offset;
    while (contents[index] === ' ' || contents[index] === '\t') { index += 1; }
    if (contents[index] === '\r') { index += 1; }
    if (contents[index] === '\n') { index += 1; }
    return index;
}

/** A string value, or undefined when the key is absent or holds something else. */
export function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** The strings of a list value (ids, paths), or an empty list when the key is absent. */
export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
