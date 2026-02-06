import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { ExecFileOptionsWithStringEncoding } from 'child_process';

const execFile = promisify(execFileCallback) as (
    file: string,
    args?: ReadonlyArray<string>,
    options?: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

export function compareVersions(left: string, right: string): number {
    const parse = (value: string) => value.split('.').map((part) => Number(part) || 0);
    const a = parse(left);
    const b = parse(right);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff > 0) {
            return 1;
        }
        if (diff < 0) {
            return -1;
        }
    }
    return 0;
}

export function parseSwiftVersion(pbxContents: string): string | null {
    const matches = [...pbxContents.matchAll(/SWIFT_VERSION = ([^;]+);/g)];
    const versions = matches
        .map((match) => cleanup(match[1]))
        .filter((value) => value.length > 0);
    const unique = [...new Set(versions)];
    unique.sort((a, b) => compareVersions(b, a));
    return unique[0] || null;
}

export function parseSwiftToolsVersion(output: string | null | undefined): string | null {
    if (!output) {
        return null;
    }
    const match = output.match(/Swift(?:\s+language)?\s+version\s+([0-9]+(?:\.[0-9]+)*)/i);
    return match ? match[1] : null;
}

export async function detectSwiftToolsVersion(): Promise<string | null> {
    const commands: Array<{ command: string; args: string[] }> = [
        { command: 'xcrun', args: ['swift', '--version'] },
        { command: 'swift', args: ['--version'] }
    ];
    for (const entry of commands) {
        try {
            const { stdout } = await execFile(entry.command, entry.args, { encoding: 'utf8' });
            const version = parseSwiftToolsVersion(stdout);
            if (version) {
                return version;
            }
        } catch (error) {
            // Ignore and try next candidate.
        }
    }
    return null;
}

export async function detectMacOSVersion(): Promise<string | null> {
    if (process.platform !== 'darwin') {
        return null;
    }
    try {
        const { stdout } = await execFile('sw_vers', ['-productVersion'], { encoding: 'utf8' });
        const version = cleanup(stdout);
        return version.length > 0 ? version : null;
    } catch (error) {
        return null;
    }
}

export function cleanup(value: string | null | undefined): string {
    if (!value) {
        return '';
    }
    return value.replace(/^"+|"+$/g, '').trim();
}
