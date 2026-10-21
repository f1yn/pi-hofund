/**
 * Example upstream override for the `opencode-go/*` models.
 *
 * Auto-discovered by `src/providers/registry.ts`. Copy this file to add
 * behavior for another upstream; both hooks are optional. Hooks must never do
 * network I/O, and a thrown error is caught by the dispatcher and bypassed.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { OutgoingBody, UpstreamMeta } from "./registry.ts";

/**
 * Optional: inspect or mutate the outgoing chat-completions body for
 * `opencode-go/*` models. Mutate `body` in place, or return a replacement.
 * This example is a no-op.
 */
export async function processOutgoing(body: OutgoingBody, _meta: UpstreamMeta): Promise<void> {
	// Example (disabled): normalize a field Bifrost's upstream rejects.
	// if (Array.isArray(body.messages)) body.messages = body.messages.filter(Boolean);
	void body;
}

/**
 * Optional: inspect or mutate each streamed event for `opencode-go/*` models.
 * Mutate `event.partial`, or return a replacement event. This example is a
 * no-op.
 */
export async function processIncoming(
	_event: AssistantMessageEvent,
	_meta: UpstreamMeta,
): Promise<void> {
	return;
}
