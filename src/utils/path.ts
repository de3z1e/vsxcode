import * as path from 'path';
import * as fs from 'fs';

export function determineTargetPath(rootPath: string, targetName: string, isTest: boolean): string {
    const relativeCandidates: string[] = [];
    if (isTest) {
        relativeCandidates.push(path.join('Tests', targetName));
        if (targetName.endsWith('Tests')) {
            relativeCandidates.push(path.join('Tests', targetName.replace(/Tests$/, '')));
        }
    } else {
        relativeCandidates.push(path.join('Sources', targetName));
    }
    relativeCandidates.push(targetName);
    relativeCandidates.push(path.join('Sources', 'Shared', targetName));

    for (const relativeCandidate of relativeCandidates) {
        const absolute = path.join(rootPath, relativeCandidate);
        if (fs.existsSync(absolute)) {
            return relativeCandidate.split(path.sep).join('/');
        }
    }
    return targetName;
}
