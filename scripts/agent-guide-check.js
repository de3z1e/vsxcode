#!/usr/bin/env node
/**
 * Agent guide check: does the sidebar's agent prompt link the guide at the installed version's tag?
 *
 * The Copy Prompt for AI Agent button copies a one-line prompt that links docs/AGENT_README.md on
 * GitHub at the tag v<version>, which npm run release creates for every published version. This runs
 * the compiled src/utils/agentGuide.ts over the repository URL forms package.json may use, checks
 * that this repository's package.json yields such a link and that the guide exists at the linked
 * path, and checks the prompt's wording.
 *
 * Usage: npm run test:agent-guide
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { AGENT_GUIDE_PATH, agentGuideUrl, agentGuidePrompt } = require(path.join(ROOT, 'out', 'utils/agentGuide.js'));

let failures = 0;
function report(ok, label, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
    if (!ok) { failures += 1; }
}

const link = 'https://raw.githubusercontent.com/de3z1e/vsxcode/v3.12.0/docs/AGENT_README.md';
function expectUrl(label, repositoryUrl, expected) {
    const url = agentGuideUrl(repositoryUrl, '3.12.0');
    report(url === expected, label, url);
}

console.log('repository URL forms');
expectUrl('https with .git', 'https://github.com/de3z1e/vsxcode.git', link);
expectUrl('https without .git', 'https://github.com/de3z1e/vsxcode', link);
expectUrl('git+https', 'git+https://github.com/de3z1e/vsxcode.git', link);
expectUrl('trailing slash', 'https://github.com/de3z1e/vsxcode/', link);
expectUrl('a host other than GitHub gives no link', 'https://gitlab.com/de3z1e/vsxcode.git', undefined);
expectUrl('a URL below the repository gives no link', 'https://github.com/de3z1e/vsxcode/tree/main', undefined);
expectUrl('no repository URL gives no link', undefined, undefined);

console.log('this repository');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const own = agentGuideUrl(pkg.repository && pkg.repository.url, pkg.version);
report(
    own !== undefined && own.startsWith('https://raw.githubusercontent.com/') && own.endsWith(`/v${pkg.version}/${AGENT_GUIDE_PATH}`),
    `package.json links the guide at v${pkg.version}`,
    own
);
report(fs.existsSync(path.join(ROOT, AGENT_GUIDE_PATH)), `${AGENT_GUIDE_PATH} exists, so every tagged release carries it`);

console.log('prompt');
const base = { guideUrl: link, version: '3.12.0' };
const full = agentGuidePrompt({ ...base, projectFile: 'MyApp.xcodeproj', schemeName: 'MyApp' });
report(full.includes(link) && full.includes('version 3.12.0'), 'names the link and the version');
report(full.endsWith("VSXcode's selected project is MyApp.xcodeproj, scheme MyApp."), 'ends with the selected project and scheme', full);
const projectOnly = agentGuidePrompt({ ...base, projectFile: 'MyApp.xcodeproj' });
report(projectOnly.endsWith("VSXcode's selected project is MyApp.xcodeproj."), 'a project without a scheme', projectOnly);
report(!agentGuidePrompt(base).includes('selected project'), 'no stored selection, no selection sentence');
report(!/[\r\n\t]/.test(agentGuidePrompt({ ...base, projectFile: 'My\nApp.xcodeproj', schemeName: 'My\tApp' })), 'stays on one line');

if (failures > 0) {
    console.log(`\n${failures} agent guide check failure(s).`);
    process.exit(1);
}
console.log('\nAgent guide check OK.');
