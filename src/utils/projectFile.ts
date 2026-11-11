/**
 * Which definition file an `.xcodeproj` bundle holds: `project.pbxproj`, or Xcode 27.2's JSON `project.xcproj`. Xcode opens
 * a bundle with exactly one of them and refuses one holding both ("has multiple project definition files"), which a
 * format switch passes through for a moment: Xcode writes the new file, then deletes the old. Writes go through
 * `writeProjectFile`, which never creates a definition file, so a write queued before a switch can't bring the old one
 * back. No vscode import.
 */
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';

export type ProjectFileFormat = 'pbxproj' | 'xcproj';

export const PROJECT_FILE_NAMES: Readonly<Record<ProjectFileFormat, string>> = {
    pbxproj: 'project.pbxproj',
    xcproj: 'project.xcproj'
};

/** The bundle's definition file, or why there is none to use. */
export type ProjectFileResolution =
    | { path: string; format: ProjectFileFormat }
    | { error: 'missing' }
    | { error: 'both'; paths: string[] };

/** The definition file in a bundle, synchronously, since some callers are synchronous. Backups beside it don't count. */
export function resolveProjectFile(bundlePath: string): ProjectFileResolution {
    const present = (Object.keys(PROJECT_FILE_NAMES) as ProjectFileFormat[])
        .map((format) => ({ format, path: path.join(bundlePath, PROJECT_FILE_NAMES[format]) }))
        .filter((candidate) => isFile(candidate.path));
    if (present.length === 0) { return { error: 'missing' }; }
    if (present.length > 1) { return { error: 'both', paths: present.map((candidate) => candidate.path) }; }
    return present[0];
}

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

/** The first `.xcodeproj` bundle in the folder, as the extension has always picked it; null when there is none. */
export function findProjectBundle(rootPath: string): string | null {
    try {
        const bundle = fs.readdirSync(rootPath, { withFileTypes: true })
            .find((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'));
        return bundle ? path.join(rootPath, bundle.name) : null;
    } catch {
        return null;
    }
}

/** Whether two resolutions name the same state: the same file, or the same reason for having none. */
export function sameResolution(a: ProjectFileResolution | undefined, b: ProjectFileResolution | undefined): boolean {
    if (!a || !b) { return a === b; }
    if ('error' in a || 'error' in b) { return 'error' in a && 'error' in b && a.error === b.error; }
    return a.path === b.path && a.format === b.format;
}

/** A definition file a job resolved, with its bundle, held between the job's read and its write. */
export interface ProjectFile {
    bundle: string;
    path: string;
    format: ProjectFileFormat;
}

/** The bundle's definition file for a job, resolved when the job runs; undefined, with a log line, while there is none or there are two. */
export function projectFileForJob(bundlePath: string, log: (message: string) => void, logPrefix: string): ProjectFile | undefined {
    const resolution = resolveProjectFile(bundlePath);
    if ('error' in resolution) {
        log(`${logPrefix} ${describeResolution(bundlePath, resolution)}, skipping`);
        return undefined;
    }
    return { bundle: bundlePath, path: resolution.path, format: resolution.format };
}

/** A resolution as words for a log line: the file's name, or what's wrong. */
export function describeResolution(bundlePath: string, resolution: ProjectFileResolution): string {
    const bundle = path.basename(bundlePath);
    if (!('error' in resolution)) { return `${bundle}/${path.basename(resolution.path)}`; }
    return resolution.error === 'missing'
        ? `${bundle} holds no project.pbxproj or project.xcproj`
        : `${bundle} holds both project.pbxproj and project.xcproj, which Xcode refuses`;
}

/** Writes only when the bundle, re-resolved now, still holds just the expected file; `r+` so none is ever created. False, logged, otherwise. */
export async function writeProjectFile(
    bundlePath: string,
    expectedFormat: ProjectFileFormat,
    text: string,
    log: (message: string) => void
): Promise<boolean> {
    const expected = PROJECT_FILE_NAMES[expectedFormat];
    const resolution = resolveProjectFile(bundlePath);
    if ('error' in resolution || resolution.format !== expectedFormat) {
        const now = 'error' in resolution ? describeResolution(bundlePath, resolution) : `${path.basename(bundlePath)} now holds ${path.basename(resolution.path)}`;
        log(`[project-file] ${expected} wasn't written: ${now}`);
        return false;
    }
    let handle: fs.promises.FileHandle;
    try {
        handle = await fsp.open(resolution.path, 'r+');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            log(`[project-file] ${expected} wasn't written: it was removed just before the write`);
            return false;
        }
        throw error;
    }
    try {
        const data = Buffer.from(text, 'utf8');
        await handle.write(data, 0, data.length, 0);
        await handle.truncate(data.length);
    } finally {
        await handle.close();
    }
    return true;
}
