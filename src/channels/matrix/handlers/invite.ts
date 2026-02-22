/**
 * Invite Handler
 *
 * Handles room membership events (invites, joins, leaves).
 */

import type * as sdk from "matrix-js-sdk";
import type { DmPolicy } from "../../../pairing/types.js";

interface InviteHandlerContext {
	client: sdk.MatrixClient;
	event: sdk.MatrixEvent;
	member: sdk.RoomMember;
	dmPolicy: DmPolicy;
	allowedUsers: string[];
	autoAccept: boolean;
	// Optional storage for cleanup when bot leaves room
	storage?: {
		deleteConversationForRoom: (roomId: string) => void;
	};
	ourUserId?: string;
}

/**
 * Handle a room membership event
 */
export async function handleMembershipEvent(ctx: InviteHandlerContext): Promise<void> {
	const { client, event, member, dmPolicy, allowedUsers, autoAccept, storage, ourUserId } = ctx;

	const membership = member.membership;
	const sender = event.getSender();

	if (!sender) return;

	switch (membership) {
		case "invite":
			await handleInvite(client, member, sender, dmPolicy, allowedUsers, autoAccept);
			break;
		case "join":
			handleJoin(member);
			break;
		case "leave":
			handleLeave(member, storage, ourUserId);
			break;
	}
}

/**
 * Handle an invite
 */
async function handleInvite(
	client: sdk.MatrixClient,
	member: sdk.RoomMember,
	sender: string,
	dmPolicy: DmPolicy,
	allowedUsers: string[],
	autoAccept: boolean,
): Promise<void> {
	console.log(`[MatrixInvite] Received invite to ${member.roomId} from ${sender}`);

	if (!autoAccept) {
		console.log(`[MatrixInvite] Auto-accept disabled, ignoring invite`);
		return;
	}

	// Check if we should accept based on policy
	if (dmPolicy === "allowlist") {
		const isAllowed = allowedUsers.includes(sender);
		if (!isAllowed) {
			console.log(`[MatrixInvite] Rejecting invite from non-allowed user: ${sender}`);
			return;
		}
	}

	try {
		await client.joinRoom(member.roomId);
		console.log(`[MatrixInvite] Joined room: ${member.roomId}`);
	} catch (err) {
		console.error(`[MatrixInvite] Failed to join room: ${err}`);
	}
}

/**
 * Handle a join
 */
function handleJoin(member: sdk.RoomMember): void {
	console.log(`[MatrixInvite] User ${member.userId} joined ${member.roomId}`);
}

/**
 * Handle a leave
 */
function handleLeave(
	member: sdk.RoomMember,
	storage?: { deleteConversationForRoom: (roomId: string) => void },
	ourUserId?: string,
): void {
	console.log(`[MatrixInvite] User ${member.userId} left ${member.roomId}`);

	// If OUR user left the room, clean up the conversation mapping
	if (ourUserId && member.userId === ourUserId) {
		console.log(`[MatrixInvite] Our user left room ${member.roomId}, cleaning up conversation mapping...`);
		storage?.deleteConversationForRoom(member.roomId);
	}
}
