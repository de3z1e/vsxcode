import type { ResourceOutput } from '../types/interfaces';
import { PROCESSABLE_RESOURCE_EXTENSIONS } from '../types/constants';
import { cleanup } from '../utils/version';
import * as path from 'path';

export function determineResourceType(filePath: string): '.process' | '.copy' {
    const ext = path.extname(filePath).toLowerCase();
    return PROCESSABLE_RESOURCE_EXTENSIONS.has(ext) ? '.process' : '.copy';
}

export function parseResourcesBuildPhase(
    pbxContents: string,
    resourcesBuildPhaseId: string
): string[] {
    if (!resourcesBuildPhaseId) {
        return [];
    }

    const phaseRegex = new RegExp(
        resourcesBuildPhaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        /\s*\/\*\s*Resources\s*\*\/\s*=\s*\{[^}]*files = \(([\s\S]*?)\);/.source
    );
    const phaseMatch = phaseRegex.exec(pbxContents);
    if (!phaseMatch) {
        return [];
    }

    const fileRefs: string[] = [];
    const fileRefRegex = /([A-F0-9]{24})\s*\/\*\s*([^*]+)\s*\*\//g;
    let match: RegExpExecArray | null;
    while ((match = fileRefRegex.exec(phaseMatch[1])) !== null) {
        const fileName = cleanup(match[2]);
        if (fileName.includes(' in Resources')) {
            const resourceName = fileName.replace(' in Resources', '').trim();
            fileRefs.push(resourceName);
        }
    }

    return fileRefs;
}

export function buildResourceOutputs(fileNames: string[]): ResourceOutput[] {
    if (fileNames.length === 0) {
        return [];
    }

    const dirSet = new Set<string>();
    const individualFiles: ResourceOutput[] = [];

    for (const fileName of fileNames) {
        const ext = path.extname(fileName).toLowerCase();
        const resourceType = determineResourceType(fileName);

        if (PROCESSABLE_RESOURCE_EXTENSIONS.has(ext)) {
            dirSet.add('Resources');
        } else {
            individualFiles.push({ type: resourceType, path: fileName });
        }
    }

    const outputs: ResourceOutput[] = [];

    if (dirSet.has('Resources')) {
        outputs.push({ type: '.process', path: 'Resources' });
    }

    for (const file of individualFiles) {
        outputs.push(file);
    }

    return outputs;
}

export function parseResourcesForTarget(
    pbxContents: string,
    resourcesBuildPhaseId: string | undefined
): ResourceOutput[] {
    if (!resourcesBuildPhaseId) {
        return [];
    }
    const fileNames = parseResourcesBuildPhase(pbxContents, resourcesBuildPhaseId);
    return buildResourceOutputs(fileNames);
}
