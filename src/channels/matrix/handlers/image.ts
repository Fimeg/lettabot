/**
 * Image Handler for Matrix Adapter
 *
 * Handles incoming image messages - processes immediately and sends to Letta.
 */

import type * as sdk from "matrix-js-sdk";
import type { InboundMessage } from "../../../core/types.js";
import { downloadAndDecryptMedia, type EncryptionInfo } from "../media.js";

export interface ImageHandlerContext {
	client: sdk.MatrixClient;
	room: sdk.Room;
	event: sdk.MatrixEvent;
	ourUserId: string;
	imageMaxSize: number;

	// Callbacks
	sendTyping: (roomId: string, typing: boolean) => Promise<void>;
	sendMessage: (roomId: string, text: string) => Promise<void>;
	addReaction: (roomId: string, eventId: string, emoji: string) => Promise<void>;
}

interface ImageInfo {
	mxcUrl?: string;
	encryptionInfo?: EncryptionInfo;
}

/**
 * Handle image messages - processes immediately and returns InboundMessage
 *
 * The ✅ reaction is added AFTER the image is successfully submitted to Letta.
 */
export async function handleImageMessage(
	ctx: ImageHandlerContext,
): Promise<InboundMessage | null> {
	const { client, room, event, ourUserId, imageMaxSize } = ctx;

	const sender = event.getSender();
	const roomId = room.roomId;
	const eventId = event.getId();

	if (!sender || !roomId || !eventId) return null;

	console.log(`[MatrixImage] Image from ${sender} in ${roomId}`);

	// Send typing indicator (image processing takes time)
	await ctx.sendTyping(roomId, true);

	try {
		const content = event.getContent();

		// Get image URL and encryption info
		const imageInfo = extractImageInfo(content);
		if (!imageInfo.mxcUrl) {
			throw new Error("No image URL found");
		}

		// Download and decrypt image (handles auth + E2EE)
		const imageData = await downloadAndDecryptMedia(client, imageInfo.mxcUrl, imageInfo.encryptionInfo);
		console.log(`[MatrixImage] Downloaded ${imageData.length} bytes`);

		// Detect format
		const format = detectImageFormat(imageData);
		console.log(`[MatrixImage] Format: ${format}`);

		// Validate size
		if (imageData.length > 10 * 1024 * 1024) {
			throw new Error("Image too large (max 10MB)");
		}

		// Stop typing
		await ctx.sendTyping(roomId, false);

		// Build inbound message with image attachment
		const isDm = room.getJoinedMembers().length === 2;
		const message: InboundMessage = {
			channel: "matrix",
			chatId: roomId,
			userId: sender,
			userName: extractDisplayName(sender),
			userHandle: sender,
			messageId: eventId,
			text: content.body as string || "Image", // Use body as caption, fallback to "Image"
			timestamp: new Date(event.getTs()),
			isGroup: !isDm,
			groupName: isDm ? undefined : room.name,
			attachments: [{
				kind: 'image',
				mimeType: `image/${format}`,
				data: imageData,
				caption: content.body as string || undefined,
			}],
		};

		console.log(`[MatrixImage] Image ready for submission (${imageData.length} bytes)`);

		// Return the message - let adapter add ✅ after successful submission
		return message;
	} catch (err) {
		console.error("[MatrixImage] Failed to process image:", err);
		await ctx.sendTyping(roomId, false);
		await ctx.sendMessage(roomId, `Failed to process image: ${err instanceof Error ? err.message : "Unknown error"}`);
		return null;
	}
}

function extractImageInfo(content: Record<string, unknown>): ImageInfo {
	const file = content.file as Record<string, unknown> | undefined;
	const url = content.url as string | undefined;

	if (file?.url) {
		return {
			mxcUrl: file.url as string,
			encryptionInfo: {
				key: file.key as { k: string },
				iv: file.iv as string,
				hashes: file.hashes as { sha256: string },
			},
		};
	}

	if (url) {
		return { mxcUrl: url };
	}

	return {};
}

function detectImageFormat(data: Buffer): string {
	if (data.length < 4) return "unknown";

	// JPEG: FF D8 FF
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return "jpeg";
	}

	// PNG: 89 50 4E 47
	if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
		return "png";
	}

	// GIF: 47 49 46 38
	if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
		return "gif";
	}

	// WebP: 52 49 46 46 ... 57 45 42 50
	if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
		return "webp";
	}

	return "unknown";
}

function extractDisplayName(sender: string): string {
	// Extract display name from Matrix ID (@user:server -> user)
	const match = sender.match(/^@([^:]+):/);
	return match ? match[1] : sender;
}
