/**
 * The project-file edit operations the sync uses, for either format: a pbxproj goes to `pbxproj.ts` and Xcode's JSON
 * project file to `xcproj.ts`. Only the JSON session can decline an operation; when it does, the change it belongs to is
 * undone (`beginChange` … `endChange`) and the rest of the session goes on. No vscode import.
 */
import { readProject } from '../parsers/projectIndex';
import * as pbxproj from './pbxproj';
import type { ElementPathChange } from './pbxproj';
import * as xcproj from './xcproj';

export type { ElementPathChange };
export { anyEntry } from './pbxproj';

/** A run of edits on one read of either format. */
export type ProjectEdit = pbxproj.ProjectEdit | xcproj.XcprojEdit;

/** Starts a run of edits; null when the text can't be read. `log` hears why a JSON operation declined. */
export function beginProjectEdit(contents: string, log: (message: string) => void = () => undefined): ProjectEdit | null {
    const index = readProject(contents);
    if (typeof index === 'string') { return null; }
    return index.format === 'xcproj' ? xcproj.beginXcprojEdit(contents, log) : pbxproj.beginProjectEdit(contents);
}

/** Registers a Swift file in a group and a Sources phase: the new file's id, or undefined when a JSON edit declined. */
export function addSwiftFile(edit: ProjectEdit, fileName: string, groupId: string, sourcesBuildPhaseId: string): string | undefined {
    return edit.format === 'xcproj'
        ? xcproj.addSwiftFile(edit, fileName, groupId, sourcesBuildPhaseId)
        : pbxproj.addSwiftFile(edit, fileName, groupId, sourcesBuildPhaseId);
}

export function removeSwiftFile(edit: ProjectEdit, fileReferenceId: string): void {
    if (edit.format === 'xcproj') { xcproj.removeSwiftFile(edit, fileReferenceId); } else { pbxproj.removeSwiftFile(edit, fileReferenceId); }
}

export function renameSwiftFile(edit: ProjectEdit, fileReferenceId: string, fileName: string): void {
    if (edit.format === 'xcproj') {
        xcproj.renameSwiftFile(edit, fileReferenceId, fileName);
    } else {
        pbxproj.renameSwiftFile(edit, fileReferenceId, fileName);
    }
}

export function rehomeSwiftFile(edit: ProjectEdit, fileReferenceId: string, groupId: string, fileName: string): void {
    if (edit.format === 'xcproj') {
        xcproj.rehomeSwiftFile(edit, fileReferenceId, groupId, fileName);
    } else {
        pbxproj.rehomeSwiftFile(edit, fileReferenceId, groupId, fileName);
    }
}

export function moveElement(
    edit: ProjectEdit,
    id: string,
    groupId: string,
    elementPath: string,
    shownName: string,
    comparable: ((name: string) => boolean) | null
): void {
    if (edit.format === 'xcproj') {
        xcproj.moveElement(edit, id, groupId, elementPath, shownName, comparable);
    } else {
        pbxproj.moveElement(edit, id, groupId, elementPath, shownName, comparable);
    }
}

export function setFileReferencePath(edit: ProjectEdit, fileReferenceId: string, newPath: string): void {
    if (edit.format === 'xcproj') {
        xcproj.setFileReferencePath(edit, fileReferenceId, newPath);
    } else {
        pbxproj.setFileReferencePath(edit, fileReferenceId, newPath);
    }
}

export function setElementPaths(edit: ProjectEdit, changes: readonly ElementPathChange[]): void {
    if (edit.format === 'xcproj') { xcproj.setElementPaths(edit, changes); } else { pbxproj.setElementPaths(edit, changes); }
}

/** Creates nested groups for folders under a group: the deepest group's id, or undefined when a JSON edit declined. */
export function addGroupPath(edit: ProjectEdit, parentGroupId: string, folderNames: string[]): string | undefined {
    return edit.format === 'xcproj'
        ? xcproj.addGroupPath(edit, parentGroupId, folderNames)
        : pbxproj.addGroupPath(edit, parentGroupId, folderNames);
}

/** Opens a change: until `endChange`, a JSON decline undoes everything since. Nothing for a pbxproj, which never declines. */
export function beginChange(edit: ProjectEdit): void {
    if (edit.format === 'xcproj') { xcproj.beginChange(edit); }
}

/** Closes the change; whether it landed. Always true for a pbxproj. */
export function endChange(edit: ProjectEdit): boolean {
    return edit.format === 'xcproj' ? xcproj.endChange(edit) : true;
}

/** The text to write: a pbxproj session's as it is; a JSON session's once it reads back as a project, else the input. */
export function projectEditText(edit: ProjectEdit): string {
    return edit.format === 'xcproj' ? xcproj.xcprojEditText(edit) : edit.contents;
}

/** Why a session's text wasn't written (a JSON read-back that failed); undefined otherwise, and always for a pbxproj. */
export function editDeclined(edit: ProjectEdit): string | undefined {
    return edit.format === 'xcproj' ? xcproj.xcprojEditDeclined(edit) : undefined;
}
