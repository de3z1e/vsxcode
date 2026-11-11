/**
 * Edits Xcode's JSON project file (`project.xcproj`) with the operations the pbxproj writer offers, so the sync works on
 * either format. Edits are splices: bytes outside the edited spans stay as they were, and what is inserted follows the
 * layout Xcode's printer writes (two-space indents, a comma after every element, one-line objects where Xcode prints them,
 * adjacent multi-line elements joined `}, {`).
 *
 * A session reads the input once. Its ids are handles that stay valid while operations rename and move their elements;
 * an element a session creates gets the id its place gives, rehashed while an input id or another handle holds it.
 *
 * An operation declines when it can't be done safely: an object with duplicate keys to edit, a reference into the file
 * tree that would name nothing or more than one element, no membership form Xcode reads. A decline undoes the whole
 * change it belongs to (`beginChange` … `endChange`; an operation outside one is a change of its own) and says why; the
 * session goes on with the next change. No vscode import.
 */
import { duplicateKeys, nodeAt, parseJson5Text, valueOf } from '../parsers/xcprojText';
import type { Json5Node } from '../parsers/xcprojText';
import {
    childKey, compareCodePoints, elementNaming, encodeReference, formatPath, isElementKind, lastPathComponent, readPath,
    readReference, resolveReference, syntheticId
} from '../parsers/xcprojIndex';
import type { ElementKind, JsonPointer, ParsedPath } from '../parsers/xcprojIndex';
import { displayName, readProject } from '../parsers/projectIndex';
import type { ProjectIndex } from '../parsers/projectIndex';
import type { ElementPathChange } from './pbxproj';

// ── Session ──────────────────────────────────────────────

/** One element of the file tree, by handle. */
interface NodeRecord {
    kind: ElementKind;
    /** Undefined at the top level. */
    parent: string | undefined;
    children: string[];
    /** The `id` the file gives it, which `id:` references name. */
    explicitId?: string;
    /** The name an element created in the session sorts by. */
    insertedName?: string;
    /** Its `path` and `name` values as the text holds them now. */
    path: string;
    name?: string;
}

interface Model {
    nodes: Map<string, NodeRecord>;
    top: string[];
}

/** A reference from outside the file tree into it, and the element it named when the session began. */
interface RecordedReference {
    /** Where its value sits; computed, since a model's `current-version` moves with the model. */
    location: () => JsonPointer | undefined;
    /** Undefined when the path starts at the top level; else the version group it starts at. */
    origin: string | undefined;
    target: string;
    /** `products-group` may be absent, meaning `Products`. */
    implicit?: string;
    /** The reference's value as the text holds it now. */
    value: unknown;
}

interface Change {
    contents: string;
    model: Model;
    createdGroups: Map<string, string>;
    references: RecordedReference[];
    /** Whether an operation opened it, rather than `beginChange`. */
    implicit: boolean;
    declined?: string;
}

interface Session {
    log: (message: string) => void;
    /** The log prefix a decline is reported under, the caller's. */
    prefix: string;
    input: string;
    mainGroupId: string;
    model: Model;
    /** `<parent handle>/<folder name>` → the group created for it. */
    createdGroups: Map<string, string>;
    references: RecordedReference[];
    change?: Change;
    parsed?: { contents: string; root: Json5Node | undefined };
    /** Why the session's text wasn't written, once the read-back has failed. */
    gateProblem?: string;
    /** Whether the file's lines end in CRLF. */
    crlf: boolean;
}

export interface XcprojEdit {
    format: 'xcproj';
    /** The text as it changes. */
    contents: string;
    /** The input's lowering; it doesn't change during the session. */
    index: ProjectIndex;
    session: Session;
}

class Decline extends Error {}

function decline(reason: string): never {
    throw new Decline(reason);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Starts a session on a JSON project file's text; null when the text doesn't read as one. */
export function beginXcprojEdit(contents: string, log: (message: string) => void, prefix = '[project-sync]'): XcprojEdit | null {
    const index = readProject(contents);
    if (typeof index === 'string' || index.format !== 'xcproj' || !index.sources || !index.mainGroupId) { return null; }
    const root = parseJson5Text(contents);
    if (!root) { return null; }

    const byPointer = new Map<string, string>();
    for (const [id, pointer] of index.sources) { byPointer.set(JSON.stringify(pointer), id); }
    const model: Model = { nodes: new Map(), top: [] };
    const build = (list: Json5Node | undefined, pointer: JsonPointer, parent: string | undefined): string[] => {
        if (list?.kind !== 'array') { return []; }
        return list.elements.map((element, position) => {
            const at = [...pointer, position];
            const handle = byPointer.get(JSON.stringify(at));
            const value = valueOf(element);
            if (handle === undefined || !isObject(value)) { throw new Error(`no lowered element at ${at.join('/')}`); }
            const kind = value.kind ?? 'file-reference';
            if (!isElementKind(kind)) { throw new Error(`unknown kind at ${at.join('/')}`); }
            const record: NodeRecord = { kind, parent, children: [], path: typeof value.path === 'string' ? value.path : '' };
            if (typeof value.name === 'string') { record.name = value.name; }
            if (typeof value.id === 'string') { record.explicitId = value.id; }
            model.nodes.set(handle, record);
            if (kind === 'group' || kind === 'variant-group' || kind === 'version-group') {
                record.children = build(element.kind === 'object' ? nodeAt(element, ['children']) : undefined, [...at, 'children'], handle);
            }
            return handle;
        });
    };
    model.top = build(nodeAt(root, ['files']), ['files'], undefined);

    const edit: XcprojEdit = {
        format: 'xcproj',
        contents,
        index,
        session: {
            log, prefix, input: contents, mainGroupId: index.mainGroupId, model, createdGroups: new Map(), references: [],
            crlf: contents.includes('\r\n')
        }
    };
    edit.session.references = recordReferences(edit, root);
    return edit;
}

// ── Reading the current text ─────────────────────────────

function parsedRoot(edit: XcprojEdit): Json5Node {
    const session = edit.session;
    if (session.parsed?.contents !== edit.contents) {
        session.parsed = { contents: edit.contents, root: parseJson5Text(edit.contents) };
    }
    const root = session.parsed.root;
    if (!root) { return decline('the edited text no longer reads as JSON5'); }
    return root;
}

function record(edit: XcprojEdit, handle: string): NodeRecord {
    const node = edit.session.model.nodes.get(handle);
    if (!node) { return decline(`no element ${handle} in the file tree`); }
    return node;
}

function siblingsOf(model: Model, parent: string | undefined): string[] {
    return parent === undefined ? model.top : model.nodes.get(parent)?.children ?? [];
}

/** Where an element sits in the current text. */
function pointerOf(edit: XcprojEdit, handle: string): JsonPointer {
    const model = edit.session.model;
    const node = record(edit, handle);
    const position = siblingsOf(model, node.parent).indexOf(handle);
    if (position === -1) { return decline(`element ${handle} isn't in its parent`); }
    return node.parent === undefined ? ['files', position] : [...pointerOf(edit, node.parent), 'children', position];
}

function jsonNode(edit: XcprojEdit, pointer: JsonPointer): Json5Node {
    const node = nodeAt(parsedRoot(edit), pointer);
    if (!node) { return decline(`nothing at ${pointer.join('/')}`); }
    return node;
}

/** An element's object node, refusing one with duplicate keys, which is never edited. */
function editableObject(edit: XcprojEdit, pointer: JsonPointer): Json5Node & { kind: 'object' } {
    const node = jsonNode(edit, pointer);
    if (node.kind !== 'object') { return decline(`${pointer.join('/')} isn't an object`); }
    const duplicates = duplicateKeys(node);
    if (duplicates.length > 0) { return decline(`the object at ${pointer.join('/') || 'the top level'} repeats "${duplicates[0]}"`); }
    return node;
}

function member(object: Json5Node & { kind: 'object' }, key: string) {
    return object.members.find((candidate) => candidate.key === key);
}

function elementValue(edit: XcprojEdit, handle: string): Json {
    const value = valueOf(jsonNode(edit, pointerOf(edit, handle)));
    return isObject(value) ? value : decline(`element ${handle} isn't an object`);
}

function parsedPathOf(node: NodeRecord): ParsedPath {
    return readPath(node.path) ?? decline(`the path "${node.path}" doesn't read`);
}

function naming(edit: XcprojEdit, handle: string): { displayName: string; identity: string } {
    const node = record(edit, handle);
    const parentKind = node.parent === undefined ? undefined : edit.session.model.nodes.get(node.parent)?.kind;
    return elementNaming(node.kind, node.path, parsedPathOf(node), node.name, parentKind === 'variant-group');
}

/** The name an element sorts by, as the pbxproj writer sorts: its input display name, or the name it was created under. */
function sortName(edit: XcprojEdit, handle: string): string {
    return record(edit, handle).insertedName ?? displayName(edit.index.object(handle));
}

/** An element's key in the current tree, which its synthetic id comes from. */
function currentKey(edit: XcprojEdit, handle: string | undefined): string {
    if (handle === undefined) { return 'main'; }
    const node = record(edit, handle);
    const identity = naming(edit, handle).identity;
    let ordinal = 0;
    for (const sibling of siblingsOf(edit.session.model, node.parent)) {
        if (sibling === handle) { break; }
        if (naming(edit, sibling).identity === identity) { ordinal++; }
    }
    return childKey(currentKey(edit, node.parent), identity, ordinal);
}

/** A handle for a new element: the id its key gives, rehashed while an input id or another handle holds it. */
function newHandle(edit: XcprojEdit, handle: string): string {
    const taken = (candidate: string): boolean =>
        edit.session.model.nodes.has(candidate) || edit.index.object(candidate) !== undefined || candidate === edit.session.mainGroupId;
    return syntheticId(currentKey(edit, handle), taken);
}

/** The group handle's list: the top level for the main group. */
function parentOf(edit: XcprojEdit, groupId: string): string | undefined {
    if (groupId === edit.session.mainGroupId) { return undefined; }
    const node = record(edit, groupId);
    if (node.kind !== 'group') { return decline(`${groupId} isn't a group`); }
    return groupId;
}

// ── Printing, as Xcode's printer does ───────────────────

const INDENT = '  ';

function indent(depth: number): string {
    return INDENT.repeat(depth);
}

/** Whether Xcode prints a file-tree element on one line. */
function elementIsCompact(value: Json): boolean {
    const list = (key: string): unknown[] => (Array.isArray(value[key]) ? value[key] as unknown[] : []);
    switch (value.kind ?? 'file-reference') {
        case 'group': return list('children').length === 0;
        case 'folder': return list('membership-exceptions').length === 0;
        case 'variant-group':
        case 'version-group': return list('children').length === 0 && list('target-membership').length <= 1;
        default: return list('target-membership').length <= 1;
    }
}

/**
 * A value in Xcode's layout at `depth`: on one line when `compact`, else objects and arrays across lines, with a comma
 * after every entry and adjacent multi-line containers joined `}, {`. Elements of a `children` list decide for themselves.
 */
function printValue(value: unknown, depth: number, compact: boolean): string {
    if (Array.isArray(value)) {
        if (value.length === 0) { return '[]'; }
        if (compact) { return `[ ${value.map((item) => printValue(item, depth + 1, true)).join(', ')} ]`; }
        return printList(value.map((item) => printEntry(item, depth + 1)), depth);
    }
    if (isObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) { return '{}'; }
        if (compact) { return `{ ${keys.map((key) => `${JSON.stringify(key)}: ${printValue(value[key], depth + 1, true)}`).join(', ')} }`; }
        const lines = keys.map((key) => `${indent(depth + 1)}${JSON.stringify(key)}: ${printChild(key, value[key], depth + 1, value.kind)},\n`);
        return `{\n${lines.join('')}${indent(depth)}}`;
    }
    return JSON.stringify(value);
}

/**
 * A field of a multi-line object: a `children` list holds elements, each printed by its own density, except a model's
 * versions, which Xcode prints across lines even with nothing but a path.
 */
function printChild(key: string, value: unknown, depth: number, ownerKind: unknown): string {
    if (key === 'children' && Array.isArray(value)) {
        if (value.length === 0) { return '[]'; }
        const print = (item: unknown): string => (ownerKind === 'version-group' ? printValue(item, depth + 1, false) : printElement(item, depth + 1));
        return printList(value.map(print), depth);
    }
    return printValue(value, depth, false);
}

function printEntry(value: unknown, depth: number): string {
    return printValue(value, depth, false);
}

/** A file-tree element at `depth`. */
function printElement(value: unknown, depth: number): string {
    return isObject(value) ? printValue(value, depth, elementIsCompact(value)) : printValue(value, depth, true);
}

/** Entries already printed at `depth + 1`, as a multi-line list. */
function printList(entries: string[], depth: number): string {
    let out = '[\n';
    entries.forEach((entry, position) => {
        out += position === 0 || !joinedOnOneLine(entries[position - 1], entry) ? indent(depth + 1) : '';
        out += entry;
        out += position < entries.length - 1 && joinedOnOneLine(entry, entries[position + 1]) ? ', ' : ',\n';
    });
    return `${out}${indent(depth)}]`;
}

/** Whether two adjacent list entries, as printed, are both multi-line containers, which Xcode joins `}, {`. */
function joinedOnOneLine(previous: string, next: string): boolean {
    const multiLineContainer = (text: string): boolean => /^[[{]/.test(text) && text.includes('\n');
    return multiLineContainer(previous) && multiLineContainer(next);
}

// ── Splicing ─────────────────────────────────────────────

/** Replaces a span; what goes in takes the file's line endings, so a CRLF file stays CRLF throughout. */
function splice(edit: XcprojEdit, start: number, end: number, text: string): void {
    const written = edit.session.crlf ? text.replace(/\r?\n/g, '\r\n') : text;
    edit.contents = edit.contents.slice(0, start) + written + edit.contents.slice(end);
}

/** The depth a value at `pointer` is printed at: one level per step from the root. */
function depthOf(pointer: JsonPointer): number {
    return pointer.length;
}

/** `text`, printed for `fromDepth`, moved to `toDepth`: every line after the first re-indented by the difference. */
function reindent(text: string, fromDepth: number, toDepth: number): string {
    if (fromDepth === toDepth) { return text; }
    const shift = (toDepth - fromDepth) * INDENT.length;
    return text.split('\n').map((line, position) => {
        if (position === 0) { return line; }
        if (shift > 0) { return ' '.repeat(shift) + line; }
        const spaces = /^ */.exec(line)?.[0].length ?? 0;
        return line.slice(Math.min(spaces, -shift));
    }).join('\n');
}

function isPlainSeparator(text: string): boolean {
    return /^\s*,?\s*$/.test(text);
}

/** The separator Xcode prints between two list entries at `depth`. */
function separator(previous: string, next: string, depth: number): string {
    return joinedOnOneLine(previous, next) ? ', ' : `,\n${indent(depth)}`;
}

/** Inserts printed `text` into the list at `pointer`, before entry `position` (at the end when past it). */
function insertIntoList(edit: XcprojEdit, pointer: JsonPointer, position: number, text: string): void {
    const list = jsonNode(edit, pointer);
    if (list.kind !== 'array') { return decline(`${pointer.join('/')} isn't a list`); }
    const depth = depthOf([...pointer, 0]);
    const contents = edit.contents;
    const entries = list.elements;
    const entryText = (node: Json5Node): string => contents.slice(node.start, node.end);
    if (entries.length === 0) {
        splice(edit, list.start, list.end, `[\n${indent(depth)}${text},\n${indent(depth - 1)}]`);
        return;
    }
    const previous = position > 0 ? entries[position - 1] : undefined;
    const next = position < entries.length ? entries[position] : undefined;
    if (previous && next) {
        const between = contents.slice(previous.end, next.start);
        if (isPlainSeparator(between)) {
            splice(edit, previous.end, next.start,
                `${separator(entryText(previous), text, depth)}${text}${separator(text, entryText(next), depth)}`);
        } else {
            splice(edit, next.start, next.start, `${text},\n${indent(depth)}`);
        }
    } else if (next) {
        const before = contents.slice(list.start + 1, next.start);
        if (/^\s*$/.test(before)) {
            splice(edit, list.start + 1, next.start, `\n${indent(depth)}${text}${separator(text, entryText(next), depth)}`);
        } else {
            splice(edit, next.start, next.start, `${text},\n${indent(depth)}`);
        }
    } else if (previous) {
        const close = list.end - 1;
        const after = contents.slice(previous.end, close);
        if (isPlainSeparator(after)) {
            splice(edit, previous.end, close, `${separator(entryText(previous), text, depth)}${text},\n${indent(depth - 1)}`);
        } else {
            const comma = after.includes(',') ? '' : ',';
            splice(edit, previous.end, previous.end, `${comma}\n${indent(depth)}${text}${comma ? '' : ','}`);
        }
    }
}

/** Removes entry `position` from the list at `pointer`, rejoining its neighbours as Xcode prints them. */
function removeFromList(edit: XcprojEdit, pointer: JsonPointer, position: number): void {
    const list = jsonNode(edit, pointer);
    if (list.kind !== 'array' || position >= list.elements.length) { return decline(`no entry ${position} in ${pointer.join('/')}`); }
    const depth = depthOf([...pointer, 0]);
    const contents = edit.contents;
    const entries = list.elements;
    const entry = entries[position];
    const previous = position > 0 ? entries[position - 1] : undefined;
    const next = position + 1 < entries.length ? entries[position + 1] : undefined;
    const plain = (start: number, end: number): boolean => isPlainSeparator(contents.slice(start, end));
    if (previous && next && plain(previous.end, entry.start) && plain(entry.end, next.start)) {
        splice(edit, previous.end, next.start,
            separator(contents.slice(previous.start, previous.end), contents.slice(next.start, next.end), depth));
    } else if (!previous && next && /^\s*$/.test(contents.slice(list.start + 1, entry.start)) && plain(entry.end, next.start)) {
        splice(edit, entry.start, next.start, '');
    } else if (previous && !next && plain(previous.end, entry.start)) {
        splice(edit, previous.end, entry.end, '');
    } else {
        // Not as Xcode prints it: take the entry and the comma after it, leaving the rest.
        const after = /^\s*,/.exec(contents.slice(entry.end));
        splice(edit, entry.start, entry.end + (after ? after[0].length : 0), '');
    }
}

/** Replaces an object's value for `key`, or adds the key before the first of `before` it has, else last. */
function setField(edit: XcprojEdit, pointer: JsonPointer, key: string, value: string, before: readonly string[]): void {
    const object = editableObject(edit, pointer);
    const existing = member(object, key);
    if (existing) {
        splice(edit, existing.value.start, existing.value.end, value);
        return;
    }
    const contents = edit.contents;
    const multiLine = contents.slice(object.start, object.end).includes('\n');
    const following = object.members.find((candidate) => before.includes(candidate.key));
    const field = `${JSON.stringify(key)}: ${value}`;
    if (multiLine) {
        const depth = depthOf(pointer) + 1;
        const close = object.end - 1;
        const last = object.members[object.members.length - 1];
        if (following) {
            const lineStart = contents.lastIndexOf('\n', following.start) + 1;
            splice(edit, lineStart, lineStart, `${indent(depth)}${field},\n`);
        } else if (last && contents.slice(contents.lastIndexOf('\n', close) + 1, close).trim() !== '') {
            // Not as Xcode prints it: the last member shares the closing line, so the field goes after it.
            const comma = contents.slice(last.end, close).indexOf(',');
            if (comma === -1) {
                splice(edit, last.end, last.end, `,\n${indent(depth)}${field},`);
            } else {
                splice(edit, last.end + comma + 1, last.end + comma + 1, `\n${indent(depth)}${field},`);
            }
        } else {
            const lineStart = contents.lastIndexOf('\n', close) + 1;
            const comma = last && !/,/.test(contents.slice(last.end, close)) ? ',' : '';
            if (comma) { splice(edit, last.end, last.end, comma); }
            const at = lineStart + comma.length;
            splice(edit, at, at, `${indent(depth)}${field},\n`);
        }
    } else if (following) {
        splice(edit, following.start, following.start, `${field}, `);
    } else {
        const last = object.members[object.members.length - 1];
        if (!last) {
            splice(edit, object.start, object.end, `{ ${field} }`);
        } else {
            splice(edit, last.end, last.end, `, ${field}`);
        }
    }
}

/** Removes an object's `key`, with its line or its comma. */
function removeField(edit: XcprojEdit, pointer: JsonPointer, key: string): void {
    const object = editableObject(edit, pointer);
    const existing = member(object, key);
    if (!existing) { return; }
    const contents = edit.contents;
    const position = object.members.indexOf(existing);
    if (contents.slice(object.start, object.end).includes('\n')) {
        const lineStart = contents.lastIndexOf('\n', existing.start) + 1;
        const lineEnd = contents.indexOf('\n', existing.end);
        if (/^\s*$/.test(contents.slice(lineStart, existing.start)) && /^\s*,?\s*$/.test(contents.slice(existing.end, lineEnd))) {
            splice(edit, lineStart, lineEnd + 1, '');
            return;
        }
    }
    const next = object.members[position + 1];
    if (next) {
        splice(edit, existing.start, next.start, '');
    } else {
        const previous = object.members[position - 1];
        splice(edit, previous ? previous.end : existing.start, existing.end + (/^\s*,/.exec(contents.slice(existing.end))?.[0].length ?? 0), '');
    }
}

/** Replaces an element's whole text with its value printed afresh, as Xcode would print it. */
function reprintElement(edit: XcprojEdit, handle: string, value: Json): void {
    const pointer = pointerOf(edit, handle);
    editableObject(edit, pointer);
    const node = jsonNode(edit, pointer);
    splice(edit, node.start, node.end, printElement(value, depthOf(pointer)));
    rejoinAround(edit, handle);
}

/** Rewrites the separators on both sides of an element whose layout changed between one line and several. */
function rejoinAround(edit: XcprojEdit, handle: string): void {
    const pointer = pointerOf(edit, handle);
    const listPointer = pointer.slice(0, -1);
    const position = pointer[pointer.length - 1] as number;
    const list = jsonNode(edit, listPointer);
    if (list.kind !== 'array') { return; }
    const depth = depthOf(pointer);
    const text = (node: Json5Node): string => edit.contents.slice(node.start, node.end);
    // From the end, so the earlier offsets stay valid.
    const next = list.elements[position + 1];
    const entry = list.elements[position];
    const previous = list.elements[position - 1];
    if (next && isPlainSeparator(edit.contents.slice(entry.end, next.start))) {
        splice(edit, entry.end, next.start, separator(text(entry), text(next), depth));
    }
    if (previous && isPlainSeparator(edit.contents.slice(previous.end, entry.start))) {
        splice(edit, previous.end, entry.start, separator(text(previous), text(entry), depth));
    }
}

// ── Changes ──────────────────────────────────────────────

function copyModel(model: Model): Model {
    const nodes = new Map<string, NodeRecord>();
    for (const [handle, node] of model.nodes) { nodes.set(handle, { ...node, children: [...node.children] }); }
    return { nodes, top: [...model.top] };
}

/** Opens a change: until `endChange`, a decline undoes everything since. */
export function beginChange(edit: XcprojEdit): void {
    const session = edit.session;
    session.change = {
        contents: edit.contents, model: copyModel(session.model), createdGroups: new Map(session.createdGroups),
        references: session.references.map((reference) => ({ ...reference })), implicit: false
    };
}

function openImplicitChange(edit: XcprojEdit): Change {
    beginChange(edit);
    const change = edit.session.change as Change;
    change.implicit = true;
    return change;
}

/** Closes the change; whether it landed. */
export function endChange(edit: XcprojEdit): boolean {
    const landed = edit.session.change?.declined === undefined;
    edit.session.change = undefined;
    return landed;
}

/**
 * Runs one operation inside the open change, or as a change of its own: after it, every reference into the file tree must
 * still name its element, re-encoded where its path changed. A decline restores the change's start and makes the rest of
 * the change do nothing.
 */
function operate<T>(edit: XcprojEdit, name: string, body: () => T): T | undefined {
    const session = edit.session;
    const open = session.change;
    const change = open ?? openImplicitChange(edit);
    try {
        if (change.declined !== undefined) { return undefined; }
        const result = body();
        followReferences(edit);
        return result;
    } catch (error) {
        if (!(error instanceof Decline)) { throw error; }
        change.declined = error.message;
        edit.contents = change.contents;
        session.model = copyModel(change.model);
        session.createdGroups = new Map(change.createdGroups);
        session.references = change.references.map((reference) => ({ ...reference }));
        session.parsed = undefined;
        session.log(`${session.prefix} project.xcproj: ${name} left undone, with the rest of its change: ${error.message}`);
        return undefined;
    } finally {
        if (change.implicit) { session.change = undefined; }
    }
}

// ── References into the file tree ────────────────────────

/**
 * A node of the current tree as references walk it, read from the records on demand. One instance per handle within a
 * walk, since the resolver compares nodes by identity.
 */
class ViewNode {
    constructor(private readonly views: Views, readonly handle: string) {}

    get displayName(): string {
        return naming(this.views.edit, this.handle).displayName;
    }

    get parent(): ViewNode | undefined {
        const parent = record(this.views.edit, this.handle).parent;
        return parent === undefined ? undefined : this.views.of(parent);
    }

    get children(): ViewNode[] {
        return record(this.views.edit, this.handle).children.map((child) => this.views.of(child));
    }
}

class Views {
    private readonly made = new Map<string, ViewNode>();

    constructor(readonly edit: XcprojEdit) {}

    of(handle: string): ViewNode {
        let view = this.made.get(handle);
        if (!view) {
            view = new ViewNode(this, handle);
            this.made.set(handle, view);
        }
        return view;
    }
}

/** What a reference names in the current tree, by handle; undefined when it names nothing, or more than one element. */
function resolveHandle(edit: XcprojEdit, raw: unknown, origin: string | undefined): string | undefined {
    const read = readReference(raw);
    if ('problem' in read) { return undefined; }
    const model = edit.session.model;
    const views = new Views(edit);
    const byId = (id: string): ViewNode | undefined => {
        for (const [handle, node] of model.nodes) {
            if (node.explicitId === id) { return views.of(handle); }
        }
        return undefined;
    };
    const top = model.top.map((handle) => views.of(handle));
    const resolved = resolveReference<ViewNode>(read.reference, origin === undefined ? undefined : views.of(origin), top, byId);
    return 'problem' in resolved ? undefined : resolved.node.handle;
}

/** Every reference from outside the file tree into it, with the element it names now. */
function recordReferences(edit: XcprojEdit, root: Json5Node): RecordedReference[] {
    const value = valueOf(root);
    if (!isObject(value)) { return []; }
    const found: RecordedReference[] = [];
    const add = (pointer: JsonPointer, origin: string | undefined, location?: () => JsonPointer | undefined, implicit?: string): void => {
        const raw = implicit ?? valueOf(nodeAt(root, pointer) as Json5Node);
        const target = resolveHandle(edit, raw, origin);
        if (target !== undefined) { found.push({ location: location ?? (() => pointer), origin, target, implicit, value: raw }); }
    };
    if (value['products-group'] === undefined) {
        add(['products-group'], undefined, undefined, 'Products');
    } else {
        add(['products-group'], undefined);
    }
    const configurationFiles = (entries: unknown, pointer: JsonPointer): void => {
        if (!Array.isArray(entries)) { return; }
        entries.forEach((entry, position) => {
            if (!isObject(entry) || entry.file === undefined) { return; }
            const at = [...pointer, position, 'file'];
            if (!isObject(entry.file)) {
                add(at, undefined);
            } else if (entry.file.anchor !== undefined) {
                add([...at, 'anchor'], undefined);
            }
        });
    };
    configurationFiles(value.configurations, ['configurations']);
    // A product of another project, linked or copied here, names that project's file reference; the lowering doesn't read
    // these, so nothing but this record keeps them in step, and Xcode refuses the project when one names nothing.
    (Array.isArray(value['imported-products']) ? value['imported-products'] : []).forEach((product, position) => {
        if (isObject(product) && product.project !== undefined) { add(['imported-products', position, 'project'], undefined); }
    });
    (Array.isArray(value.targets) ? value.targets : []).forEach((target, position) => {
        if (!isObject(target)) { return; }
        if (target.product !== undefined) { add(['targets', position, 'product'], undefined); }
        configurationFiles(target['specialized-configurations'], ['targets', position, 'specialized-configurations']);
        (Array.isArray(target.dependencies) ? target.dependencies : []).forEach((dependency, index) => {
            if (isObject(dependency) && dependency.kind === 'remoteTarget' && dependency.project !== undefined) {
                add(['targets', position, 'dependencies', index, 'project'], undefined);
            }
        });
    });
    for (const [handle, node] of edit.session.model.nodes) {
        if (node.kind !== 'version-group') { continue; }
        const pointer = [...pointerOf(edit, handle), 'current-version'];
        if (nodeAt(root, pointer) === undefined) { continue; }
        add(pointer, handle, () => (edit.session.model.nodes.has(handle) ? [...pointerOf(edit, handle), 'current-version'] : undefined));
    }
    return found;
}

/** Re-encodes every reference that no longer names its element; declines when one can't be made to. */
function followReferences(edit: XcprojEdit): void {
    const model = edit.session.model;
    // A model's current version lives inside it: removing the model takes the reference along, not a dangling one.
    edit.session.references = edit.session.references.filter((reference) => reference.origin === undefined || model.nodes.has(reference.origin));
    for (const reference of edit.session.references) {
        if (!model.nodes.has(reference.target)) { return decline('a reference into the file tree names an element the change removes'); }
        if (resolveHandle(edit, reference.value, reference.origin) === reference.target) { continue; }
        if (reference.implicit !== undefined) { return decline(`"${reference.implicit}" would no longer name the products group`); }
        const names: string[] = [];
        let current: string | undefined = reference.target;
        while (current !== undefined && current !== reference.origin) {
            names.unshift(naming(edit, current).displayName);
            current = record(edit, current).parent;
        }
        if (current !== reference.origin) { return decline('a current version would leave its model'); }
        const pointer = reference.location();
        if (!pointer) { return decline('a reference into the file tree lost its place'); }
        const ownerPointer = pointer.slice(0, -1);
        const owner = editableObject(edit, ownerPointer);
        const field = member(owner, String(pointer[pointer.length - 1]));
        if (!field) { return decline(`no reference at ${pointer.join('/')}`); }
        const encoded = encodeReference(names);
        const compact = !edit.contents.slice(owner.start, owner.end).includes('\n');
        splice(edit, field.value.start, field.value.end, printValue(encoded, depthOf(pointer), compact));
        reference.value = encoded;
        if (resolveHandle(edit, encoded, reference.origin) !== reference.target) {
            return decline(`"${names.join('/')}" would name more than one element`);
        }
    }
}

// ── Operations ───────────────────────────────────────────

/** Comparable-entry filter for Swift files, as the pbxproj writer's default. */
function isSwiftEntry(name: string): boolean {
    return name.endsWith('.swift') || name.includes('.swift ');
}

/** Where a new child sorts among `siblings`, as the pbxproj writer's `insertListEntry` sorts; null comparable appends. */
function sortedPosition(edit: XcprojEdit, siblings: string[], name: string, comparable: ((name: string) => boolean) | null): number {
    if (!comparable) { return siblings.length; }
    let lastBefore = -1;
    for (let position = 0; position < siblings.length; position++) {
        const sibling = sortName(edit, siblings[position]);
        if (sibling === '' || !comparable(sibling)) { continue; }
        if (sibling.localeCompare(name, undefined, { sensitivity: 'base' }) > 0) { return position; }
        lastBefore = position;
    }
    return lastBefore === -1 ? siblings.length : lastBefore + 1;
}

/** Inserts an element's printed value under `parent` (undefined: the top level) at `position`, and into the model. */
function insertElement(edit: XcprojEdit, parent: string | undefined, position: number, handle: string, node: NodeRecord, value: Json): void {
    const model = edit.session.model;
    if (parent === undefined) {
        insertIntoList(edit, ['files'], position, printElement(value, 2));
    } else {
        const groupPointer = pointerOf(edit, parent);
        const group = editableObject(edit, groupPointer);
        const children = member(group, 'children');
        if (!children || children.value.kind !== 'array' || children.value.elements.length === 0) {
            const groupValue = elementValue(edit, parent);
            const { children: _empty, ...fields } = groupValue;
            reprintElement(edit, parent, { ...fields, children: [value] });
        } else {
            insertIntoList(edit, [...groupPointer, 'children'], position, printElement(value, depthOf(groupPointer) + 2));
        }
    }
    model.nodes.set(handle, node);
    siblingsOf(model, parent).splice(position, 0, handle);
}

/** Takes an element out of its list and the model; its text, printed at the depth it had. */
function detachElement(edit: XcprojEdit, handle: string): { text: string; depth: number } {
    const model = edit.session.model;
    const node = record(edit, handle);
    const pointer = pointerOf(edit, handle);
    const element = jsonNode(edit, pointer);
    const text = edit.contents.slice(element.start, element.end);
    const siblings = siblingsOf(model, node.parent);
    const position = siblings.indexOf(handle);
    if (node.parent !== undefined && siblings.length === 1) {
        const groupValue = elementValue(edit, node.parent);
        const { children: _gone, ...fields } = groupValue;
        siblings.splice(position, 1);
        reprintElement(edit, node.parent, fields);
    } else {
        if (node.parent !== undefined) { editableObject(edit, pointerOf(edit, node.parent)); }
        removeFromList(edit, pointer.slice(0, -1), position);
        siblings.splice(position, 1);
    }
    return { text, depth: depthOf(pointer) };
}

/** Puts a detached element's text under `parent` at `position`, re-indented for its new depth. */
function attachElement(edit: XcprojEdit, handle: string, text: string, fromDepth: number, parent: string | undefined, position: number): void {
    const model = edit.session.model;
    const node = record(edit, handle);
    const value = valueOf(parseJson5Text(text) as Json5Node);
    if (parent === undefined) {
        insertIntoList(edit, ['files'], position, reindent(text, fromDepth, 2));
    } else {
        const groupPointer = pointerOf(edit, parent);
        const group = editableObject(edit, groupPointer);
        const children = member(group, 'children');
        if (!children || children.value.kind !== 'array' || children.value.elements.length === 0) {
            const groupValue = elementValue(edit, parent);
            const { children: _empty, ...fields } = groupValue;
            reprintElement(edit, parent, { ...fields, children: [value] });
            // The reprint printed the element afresh; put its own text back, re-indented, so its bytes stay.
            const childPointer = [...pointerOf(edit, parent), 'children', 0];
            const printed = jsonNode(edit, childPointer);
            splice(edit, printed.start, printed.end, reindent(text, fromDepth, depthOf(childPointer)));
        } else {
            insertIntoList(edit, [...groupPointer, 'children'], position, reindent(text, fromDepth, depthOf(groupPointer) + 2));
        }
    }
    node.parent = parent;
    siblingsOf(model, parent).splice(position, 0, handle);
}

function isWithin(edit: XcprojEdit, handle: string, ancestor: string): boolean {
    for (let current: string | undefined = handle; current !== undefined; current = record(edit, current).parent) {
        if (current === ancestor) { return true; }
    }
    return false;
}

const FILE_FIELDS_AFTER_PATH = ['id', 'type', 'signature', 'encoding', 'line-ending', 'index', 'target-membership', 'name'];
const GROUP_FIELDS_AFTER_PATH = ['name', 'index', 'children', 'current-version', 'type', 'target-membership'];

function fieldsAfterPath(kind: ElementKind): string[] {
    return kind === 'file-reference' ? FILE_FIELDS_AFTER_PATH : GROUP_FIELDS_AFTER_PATH;
}

/** Sets an element's relative path under `sourceTree`, written as Xcode's encoder writes it. */
function writePath(edit: XcprojEdit, handle: string, sourceTree: string, path: string): void {
    const text = formatPath(sourceTree, path);
    if (readPath(text) === undefined) { return decline(`"${text}" isn't a path Xcode reads`); }
    setField(edit, pointerOf(edit, handle), 'path', JSON.stringify(text), fieldsAfterPath(record(edit, handle).kind));
    record(edit, handle).path = text;
}

/** The membership entry for a target's Sources phase, as Xcode's encoder writes it. */
function sourcesMembership(edit: XcprojEdit, phaseId: string): unknown {
    const pointer = edit.index.sources?.get(phaseId);
    if (!pointer || pointer[0] !== 'targets' || pointer[2] !== 'build-phases') { return decline(`${phaseId} isn't a build phase`); }
    const targetNode = nodeAt(parsedRoot(edit), ['targets', pointer[1]]);
    const target = targetNode ? valueOf(targetNode) : undefined;
    if (!isObject(target) || typeof target.name !== 'string') { return decline(`no target holds ${phaseId}`); }
    const phases = Array.isArray(target['build-phases']) ? target['build-phases'] : [];
    const kindOf = (phase: unknown): unknown => (typeof phase === 'string' ? phase : isObject(phase) ? phase.kind : undefined);
    const phase = phases[pointer[3] as number];
    if (kindOf(phase) !== 'compile-sources') { return decline(`${phaseId} isn't a Sources phase`); }
    if (phases.filter((candidate) => kindOf(candidate) === 'compile-sources').length === 1) {
        const reference = encodeReference([target.name, 'compile-sources']);
        return typeof reference === 'string' ? reference : { 'build-phase': reference };
    }
    if (isObject(phase) && typeof phase.id === 'string') { return `id:${phase.id}`; }
    return decline(`target ${target.name} has several Sources phases and this one has no id to name it by`);
}

/** Registers a Swift file in a group and a Sources phase; the new element's handle, or undefined when declined. */
export function addSwiftFile(edit: XcprojEdit, fileName: string, groupId: string, sourcesBuildPhaseId: string): string | undefined {
    return operate(edit, `adding ${fileName}`, () => {
        const parent = parentOf(edit, groupId);
        const path = formatPath('<group>', fileName);
        if (readPath(path) === undefined) { return decline(`"${path}" isn't a path Xcode reads`); }
        const value: Json = { path, 'target-membership': [sourcesMembership(edit, sourcesBuildPhaseId)] };
        const siblings = siblingsOf(edit.session.model, parent);
        const position = sortedPosition(edit, siblings, fileName, isSwiftEntry);
        const placeholder = `pending:${fileName}`;
        insertElement(edit, parent, position, placeholder, { kind: 'file-reference', parent, children: [], insertedName: fileName, path }, value);
        return rename(edit, placeholder, newHandle(edit, placeholder));
    });
}

/** Gives an element created in this operation its final handle. */
function rename(edit: XcprojEdit, from: string, to: string): string {
    const model = edit.session.model;
    const node = record(edit, from);
    model.nodes.delete(from);
    model.nodes.set(to, node);
    const siblings = siblingsOf(model, node.parent);
    siblings[siblings.indexOf(from)] = to;
    return to;
}

/** Unregisters a file: its element goes, and its memberships with it. */
export function removeSwiftFile(edit: XcprojEdit, fileReferenceId: string): void {
    operate(edit, 'removing a file', () => {
        detachElement(edit, fileReferenceId);
        edit.session.model.nodes.delete(fileReferenceId);
    });
}

/** Renames a file in place: the last component of its path, under the base it has. */
export function renameSwiftFile(edit: XcprojEdit, fileReferenceId: string, fileName: string): void {
    operate(edit, `renaming a file to ${fileName}`, () => {
        const parsed = parsedPathOf(record(edit, fileReferenceId));
        if (parsed.path === '') { return; }
        const components = parsed.path.split('/');
        components[components.length - 1] = fileName;
        writePath(edit, fileReferenceId, parsed.sourceTree, components.join('/'));
    });
}

/** Moves a file into a group under a file name. */
export function rehomeSwiftFile(edit: XcprojEdit, fileReferenceId: string, groupId: string, fileName: string): void {
    operate(edit, `moving a file as ${fileName}`, () => {
        move(edit, fileReferenceId, groupId, fileName, fileName, isSwiftEntry);
    });
}

/** Moves an element into a group, sorted with `comparable`, its path group-relative. */
export function moveElement(
    edit: XcprojEdit,
    id: string,
    groupId: string,
    elementPath: string,
    shownName: string,
    comparable: ((name: string) => boolean) | null
): void {
    operate(edit, `moving ${shownName}`, () => {
        move(edit, id, groupId, elementPath, shownName, comparable);
    });
}

function move(edit: XcprojEdit, id: string, groupId: string, elementPath: string, shownName: string, comparable: ((name: string) => boolean) | null): void {
    const parent = parentOf(edit, groupId);
    if (parent !== undefined && isWithin(edit, parent, id)) { return decline(`${shownName} can't move into itself`); }
    editableObject(edit, pointerOf(edit, id));
    const { text, depth } = detachElement(edit, id);
    const siblings = siblingsOf(edit.session.model, parent);
    attachElement(edit, id, text, depth, parent, sortedPosition(edit, siblings, shownName, comparable));
    writePath(edit, id, '<group>', elementPath);
}

/** Replaces a file's path, under the base it has. */
export function setFileReferencePath(edit: XcprojEdit, fileReferenceId: string, newPath: string): void {
    operate(edit, 'setting a file path', () => {
        writePath(edit, fileReferenceId, parsedPathOf(record(edit, fileReferenceId)).sourceTree, newPath);
    });
}

/**
 * Sets elements' paths under the bases they have now, for elements of the input with a path. A `name` equal to the new
 * path's last component is implicit, so an explicit one goes; another is written; file references and folders take none.
 */
export function setElementPaths(edit: XcprojEdit, changes: readonly ElementPathChange[]): void {
    operate(edit, 'rewriting paths', () => {
        for (const change of changes) {
            if (!edit.index.object(change.id) || !edit.session.model.nodes.has(change.id)) { continue; }
            const node = record(edit, change.id);
            if (node.path !== '') { writePath(edit, change.id, parsedPathOf(node).sourceTree, change.path); }
            if (change.name === undefined || node.kind === 'file-reference' || node.kind === 'folder') { continue; }
            if (change.name === lastPathComponent(change.path)) {
                removeField(edit, pointerOf(edit, change.id), 'name');
                delete node.name;
            } else {
                setField(edit, pointerOf(edit, change.id), 'name', JSON.stringify(change.name), ['index', 'children', 'current-version', 'type', 'target-membership']);
                node.name = change.name;
            }
        }
    });
}

/** Creates nested groups for folders under a group, reusing any created earlier in the session; the deepest group's handle. */
export function addGroupPath(edit: XcprojEdit, parentGroupId: string, folderNames: string[]): string | undefined {
    return operate(edit, `adding the group ${folderNames.join('/')}`, () => {
        let parentId = parentGroupId;
        for (const name of folderNames) {
            const key = `${parentId}/${name}`;
            const existing = edit.session.createdGroups.get(key);
            if (existing && edit.session.model.nodes.has(existing)) {
                parentId = existing;
                continue;
            }
            const parent = parentOf(edit, parentId);
            const path = formatPath('<group>', name);
            if (readPath(path) === undefined) { return decline(`"${path}" isn't a path Xcode reads`); }
            const siblings = siblingsOf(edit.session.model, parent);
            const position = sortedPosition(edit, siblings, name, () => true);
            const placeholder = `pending:${key}`;
            insertElement(edit, parent, position, placeholder, { kind: 'group', parent, children: [], insertedName: name, path }, { kind: 'group', path });
            const handle = rename(edit, placeholder, newHandle(edit, placeholder));
            edit.session.createdGroups.set(key, handle);
            parentId = handle;
        }
        return parentId;
    });
}

// ── Core Data models ─────────────────────────────────────

/** A model's keys in the order Xcode's encoder writes them (`VersionGroup.swift`); keys it doesn't know follow. */
const MODEL_KEY_ORDER = ['kind', 'id', 'path', 'name', 'current-version', 'type', 'index', 'target-membership', 'children'];

function inModelOrder(value: Json): Json {
    const ordered: Json = {};
    for (const key of MODEL_KEY_ORDER) {
        if (value[key] !== undefined) { ordered[key] = value[key]; }
    }
    for (const key of Object.keys(value)) {
        if (!(key in ordered)) { ordered[key] = value[key]; }
    }
    return ordered;
}

/** The version a model points at: the named one when it is among them, else the first; undefined without versions. */
function currentOf(versionNames: string[], currentVersionName: string | undefined): string | undefined {
    return currentVersionName !== undefined && versionNames.includes(currentVersionName) ? currentVersionName : versionNames[0];
}

/** Records a model's versions as its children, in order; their handles. */
function recordVersions(edit: XcprojEdit, model: string, versionNames: string[]): string[] {
    const node = record(edit, model);
    node.children = [];
    return versionNames.map((name) => {
        const placeholder = `pending:${model}/${name}`;
        edit.session.model.nodes.set(placeholder, { kind: 'file-reference', parent: model, children: [], path: formatPath('<group>', name), insertedName: name });
        node.children.push(placeholder);
        return rename(edit, placeholder, newHandle(edit, placeholder));
    });
}

function modelRecord(edit: XcprojEdit, id: string): NodeRecord {
    const node = record(edit, id);
    return node.kind === 'version-group' ? node : decline(`${id} isn't a model`);
}

/** Registers a `.xcdatamodeld` bundle in a group and a Sources phase, with its versions; the model's handle. */
function addModel(
    edit: XcprojEdit, bundleName: string, versionNames: string[], currentVersionName: string | undefined, groupId: string, phaseId: string
): string | undefined {
    return operate(edit, `registering ${bundleName}`, () => {
        const parent = parentOf(edit, groupId);
        const path = formatPath('<group>', bundleName);
        if (readPath(path) === undefined) { return decline(`"${path}" isn't a path Xcode reads`); }
        const current = currentOf(versionNames, currentVersionName);
        const value = inModelOrder({
            kind: 'version-group',
            path,
            'current-version': current === undefined ? undefined : encodeReference([current]),
            type: 'wrapper.xcdatamodel',
            'target-membership': [sourcesMembership(edit, phaseId)],
            children: versionNames.length > 0 ? versionNames.map((name) => ({ path: formatPath('<group>', name) })) : undefined
        });
        const siblings = siblingsOf(edit.session.model, parent);
        const placeholder = `pending:${bundleName}`;
        insertElement(edit, parent, sortedPosition(edit, siblings, bundleName, () => true), placeholder,
            { kind: 'version-group', parent, children: [], insertedName: bundleName, path }, value);
        const handle = rename(edit, placeholder, newHandle(edit, placeholder));
        recordVersions(edit, handle, versionNames);
        return handle;
    });
}

/** Replaces a model's versions and current version, keeping its memberships and every other key. */
function refreshModel(edit: XcprojEdit, id: string, versionNames: string[], currentVersionName: string | undefined): true | undefined {
    return operate(edit, 'refreshing a model\'s versions', () => {
        const node = modelRecord(edit, id);
        editableObject(edit, pointerOf(edit, id));
        const current = currentOf(versionNames, currentVersionName) as string;
        const value = inModelOrder({
            ...elementValue(edit, id),
            'current-version': encodeReference([current]),
            children: versionNames.map((name) => ({ path: formatPath('<group>', name) }))
        });
        for (const child of node.children) { edit.session.model.nodes.delete(child); }
        node.children = [];
        reprintElement(edit, id, value);
        const handles = recordVersions(edit, id, versionNames);
        // The current version is rewritten here, so its recorded reference follows the new version.
        const target = handles[versionNames.indexOf(current)];
        const recorded = edit.session.references.filter((reference) => reference.origin === id);
        for (const reference of recorded) {
            reference.target = target;
            reference.value = encodeReference([current]);
        }
        if (recorded.length === 0) {
            edit.session.references.push({
                location: () => (edit.session.model.nodes.has(id) ? [...pointerOf(edit, id), 'current-version'] : undefined),
                origin: id, target, value: encodeReference([current])
            });
        }
        return true;
    });
}

/** Moves a model into a group, its relative path collapsed to the bundle name when it differs; its base stays. */
function moveModel(edit: XcprojEdit, id: string, groupId: string, bundleName: string): true | undefined {
    return operate(edit, `moving ${bundleName}`, () => {
        modelRecord(edit, id);
        editableObject(edit, pointerOf(edit, id));
        const parent = parentOf(edit, groupId);
        if (parent !== undefined && isWithin(edit, parent, id)) { return decline(`${bundleName} can't move into itself`); }
        const { text, depth } = detachElement(edit, id);
        attachElement(edit, id, text, depth, parent, sortedPosition(edit, siblingsOf(edit.session.model, parent), bundleName, () => true));
        const parsed = parsedPathOf(record(edit, id));
        if (parsed.path !== bundleName) { writePath(edit, id, parsed.sourceTree, bundleName); }
        return true;
    });
}

/** Unregisters a model: its object goes whole, with its versions and memberships. */
function removeModel(edit: XcprojEdit, id: string): true | undefined {
    return operate(edit, 'removing a model', () => {
        const node = modelRecord(edit, id);
        detachElement(edit, id);
        for (const child of node.children) { edit.session.model.nodes.delete(child); }
        edit.session.model.nodes.delete(id);
        return true;
    });
}

/** Runs one Core Data change on a text: the text to write, or null when it declined or didn't read back (why is logged). */
function onText(text: string, log: (message: string) => void, change: (edit: XcprojEdit) => unknown): string | null {
    const edit = beginXcprojEdit(text, log, '[datamodel-sync]');
    if (!edit || change(edit) === undefined) { return null; }
    const output = xcprojEditText(edit);
    return edit.session.gateProblem === undefined ? output : null;
}

function isModelId(text: string, id: string): boolean {
    const index = readProject(text);
    return typeof index !== 'string' && index.object(id)?.isa === 'XCVersionGroup';
}

/** Registers a `.xcdatamodeld` bundle; null when declined. */
export function addXcprojDataModel(
    text: string, bundleName: string, versionNames: string[], currentVersionName: string | undefined, groupId: string,
    sourcesBuildPhaseId: string, log: (message: string) => void
): string | null {
    return onText(text, log, (edit) => addModel(edit, bundleName, versionNames, currentVersionName, groupId, sourcesBuildPhaseId));
}

/** Rewrites a model's versions; null for no versions, an id that isn't a model, or a decline. */
export function updateXcprojVersionGroupVersions(
    text: string, versionGroupId: string, versionNames: string[], currentVersionName: string | undefined, log: (message: string) => void
): string | null {
    if (versionNames.length === 0 || !isModelId(text, versionGroupId)) { return null; }
    return onText(text, log, (edit) => refreshModel(edit, versionGroupId, versionNames, currentVersionName));
}

/** Moves a model into another group; null when declined. */
export function moveXcprojVersionGroupToGroup(
    text: string, versionGroupId: string, newGroupId: string, bundleName: string, log: (message: string) => void
): string | null {
    return onText(text, log, (edit) => moveModel(edit, versionGroupId, newGroupId, bundleName));
}

/** Unregisters a model; null when the id isn't a model, or when declined. */
export function removeXcprojDataModel(text: string, versionGroupId: string, log: (message: string) => void): string | null {
    if (!isModelId(text, versionGroupId)) { return null; }
    return onText(text, log, (edit) => removeModel(edit, versionGroupId));
}

// ── Build settings ───────────────────────────────────────

/** Keys a project's `build-settings` precedes, in Xcode's encoder order (`Project.swift`). */
const PROJECT_KEYS_AFTER_SETTINGS = ['products-group', 'last-upgrade', 'last-swift-update', 'last-swift-migration'];

function sameValue(a: string, b: string): boolean {
    const read = (text: string): string => {
        const node = parseJson5Text(text);
        return node ? JSON.stringify(valueOf(node)) : text;
    };
    return read(a) === read(b);
}

/** Sets a key of a settings object, inserted in code-point order among the keys it holds. */
function setSortedKey(edit: XcprojEdit, pointer: JsonPointer, key: string, valueText: string): void {
    const object = editableObject(edit, pointer);
    const next = object.members.find((candidate) => compareCodePoints(candidate.key, key) > 0);
    setField(edit, pointer, key, valueText, next ? [next.key] : []);
}

/**
 * Sets `key` to `value` in one configuration of an owner (the project or a target) as Xcode writes settings: one plain
 * key when every configuration of its list has the same value, else one `key[config=<name>]` per configuration that has
 * one. A configuration whose value doesn't change keeps its value as written; keys with other conditions stay as they are.
 */
function setSetting(edit: XcprojEdit, ownerPointer: JsonPointer, names: string[], configuration: string, key: string, value: string): void {
    const owner = editableObject(edit, ownerPointer);
    const conditioned = (name: string): string => `${key}[config=${name}]`;
    const settingsPointer = [...ownerPointer, 'build-settings'];
    const existing = member(owner, 'build-settings');
    const current = new Map<string, string>();
    if (existing) {
        if (existing.value.kind !== 'object') { return decline('"build-settings" isn\'t an object'); }
        const settings = editableObject(edit, settingsPointer);
        const plain = member(settings, key);
        for (const name of names) {
            const own = plain ?? member(settings, conditioned(name));
            if (own) { current.set(name, edit.contents.slice(own.value.start, own.value.end)); }
        }
    }
    current.set(configuration, JSON.stringify(value));
    const values = names.map((name) => current.get(name));
    const first = values[0];
    const agree = first !== undefined && values.every((text) => text !== undefined && sameValue(text, first));

    // An empty object is written afresh too, so its first key goes on a line of its own, as Xcode prints it.
    if (!existing || (existing.value.kind === 'object' && existing.value.members.length === 0)) {
        const entries = agree
            ? [[key, first as string]]
            : names.filter((name) => current.has(name)).map((name) => [conditioned(name), current.get(name) as string]);
        entries.sort(([a], [b]) => compareCodePoints(a, b));
        const depth = depthOf(settingsPointer);
        const text = `{\n${entries.map(([entryKey, entryValue]) => `${indent(depth + 1)}${JSON.stringify(entryKey)}: ${entryValue},\n`).join('')}${indent(depth)}}`;
        setField(edit, ownerPointer, 'build-settings', text, ownerPointer.length === 0 ? PROJECT_KEYS_AFTER_SETTINGS : []);
        return;
    }
    if (agree) {
        for (const name of names) { removeField(edit, settingsPointer, conditioned(name)); }
        setSortedKey(edit, settingsPointer, key, first as string);
    } else {
        removeField(edit, settingsPointer, key);
        for (const name of names) {
            const text = current.get(name);
            if (text !== undefined) { setSortedKey(edit, settingsPointer, conditioned(name), text); }
        }
    }
}

/**
 * Sets a build setting in one configuration of a JSON project file; the input unchanged when the configuration isn't
 * found, or when the change declines, whose reason goes to `onDecline`.
 */
export function updateXcprojBuildSetting(
    text: string, configId: string, key: string, value: string, onDecline: (reason: string) => void
): string {
    const edit = beginXcprojEdit(text, () => undefined);
    if (!edit) { return text; }
    const { index } = edit;
    const configuration = index.object(configId);
    if (configuration?.isa !== 'XCBuildConfiguration' || typeof configuration.name !== 'string') { return text; }
    const listId = Object.keys(index.objects).find((id) => index.objects[id].isa === 'XCConfigurationList' &&
        Array.isArray(index.objects[id].buildConfigurations) && (index.objects[id].buildConfigurations as unknown[]).includes(configId));
    if (!listId) { return text; }
    let ownerPointer: JsonPointer | undefined;
    if (index.project?.buildConfigurationList === listId) {
        ownerPointer = [];
    } else {
        const owner = ['PBXNativeTarget', 'PBXAggregateTarget', 'PBXLegacyTarget'].flatMap((isa) => index.objectsOfIsa(isa))
            .find(({ object }) => object.buildConfigurationList === listId);
        ownerPointer = owner ? index.sources?.get(owner.id) : undefined;
    }
    if (!ownerPointer) { return text; }
    const names = (index.objects[listId].buildConfigurations as unknown[])
        .map((id) => index.object(id)?.name)
        .filter((name): name is string => typeof name === 'string');

    beginChange(edit);
    operate(edit, `setting ${key}`, () => setSetting(edit, ownerPointer as JsonPointer, names, configuration.name as string, key, value));
    const reason = edit.session.change?.declined;
    endChange(edit);
    if (reason !== undefined) {
        onDecline(reason);
        return text;
    }
    const output = xcprojEditText(edit);
    if (edit.session.gateProblem !== undefined) {
        onDecline(edit.session.gateProblem);
        return text;
    }
    return output;
}

// ── Writing ──────────────────────────────────────────────

/**
 * The text to write: the session's when it reads back as a project, else the input unchanged (and why is logged once and
 * kept for `xcprojEditDeclined`). Per-change checks should leave nothing for the read-back to catch.
 */
export function xcprojEditText(edit: XcprojEdit): string {
    const session = edit.session;
    if (edit.contents === session.input) { return session.input; }
    const read = readProject(edit.contents);
    if (typeof read !== 'string' && read.format === 'xcproj') { return edit.contents; }
    if (session.gateProblem === undefined) {
        session.gateProblem = 'the edited project file no longer reads as a project Xcode opens';
        session.log(`${session.prefix} project.xcproj left unchanged: ${session.gateProblem}`);
    }
    return session.input;
}

/** Why the session's text wasn't written, or undefined. */
export function xcprojEditDeclined(edit: XcprojEdit): string | undefined {
    xcprojEditText(edit);
    return edit.session.gateProblem;
}
