// ── lldb-dap stop classification ─────────────────────────
//
// A --start-stopped device launch produces stops that are debugger artifacts and must be resumed
// silently: its SIGSTOP, a leaked initial-attach stop with no reason, and internal negative-id
// breakpoint stops lldb-dap leaks on dyld image notifications (LLVM PR #173848, not yet in Xcode).
// lldb-dap reports a user pause exactly like the launch SIGSTOP (`exception`, "signal SIGSTOP"),
// so the client's last request is part of the decision.

/** The user's last resume-style request, which the next stop belongs to. */
export type PendingUserStop = 'step' | 'pause' | null;

export interface StoppedEventBody {
    reason?: string;
    description?: string;
    hitBreakpointIds?: number[];
    threadId?: number;
}

export type StopKind =
    | 'exception' | 'user-breakpoint' | 'internal-breakpoint' | 'user-request'
    | 'launch-sigstop' | 'user-stop' | 'initial-attach' | 'unrecognized';

export interface StopVerdict {
    action: 'continue' | 'leave';
    kind: StopKind;
    why: string;
}

const STEP_REQUESTS = new Set(['next', 'stepIn', 'stepOut', 'stepBack', 'goto']);

/** Stop reasons the user asked for or would expect; never resumed on their behalf. */
const USER_STOP_REASONS = new Set([
    'step', 'pause', 'breakpoint', 'function breakpoint', 'data breakpoint', 'instruction breakpoint',
    'watchpoint', 'entry', 'goto'
]);

/** The launch artifact and a user pause both look like this; only the pending mark tells them apart. */
function isSIGSTOP(body: StoppedEventBody): boolean {
    return body.reason === 'exception' && (body.description ?? '').startsWith('signal SIGSTOP');
}

/** What the mark becomes after the client sends `command`: steps and pauses set it, continue clears it. */
export function pendingUserStopAfterRequest(command: string, previous: PendingUserStop): PendingUserStop {
    if (STEP_REQUESTS.has(command)) { return 'step'; }
    if (command === 'pause') { return 'pause'; }
    if (command === 'continue' || command === 'reverseContinue') { return null; }
    return previous;
}

/**
 * Whether a `stopped` event (after configurationDone) is a launch artifact to resume or a stop
 * to leave to the user. Order matters: a crash is never resumed whatever it carries; breakpoint
 * ids decide before any reason, since the reason on an internal-breakpoint stop is not recorded
 * and may well read `breakpoint`; the pending mark protects a user pause from the SIGSTOP rule.
 */
export function classifyStop(body: StoppedEventBody, pending: PendingUserStop): StopVerdict {
    const reason = body.reason ?? '';
    const ids = body.hitBreakpointIds ?? [];

    if (reason === 'exception' && !isSIGSTOP(body)) {
        return { action: 'leave', kind: 'exception', why: `exception (${body.description ?? 'no description'})` };
    }
    if (ids.length > 0) {
        return ids.some((id) => id >= 0)
            ? { action: 'leave', kind: 'user-breakpoint', why: `user breakpoint (${ids.join(', ')})` }
            : { action: 'continue', kind: 'internal-breakpoint', why: `internal breakpoint (${ids.join(', ')})` };
    }
    if (pending === 'step' || pending === 'pause') {
        return { action: 'leave', kind: 'user-request', why: `user ${pending}` };
    }
    if (isSIGSTOP(body)) {
        return { action: 'continue', kind: 'launch-sigstop', why: 'SIGSTOP from --start-stopped' };
    }
    if (USER_STOP_REASONS.has(reason)) {
        return { action: 'leave', kind: 'user-stop', why: `user stop (${reason})` };
    }
    if (reason === '' || reason === 'none' || reason === 'unknown') {
        return { action: 'continue', kind: 'initial-attach', why: `initial attach stop (reason ${reason || 'absent'})` };
    }
    return { action: 'leave', kind: 'unrecognized', why: `unrecognized reason "${reason}"` };
}
