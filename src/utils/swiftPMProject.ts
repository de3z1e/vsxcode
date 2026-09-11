import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';

import { usesSwiftPMObjectIds } from '../parsers/project';

// No vscode import: the dialog and the capabilities are passed in.

/** How the user wants a SwiftPM-generated project handled: managed fully, or left as a SwiftPM package. */
export type SwiftPMProjectChoice = 'full' | 'keep';

/** What a decision came to; `not-swiftpm` projects are managed as before, without asking. */
export type SwiftPMProjectOutcome = SwiftPMProjectChoice | 'dismissed' | 'not-swiftpm';

/** Workspace-state key holding the choice per project file (`Name.xcodeproj`). */
export const SWIFTPM_PROJECT_CHOICES_KEY = 'swiftPMProjectChoices';

/** A file VSXcode would change, with the backup it would get. */
export interface BackupEntry {
    file: string;
    backup: string;
}

export interface SwiftPMProjectPrompt {
    projectFile: string;
    /** The files that exist, each with its next free backup name. */
    entries: BackupEntry[];
}

/** The part of a vscode.Memento the decisions need. */
export interface ChoiceStore {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
}

export interface SwiftPMProjectsOptions {
    projectRoot: string;
    store: ChoiceStore;
    /** The file VS Code writes workspace settings to: `.vscode/settings.json`, or the open `.code-workspace` file. */
    workspaceSettingsFile(): string;
    /** Shows the choice; resolves to the chosen option, or undefined when the dialog is dismissed. */
    ask(prompt: SwiftPMProjectPrompt): PromiseLike<SwiftPMProjectChoice | undefined>;
    log(message: string): void;
}

export interface SwiftPMProjectDecision {
    outcome: SwiftPMProjectOutcome;
    /** Backups written for `full`, in the order of `filesVSXcodeChanges`. */
    backups: string[];
}

/** The files VSXcode may change in a workspace, limited to those that exist. */
export function filesVSXcodeChanges(projectRoot: string, projectFile: string, workspaceSettingsFile: string): string[] {
    return [
        path.join(projectRoot, 'Package.swift'),
        workspaceSettingsFile,
        path.join(projectRoot, '.vscode', '.swift-format'),
        path.join(projectRoot, projectFile, 'project.pbxproj')
    ].filter((file) => fs.existsSync(file));
}

const backupName = (file: string, attempt: number): string => (attempt === 1 ? `${file}_backup` : `${file}_backup-${attempt}`);

/** The first backup name beside `file` that isn't taken: `<file>_backup`, then `<file>_backup-2`, `-3` and so on. */
export function nextBackupPath(file: string): string {
    for (let attempt = 1; ; attempt++) {
        const candidate = backupName(file, attempt);
        if (!fs.existsSync(candidate)) { return candidate; }
    }
}

/** Copies `file` to its first free backup name and returns that path; an existing file is never replaced. */
export async function backUpFile(file: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
        const candidate = backupName(file, attempt);
        try {
            await fsp.copyFile(file, candidate, fs.constants.COPYFILE_EXCL);
            return candidate;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        }
    }
}

export interface SwiftPMProjects {
    /**
     * Whether VSXcode may manage `projectFile`. A remembered choice is used as is unless `askEvenIfChosen`; otherwise the
     * user is asked, and `full` backs up every file VSXcode would change before the choice is recorded.
     */
    decide(projectFile: string, askEvenIfChosen: boolean): Promise<SwiftPMProjectDecision>;
}

export function createSwiftPMProjects(options: SwiftPMProjectsOptions): SwiftPMProjects {
    const { projectRoot, store, log } = options;

    return {
        async decide(projectFile, askEvenIfChosen) {
            let contents: string;
            try {
                contents = await fsp.readFile(path.join(projectRoot, projectFile, 'project.pbxproj'), 'utf8');
            } catch {
                return { outcome: 'not-swiftpm', backups: [] };
            }
            if (!usesSwiftPMObjectIds(contents)) {
                return { outcome: 'not-swiftpm', backups: [] };
            }

            const stored = store.get<Record<string, SwiftPMProjectChoice>>(SWIFTPM_PROJECT_CHOICES_KEY, {})[projectFile];
            if (stored && !askEvenIfChosen) {
                return { outcome: stored, backups: [] };
            }

            const listed = filesVSXcodeChanges(projectRoot, projectFile, options.workspaceSettingsFile());
            const choice = await options.ask({
                projectFile,
                entries: listed.map((file) => ({ file, backup: nextBackupPath(file) }))
            });
            if (choice !== 'full' && choice !== 'keep') {
                log(`[swiftpm] ${projectFile}: dialog dismissed, workspace left unchanged`);
                return { outcome: 'dismissed', backups: [] };
            }

            const backups: string[] = [];
            if (choice === 'full') {
                // Listed again: the dialog can stay open while files come and go.
                for (const file of filesVSXcodeChanges(projectRoot, projectFile, options.workspaceSettingsFile())) {
                    backups.push(await backUpFile(file));
                }
            }
            // Re-read before writing, since another window on this workspace may have recorded a choice meanwhile.
            const latest = store.get<Record<string, SwiftPMProjectChoice>>(SWIFTPM_PROJECT_CHOICES_KEY, {});
            await store.update(SWIFTPM_PROJECT_CHOICES_KEY, { ...latest, [projectFile]: choice });
            log(`[swiftpm] ${projectFile}: ${choice === 'full' ? `managing fully, ${backups.length} backup(s) written` : 'kept as a SwiftPM package'}`);
            return { outcome: choice, backups };
        }
    };
}
