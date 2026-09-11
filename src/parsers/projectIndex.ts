import { execFileSync } from 'child_process';

/** One entry of a project's `objects` dictionary as plutil renders it: strings, lists and dictionaries. */
export interface ProjectObject {
    isa?: string;
    [key: string]: unknown;
}

export interface ProjectIndex {
    objects: Readonly<Record<string, ProjectObject>>;
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

interface Token {
    /** A punctuation character, or `string` for quoted and bare values. */
    type: string;
    value: string;
    start: number;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const PUNCTUATION = new Set(['{', '}', '(', ')', '=', ';', ',']);

/** Where one root `objects` entry sits in the project text. */
export interface ObjectLocation {
    /** The start of the entry's line. */
    startIndex: number;
    /** Just past the entry's `};`, any spaces or tabs after it, and its line break. */
    endIndex: number;
}

/**
 * The keys of the root `objects` dictionary, in the order the OpenStep text defines them. Values are skipped by nesting
 * depth, so ids that reappear as keys further down (a project's TargetAttributes) are never counted.
 */
export function definitionOrder(contents: string): string[] {
    return walkObjects(contents).map((entry) => entry.id);
}

let lastLocatedContents: string | undefined;
let lastLocations = new Map<string, ObjectLocation>();

/** The offsets of one root `objects` entry; undefined when the id isn't an entry or the text can't be walked. */
export function locateObject(contents: string, id: string): ObjectLocation | undefined {
    if (contents !== lastLocatedContents) {
        try {
            lastLocations = new Map(walkObjects(contents).map((entry) => [entry.id, entry.location]));
        } catch {
            lastLocations = new Map();
        }
        lastLocatedContents = contents;
    }
    return lastLocations.get(id);
}

/** Every root `objects` entry with its offsets, in text order; throws where the text doesn't follow the grammar. */
function walkObjects(contents: string): { id: string; location: ObjectLocation }[] {
    const length = contents.length;
    let position = 0;

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
        const start = position;
        const character = contents[position];
        if (PUNCTUATION.has(character)) {
            position++;
            return { type: character, value: character, start };
        }
        if (character === '"') {
            let value = '';
            for (position++; position < length && contents[position] !== '"'; position++) {
                if (contents[position] === '\\') { position++; }
                value += contents[position];
            }
            position++;
            return { type: 'string', value, start };
        }
        // A bare value ends only at whitespace, punctuation or a quote: plutil reads `foo//bar` as one value.
        while (position < length && !WHITESPACE.has(contents[position]) && !PUNCTUATION.has(contents[position]) &&
            contents[position] !== '"') {
            position++;
        }
        return { type: 'string', value: contents.slice(start, position), start };
    };

    const expect = (type: string): Token => {
        const token = next();
        if (!token || token.type !== type) {
            throw new Error(`expected "${type}" at ${token ? token.start : 'the end'}`);
        }
        return token;
    };

    const skipValue = (first: Token | null): number => {
        if (!first) { throw new Error('missing value'); }
        if (first.type === 'string') { return position; }
        if (first.type !== '{' && first.type !== '(') { throw new Error(`unexpected "${first.type}" at ${first.start}`); }
        for (let depth = 1; depth > 0;) {
            const token = next();
            if (!token) { throw new Error('unterminated value'); }
            if (token.type === '{' || token.type === '(') {
                depth++;
            } else if (token.type === '}' || token.type === ')') {
                depth--;
            }
        }
        return position;
    };

    expect('{');
    for (;;) {
        const key = next();
        if (!key || key.type === '}') { return []; }
        expect('=');
        const value = next();
        if (key.type === 'string' && key.value === 'objects' && value?.type === '{') {
            const entries: { id: string; location: ObjectLocation }[] = [];
            for (;;) {
                const objectKey = next();
                if (!objectKey) { throw new Error('unterminated objects dictionary'); }
                if (objectKey.type === '}') { return entries; }
                expect('=');
                const valueEnd = skipValue(next());
                expect(';');
                entries.push({
                    id: objectKey.value,
                    location: { startIndex: lineStart(contents, objectKey.start), endIndex: entryEnd(contents, valueEnd) }
                });
            }
        }
        skipValue(value);
        expect(';');
    }
}

/** The start of `offset`'s line, when only spaces or tabs precede it there. */
function lineStart(contents: string, offset: number): number {
    let start = offset;
    while (start > 0 && (contents[start - 1] === ' ' || contents[start - 1] === '\t')) { start--; }
    return start;
}

function entryEnd(contents: string, valueEnd: number): number {
    let index = valueEnd;
    if (contents[index] === ';') { index += 1; }
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
