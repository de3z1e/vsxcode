import type { ExtractObjectBodyResult, PackageRequirement } from '../types/interfaces';
import { cleanup } from '../utils/version';

export function extractObjectBody(contents: string, startIndex: number): ExtractObjectBodyResult | null {
    const length = contents.length;
    const braceIndex = contents.indexOf('{', startIndex);
    if (braceIndex === -1) {
        return null;
    }
    let depth = 1;
    let index = braceIndex + 1;
    const bodyStart = index;
    while (index < length) {
        const char = contents[index];
        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return {
                    body: contents.slice(bodyStart, index),
                    endIndex: index + 1
                };
            }
        }
        index += 1;
    }
    return {
        body: contents.slice(bodyStart),
        endIndex: length
    };
}

export function parsePackageRequirement(block: string): PackageRequirement {
    const requirement: PackageRequirement = {};
    const pairRegex = /([A-Za-z]+)\s*=\s*([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = pairRegex.exec(block)) !== null) {
        const key = cleanup(match[1]);
        const value = cleanup(match[2]);
        if (key && value) {
            requirement[key] = value;
        }
    }
    return requirement;
}

export function parseListValue(raw: string): string[] {
    const trimmed = raw.trim();
    if (trimmed.startsWith('(')) {
        const inner = trimmed.replace(/^\(\s*/, '').replace(/\s*\)$/, '');
        return inner
            .split(',')
            .map((item) => cleanup(item.trim()))
            .filter((item) => item.length > 0);
    }
    const cleaned = cleanup(trimmed);
    if (cleaned.includes(' ')) {
        return cleaned.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    return cleaned.length > 0 ? [cleaned] : [];
}
