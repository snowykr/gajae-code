import type { RpcCommand } from "../../rpc/rpc-types";

/** Commands that must interrupt an in-flight ordered operation. */
export const RPC_CANCELLATION_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
	"abort",
	"abort_bash",
	"abort_retry",
]);

/** Synchronous, side-effect-free reads that may bypass the ordered mutation chain. */
export const RPC_SAFE_READ_CONTROL_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
	"get_state",
	"get_session_stats",
	"get_available_models",
	"get_branch_messages",
	"get_last_assistant_text",
	"get_messages",
	"get_login_providers",
	"get_pending_workflow_gates",
]);

export function isFastLaneRpcCommand(type: RpcCommand["type"]): boolean {
	return RPC_CANCELLATION_COMMANDS.has(type) || RPC_SAFE_READ_CONTROL_COMMANDS.has(type);
}

export interface RpcCommandScheduler<T> {
	dispatch(command: RpcCommand): Promise<T>;
}

/**
 * Shared RPC/Bridge command scheduler. Fast lanes execute immediately; all
 * mutating and asynchronous commands share one causal chain. A failed command
 * does not poison later commands in that chain.
 */
export function createRpcCommandScheduler<T>(
	run: (command: RpcCommand) => Promise<T>,
	track?: (task: Promise<T>) => void,
): RpcCommandScheduler<T> {
	let orderedChain: Promise<void> = Promise.resolve();
	return {
		dispatch(command: RpcCommand): Promise<T> {
			if (isFastLaneRpcCommand(command.type)) {
				const task = run(command);
				track?.(task);
				return task;
			}
			const task = orderedChain.then(() => run(command));
			orderedChain = task.then(
				() => undefined,
				() => undefined,
			);
			track?.(task);
			return task;
		},
	};
}
