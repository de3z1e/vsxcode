// No vscode import: scripts/agent-guide-check.js loads this in plain Node.

export const AGENT_GUIDE_PATH = 'docs/AGENT_README.md';

const GITHUB_REPOSITORY = /^(?:git\+)?https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** Pinned to tag `v<version>` so the agent reads the guide for the installed release; undefined unless GitHub https. */
export function agentGuideUrl(repositoryUrl: string | undefined, version: string): string | undefined {
    const match = GITHUB_REPOSITORY.exec(repositoryUrl ?? '');
    if (!match) {
        return undefined;
    }
    return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/v${version}/${AGENT_GUIDE_PATH}`;
}

export interface AgentPromptInput {
    guideUrl: string;
    version: string;
    /** Relative to the workspace root, as BuildTaskConfig stores it. */
    projectFile?: string;
    schemeName?: string;
}

/** Names the selection because it lives in workspace state, where an agent can't read it. */
export function agentGuidePrompt(input: AgentPromptInput): string {
    const sentences = [
        `This workspace uses the VSXcode extension (version ${input.version}) to build, run, debug and test its Xcode project.`,
        `Before changing anything, read ${input.guideUrl}: it lists what VSXcode does automatically and which of its commands to use instead of raw xcodebuild.`,
    ];
    if (input.projectFile) {
        sentences.push(input.schemeName
            ? `VSXcode's selected project is ${input.projectFile}, scheme ${input.schemeName}.`
            : `VSXcode's selected project is ${input.projectFile}.`);
    }
    // One line, so pasting it into a terminal agent can't submit it early.
    return sentences.join(' ').replace(/\s+/g, ' ');
}
