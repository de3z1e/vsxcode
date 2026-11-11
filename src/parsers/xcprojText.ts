/**
 * A position-aware reader for Xcode's JSON project file, `project.xcproj` (Xcode 27.2 and later).
 *
 * Xcode reads the file with Foundation's JSON5 parser. This follows the dialect as Xcode 27.2 accepts and rejects it,
 * which `npm run test:xcproj` checks case by case against xcprojformatter (Xcode's own reader). It keeps every value's
 * offsets, so an edit can splice the text and leave the rest untouched. plutil, the only native reader a Node process
 * can call, is no substitute: it keeps the last of two duplicate keys where Xcode keeps the first, rejects Infinity and
 * NaN, which Xcode accepts, and reports no positions.
 */

/** Offsets into the text, `end` exclusive, in UTF-16 code units. */
export interface Json5Span {
    start: number;
    end: number;
}

export interface Json5Member extends Json5Span {
    /** The decoded key. */
    key: string;
    /** The key as written, quotes included. */
    keyStart: number;
    keyEnd: number;
    value: Json5Node;
}

export interface Json5Object extends Json5Span {
    kind: 'object';
    /** Every member in text order, duplicates included; lookups take the first. */
    members: Json5Member[];
}

export interface Json5Array extends Json5Span {
    kind: 'array';
    elements: Json5Node[];
}

export interface Json5String extends Json5Span {
    kind: 'string';
    value: string;
}

export interface Json5Number extends Json5Span {
    kind: 'number';
    value: number;
}

export interface Json5Boolean extends Json5Span {
    kind: 'boolean';
    value: boolean;
}

export interface Json5Null extends Json5Span {
    kind: 'null';
    value: null;
}

export type Json5Node = Json5Object | Json5Array | Json5String | Json5Number | Json5Boolean | Json5Null;

class Json5SyntaxError extends Error {}

const BACKSLASH = 0x5c;
const NO_BREAK_SPACE = 0xa0;
const BYTE_ORDER_MARK = 0xfeff;
const KEY_START = /^[\p{L}\p{Nl}$_]$/u;

/** Space, tab, line feed, carriage return, vertical tab and form feed: the only whitespace Xcode allows between tokens. */
function isWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c;
}

function isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
}

function hexValue(code: number): number {
    if (code >= 0x30 && code <= 0x39) { return code - 0x30; }
    if (code >= 0x41 && code <= 0x46) { return code - 0x41 + 10; }
    if (code >= 0x61 && code <= 0x66) { return code - 0x61 + 10; }
    return -1;
}

class Reader {
    private pos = 0;

    constructor(private readonly text: string) {}

    read(): Json5Node {
        if (this.text.charCodeAt(0) === BYTE_ORDER_MARK) { this.pos = 1; }
        this.skipTrivia();
        if (this.pos >= this.text.length) {
            // Whitespace or comments alone read as an empty object, as plutil gives it; Xcode then finds no `files`.
            if (this.text.length === 0) { this.fail('empty text'); }
            return { kind: 'object', members: [], start: this.text.length, end: this.text.length };
        }
        const value = this.value();
        this.skipTrivia();
        if (this.pos < this.text.length) { this.fail('unexpected text after the value'); }
        return value;
    }

    private fail(why: string): never {
        throw new Json5SyntaxError(`${why} at offset ${this.pos}`);
    }

    private code(offset = 0): number {
        return this.text.charCodeAt(this.pos + offset);
    }

    private skipTrivia(): void {
        for (;;) {
            const code = this.code();
            if (isWhitespace(code)) {
                this.pos += 1;
            } else if (code === 0x2f && this.code(1) === 0x2f) {
                this.pos += 2;
                while (this.pos < this.text.length && this.code() !== 0x0a && this.code() !== 0x0d) { this.pos += 1; }
            } else if (code === 0x2f && this.code(1) === 0x2a) {
                const close = this.text.indexOf('*/', this.pos + 2);
                if (close === -1) { this.fail('unterminated comment'); }
                this.pos = close + 2;
            } else {
                return;
            }
        }
    }

    private value(): Json5Node {
        const code = this.code();
        if (code === 0x7b) { return this.object(); }
        if (code === 0x5b) { return this.array(); }
        if (code === 0x22 || code === 0x27) {
            const start = this.pos;
            const value = this.string();
            return { kind: 'string', value, start, end: this.pos };
        }
        if (this.text.startsWith('true', this.pos)) { return this.literal('boolean', true, 4); }
        if (this.text.startsWith('false', this.pos)) { return this.literal('boolean', false, 5); }
        if (this.text.startsWith('null', this.pos)) { return this.literal('null', null, 4); }
        if (code === 0x2b || code === 0x2d || code === 0x2e || isDigit(code) || code === 0x49 || code === 0x4e) {
            return this.number();
        }
        return this.fail('expected a value');
    }

    private literal(kind: 'boolean', value: boolean, length: number): Json5Boolean;
    private literal(kind: 'null', value: null, length: number): Json5Null;
    private literal(kind: 'boolean' | 'null', value: boolean | null, length: number): Json5Boolean | Json5Null {
        const start = this.pos;
        this.pos += length;
        return kind === 'null'
            ? { kind: 'null', value: null, start, end: this.pos }
            : { kind: 'boolean', value: value as boolean, start, end: this.pos };
    }

    /**
     * Xcode's number forms: an optional `+`, then an optional `-` (`+-1` reads -1), then Infinity, NaN, hex or a decimal
     * that may lack its integer or its fraction digits but not both. A literal with fraction digits or an exponent is a
     * double and keeps negative zero; any other is an integer, so `-0` reads 0, as Xcode and plutil read it. Hex is a
     * 64-bit integer to Xcode: at most 16 digits, leading zeros included, and no lower than -2^63. A decimal may be any
     * size.
     */
    private number(): Json5Number {
        const start = this.pos;
        let plus = false;
        if (this.code() === 0x2b) { plus = true; this.pos += 1; }
        let negative = false;
        if (this.code() === 0x2d) { negative = true; this.pos += 1; }
        const sign = negative ? -1 : 1;

        if (this.text.startsWith('Infinity', this.pos) || this.text.startsWith('NaN', this.pos)) {
            if (plus && negative) { this.fail('a sign pair before Infinity or NaN'); }
            const infinity = this.text.startsWith('Infinity', this.pos);
            this.pos += infinity ? 8 : 3;
            return { kind: 'number', value: infinity ? sign * Infinity : NaN, start, end: this.pos };
        }

        if (this.code() === 0x30 && (this.code(1) === 0x78 || this.code(1) === 0x58)) {
            this.pos += 2;
            const digitsStart = this.pos;
            while (hexValue(this.code()) >= 0) { this.pos += 1; }
            if (this.pos === digitsStart) { this.fail('hex number without digits'); }
            const digits = this.text.slice(digitsStart, this.pos);
            if (digits.length > 16) { this.fail('hex number longer than 16 digits'); }
            if (negative && BigInt(`0x${digits}`) > 2n ** 63n) { this.fail('hex number below the 64-bit minimum'); }
            const magnitude = parseInt(digits, 16);
            return { kind: 'number', value: negative && magnitude === 0 ? 0 : sign * magnitude, start, end: this.pos };
        }

        const bodyStart = this.pos;
        let integerDigits = 0;
        if (this.code() === 0x30) {
            this.pos += 1;
            integerDigits = 1;
            if (isDigit(this.code())) { this.fail('leading zero'); }
        } else {
            while (isDigit(this.code())) { this.pos += 1; integerDigits += 1; }
        }
        let fractionDigits = 0;
        if (this.code() === 0x2e) {
            this.pos += 1;
            while (isDigit(this.code())) { this.pos += 1; fractionDigits += 1; }
        }
        if (integerDigits === 0 && fractionDigits === 0) { this.fail('number without digits'); }
        let exponent = false;
        if (this.code() === 0x65 || this.code() === 0x45) {
            exponent = true;
            this.pos += 1;
            if (this.code() === 0x2b || this.code() === 0x2d) { this.pos += 1; }
            const exponentStart = this.pos;
            while (isDigit(this.code())) { this.pos += 1; }
            if (this.pos === exponentStart) { this.fail('exponent without digits'); }
        }
        const magnitude = Number(this.text.slice(bodyStart, this.pos));
        if (!Number.isFinite(magnitude)) { this.fail('number out of range'); }
        const isDouble = fractionDigits > 0 || exponent;
        const value = negative && magnitude === 0 && !isDouble ? 0 : sign * magnitude;
        return { kind: 'number', value, start, end: this.pos };
    }

    /** A quoted string, from its opening quote to just past its closing one. */
    private string(): string {
        const quote = this.code();
        this.pos += 1;
        let out = '';
        for (;;) {
            if (this.pos >= this.text.length) { this.fail('unterminated string'); }
            const code = this.code();
            if (code === quote) {
                this.pos += 1;
                return out;
            }
            if (code === BACKSLASH) {
                out += this.escape();
            } else if (code < 0x20) {
                this.fail('control character in a string');
            } else {
                out += this.text[this.pos];
                this.pos += 1;
            }
        }
    }

    /**
     * One escape, from its backslash: the JSON escapes, `\'`, two-digit `\x` and four-digit `\u` (neither may give NUL;
     * surrogates only as a pair), and a backslash before a line break, which reads as a single line feed. Anything else,
     * `\0` and `\v` included, is rejected, as Xcode rejects it.
     */
    private escape(): string {
        this.pos += 1;
        const code = this.code();
        this.pos += 1;
        switch (code) {
            case 0x62: return '\b';
            case 0x66: return '\f';
            case 0x6e: return '\n';
            case 0x72: return '\r';
            case 0x74: return '\t';
            case 0x27: return '\'';
            case 0x22: return '"';
            case 0x2f: return '/';
            case BACKSLASH: return '\\';
            case 0x0a: return '\n';
            case 0x0d:
                if (this.code() === 0x0a) { this.pos += 1; }
                return '\n';
            case 0x78: {
                const unit = this.hexDigits(2);
                if (unit === 0) { this.fail('escaped NUL'); }
                return String.fromCharCode(unit);
            }
            case 0x75: {
                const unit = this.hexDigits(4);
                if (unit === 0) { this.fail('escaped NUL'); }
                if (unit >= 0xdc00 && unit <= 0xdfff) { this.fail('lone low surrogate'); }
                if (unit >= 0xd800 && unit <= 0xdbff) {
                    if (this.code() !== BACKSLASH || this.code(1) !== 0x75) { this.fail('lone high surrogate'); }
                    this.pos += 2;
                    const low = this.hexDigits(4);
                    if (low < 0xdc00 || low > 0xdfff) { this.fail('lone high surrogate'); }
                    return String.fromCharCode(unit, low);
                }
                return String.fromCharCode(unit);
            }
            default:
                this.pos -= 1;
                return this.fail('invalid escape');
        }
    }

    private hexDigits(count: number): number {
        let value = 0;
        for (let index = 0; index < count; index++) {
            const digit = hexValue(this.code());
            if (digit < 0) { this.fail('short hex escape'); }
            value = value * 16 + digit;
            this.pos += 1;
        }
        return value;
    }

    /**
     * An unquoted key: a letter, letter number, `$`, `_` or an escape first (the escape's character isn't checked), then
     * anything up to whitespace, `:` or a comment, with escapes decoded. A no-break space or a control character is
     * rejected anywhere in it.
     */
    private unquotedKey(): string {
        let out = '';
        const first = this.code();
        if (first === BACKSLASH) {
            out += this.escape();
        } else {
            const point = this.text.codePointAt(this.pos) ?? 0;
            const character = String.fromCodePoint(point);
            if (!KEY_START.test(character)) { this.fail('invalid key'); }
            out += character;
            this.pos += character.length;
        }
        while (this.pos < this.text.length) {
            const code = this.code();
            if (isWhitespace(code) || code === 0x3a) { break; }
            if (code === 0x2f && (this.code(1) === 0x2f || this.code(1) === 0x2a)) { break; }
            if (code === BACKSLASH) {
                out += this.escape();
                continue;
            }
            if (code === NO_BREAK_SPACE || code < 0x20) { this.fail('invalid character in a key'); }
            const point = this.text.codePointAt(this.pos) ?? 0;
            const character = String.fromCodePoint(point);
            out += character;
            this.pos += character.length;
        }
        return out;
    }

    private object(): Json5Object {
        const start = this.pos;
        this.pos += 1;
        const members: Json5Member[] = [];
        this.skipTrivia();
        if (this.code() === 0x7d) {
            this.pos += 1;
            return { kind: 'object', members, start, end: this.pos };
        }
        for (;;) {
            this.skipTrivia();
            const keyStart = this.pos;
            const quoted = this.code() === 0x22 || this.code() === 0x27;
            const key = quoted ? this.string() : this.unquotedKey();
            const keyEnd = this.pos;
            this.skipTrivia();
            if (this.code() !== 0x3a) { this.fail('expected a colon'); }
            this.pos += 1;
            this.skipTrivia();
            const value = this.value();
            members.push({ key, keyStart, keyEnd, value, start: keyStart, end: value.end });
            this.skipTrivia();
            if (this.code() === 0x2c) {
                this.pos += 1;
                this.skipTrivia();
                if (this.code() === 0x7d) { break; }
            } else if (this.code() === 0x7d) {
                break;
            } else {
                this.fail('expected a comma or a closing brace');
            }
        }
        this.pos += 1;
        return { kind: 'object', members, start, end: this.pos };
    }

    private array(): Json5Array {
        const start = this.pos;
        this.pos += 1;
        const elements: Json5Node[] = [];
        this.skipTrivia();
        if (this.code() === 0x5d) {
            this.pos += 1;
            return { kind: 'array', elements, start, end: this.pos };
        }
        for (;;) {
            this.skipTrivia();
            elements.push(this.value());
            this.skipTrivia();
            if (this.code() === 0x2c) {
                this.pos += 1;
                this.skipTrivia();
                if (this.code() === 0x5d) { break; }
            } else if (this.code() === 0x5d) {
                break;
            } else {
                this.fail('expected a comma or a closing bracket');
            }
        }
        this.pos += 1;
        return { kind: 'array', elements, start, end: this.pos };
    }
}

/** The text's value with offsets, or undefined when Xcode would reject the text; never throws. */
export function parseJson5Text(text: string): Json5Node | undefined {
    try {
        return new Reader(text).read();
    } catch {
        // Syntax errors, and a stack overflow on absurd nesting, both mean the text can't be read.
        return undefined;
    }
}

/** The node a pointer of keys and indexes reaches; an object key takes its first occurrence, as Xcode does. */
export function nodeAt(root: Json5Node, pointer: readonly (string | number)[]): Json5Node | undefined {
    let node: Json5Node | undefined = root;
    for (const step of pointer) {
        if (node?.kind === 'object' && typeof step === 'string') {
            node = node.members.find((member) => member.key === step)?.value;
        } else if (node?.kind === 'array' && typeof step === 'number') {
            node = node.elements[step];
        } else {
            return undefined;
        }
    }
    return node;
}

/** The plain value, with the first of any duplicate keys, as Xcode reads it. */
export function valueOf(node: Json5Node): unknown {
    switch (node.kind) {
        case 'object': {
            const out: Record<string, unknown> = {};
            for (const member of node.members) {
                if (Object.prototype.hasOwnProperty.call(out, member.key)) { continue; }
                // defineProperty, so a `__proto__` key stays an ordinary key, as JSON.parse keeps it.
                Object.defineProperty(out, member.key, {
                    value: valueOf(member.value), enumerable: true, writable: true, configurable: true
                });
            }
            return out;
        }
        case 'array':
            return node.elements.map(valueOf);
        case 'string':
        case 'number':
        case 'boolean':
        case 'null':
            return node.value;
    }
}

/** The keys an object gives more than once, in order of first appearance. */
export function duplicateKeys(node: Json5Object): string[] {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const { key } of node.members) {
        if (seen.has(key) && !duplicates.includes(key)) { duplicates.push(key); }
        seen.add(key);
    }
    return duplicates;
}
