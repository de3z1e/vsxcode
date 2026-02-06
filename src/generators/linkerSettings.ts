export function generateLinkerSettings(frameworkNames: string[]): string[] {
    return frameworkNames.map((name) => `.linkedFramework("${name}")`);
}
