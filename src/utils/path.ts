import * as path from 'path';
import * as fs from 'fs';

export function determineTargetPath(rootPath: string, targetName: string, isTest: boolean, productName?: string): string {
    const names = [targetName];
    if (productName && productName !== targetName) {
        names.push(productName);
    }

    const relativeCandidates: string[] = [];
    for (const name of names) {
        if (isTest) {
            relativeCandidates.push(path.join('Tests', name));
            if (name.endsWith('Tests')) {
                relativeCandidates.push(path.join('Tests', name.replace(/Tests$/, '')));
            }
        } else {
            relativeCandidates.push(path.join('Sources', name));
        }
        relativeCandidates.push(name);
        relativeCandidates.push(path.join('Sources', 'Shared', name));
    }

    for (const relativeCandidate of relativeCandidates) {
        const absolute = path.join(rootPath, relativeCandidate);
        if (fs.existsSync(absolute)) {
            return relativeCandidate.split(path.sep).join('/');
        }
    }
    return targetName;
}
