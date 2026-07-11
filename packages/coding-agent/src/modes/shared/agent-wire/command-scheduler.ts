import type { RpcCommand } from "../../rpc/rpc-types";

export const RPC_CANCELLATION_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
	"abort",
	"abort_bash",
	"abort_retry",
]);

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

export function createSharedRpcCommandScheduler<TResult>(
	run: (command: RpcCommand) => Promise<TResult>,
	track: (task: Promise<TResult>) => void = () => {},
): { dispatch: (command: RpcCommand) => Promise<TResult> } {
	let orderedTail = Promise.resolve();
	return {
		dispatch(command: RpcCommand): Promise<TResult> {
			const fastLane = isFastLaneRpcCommand(command.type);
			const task = fastLane ? run(command) : orderedTail.then(() => run(command));
			if (!fastLane) {
				orderedTail = task.then(
					() => undefined,
					() => undefined,
				);
			}
			track(task);
			return task;
		},
	};
}
