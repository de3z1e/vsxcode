#!/usr/bin/env node
/**
 * Release: publish the current version to the VS Code Marketplace and tag the commit it was built from.
 *
 * Publishing only from a clean main that matches origin/main means the published build is exactly
 * the tagged commit: `npx vsce publish` compiles first through the vscode:prepublish script, and out/
 * is not tracked. A check that can't run (offline, say) counts as failed.
 *
 * Usage: npm run release [-- --dry-run]
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function git(args) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return {
        ok: result.status === 0,
        out: (result.stdout || '').trim(),
        err: (result.stderr || '').trim() || (result.error ? result.error.message : `git exited with ${result.status}`),
    };
}

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tag = `v${version}`;
const problems = [];

const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
if (!branch.ok) {
    problems.push('HEAD is detached; check out main.');
} else if (branch.out !== 'main') {
    problems.push(`The current branch is ${branch.out}, not main.`);
}

const status = git(['status', '--porcelain', '--untracked-files=no']);
if (!status.ok) {
    problems.push(`Couldn't read the working tree status: ${status.err}`);
} else if (status.out !== '') {
    problems.push('Tracked files have uncommitted changes; commit or stash them.');
}

const head = git(['rev-parse', 'HEAD']);
const fetched = git(['fetch', '--quiet', 'origin', 'main']);
if (!fetched.ok) {
    problems.push(`Couldn't fetch origin main: ${fetched.err}`);
} else {
    const upstream = git(['rev-parse', 'origin/main']);
    if (!head.ok || !upstream.ok) {
        problems.push(`Couldn't compare HEAD with origin/main: ${head.ok ? upstream.err : head.err}`);
    } else if (head.out !== upstream.out) {
        problems.push(`HEAD (${head.out.slice(0, 7)}) doesn't match origin/main (${upstream.out.slice(0, 7)}); push or pull first.`);
    }
}

const localTag = git(['tag', '--list', tag]);
if (!localTag.ok) {
    problems.push(`Couldn't list local tags: ${localTag.err}`);
} else if (localTag.out !== '') {
    problems.push(`${tag} already exists locally.`);
}
const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
if (!remoteTag.ok) {
    problems.push(`Couldn't list origin's tags: ${remoteTag.err}`);
} else if (remoteTag.out !== '') {
    problems.push(`${tag} already exists on origin.`);
}

if (problems.length > 0) {
    console.error(`Not releasing ${version}:`);
    for (const problem of problems) { console.error(`  - ${problem}`); }
    process.exit(1);
}

const tagCommand = `git tag -a ${tag} -m "VSXcode ${version}" ${head.out}`;
const pushCommand = `git push origin ${tag}`;
if (dryRun) {
    console.log(`Ready to release ${version}. Would run:`);
    for (const command of ['npx vsce publish', tagCommand, pushCommand]) { console.log(`  ${command}`); }
    process.exit(0);
}

const publish = spawnSync('npx', ['vsce', 'publish'], { cwd: ROOT, stdio: 'inherit' });
if (publish.status !== 0) {
    console.error(`\nnpx vsce publish failed${publish.error ? `: ${publish.error.message}` : ''}. Nothing was tagged.`);
    process.exit(1);
}

const tagged = git(['tag', '-a', tag, '-m', `VSXcode ${version}`, head.out]);
const pushed = tagged.ok ? git(['push', 'origin', tag]) : undefined;
if (!tagged.ok || !pushed.ok) {
    const failure = tagged.ok ? `pushing ${tag} failed: ${pushed.err}` : `creating ${tag} failed: ${tagged.err}`;
    console.error(`\nPublished ${version}, but ${failure}`);
    console.error('Finish by hand:');
    if (!tagged.ok) { console.error(`  ${tagCommand}`); }
    console.error(`  ${pushCommand}`);
    process.exit(1);
}
console.log(`\nReleased ${version} and pushed ${tag} (${head.out.slice(0, 7)}).`);
