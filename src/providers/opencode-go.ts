/**
 * Upstream override for the `opencode-go/*` models.
 *
 * Auto-discovered by `src/providers/registry.ts`. Copy this file to add
 * behavior for another upstream; every hook is optional. Hooks must never do
 * network I/O, and a thrown error is caught by the dispatcher and bypassed.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { OutgoingBody, UpstreamMeta } from "./registry.ts";

/**
 * Header Bifrost forwards upstream so opencode can stick one Pi session to one
 * backend. The `x-bf-eh-` prefix is Bifrost's extra-header passthrough.
 */
export const OPENCODE_SESSION_HEADER = "x-bf-eh-x-opencode-session";

/**
 * Attach the Pi session id so opencode's session affinity resolves.
 *
 * @param headers - Outgoing request headers, mutated in place.
 * @param meta - Upstream identity, including the Pi session id when available.
 * @returns Nothing; the header is set only when a session id exists.
 * @remarks
 * opencode requires a stable per-session identifier, and Bifrost forwards
 * `x-bf-eh-*` headers untouched, so no client-side rebuild is needed.
 */
export async function processHeaders(headers: Headers, meta: UpstreamMeta): Promise<void> {
	const sessionId = meta.sessionId;
	if (!sessionId) return;
	headers.set(OPENCODE_SESSION_HEADER, sessionId);
}

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
