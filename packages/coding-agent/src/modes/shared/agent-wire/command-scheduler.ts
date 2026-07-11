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

export interface SharedRpcCommandReservation<TResult> {
	dispatch(command: RpcCommand): Promise<TResult>;
	cancel(): void;
}

export function createSharedRpcCommandScheduler<TResult>(
	run: (command: RpcCommand) => Promise<TResult>,
	track: (task: Promise<TResult>) => void = () => {},
): {
	dispatch: (command: RpcCommand) => Promise<TResult>;
	reserve: () => SharedRpcCommandReservation<TResult>;
} {
	let orderedTail = Promise.resolve();

	const reserve = (): SharedRpcCommandReservation<TResult> => {
		const prior = orderedTail;
		const slot = Promise.withResolvers<void>();
		let settled = false;
		let task: Promise<TResult> | undefined;
		orderedTail = slot.promise;

		return {
			dispatch(command): Promise<TResult> {
				if (settled) throw new Error("RPC command reservation already settled");
				settled = true;
				if (isFastLaneRpcCommand(command.type)) {
					slot.resolve();
					task = run(command);
				} else {
					task = prior.then(() => run(command));
					void task.then(
						() => slot.resolve(),
						() => slot.resolve(),
					);
				}
				track(task!);
				return task!;
			},
			cancel(): void {
				if (settled) return;
				settled = true;
				slot.resolve();
			},
		};
	};

	return {
		dispatch(command): Promise<TResult> {
			return reserve().dispatch(command);
		},
		reserve,
	};
}
