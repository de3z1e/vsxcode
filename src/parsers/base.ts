import { cleanup } from '../utils/version';

/** The items of a list setting: a plist list's items as they are (empty ones dropped), or a string split as Xcode's editor writes it. */
export function parseListValue(raw: string | string[]): string[] {
    if (Array.isArray(raw)) {
        return raw.filter((item) => item.length > 0);
    }
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
