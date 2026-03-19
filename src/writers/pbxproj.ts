import * as crypto from 'crypto';

// ── ID Generation ────────────────────────────────────────

export function collectExistingIds(pbxContents: string): Set<string> {
    const ids = new Set<string>();
    const idRegex = /\b([A-F0-9]{24})\b/g;
    let match: RegExpExecArray | null;
    while ((match = idRegex.exec(pbxContents)) !== null) {
        ids.add(match[1]);
    }
    return ids;
}

export function generateUniqueId(existingIds: Set<string>): string {
    let id: string;
    do {
        id = crypto.randomBytes(12).toString('hex').toUpperCase();
    } while (existingIds.has(id));
    return id;
}

// ── Helpers ──────────────────────────────────────────────

function needsQuoting(value: string): boolean {
    return /[^A-Za-z0-9._]/.test(value);
}

function formatPath(fileName: string): string {
    return needsQuoting(fileName) ? `"${fileName}"` : fileName;
}

function extractCommentName(line: string): string | null {
    const match = /\/\*\s*([^*]+?)\s*\*\//.exec(line);
    return match ? match[1] : null;
}

/** Extract leading whitespace from the first line containing a pbxproj ID. */
function detectIndent(lines: string[], fallback: string): string {
    for (const line of lines) {
        const m = /^(\s+)[A-F0-9]{24}\s/.exec(line);
        if (m) { return m[1]; }
    }
    return fallback;
}

/** Find the insertion offset within a pbxproj section to maintain ascending ID order. */
function findIdOrderInsertOffset(
    pbxContents: string,
    sectionStartIdx: number,
    sectionEndIdx: number,
    newId: string
): number {
    const sectionBody = pbxContents.slice(sectionStartIdx, sectionEndIdx);
    const lines = sectionBody.split('\n');
    const idPattern = /^\s*([A-F0-9]{24})\s/;

    let offset = sectionStartIdx;
    for (const line of lines) {
        const match = idPattern.exec(line);
        if (match && match[1] > newId) {
            return offset;
        }
        offset += line.length + 1;
    }
    return sectionEndIdx;
}

/** Find the alphabetical insertion offset among .swift entries only. */
function findAlphabeticalInsertOffset(
    lines: string[],
    baseOffset: number,
    defaultOffset: number,
    fileName: string
): number {
    let lastSwiftLineEnd = -1;
    for (let i = 0; i < lines.length; i++) {
        const commentName = extractCommentName(lines[i]);
        if (!commentName) { continue; }

        // Only compare against other .swift entries
        const isSwift = commentName.endsWith('.swift') || commentName.includes('.swift ');
        if (!isSwift) { continue; }

        if (commentName.localeCompare(fileName, undefined, { sensitivity: 'base' }) > 0) {
            // Insert before this .swift entry
            let offset = baseOffset;
            for (let j = 0; j < i; j++) {
                offset += lines[j].length + 1;
            }
            return offset;
        }

        // Track the end of this .swift line as fallback insertion point
        let offset = baseOffset;
        for (let j = 0; j <= i; j++) {
            offset += lines[j].length + 1;
        }
        lastSwiftLineEnd = offset;
    }
    // Insert after the last .swift entry, or fall back to end
    return lastSwiftLineEnd !== -1 ? lastSwiftLineEnd : defaultOffset;
}

// ── Adding a File ────────────────────────────────────────

export function addFileReference(
    pbxContents: string,
    fileRefId: string,
    fileName: string
): string {
    const endMarker = '/* End PBXFileReference section */';
    const endIdx = pbxContents.indexOf(endMarker);
    if (endIdx === -1) { return pbxContents; }

    const startMarker = '/* Begin PBXFileReference section */';
    const startIdx = pbxContents.indexOf(startMarker);
    if (startIdx === -1) { return pbxContents; }

    const sectionBody = pbxContents.slice(startIdx, endIdx);
    const lines = sectionBody.split('\n');
    const indent = detectIndent(lines.slice(1), '\t\t');

    const entry = `${indent}${fileRefId} /* ${fileName} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${formatPath(fileName)}; sourceTree = "<group>"; };\n`;
    const insertAt = findIdOrderInsertOffset(pbxContents, startIdx, endIdx, fileRefId);
    return pbxContents.slice(0, insertAt) + entry + pbxContents.slice(insertAt);
}

export function addBuildFile(
    pbxContents: string,
    buildFileId: string,
    fileRefId: string,
    fileName: string
): string {
    const endMarker = '/* End PBXBuildFile section */';
    const endIdx = pbxContents.indexOf(endMarker);
    if (endIdx === -1) { return pbxContents; }

    const startMarker = '/* Begin PBXBuildFile section */';
    const startIdx = pbxContents.indexOf(startMarker);
    if (startIdx === -1) { return pbxContents; }

    const sectionBody = pbxContents.slice(startIdx, endIdx);
    const lines = sectionBody.split('\n');
    const indent = detectIndent(lines.slice(1), '\t\t');

    const entry = `${indent}${buildFileId} /* ${fileName} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${fileName} */; };\n`;
    const insertAt = findIdOrderInsertOffset(pbxContents, startIdx, endIdx, buildFileId);
    return pbxContents.slice(0, insertAt) + entry + pbxContents.slice(insertAt);
}

export function addToGroup(
    pbxContents: string,
    groupId: string,
    fileRefId: string,
    fileName: string
): string {
    // Find the group entry by its ID
    const groupPattern = new RegExp(
        groupId + '\\s*(?:\\/\\*[^*]*\\*\\/\\s*)?=\\s*\\{[\\s\\S]*?children\\s*=\\s*\\('
    );
    const groupMatch = groupPattern.exec(pbxContents);
    if (!groupMatch) { return pbxContents; }

    const childrenStart = groupMatch.index + groupMatch[0].length;

    // Find the closing paren of children = (...)
    const closingParenIdx = pbxContents.indexOf(')', childrenStart);
    if (closingParenIdx === -1) { return pbxContents; }

    const childrenBlock = pbxContents.slice(childrenStart, closingParenIdx);
    const childLines = childrenBlock.split('\n');
    const indent = detectIndent(childLines, '\t\t\t\t');
    const newEntry = `${indent}${fileRefId} /* ${fileName} */,\n`;

    // Default insertion: before the newline that precedes the closing )
    const lastNewline = pbxContents.lastIndexOf('\n', closingParenIdx);
    const defaultInsert = lastNewline !== -1 ? lastNewline + 1 : closingParenIdx;
    const insertOffset = findAlphabeticalInsertOffset(childLines, childrenStart, defaultInsert, fileName);
    return pbxContents.slice(0, insertOffset) + newEntry + pbxContents.slice(insertOffset);
}

export function addToSourcesBuildPhase(
    pbxContents: string,
    sourcesBuildPhaseId: string,
    buildFileId: string,
    fileName: string
): string {
    // Find the Sources build phase by its ID
    const phasePattern = new RegExp(
        sourcesBuildPhaseId + '\\s*(?:\\/\\*[^*]*\\*\\/\\s*)?=\\s*\\{[\\s\\S]*?files\\s*=\\s*\\('
    );
    const phaseMatch = phasePattern.exec(pbxContents);
    if (!phaseMatch) { return pbxContents; }

    const filesStart = phaseMatch.index + phaseMatch[0].length;
    const closingParenIdx = pbxContents.indexOf(')', filesStart);
    if (closingParenIdx === -1) { return pbxContents; }

    const filesBlock = pbxContents.slice(filesStart, closingParenIdx);
    const fileLines = filesBlock.split('\n');
    const indent = detectIndent(fileLines, '\t\t\t\t');
    const newEntry = `${indent}${buildFileId} /* ${fileName} in Sources */,\n`;

    // Insert before the newline that precedes the closing ), not at ) itself
    const lastNewline = pbxContents.lastIndexOf('\n', closingParenIdx);
    const insertAt = lastNewline !== -1 ? lastNewline + 1 : closingParenIdx;
    return pbxContents.slice(0, insertAt) + newEntry + pbxContents.slice(insertAt);
}

export function addSwiftFileToPbxproj(
    pbxContents: string,
    fileName: string,
    groupId: string,
    sourcesBuildPhaseId: string
): string {
    const existingIds = collectExistingIds(pbxContents);
    const buildFileId = generateUniqueId(existingIds);
    existingIds.add(buildFileId);
    const fileRefId = generateUniqueId(existingIds);

    let result = pbxContents;
    result = addBuildFile(result, buildFileId, fileRefId, fileName);
    result = addFileReference(result, fileRefId, fileName);
    result = addToGroup(result, groupId, fileRefId, fileName);
    result = addToSourcesBuildPhase(result, sourcesBuildPhaseId, buildFileId, fileName);
    return result;
}

// ── Finding entries for removal ──────────────────────────

export function findFileReferenceId(
    pbxContents: string,
    fileName: string
): string | null {
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `([A-F0-9]{24})\\s*\\/\\*\\s*${escaped}\\s*\\*\\/\\s*=\\s*\\{[^}]*isa\\s*=\\s*PBXFileReference`
    );
    const match = pattern.exec(pbxContents);
    return match ? match[1] : null;
}

export function findBuildFileId(
    pbxContents: string,
    fileRefId: string
): string | null {
    const pattern = new RegExp(
        `([A-F0-9]{24})\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*fileRef\\s*=\\s*${fileRefId}`
    );
    const match = pattern.exec(pbxContents);
    return match ? match[1] : null;
}

// ── Removing a File ──────────────────────────────────────

export function removeFileReference(
    pbxContents: string,
    fileRefId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${fileRefId}\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*\\};\\s*\\n`, 'm');
    return pbxContents.replace(pattern, '');
}

export function removeBuildFile(
    pbxContents: string,
    buildFileId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${buildFileId}\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*\\};\\s*\\n`, 'm');
    return pbxContents.replace(pattern, '');
}

export function removeFromGroup(
    pbxContents: string,
    fileRefId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${fileRefId}\\s*\\/\\*[^*]*\\*\\/,\\s*\\n`, 'gm');
    return pbxContents.replace(pattern, '');
}

export function removeFromSourcesBuildPhase(
    pbxContents: string,
    buildFileId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${buildFileId}\\s*\\/\\*[^*]*\\*\\/,\\s*\\n`, 'gm');
    return pbxContents.replace(pattern, '');
}

export function updateBuildSetting(
    pbxContents: string,
    configId: string,
    key: string,
    value: string
): string {
    // Match the XCBuildConfiguration block by its ID
    const blockRegex = new RegExp(
        `(${configId}\\s*/\\*[^*]*\\*/\\s*=\\s*\\{[^}]*buildSettings\\s*=\\s*\\{)((?:[^}]|\\}(?!;))*)(\\};\\s*name)`,
    );
    const blockMatch = blockRegex.exec(pbxContents);
    if (!blockMatch) { return pbxContents; }

    const settingsBlock = blockMatch[2];
    const settingRegex = new RegExp(`([ \\t]*)${key} = [^;]*;`);
    const existingMatch = settingRegex.exec(settingsBlock);

    let newSettings: string;
    if (existingMatch) {
        newSettings = settingsBlock.replace(settingRegex, `${existingMatch[1]}${key} = ${value};`);
    } else {
        // Insert new setting before the closing of buildSettings block
        const indentMatch = /^([ \t]+)\w/.exec(settingsBlock.split('\n').find(l => /^\s+\w/.test(l)) || '');
        const indent = indentMatch ? indentMatch[1] : '\t\t\t\t';
        const newLine = `\n${indent}${key} = ${value};`;
        // Try inserting before trailing whitespace, or append before end
        const trailingMatch = /(\n)([ \t]*$)/.exec(settingsBlock);
        if (trailingMatch) {
            newSettings = settingsBlock.replace(/(\n)([ \t]*$)/, `${newLine}\n$2`);
        } else {
            newSettings = settingsBlock + newLine + '\n';
        }
    }

    return pbxContents.slice(0, blockMatch.index) +
        blockMatch[1] + newSettings + blockMatch[3] +
        pbxContents.slice(blockMatch.index + blockMatch[0].length);
}

export function removeSwiftFileFromPbxproj(
    pbxContents: string,
    fileName: string
): string | null {
    const fileRefId = findFileReferenceId(pbxContents, fileName);
    if (!fileRefId) { return null; }

    const buildFileId = findBuildFileId(pbxContents, fileRefId);

    let result = pbxContents;
    if (buildFileId) {
        result = removeFromSourcesBuildPhase(result, buildFileId);
        result = removeBuildFile(result, buildFileId);
    }
    result = removeFromGroup(result, fileRefId);
    result = removeFileReference(result, fileRefId);
    return result;
}
