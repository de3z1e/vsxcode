import type { ResourceOutput } from '../types/interfaces';

export function formatResourceEntry(resource: ResourceOutput): string {
    return `${resource.type}("${resource.path}")`;
}

export function generateResourceEntries(resources: ResourceOutput[]): string[] {
    return resources.map(formatResourceEntry);
}
