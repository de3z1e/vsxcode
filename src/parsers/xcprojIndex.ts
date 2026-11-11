/**
 * Lowers Xcode's JSON project file (`project.xcproj`) into the object graph VSXcode reads from a `project.pbxproj`.
 *
 * It rebuilds the PBX objects Xcode's own `xcodebuild -convert-project pbxproj` writes, with the isa names, fields and
 * orders VSXcode's parsers read. A file Xcode would refuse to open lowers to a problem instead; parts VSXcode doesn't
 * read (platform filters, file types, attributes, …) aren't checked.
 *
 * Objects the file gives an `id` keep it. Every other object gets a synthetic id: the first 24 hex digits of a SHA-1 over
 * its place in the project (its kind, its parent's key, and its path or name, lower-cased), so ids survive re-reads,
 * edits elsewhere in the file and letter-case fixes; renaming or moving an element gives it and everything under it new
 * ids. Objects are listed by isa and then id, the order Xcode writes a pbxproj in.
 */
import { createHash } from 'crypto';

import { nodeAt, parseJson5Text, valueOf } from './xcprojText';
import type { Json5Node } from './xcprojText';
import type { ProjectObject } from './projectIndex';

export type JsonPointer = readonly (string | number)[];

/** The lowered graph: what plutil's reading of a pbxproj gives, plus each object's place in the JSON. */
export interface LoweredProject {
    objects: Record<string, ProjectObject>;
    rootObject: string;
    /** Every object id: grouped by isa name, ids ascending within each, as Xcode writes a pbxproj. */
    order: string[];
    /** The JSON pointer of each object that stands for a node of the file: the project, the main group, file-tree elements, targets and phases. */
    sources: Map<string, JsonPointer>;
}

/** Why Xcode would refuse the file. */
export interface XcprojProblem {
    problem: string;
}

type Json = Record<string, unknown>;

class Refusal extends Error {}

function refuse(message: string): never {
    throw new Refusal(message);
}

// ── Values ───────────────────────────────────────────────

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A table entry by own key only, so a kind spelled like `constructor` finds nothing. */
function own<T>(table: Record<string, T>, key: unknown): T | undefined {
    return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

function asObject(value: unknown, what: string): Json {
    if (!isObject(value)) { refuse(`${what} isn't an object`); }
    return value;
}

function asString(value: unknown, what: string): string {
    if (typeof value !== 'string') { refuse(`${what} isn't a string`); }
    return value;
}

function asList(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) { refuse(`${what} isn't a list`); }
    return value;
}

function optionalString(json: Json, key: string, what: string): string | undefined {
    return json[key] === undefined ? undefined : asString(json[key], `${what} "${key}"`);
}

function optionalList(json: Json, key: string, what: string): unknown[] {
    return json[key] === undefined ? [] : asList(json[key], `${what} "${key}"`);
}

function stringList(value: unknown, what: string): string[] {
    return asList(value, what).map((entry, index) => asString(entry, `${what} item ${index}`));
}

/**
 * A name as Xcode compares target, build phase and package names: canonically equivalent spellings (`é` precomposed or
 * as `e` plus a combining accent) are the same name. Element names in a tree reference compare exactly instead.
 */
function nameKey(name: string): string {
    return name.normalize('NFC');
}

/** A list Xcode decodes as a set of names, which it refuses when two entries are the same name. */
function nameSet(value: unknown, what: string): string[] {
    const names = stringList(value, what);
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(nameKey(name))) { refuse(`${what} lists "${name}" twice`); }
        seen.add(nameKey(name));
    }
    return names;
}

/** Code-point order, which Xcode uses for build setting keys and, after NFD, for build phase members. */
export function compareCodePoints(a: string, b: string): number {
    const left = Array.from(a);
    const right = Array.from(b);
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const difference = (left[index].codePointAt(0) ?? 0) - (right[index].codePointAt(0) ?? 0);
        if (difference !== 0) { return difference; }
    }
    return left.length - right.length;
}

/** The last component of a path, as Swift gives it: trailing slashes ignored, empty for an empty path. */
export function lastPathComponent(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    if (trimmed === '') { return path === '' ? '' : '/'; }
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

// ── Paths ────────────────────────────────────────────────

const BASES: Record<string, string> = {
    PROJECT: 'SOURCE_ROOT',
    DEVELOPER: 'DEVELOPER_DIR',
    PRODUCTS: 'BUILT_PRODUCTS_DIR',
    SDK: 'SDKROOT'
};

export interface ParsedPath {
    sourceTree: string;
    /** Relative to the base, or absolute for `<absolute>`; empty when the element has no path of its own. */
    path: string;
}

/** A `path` value as parsePath reads it, or undefined where Xcode would refuse it. */
export function readPath(raw: string): ParsedPath | undefined {
    try {
        return parsePath(raw, 'the path');
    } catch (error) {
        if (error instanceof Refusal) { return undefined; }
        throw error;
    }
}

/**
 * The `path` value that reads back as `path` under `sourceTree`, as Xcode's encoder writes it: a base prefix and the raw
 * path, or a plain path with `\` and `<` escaped. A relative path that would start with `~`, which Xcode reads as absolute
 * and refuses after any base but `<absolute>`, is written `./~…`.
 */
export function formatPath(sourceTree: string, path: string): string {
    const relative = path.startsWith('~') ? `./${path}` : path;
    const escapePlain = (text: string): string => text.replace(/[\\<]/g, (character) => `\\${character}`);
    switch (sourceTree) {
        case '<group>': return escapePlain(relative);
        case '<absolute>': return escapePlain(path);
        default: {
            const base = Object.keys(BASES).find((variable) => BASES[variable] === sourceTree);
            const prefix = base !== undefined ? `<${base}>` : `<USER:${sourceTree.replace(/[\\>]/g, (character) => `\\${character}`)}>`;
            return `${prefix}/${relative}`;
        }
    }
}

/**
 * A `path` value as Xcode's FilePath reads it: `<PROJECT>/`, `<DEVELOPER>/`, `<PRODUCTS>/`, `<SDK>/` or `<USER:VAR>/`
 * before a raw path, or a plain path relative to the group (absolute when it starts with `/`) in which a backslash escapes
 * `\` and `<`. A path that starts with `/` or `~` must be absolute, and only a plain one may be.
 */
function parsePath(raw: string, what: string): ParsedPath {
    let sourceTree: string;
    let path: string;
    let absoluteBase = false;
    if (raw.startsWith('<USER:')) {
        let variable = '';
        let index = '<USER:'.length;
        for (;;) {
            if (index >= raw.length) { refuse(`${what}: the path base in "${raw}" isn't closed`); }
            const character = raw[index];
            if (character === '\\') {
                const next = raw[index + 1];
                if (next !== '>' && next !== '\\') { refuse(`${what}: invalid escape in the path base of "${raw}"`); }
                variable += next;
                index += 2;
                continue;
            }
            if (character === '>') { index += 1; break; }
            variable += character;
            index += 1;
        }
        if (raw[index] !== '/') { refuse(`${what}: the path base in "${raw}" isn't followed by /`); }
        sourceTree = variable;
        path = raw.slice(index + 1);
    } else if (raw.startsWith('<')) {
        const close = raw.indexOf('>/');
        if (close === -1) { refuse(`${what}: the path base in "${raw}" isn't closed`); }
        const variable = raw.slice(1, close);
        const tree = own(BASES, variable);
        if (tree === undefined) { refuse(`${what}: unknown path base <${variable}>`); }
        sourceTree = tree;
        path = raw.slice(close + 2);
    } else {
        absoluteBase = raw.startsWith('/');
        sourceTree = absoluteBase ? '<absolute>' : '<group>';
        path = unescapePlainPath(raw, what);
    }
    if ((path.startsWith('/') || path.startsWith('~')) !== absoluteBase) {
        refuse(`${what}: "${raw}" disagrees with its base about being absolute`);
    }
    return { sourceTree, path };
}

function unescapePlainPath(raw: string, what: string): string {
    let out = '';
    for (let index = 0; index < raw.length; index++) {
        const character = raw[index];
        if (character === '<') { refuse(`${what}: unescaped "<" in "${raw}"`); }
        if (character === '\\') {
            const next = raw[index + 1];
            if (next !== '<' && next !== '\\') { refuse(`${what}: invalid escape in "${raw}"`); }
            out += next;
            index += 1;
            continue;
        }
        out += character;
    }
    return out;
}

// ── References ───────────────────────────────────────────

export type ReferenceComponent = { kind: 'current' } | { kind: 'parent' } | { kind: 'child'; name: string };
export type Reference = { id: string } | { components: ReferenceComponent[] };
type Component = ReferenceComponent;

/**
 * A tree or phase reference: `id:<id>`, a name path split on `/`, or an array of components, each `.`, `..`, a child
 * name without `/`, or `{ "name": … }` holding any name.
 */
function parseReference(value: unknown, what: string): Reference {
    if (typeof value === 'string') {
        if (value.startsWith('id:')) { return { id: value.slice(3) }; }
        return { components: value.split('/').map(stringComponent) };
    }
    if (Array.isArray(value)) {
        return {
            components: value.map((entry, index) => {
                if (typeof entry === 'string') {
                    if (entry.includes('/')) { refuse(`${what}: component ${index} holds "/" outside { "name": … }`); }
                    return stringComponent(entry);
                }
                const name = asString(asObject(entry, `${what} component ${index}`).name, `${what} component ${index} "name"`);
                return { kind: 'child', name } as Component;
            })
        };
    }
    return refuse(`${what} isn't a reference`);
}

function stringComponent(text: string): Component {
    if (text === '.') { return { kind: 'current' }; }
    if (text === '..') { return { kind: 'parent' }; }
    return { kind: 'child', name: text };
}

/** A reference as the text it stands for, components joined with `/`. */
export function describeReference(reference: Reference): string {
    return describe(reference);
}

/** A tree reference read by the grammar Xcode's decoder accepts, or why it can't be one. */
export function readReference(value: unknown): { reference: Reference } | { problem: string } {
    try {
        return { reference: parseReference(value, 'the reference') };
    } catch (error) {
        if (error instanceof Refusal) { return { problem: error.message }; }
        throw error;
    }
}

/**
 * The value Xcode's encoder writes for a name path (`GroupTreeReference.encoding`): the names joined with `/` when each
 * is lossless (no `/`, not `.` or `..`) and the result doesn't start with `id:`, which would read as an id; else an
 * array, with `{ "name": … }` for each name that isn't lossless.
 */
export function encodeReference(names: readonly string[]): string | Array<string | { name: string }> {
    const lossless = (name: string): boolean => !name.includes('/') && name !== '.' && name !== '..';
    const joined = names.join('/');
    if (names.length > 0 && names.every(lossless) && !joined.startsWith('id:')) { return joined; }
    return names.map((name) => (lossless(name) ? name : { name }));
}

/** A node a tree reference can walk: its display name, the element holding it, and its children. */
export interface ReferenceNode<N> {
    displayName: string;
    parent?: N;
    children: readonly N[];
}

/**
 * The node a tree reference names, walked from `origin` (undefined for the top level, whose nodes are `topLevel`): `.`
 * stays, `..` moves to the parent of the node reached so far and may not climb above `origin`, and a name must match
 * exactly one child's display name, compared exactly. An `id:` reference asks `byId`. Else why it names nothing.
 */
export function resolveReference<N extends ReferenceNode<N>>(
    reference: Reference, origin: N | undefined, topLevel: readonly N[], byId: (id: string) => N | undefined
): { node: N } | { problem: string } {
    if ('id' in reference) {
        const node = byId(reference.id);
        return node ? { node } : { problem: `"id:${reference.id}" names no element` };
    }
    let current = origin;
    for (const component of reference.components) {
        if (component.kind === 'current') { continue; }
        if (component.kind === 'parent') {
            if (current === origin) { return { problem: `"${describe(reference)}" climbs above where it starts` }; }
            current = current?.parent;
            continue;
        }
        const matches = (current ? current.children : topLevel).filter((node) => node.displayName === component.name);
        if (matches.length !== 1) {
            return { problem: `"${describe(reference)}" ${matches.length === 0 ? 'names nothing' : 'is ambiguous'}` };
        }
        current = matches[0];
    }
    if (current === origin || current === undefined) { return { problem: `"${describe(reference)}" names nothing` }; }
    return { node: current };
}

function describe(reference: Reference): string {
    if ('id' in reference) { return `id:${reference.id}`; }
    return reference.components.map((component) => component.kind === 'child' ? component.name : component.kind === 'current' ? '.' : '..').join('/');
}

/** The child names of a phase reference; `.` and `..` name no phase. */
function childNames(reference: { components: Component[] }, what: string): string[] {
    return reference.components.map((component) => {
        if (component.kind !== 'child') { refuse(`${what}: "${describe(reference)}" names no build phase`); }
        return component.name;
    });
}

// ── Model ────────────────────────────────────────────────

export type ElementKind = 'file-reference' | 'group' | 'folder' | 'variant-group' | 'version-group';

const ELEMENT_TAGS: Record<ElementKind, string> = {
    'file-reference': 'f', 'group': 'g', 'folder': 'd', 'variant-group': 'v', 'version-group': 'm'
};

/** Whether a file-tree `kind` is one Xcode knows (absent means a file reference). */
export function isElementKind(kind: unknown): kind is ElementKind {
    return own(ELEMENT_TAGS, kind) !== undefined;
}

/**
 * What an element's own fields give: the name references and phase order use (the explicit `name`, else the last path
 * component; a localized child is named after its `<lang>.lproj` folder), the `name` Xcode's lowering writes, and the
 * identity its key uses (kind tag and the lower-cased path, else name). File references and folders have no `name`.
 */
export function elementNaming(
    kind: ElementKind, rawPath: string, parsedPath: ParsedPath, name: string | undefined, inVariantGroup: boolean
): { displayName: string; loweredName?: string; identity: string } {
    const explicitName = kind === 'file-reference' || kind === 'folder' ? undefined : name;
    const ownName = lastPathComponent(parsedPath.path);
    let displayName = explicitName ?? ownName;
    let loweredName = explicitName ?? (parsedPath.path.includes('/') ? ownName : undefined);
    if (inVariantGroup) {
        const languageFolder = parsedPath.path.split('/').find((component) => component.endsWith('.lproj'));
        if (languageFolder) {
            loweredName = languageFolder.slice(0, -'.lproj'.length);
            displayName = loweredName;
        }
    }
    return { displayName, loweredName, identity: `${ELEMENT_TAGS[kind]}:${(rawPath || explicitName || '').toLowerCase()}` };
}

/** A child's key: its parent's key, its identity, and `#n` when n earlier siblings share that identity. */
export function childKey(parentKey: string, identity: string, ordinal: number): string {
    return `${parentKey}/${identity}${ordinal > 0 ? `#${ordinal}` : ''}`;
}

/** The synthetic id for a key: the first 24 upper-case hex digits of its SHA-1, rehashed with `#collision<n>` while taken. */
export function syntheticId(key: string, taken: (id: string) => boolean): string {
    for (let attempt = 0; ; attempt++) {
        const candidate = createHash('sha1').update(attempt === 0 ? key : `${key}#collision${attempt}`).digest('hex').slice(0, 24).toUpperCase();
        if (!taken(candidate)) { return candidate; }
    }
}

interface Element {
    id: string;
    key: string;
    kind: ElementKind;
    json: Json;
    pointer: JsonPointer;
    parsedPath: ParsedPath;
    /** The name references and phase order use: the explicit `name`, else the last path component. */
    displayName: string;
    /** The `name` Xcode's lowering writes, if any. */
    loweredName?: string;
    /** The group, variant group or version group holding it; undefined at the top level. */
    parent?: Element;
    children: Element[];
}

const STANDARD_PHASES: Record<string, string> = {
    'compile-sources': 'PBXSourcesBuildPhase',
    'frameworks': 'PBXFrameworksBuildPhase',
    'resources': 'PBXResourcesBuildPhase',
    'headers': 'PBXHeadersBuildPhase',
    'rez': 'PBXRezBuildPhase',
    'java-archive': 'PBXJavaArchiveBuildPhase',
    'apple-script': 'PBXAppleScriptBuildPhase'
};
/** Phases a reference names by kind and name together; the others by kind alone. */
const NAMED_PHASES: Record<string, string> = {
    'copy': 'PBXCopyFilesBuildPhase',
    'script': 'PBXShellScriptBuildPhase'
};

interface Member {
    name: string;
    buildFileId: string;
    fileRef?: string;
    productRef?: string;
    compilerFlags?: string;
}

interface Phase {
    id: string;
    key: string;
    kind: string;
    name?: string;
    isa: string;
    pointer: JsonPointer;
    target: Target;
    /** The phase's place in its target's `build-phases`. */
    index: number;
    packageMembers: Member[];
    fileMembers: Member[];
}

interface Target {
    id: string;
    key: string;
    name: string;
    kind: 'native' | 'aggregate' | 'external-build-system';
    json: Json;
    pointer: JsonPointer;
    /** The target's place in the project's `targets`. */
    index: number;
    phases: Phase[];
}

class Lowering {
    /** Null prototype, here and wherever the file supplies the keys, so a key spelled `__proto__` stays an ordinary entry. */
    private readonly objects: Record<string, ProjectObject> = Object.create(null);
    private readonly sources = new Map<string, JsonPointer>();
    private readonly taken = new Set<string>();
    /** What an `id:` reference names: the first element, or phase, the file gives that id, whichever id it was lowered with. */
    private readonly elementsByExplicitId = new Map<string, Element>();
    private readonly phasesByExplicitId = new Map<string, Phase>();
    private readonly targets: Target[] = [];
    /** Keyed by `nameKey`. */
    private readonly targetsByName = new Map<string, Target>();
    private readonly allElements: Element[] = [];
    private topLevel: Element[] = [];

    constructor(private readonly doc: Json) {}

    lower(): LoweredProject {
        const doc = this.doc;
        const capabilities = optionalList(doc, 'required-capabilities', 'the project');
        if (capabilities.length > 0) {
            refuse(`the project requires capabilities VSXcode doesn't know: ${capabilities.map(String).join(', ')}`);
        }
        const files = asList(doc.files, 'the project "files"');
        const defaultConfiguration = asString(doc['default-configuration'], 'the project "default-configuration"');
        const localizations = asObject(doc.localizations, 'the project "localizations"');
        const development = asString(localizations.development, 'the project "localizations.development"');
        const supported = localizations.supported === undefined ? [] : nameSet(localizations.supported, 'the project "localizations.supported"');

        this.reserveExplicitIds(doc);
        const projectId = this.id(optionalString(doc, 'id', 'the project'), 'project');
        const mainGroupId = this.id(optionalString(doc, 'root-group-debug-id', 'the project'), 'main');
        this.topLevel = this.elements(files, ['files'], 'main', undefined);

        this.readTargets(asList(doc.targets ?? [], 'the project "targets"'));
        this.collectMembers();

        const packageIds = this.lowerPackages(optionalList(doc, 'packages', 'the project'));
        this.lowerTargets(packageIds, projectId);
        this.lowerElements();

        const configurations = optionalList(doc, 'configurations', 'the project');
        const projectList = this.lowerConfigurationList(
            'project/configs', optionalString(doc, 'configuration-list-debug-id', 'the project'),
            configurations, [], defaultConfiguration, doc['build-settings'], 'the project');
        this.lowerTargetConfigurations(configurations, defaultConfiguration);

        const productsGroup = doc['products-group'] === undefined ? 'Products' : doc['products-group'];
        const productRefGroup = this.resolveElement(parseReference(productsGroup, 'the project "products-group"'), undefined, 'the project "products-group"');

        this.objects[mainGroupId] = { isa: 'PBXGroup', children: this.topLevel.map((element) => element.id), sourceTree: '<group>' };
        this.sources.set(mainGroupId, ['files']);
        const targetAttributes: Record<string, unknown> = Object.create(null);
        for (const target of this.targets) {
            if (target.json['test-host-target'] === undefined) { continue; }
            targetAttributes[target.id] = { TestTargetID: this.targetNamed(target.json['test-host-target'], `target ${target.name} "test-host-target"`).id };
        }
        const project: ProjectObject = {
            isa: 'PBXProject',
            attributes: { TargetAttributes: targetAttributes },
            buildConfigurationList: projectList,
            developmentRegion: development,
            knownRegions: [...new Set([development, ...supported])].sort(compareCodePoints),
            mainGroup: mainGroupId,
            packageReferences: packageIds.order,
            productRefGroup: productRefGroup.id,
            projectDirPath: '',
            projectRoot: '',
            targets: this.targets.map((target) => target.id)
        };
        const projectReferences = this.lowerProjectReferences();
        if (projectReferences.length > 0) { project.projectReferences = projectReferences; }
        this.objects[projectId] = project;
        this.sources.set(projectId, []);

        const order = Object.keys(this.objects).sort((a, b) =>
            compareCodePoints(this.objects[a].isa ?? '', this.objects[b].isa ?? '') || compareCodePoints(a, b));
        return { objects: this.objects, rootObject: projectId, order, sources: this.sources };
    }

    // ── Ids

    private readonly reserved = new Set<string>();

    /** Every explicit id in the file, so no synthetic id takes one. */
    private reserveExplicitIds(value: unknown): void {
        if (Array.isArray(value)) {
            value.forEach((entry) => this.reserveExplicitIds(entry));
        } else if (isObject(value)) {
            for (const key of Object.keys(value)) {
                const entry = value[key];
                if ((key === 'id' || key === 'root-group-debug-id' || key === 'configuration-list-debug-id') && typeof entry === 'string') {
                    this.reserved.add(entry);
                } else {
                    this.reserveExplicitIds(entry);
                }
            }
        }
    }

    /** The explicit id when the file gives one not already taken, else the synthetic id for `key`. */
    private id(explicit: string | undefined, key: string): string {
        if (explicit !== undefined && !this.taken.has(explicit)) {
            this.taken.add(explicit);
            return explicit;
        }
        const id = syntheticId(key, (candidate) => this.taken.has(candidate) || this.reserved.has(candidate));
        this.taken.add(id);
        return id;
    }

    // ── The file tree

    private elements(list: unknown[], pointer: JsonPointer, parentKey: string, parent: Element | undefined): Element[] {
        const ordinals = new Map<string, number>();
        return list.map((entry, index) => {
            const at = [...pointer, index];
            const json = asObject(entry, `files entry ${at.join('/')}`);
            const kind = json.kind ?? 'file-reference';
            if (!isElementKind(kind)) { refuse(`unknown file-tree kind ${JSON.stringify(json.kind)} at ${at.join('/')}`); }
            return this.element(json, kind, at, parentKey, ordinals, parent, false);
        });
    }

    private element(
        json: Json, kind: ElementKind, pointer: JsonPointer, parentKey: string, ordinals: Map<string, number>,
        parent: Element | undefined, inVariantGroup: boolean
    ): Element {
        const what = `the element at ${pointer.join('/')}`;
        const rawPath = json.path === undefined ? '' : asString(json.path, `${what} "path"`);
        const name = kind === 'file-reference' || kind === 'folder' ? undefined : optionalString(json, 'name', what);
        const parsedPath = parsePath(rawPath, what);
        const { displayName, loweredName, identity } = elementNaming(kind, rawPath, parsedPath, name, inVariantGroup);
        const ordinal = ordinals.get(identity) ?? 0;
        ordinals.set(identity, ordinal + 1);
        const key = childKey(parentKey, identity, ordinal);
        const explicitId = optionalString(json, 'id', what);
        const id = this.id(explicitId, key);

        const element: Element = { id, key, kind, json, pointer, parsedPath, displayName, loweredName, parent, children: [] };
        if (explicitId !== undefined && !this.elementsByExplicitId.has(explicitId)) { this.elementsByExplicitId.set(explicitId, element); }
        this.allElements.push(element);
        this.sources.set(id, pointer);

        if (kind === 'group') {
            element.children = this.elements(optionalList(json, 'children', what), [...pointer, 'children'], key, element);
        } else if (kind === 'variant-group' || kind === 'version-group') {
            const childOrdinals = new Map<string, number>();
            element.children = optionalList(json, 'children', what).map((entry, index) => {
                const at = [...pointer, 'children', index];
                return this.element(asObject(entry, `${what} child ${index}`), 'file-reference', at, key, childOrdinals, element, kind === 'variant-group');
            });
        }
        return element;
    }

    /**
     * The element a tree reference names: by id, or component by component from `origin` (undefined for the top-level
     * list): `.` stays, `..` moves to the parent of the element reached so far and may not climb above `origin`, and a
     * name must match exactly one child.
     */
    private resolveElement(reference: Reference, origin: Element | undefined, what: string): Element {
        const resolved = resolveReference(reference, origin, this.topLevel, (id) => this.elementsByExplicitId.get(id));
        if ('problem' in resolved) { refuse(`${what}: ${resolved.problem}`); }
        return resolved.node;
    }

    // ── Targets and phases

    private readTargets(list: unknown[]): void {
        list.forEach((entry, index) => {
            const pointer = ['targets', index];
            const json = asObject(entry, `target ${index}`);
            const name = asString(json.name, `target ${index} "name"`);
            const explicitId = asString(json.id, `target ${name} "id"`);
            if (this.targetsByName.has(nameKey(name))) { refuse(`target names must be unique, but "${name}" is used twice`); }
            const kind = (json.kind ?? 'native') as Target['kind'];
            if (!['native', 'aggregate', 'external-build-system'].includes(kind)) { refuse(`target ${name}: unknown kind ${JSON.stringify(json.kind)}`); }
            const key = `target:${explicitId}`;
            const target: Target = { id: this.id(explicitId, key), key, name, kind, json, pointer, index, phases: [] };
            this.targets.push(target);
            this.targetsByName.set(nameKey(name), target);
            this.sources.set(target.id, pointer);
        });
        for (const target of this.targets) {
            const ordinals = new Map<string, number>();
            target.phases = optionalList(target.json, 'build-phases', `target ${target.name}`).map((entry, index) => {
                const pointer = [...target.pointer, 'build-phases', index];
                const what = `target ${target.name} build phase ${index}`;
                const json = typeof entry === 'string' ? undefined : asObject(entry, what);
                const kind = typeof entry === 'string' ? entry : asString(json?.kind, `${what} "kind"`);
                const isa = own(STANDARD_PHASES, kind) ?? own(NAMED_PHASES, kind);
                if (!isa) { refuse(`${what}: unknown kind "${kind}"`); }
                if (!json && own(NAMED_PHASES, kind)) { refuse(`${what}: a ${kind} phase needs its properties`); }
                const name = json ? optionalString(json, 'name', what) : undefined;
                const identity = `${kind}:${name ?? ''}`;
                const ordinal = ordinals.get(identity) ?? 0;
                ordinals.set(identity, ordinal + 1);
                const key = `${target.key}/phase:${identity}${ordinal > 0 ? `#${ordinal}` : ''}`;
                const explicitId = json ? optionalString(json, 'id', what) : undefined;
                const phase: Phase = { id: this.id(explicitId, key), key, kind, name, isa, pointer, target, index, packageMembers: [], fileMembers: [] };
                if (explicitId !== undefined && !this.phasesByExplicitId.has(explicitId)) { this.phasesByExplicitId.set(explicitId, phase); }
                this.sources.set(phase.id, pointer);
                return phase;
            });
        }
    }

    /** The target a name refers to, by `nameKey`; refused when none has it. */
    private targetNamed(value: unknown, what: string): Target {
        const name = asString(value, what);
        const target = this.targetsByName.get(nameKey(name));
        if (!target) { refuse(`${what}: "${name}" names no target`); }
        return target;
    }

    /** A phase of `target` named by kind (and name, for copy and script phases), as Xcode resolves them. */
    private phaseOf(target: Target, names: string[], what: string): Phase {
        const [kind, name] = names;
        const standard = own(STANDARD_PHASES, kind) !== undefined;
        if (names.length < 1 || names.length > 2 || (!standard && own(NAMED_PHASES, kind) === undefined)) {
            refuse(`${what}: "${names.join('/')}" names no build phase`);
        }
        if (standard ? names.length !== 1 : names.length !== 2) { refuse(`${what}: "${target.name}/${names.join('/')}" names no build phase`); }
        const matches = target.phases.filter((phase) => phase.kind === kind &&
            (standard || (phase.name !== undefined && nameKey(phase.name) === nameKey(name))));
        if (matches.length !== 1) {
            refuse(`${what}: "${target.name}/${names.join('/')}" ${matches.length === 0 ? 'names no build phase' : 'is ambiguous'}`);
        }
        return matches[0];
    }

    /** The phase an `id:` reference names. */
    private phaseWithId(id: string, what: string): Phase {
        const phase = this.phasesByExplicitId.get(id);
        if (!phase) { refuse(`${what}: "id:${id}" names no build phase`); }
        return phase;
    }

    /** A project-level phase reference: `id:<id>`, or the target's name and then the phase. */
    private projectPhase(value: unknown, what: string): Phase {
        const reference = parseReference(value, what);
        if ('id' in reference) { return this.phaseWithId(reference.id, what); }
        const [targetName, ...rest] = childNames(reference, what);
        const target = this.targetsByName.get(nameKey(targetName));
        if (!target) { refuse(`${what}: "${describe(reference)}" names no target`); }
        return this.phaseOf(target, rest, what);
    }

    /** A target-level phase reference: `id:<id>`, or the phase's kind (and name). */
    private targetPhase(target: Target, value: unknown, what: string): Phase {
        const reference = parseReference(value, what);
        if ('id' in reference) { return this.phaseWithId(reference.id, what); }
        return this.phaseOf(target, childNames(reference, what), what);
    }

    /** Build files from every element's membership, in tree order, and from each target's package products. */
    private collectMembers(): void {
        for (const element of this.allElements) {
            if (element.kind === 'group' || element.kind === 'folder') { continue; }
            const what = `the element at ${element.pointer.join('/')}`;
            const ordinals = new Map<string, number>();
            optionalList(element.json, 'target-membership', what).forEach((entry, index) => {
                const at = `${what} membership ${index}`;
                const json = isObject(entry) ? entry : undefined;
                // Xcode refuses a bare array here ("Expected an instance of dictionary"); an array reference goes in `build-phase`.
                if (!json && typeof entry !== 'string') { refuse(`${at} isn't a phase reference or an object`); }
                const phase = this.projectPhase(json ? json['build-phase'] : entry, at);
                const ordinal = ordinals.get(phase.id) ?? 0;
                ordinals.set(phase.id, ordinal + 1);
                const buildFileId = this.id(json ? optionalString(json, 'id', at) : undefined, `${element.key}>${phase.key}${ordinal > 0 ? `#${ordinal}` : ''}`);
                const compilerFlags = json ? optionalString(json, 'arguments', at) : undefined;
                phase.fileMembers.push({ name: element.displayName, buildFileId, fileRef: element.id, compilerFlags });
            });
        }
    }

    // ── Packages

    /** The package references, and each package's id by `nameKey` of its name; null for a name two packages share. */
    private lowerPackages(list: unknown[]): { order: string[]; byName: Map<string, string | null> } {
        const order: string[] = [];
        const byName = new Map<string, string | null>();
        const named = (name: string, id: string): void => {
            byName.set(nameKey(name), byName.has(nameKey(name)) ? null : id);
        };
        list.forEach((entry, index) => {
            const what = `package ${index}`;
            const json = asObject(entry, what);
            const kind = asString(json.kind, `${what} "kind"`);
            if (kind === 'remote') {
                const repositoryURL = asString(json.repository, `${what} "repository"`);
                const id = this.id(undefined, `package:${repositoryURL.toLowerCase()}`);
                const object: ProjectObject = { isa: 'XCRemoteSwiftPackageReference', repositoryURL };
                if (json.version !== undefined) { object.requirement = requirement(asObject(json.version, `${what} "version"`), what); }
                this.objects[id] = object;
                order.push(id);
                named(lastPathComponent(repositoryURL).replace(/\.git$/, ''), id);
            } else if (kind === 'local') {
                const relativePath = asString(json.path, `${what} "path"`);
                const id = this.id(undefined, `package:${relativePath.toLowerCase()}`);
                this.objects[id] = { isa: 'XCLocalSwiftPackageReference', relativePath };
                order.push(id);
                named(lastPathComponent(relativePath), id);
            } else {
                refuse(`${what}: unknown kind "${kind}"`);
            }
        });
        return { order, byName };
    }

    private lowerTargets(packages: { byName: Map<string, string | null> }, projectId: string): void {
        for (const target of this.targets) {
            const what = `target ${target.name}`;
            const json = target.json;
            const productDependencies: string[] = [];
            const productOrdinals = new Map<string, number>();
            optionalList(json, 'package-product-members', what).forEach((entry, index) => {
                const at = `${what} package product ${index}`;
                const member = asObject(entry, at);
                const identity = `${member.package ?? ''}/${member['product-name']}`;
                const ordinal = productOrdinals.get(identity) ?? 0;
                productOrdinals.set(identity, ordinal + 1);
                const productKey = `${target.key}/product:${identity}${ordinal > 0 ? `#${ordinal}` : ''}`;
                const { id: productId, name: productName } = this.packageProduct(member, productKey, packages, at);
                productDependencies.push(productId);
                const buildFile = asObject(member['build-phase'], `${at} "build-phase"`);
                const phase = this.targetPhase(target, buildFile['build-phase'], `${at} build phase`);
                const buildFileId = this.id(optionalString(buildFile, 'id', at), `${productKey}>${phase.key}`);
                phase.packageMembers.push({ name: productName, buildFileId, productRef: productId });
            });

            const dependencies = optionalList(json, 'dependencies', what).map((entry, index) => this.dependency(target, entry, index, projectId, packages));
            const folders = this.allElements
                .filter((element) => element.kind === 'folder' &&
                    this.folderTargets(element).includes(target))
                .map((element) => element.id);

            for (const phase of target.phases) {
                // Xcode lists a phase's files by name, NFD and code point, keeping package products ahead of files on a tie.
                const members = [...phase.packageMembers, ...phase.fileMembers]
                    .map((member, position) => ({ member, position, sortKey: member.name.normalize('NFD') }))
                    .sort((a, b) => compareCodePoints(a.sortKey, b.sortKey) || a.position - b.position)
                    .map(({ member }) => member);
                for (const member of members) {
                    const buildFile: ProjectObject = { isa: 'PBXBuildFile' };
                    if (member.fileRef !== undefined) { buildFile.fileRef = member.fileRef; }
                    if (member.productRef !== undefined) { buildFile.productRef = member.productRef; }
                    if (member.compilerFlags !== undefined) { buildFile.settings = { COMPILER_FLAGS: member.compilerFlags }; }
                    this.objects[member.buildFileId] = buildFile;
                }
                const object: ProjectObject = { isa: phase.isa, files: members.map((member) => member.buildFileId) };
                if (phase.name !== undefined) { object.name = phase.name; }
                this.objects[phase.id] = object;
            }

            const object: ProjectObject = {
                isa: target.kind === 'native' ? 'PBXNativeTarget' : target.kind === 'aggregate' ? 'PBXAggregateTarget' : 'PBXLegacyTarget',
                name: target.name,
                productName: target.name
            };
            // Xcode writes no phase list for an external-build-system target that has none.
            if (target.kind !== 'external-build-system' || target.phases.length > 0) { object.buildPhases = target.phases.map((phase) => phase.id); }
            if (dependencies.length > 0) { object.dependencies = dependencies; }
            if (target.kind === 'native') {
                const abbreviated = optionalString(json, 'product-type', what);
                const productType = abbreviated !== undefined ? `com.apple.product-type.${abbreviated}` : optionalString(json, 'full-product-type', what);
                if (productType !== undefined) { object.productType = productType; }
                if (json.product !== undefined) {
                    object.productReference = this.resolveElement(parseReference(json.product, `${what} "product"`), undefined, `${what} "product"`).id;
                }
                if (productDependencies.length > 0) { object.packageProductDependencies = productDependencies; }
                if (folders.length > 0) { object.fileSystemSynchronizedGroups = folders; }
            } else if (target.kind === 'external-build-system') {
                object.buildToolPath = asString(json['build-tool-path'], `${what} "build-tool-path"`);
                object.buildArgumentsString = optionalString(json, 'build-tool-arguments', what) ?? '';
                const workingDirectory = optionalString(json, 'build-tool-working-directory', what);
                if (workingDirectory !== undefined) { object.buildWorkingDirectory = workingDirectory; }
                object.passBuildSettingsInEnvironment = json['pass-build-settings-in-environment'] === false ? '0' : '1';
            }
            this.objects[target.id] = object;
        }
    }

    /**
     * A package product a target uses, as a member of one of its phases or as a dependency, lowered to an
     * XCSwiftPackageProductDependency: `product-name`, which Xcode writes as `plugin:<name>` for a build tool plugin,
     * and the package its optional `package` names. Returns the object's id and the product's name.
     */
    private packageProduct(json: Json, key: string, packages: { byName: Map<string, string | null> }, what: string): { id: string; name: string } {
        const name = asString(json['product-name'], `${what} "product-name"`);
        const type = json['product-type'] ?? 'other';
        if (type !== 'other' && type !== 'build-tool-plugin') { refuse(`${what}: unknown product type ${JSON.stringify(type)}`); }
        const packageName = optionalString(json, 'package', what);
        const packageId = packageName === undefined ? undefined : packages.byName.get(nameKey(packageName));
        if (packageName !== undefined && packageId === undefined) { refuse(`${what}: package "${packageName}" names no package`); }
        if (packageId === null) { refuse(`${what}: package "${packageName}" names more than one package`); }
        const id = this.id(optionalString(json, 'id', what), key);
        const product: ProjectObject = { isa: 'XCSwiftPackageProductDependency', productName: type === 'build-tool-plugin' ? `plugin:${name}` : name };
        if (packageId !== undefined) { product.package = packageId; }
        this.objects[id] = product;
        return { id, name };
    }

    private dependency(target: Target, entry: unknown, index: number, projectId: string, packages: { byName: Map<string, string | null> }): string {
        const what = `target ${target.name} dependency ${index}`;
        const key = `${target.key}/dep:${index}`;
        const json = typeof entry === 'string' ? { target: entry } : asObject(entry, what);
        const kind = json.kind ?? 'localTarget';
        const dependencyId = this.id(undefined, key);
        const proxyId = this.id(undefined, `${key}/proxy`);
        if (kind === 'localTarget') {
            const other = this.targetNamed(json.target, `${what} "target"`);
            this.objects[proxyId] = { isa: 'PBXContainerItemProxy', containerPortal: projectId, proxyType: '1', remoteGlobalIDString: other.id, remoteInfo: other.name };
            this.objects[dependencyId] = { isa: 'PBXTargetDependency', target: other.id, targetProxy: proxyId };
        } else if (kind === 'remoteTarget') {
            const project = this.resolveElement(parseReference(json.project, `${what} "project"`), undefined, `${what} "project"`);
            this.objects[proxyId] = {
                isa: 'PBXContainerItemProxy', containerPortal: project.id, proxyType: '1',
                remoteGlobalIDString: asString(json['target-id'], `${what} "target-id"`), remoteInfo: asString(json.target, `${what} "target"`)
            };
            this.objects[dependencyId] = { isa: 'PBXTargetDependency', targetProxy: proxyId };
        } else if (kind === 'package') {
            const { id: productId } = this.packageProduct(json, `${key}/product`, packages, what);
            this.objects[dependencyId] = { isa: 'PBXTargetDependency', productRef: productId };
        } else {
            refuse(`${what}: unknown kind ${JSON.stringify(kind)}`);
        }
        return dependencyId;
    }

    // ── Elements

    private lowerElements(): void {
        for (const element of this.allElements) {
            const what = `the element at ${element.pointer.join('/')}`;
            const object: ProjectObject = { isa: '' };
            if (element.loweredName !== undefined) { object.name = element.loweredName; }
            if (element.parsedPath.path !== '') { object.path = element.parsedPath.path; }
            object.sourceTree = element.parsedPath.sourceTree;
            switch (element.kind) {
                case 'file-reference': {
                    object.isa = 'PBXFileReference';
                    const type = optionalString(element.json, 'type', what);
                    if (type !== undefined) { object.explicitFileType = type; }
                    break;
                }
                case 'group':
                    object.isa = 'PBXGroup';
                    object.children = element.children.map((child) => child.id);
                    break;
                case 'variant-group':
                    object.isa = 'PBXVariantGroup';
                    object.children = element.children.map((child) => child.id);
                    break;
                case 'version-group': {
                    object.isa = 'XCVersionGroup';
                    object.children = element.children.map((child) => child.id);
                    if (element.json['current-version'] !== undefined) {
                        object.currentVersion = this.resolveElement(
                            parseReference(element.json['current-version'], `${what} "current-version"`), element, `${what} "current-version"`).id;
                    }
                    const type = optionalString(element.json, 'type', what);
                    if (type !== undefined) { object.versionGroupType = type; }
                    break;
                }
                case 'folder': {
                    object.isa = 'PBXFileSystemSynchronizedRootGroup';
                    this.folderTargets(element);
                    const exceptions = this.exceptionSets(element);
                    if (exceptions.length > 0) { object.exceptions = exceptions; }
                    break;
                }
            }
            this.objects[element.id] = object;
        }
    }

    private readonly folderTargetLists = new Map<Element, Target[]>();

    /** The targets a folder's `target-membership` names, which Xcode reads as a set of target names. */
    private folderTargets(folder: Element): Target[] {
        let targets = this.folderTargetLists.get(folder);
        if (!targets) {
            const what = `the folder at ${folder.pointer.join('/')} "target-membership"`;
            const names = folder.json['target-membership'] === undefined ? [] : nameSet(folder.json['target-membership'], what);
            targets = names.map((name) => this.targetNamed(name, what));
            this.folderTargetLists.set(folder, targets);
        }
        return targets;
    }

    /**
     * A folder's exception sets as Xcode lowers them: one per target or build phase, holding every name the folder's
     * entries give it once, a set left with no names dropped, ordered by target and, within a target, its own set ahead
     * of its phases' sets in phase order. Xcode also drops the names it judges none of the target's phases would take, by
     * file type, and names not written decomposed (NFD), and sorts the rest in Finder order; here every name is kept, in
     * the order the file lists it.
     */
    private exceptionSets(folder: Element): string[] {
        const where = `the folder at ${folder.pointer.join('/')}`;
        const sets = new Map<string, { rank: [number, number]; object: ProjectObject; names: string[]; seen: Set<string> }>();
        optionalList(folder.json, 'membership-exceptions', where).forEach((entry, index) => {
            const what = `${where} exception set ${index}`;
            const json = asObject(entry, what);
            const senses = ['exclusions', 'inclusions'].filter((sense) => json[sense] !== undefined);
            if (senses.length > 1) { refuse(`${what}: both exclusions and inclusions`); }
            const names = senses.length === 1 ? nameSet(json[senses[0]], `${what} "${senses[0]}"`) : [];
            let owner: { key: string; rank: [number, number]; object: () => ProjectObject };
            if (json.target !== undefined) {
                const target = this.targetNamed(json.target, `${what} "target"`);
                owner = {
                    key: target.key, rank: [target.index, 0],
                    object: () => ({ isa: 'PBXFileSystemSynchronizedBuildFileExceptionSet', target: target.id })
                };
            } else if (json['build-phase'] !== undefined) {
                const phase = this.projectPhase(json['build-phase'], what);
                owner = {
                    key: phase.key, rank: [phase.target.index, phase.index + 1],
                    object: () => ({ isa: 'PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet', buildPhase: phase.id })
                };
            } else {
                return refuse(`${what}: names neither a target nor a build phase`);
            }
            let set = sets.get(owner.key);
            if (!set) {
                set = { rank: owner.rank, object: owner.object(), names: [], seen: new Set() };
                sets.set(owner.key, set);
            }
            for (const name of names) {
                if (set.seen.has(nameKey(name))) { continue; }
                set.seen.add(nameKey(name));
                set.names.push(name);
            }
        });
        return [...sets.entries()]
            .filter(([, set]) => set.names.length > 0)
            .sort(([, a], [, b]) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
            .map(([ownerKey, set]) => {
                const id = this.id(undefined, `${folder.key}/exception:${ownerKey}`);
                this.objects[id] = { ...set.object, membershipExceptions: set.names };
                return id;
            });
    }

    /**
     * A `projectReferences` entry for each file reference to another Xcode project (type `wrapper.pb-project`, or no type
     * and a `.xcodeproj` name), ordered by name ignoring case, each with the `Products` group Xcode creates for it outside
     * the file tree. The group is left empty, as Xcode leaves it while the other project isn't on disk; nothing VSXcode
     * reads looks inside it.
     */
    private lowerProjectReferences(): Record<string, string>[] {
        return this.allElements
            .filter((element) => element.kind === 'file-reference' && (element.json.type === undefined
                ? element.displayName.endsWith('.xcodeproj')
                : element.json.type === 'wrapper.pb-project'))
            .sort((a, b) => compareCodePoints(a.displayName.toLowerCase(), b.displayName.toLowerCase()) ||
                compareCodePoints(a.displayName, b.displayName))
            .map((element) => {
                const groupId = this.id(undefined, `${element.key}/products`);
                this.objects[groupId] = { isa: 'PBXGroup', name: 'Products', sourceTree: '<group>' };
                return { ProductGroup: groupId, ProjectRef: element.id };
            });
    }

    // ── Configurations

    /**
     * A configuration list: one XCBuildConfiguration per name, each with the owner's settings lowered for it and the base
     * configuration its entry names. `entries` come first in their order, then the `inherited` names not among them.
     */
    private lowerConfigurationList(
        listKey: string, explicitListId: string | undefined, entries: unknown[], inherited: string[],
        defaultConfiguration: string, settings: unknown, what: string
    ): string {
        const listId = this.id(explicitListId, listKey);
        const configurations: { name: string; json?: Json }[] = entries.map((entry, index) => {
            if (typeof entry === 'string') { return { name: entry }; }
            const json = asObject(entry, `${what} configuration ${index}`);
            return { name: asString(json.name, `${what} configuration ${index} "name"`), json };
        });
        for (const name of inherited) {
            if (!configurations.some((configuration) => configuration.name === name)) { configurations.push({ name }); }
        }
        const settingsObject = settings === undefined ? {} : asObject(settings, `${what} "build-settings"`);
        const ids = configurations.map(({ name, json }) => {
            const object: ProjectObject = { isa: 'XCBuildConfiguration', name, buildSettings: lowerSettings(settingsObject, name, what) };
            if (json?.file !== undefined) { this.baseConfiguration(object, json.file, `${what} configuration ${name} "file"`); }
            const id = this.id(json ? optionalString(json, 'id', what) : undefined, `${listKey}/config:${name}`);
            this.objects[id] = object;
            return id;
        });
        this.objects[listId] = { isa: 'XCConfigurationList', buildConfigurations: ids, defaultConfigurationIsVisible: '0', defaultConfigurationName: defaultConfiguration };
        return listId;
    }

    private lowerTargetConfigurations(projectConfigurations: unknown[], defaultConfiguration: string): void {
        const projectNames = projectConfigurations.map((entry) => (typeof entry === 'string' ? entry : asString(asObject(entry, 'a configuration').name, 'a configuration "name"')));
        for (const target of this.targets) {
            const what = `target ${target.name}`;
            const listId = this.lowerConfigurationList(
                `${target.key}/configs`, optionalString(target.json, 'configuration-list-debug-id', what),
                optionalList(target.json, 'specialized-configurations', what), projectNames, defaultConfiguration,
                target.json['build-settings'], what);
            this.objects[target.id].buildConfigurationList = listId;
        }
    }

    /** A configuration's xcconfig: a tree reference, or an anchor element plus a path inside it, which isn't checked on disk. */
    private baseConfiguration(object: ProjectObject, value: unknown, what: string): void {
        if (isObject(value) && (value.anchor !== undefined || value['relative-path'] !== undefined)) {
            const anchor = this.resolveElement(parseReference(value.anchor, `${what} "anchor"`), undefined, `${what} "anchor"`);
            const relative = parseReference(value['relative-path'], `${what} "relative-path"`);
            if ('id' in relative) { refuse(`${what}: "relative-path" isn't a path`); }
            object.baseConfigurationReferenceAnchor = anchor.id;
            object.baseConfigurationReferenceRelativePath = describe(relative);
            return;
        }
        object.baseConfigurationReference = this.resolveElement(parseReference(value, what), undefined, what).id;
    }
}

/** A remote package's `version` as the pbxproj `requirement` Xcode lowers it to. */
function requirement(version: Json, what: string): Record<string, string> {
    const get = (key: string): string | undefined => optionalString(version, key, `${what} "version"`);
    const value = (key: string): string => get(key) as string;
    if (get('revision') !== undefined) { return { kind: 'revision', revision: value('revision') }; }
    if (get('branch') !== undefined) { return { kind: 'branch', branch: value('branch') }; }
    if (get('version') !== undefined) { return { kind: 'exactVersion', version: value('version') }; }
    if (get('up-to-next-minor-version') !== undefined) { return { kind: 'upToNextMinorVersion', minimumVersion: value('up-to-next-minor-version') }; }
    if (get('up-to-next-major-version') !== undefined) { return { kind: 'upToNextMajorVersion', minimumVersion: value('up-to-next-major-version') }; }
    const range = get('version-range');
    if (range !== undefined) {
        const separator = range.indexOf('..<');
        if (separator === -1 || range.indexOf('..<', separator + 1) !== -1) { refuse(`${what}: unexpected version range "${range}"`); }
        return { kind: 'versionRange', minimumVersion: range.slice(0, separator), maximumVersion: range.slice(separator + 3) };
    }
    const minimum = get('version-range-min');
    const maximum = get('version-range-max');
    if (minimum === undefined || maximum === undefined) { refuse(`${what}: a version requirement Xcode doesn't know`); }
    return { kind: 'versionRange', minimumVersion: minimum, maximumVersion: maximum };
}

const CONDITION = /\[([^\]=]*)=([^\]]*)\]/g;

/**
 * An owner's build settings for one configuration, as Xcode lowers them: a key conditioned on this configuration loses
 * that condition and keeps any other, one conditioned on another configuration (or on none the project has) is left out,
 * and a key without a configuration condition beats the conditioned keys it meets. When two conditioned keys meet
 * (`K[config=Debug][sdk=x]` and `K[sdk=x][config=Debug]`), Xcode's pick varies from run to run; here the later one in
 * code-point order of the whole key wins, so the result is at least stable.
 */
function lowerSettings(settings: Json, configuration: string, what: string): Record<string, string | string[]> {
    const conditioned: { key: string; lowered: string; value: string | string[] }[] = [];
    const unconditioned: { key: string; value: string | string[] }[] = [];
    for (const key of Object.keys(settings)) {
        const value = settingValue(key, settings[key], `${what} setting ${key}`);
        const open = key.indexOf('[');
        const conditions = open === -1 ? [] : [...key.slice(open).matchAll(CONDITION)];
        if (open === -1 || conditions.map((match) => match[0]).join('') !== key.slice(open) ||
            !conditions.some((match) => match[1] === 'config')) {
            unconditioned.push({ key, value });
            continue;
        }
        if (conditions.some((match) => match[1] === 'config' && match[2] !== configuration)) { continue; }
        const lowered = key.slice(0, open) + conditions.filter((match) => match[1] !== 'config').map((match) => match[0]).join('');
        conditioned.push({ key, lowered, value });
    }
    const out: Record<string, string | string[]> = Object.create(null);
    for (const { lowered, value } of conditioned.sort((a, b) => compareCodePoints(a.key, b.key))) { out[lowered] = value; }
    for (const { key, value } of unconditioned) { out[key] = value; }
    return out;
}

/**
 * Settings Xcode's pbxproj writer stores as a list once their value has two or more words, as probed on Xcode 27.2; Xcode
 * lists more, none of which VSXcode reads.
 */
const WORD_LIST_SETTINGS = new Set([
    'ARCHS', 'FRAMEWORK_SEARCH_PATHS', 'GCC_PREPROCESSOR_DEFINITIONS', 'HEADER_SEARCH_PATHS', 'INFOPLIST_PREPROCESSOR_DEFINITIONS',
    'LD_RUNPATH_SEARCH_PATHS', 'LIBRARY_SEARCH_PATHS', 'OTHER_CFLAGS', 'OTHER_CPLUSPLUSFLAGS', 'OTHER_LDFLAGS', 'WARNING_CFLAGS'
]);

/**
 * A setting's value as Xcode's conversion writes it. Xcode holds every value as a string, a list joined by single spaces
 * with nothing quoted, so `["-a", "b c"]` holds `-a b c`; a setting in WORD_LIST_SETTINGS whose string has two or more words
 * is then written as those words.
 */
function settingValue(key: string, value: unknown, what: string): string | string[] {
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        text = value.join(' ');
    } else {
        return refuse(`${what} is neither a string nor a list of strings`);
    }
    const bracket = key.indexOf('[');
    if (!WORD_LIST_SETTINGS.has(bracket === -1 ? key : key.slice(0, bracket))) { return text; }
    const words = settingWords(text);
    return words.length > 1 ? words : text;
}

/**
 * The words of a list setting as Xcode splits them: spaces and tabs separate words; a backslash keeps the next character in
 * the word, and single or double quotes keep everything up to the closing quote, both kept in the word as written. Line
 * breaks don't separate words. An unclosed quote runs to the end.
 */
function settingWords(text: string): string[] {
    const words: string[] = [];
    let word: string | undefined;
    let quote: string | undefined;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quote === undefined && (character === ' ' || character === '\t')) {
            if (word !== undefined) { words.push(word); word = undefined; }
            continue;
        }
        word = (word ?? '') + character;
        if (character === '\\' && index + 1 < text.length) {
            word += text[++index];
        } else if (quote === undefined && (character === '"' || character === '\'')) {
            quote = character;
        } else if (character === quote) {
            quote = undefined;
        }
    }
    if (word !== undefined) { words.push(word); }
    return words;
}

// ── Entry points ─────────────────────────────────────────

/** The parsed text when it is a JSON project file: a JSON5 object with a `files` list. A pbxproj fails within its first bytes. */
export function xcprojRoot(text: string): Json5Node | undefined {
    const root = parseJson5Text(text);
    return root?.kind === 'object' && nodeAt(root, ['files'])?.kind === 'array' ? root : undefined;
}

/** Whether the text is a JSON project file rather than a pbxproj. Never calls plutil. */
export function isXcprojText(text: string): boolean {
    return xcprojRoot(text) !== undefined;
}

/** The lowered graph, or why Xcode would refuse the file; never throws, since readProject's callers only test for an error value. */
export function lowerXcproj(root: Json5Node): LoweredProject | XcprojProblem {
    try {
        return new Lowering(asObject(valueOf(root), 'the project')).lower();
    } catch (error) {
        return { problem: error instanceof Refusal ? error.message : `the file couldn't be read: ${String(error)}` };
    }
}

/** Why a JSON project file can't be read, for messages; undefined when it reads, or when the text isn't a JSON project file. */
export function describeXcprojProblem(text: string): string | undefined {
    const parsed = parseJson5Text(text);
    if (!parsed) { return text.trimStart().startsWith('{') ? 'the text isn\'t JSON5 Xcode can read' : undefined; }
    const root = xcprojRoot(text);
    if (!root) { return 'the project has no "files" list'; }
    const lowered = lowerXcproj(root);
    return 'problem' in lowered ? lowered.problem : undefined;
}
