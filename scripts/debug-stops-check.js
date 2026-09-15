#!/usr/bin/env node
/**
 * Debug-stop check: does the lldb-dap stop classifier resume only launch artifacts?
 *
 * The tracker in src/extension.ts auto-continues the stops a --start-stopped device launch
 * produces (SIGSTOP, internal breakpoints, a leaked initial-attach stop) and must leave every
 * user-visible stop alone. Two user stops share their shape with those artifacts: a step stop has
 * no breakpoint ids, and lldb-dap reports a user pause exactly like the launch SIGSTOP. This runs
 * the compiled src/utils/debugStops.ts over stop bodies recorded from real sessions.
 *
 * Usage: npm run test:debug-stops
 */
'use strict';

const path = require('path');

const OUT = path.join(path.resolve(__dirname, '..'), 'out');
const { classifyStop, pendingUserStopAfterRequest } = require(path.join(OUT, 'utils/debugStops.js'));

let failures = 0;
function report(ok, label, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
    if (!ok) { failures += 1; }
}
function expect(label, body, pending, action) {
    const verdict = classifyStop(body, pending);
    report(verdict.action === action, label, `${verdict.action}: ${verdict.why}`);
}

console.log('recorded on a simulator (Xcode 27 lldb-dap, 2026-09-15)');
const breakpointHit = { reason: 'breakpoint', description: 'breakpoint 1.1', hitBreakpointIds: [1], threadId: 38864737 };
const stepOver = { reason: 'step', description: 'step over', threadId: 38864737 };
const sigstop = { reason: 'exception', description: 'signal SIGSTOP', threadId: 38864737 };
expect('breakpoint hit stays', breakpointHit, null, 'leave');
expect('step stop stays', stepOver, null, 'leave');
expect('step stop stays with a pending step', stepOver, 'step', 'leave');
expect('user pause (SIGSTOP after a pause request) stays', sigstop, 'pause', 'leave');

console.log('device-launch artifacts as recorded by d248c6c');
expect('launch SIGSTOP with nothing pending is resumed', sigstop, null, 'continue');
expect('initial attach stop without a reason is resumed', {}, null, 'continue');
expect('initial attach stop with reason none is resumed', { reason: 'none' }, null, 'continue');
expect('internal breakpoint (negative id, reason breakpoint) is resumed', { reason: 'breakpoint', hitBreakpointIds: [-1] }, null, 'continue');
expect('internal breakpoints (negative ids, no reason) are resumed', { hitBreakpointIds: [-3, -4] }, null, 'continue');
expect('internal breakpoint hit mid-step is still resumed', { reason: 'breakpoint', hitBreakpointIds: [-2] }, 'step', 'continue');
expect('mixed ids count as a user breakpoint', { reason: 'breakpoint', hitBreakpointIds: [-1, 2] }, null, 'leave');

console.log('never resumed');
expect('a crash stays', { reason: 'exception', description: 'EXC_BAD_ACCESS (code=1, address=0x0)' }, null, 'leave');
expect('a crash stays even with internal-looking ids', { reason: 'exception', description: 'signal SIGABRT', hitBreakpointIds: [-1] }, null, 'leave');
expect('a watchpoint stays', { reason: 'watchpoint' }, null, 'leave');
expect('an unrecognized reason stays', { reason: 'somethingnew' }, null, 'leave');
expect('a pause reported as pause stays', { reason: 'pause' }, null, 'leave');

console.log('pending mark transitions');
report(pendingUserStopAfterRequest('next', null) === 'step', 'next → step');
report(pendingUserStopAfterRequest('stepIn', null) === 'step', 'stepIn → step');
report(pendingUserStopAfterRequest('stepOut', null) === 'step', 'stepOut → step');
report(pendingUserStopAfterRequest('pause', null) === 'pause', 'pause → pause');
report(pendingUserStopAfterRequest('continue', 'step') === null, 'continue clears the mark');
report(pendingUserStopAfterRequest('reverseContinue', 'pause') === null, 'reverseContinue clears the mark');
report(classifyStop({ reason: 'somethingnew' }, null).kind === 'unrecognized', 'unrecognized verdicts carry the kind the tracker logs on');
report(pendingUserStopAfterRequest('threads', 'pause') === 'pause', 'an unrelated request leaves the mark');

if (failures > 0) {
    console.log(`\n${failures} debug-stop check failure(s).`);
    process.exit(1);
}
console.log('\nDebug-stop check OK.');
