/**
 * Matrix Storage
 *
 * SQLite-based storage for room-to-conversation mappings and message tracking.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

interface StorageConfig {
	dataDir: string;
}

export class MatrixStorage {
	private db: Database.Database | null = null;
	private dataDir: string;

	constructor(config: StorageConfig) {
		this.dataDir = config.dataDir;

		// Ensure directory exists
		if (!existsSync(this.dataDir)) {
			mkdirSync(this.dataDir, { recursive: true });
		}
	}

	/**
	 * Initialize the database
	 */
	async init(): Promise<void> {
		const dbPath = join(this.dataDir, "matrix.db");
		this.db = new Database(dbPath);

		// Enable WAL mode for better concurrency
		this.db.pragma("journal_mode = WAL");

		// Create tables
		this.createTables();

		console.log("[MatrixStorage] Database initialized");
	}

	/**
	 * Create database tables
	 */
	private createTables(): void {
		if (!this.db) return;

		// Room to conversation mapping
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_conversations (
        room_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        room_name TEXT,
        is_dm BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Message event mappings for reaction feedback
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_mappings (
        matrix_event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        step_id TEXT,
        sender TEXT NOT NULL,
        room_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Audio message mappings for TTS regeneration
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS audio_messages (
        audio_event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        original_text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Per-room pause state (set via !pause / !resume)
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS paused_rooms (
        room_id TEXT PRIMARY KEY,
        paused_by TEXT NOT NULL,
        paused_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Bot ignore list (set via !bot-add / !bot-remove, prevents message loops)
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS ignored_bots (
        user_id TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Create indexes
		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON message_mappings(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_msg_room ON message_mappings(room_id);
      CREATE INDEX IF NOT EXISTS idx_audio_conv ON audio_messages(conversation_id);
    `);
	}

	/**
	 * Get conversation ID for a room
	 */
	getConversationForRoom(roomId: string): string | undefined {
		if (!this.db) {
			console.warn('[MatrixStorage] getConversationForRoom: Database not initialized');
			return undefined;
		}

		try {
			const stmt = this.db.prepare(
				"SELECT conversation_id FROM room_conversations WHERE room_id = ?",
			);
			const result = stmt.get(roomId) as { conversation_id: string } | undefined;
			return result?.conversation_id;
		} catch (err) {
			console.error(`[MatrixStorage] getConversationForRoom failed for room ${roomId}:`, err);
			return undefined;
		}
	}

	/**
	 * Create conversation for a room
	 */
	createConversationForRoom(
		roomId: string,
		conversationId: string,
		roomName?: string,
		isDm = false,
	): void {
		if (!this.db) {
			console.warn('[MatrixStorage] createConversationForRoom: Database not initialized');
			return;
		}

		try {
			const stmt = this.db.prepare(`
        INSERT INTO room_conversations (room_id, conversation_id, room_name, is_dm)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          room_name = excluded.room_name,
          updated_at = CURRENT_TIMESTAMP
      `);
			stmt.run(roomId, conversationId, roomName || null, isDm ? 1 : 0);
		} catch (err) {
			console.error(`[MatrixStorage] createConversationForRoom failed for room ${roomId}:`, err);
		}
	}

	/**
	 * Store message mapping for reaction tracking
	 */
	storeMessageMapping(
		matrixEventId: string,
		conversationId: string,
		stepId: string | undefined,
		sender: string,
		roomId: string,
	): void {
		if (!this.db) {
			console.warn('[MatrixStorage] storeMessageMapping: Database not initialized');
			return;
		}

		try {
			const stmt = this.db.prepare(`
        INSERT INTO message_mappings (matrix_event_id, conversation_id, step_id, sender, room_id)
        VALUES (?, ?, ?, ?, ?)
      `);
			stmt.run(matrixEventId, conversationId, stepId || null, sender, roomId);
		} catch (err) {
			console.error(`[MatrixStorage] storeMessageMapping failed for event ${matrixEventId}:`, err);
		}
	}

	/**
	 * Get step IDs for a message event
	 */
	getStepIdsForEvent(matrixEventId: string): string[] {
		if (!this.db) {
			console.warn('[MatrixStorage] getStepIdsForEvent: Database not initialized');
			return [];
		}

		try {
			const stmt = this.db.prepare(
				"SELECT step_id FROM message_mappings WHERE matrix_event_id = ? AND step_id IS NOT NULL",
			);
			const results = stmt.all(matrixEventId) as { step_id: string }[];
			return results.map((r) => r.step_id);
		} catch (err) {
			console.error(`[MatrixStorage] getStepIdsForEvent failed for event ${matrixEventId}:`, err);
			return [];
		}
	}

	/**
	 * Store audio message for TTS regeneration
	 */
	storeAudioMessage(
		audioEventId: string,
		conversationId: string,
		roomId: string,
		originalText: string,
	): void {
		if (!this.db) {
			console.warn('[MatrixStorage] storeAudioMessage: Database not initialized');
			return;
		}

		try {
			const stmt = this.db.prepare(`
        INSERT INTO audio_messages (audio_event_id, conversation_id, room_id, original_text)
        VALUES (?, ?, ?, ?)
      `);
			stmt.run(audioEventId, conversationId, roomId, originalText);
		} catch (err) {
			console.error(`[MatrixStorage] storeAudioMessage failed for event ${audioEventId}:`, err);
		}
	}

	/**
	 * Get original text for audio message
	 */
	getOriginalTextForAudio(audioEventId: string): string | null {
		if (!this.db) {
			console.warn('[MatrixStorage] getOriginalTextForAudio: Database not initialized');
			return null;
		}

		try {
			const stmt = this.db.prepare(
				"SELECT original_text FROM audio_messages WHERE audio_event_id = ?",
			);
			const result = stmt.get(audioEventId) as { original_text: string } | undefined;
			return result?.original_text || null;
		} catch (err) {
			console.error(`[MatrixStorage] getOriginalTextForAudio failed for event ${audioEventId}:`, err);
			return null;
		}
	}

	/**
	 * Get all rooms with conversations
	 */
	getAllRooms(): Array<{
		roomId: string;
		conversationId: string;
		roomName: string | null;
		isDm: boolean;
	}> {
		if (!this.db) return [];

		const stmt = this.db.prepare(
			"SELECT room_id, conversation_id, room_name, is_dm FROM room_conversations",
		);
		const results = stmt.all() as Array<{
			room_id: string;
			conversation_id: string;
			room_name: string | null;
			is_dm: number;
		}>;

		return results.map((r) => ({
			roomId: r.room_id,
			conversationId: r.conversation_id,
			roomName: r.room_name,
			isDm: r.is_dm === 1,
		}));
	}

	// ─── Per-room pause state ─────────────────────────────────────────────────

	pauseRoom(roomId: string, pausedBy: string): void {
		if (!this.db) return;
		this.db.prepare(
			"INSERT INTO paused_rooms (room_id, paused_by) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET paused_by = excluded.paused_by, paused_at = CURRENT_TIMESTAMP",
		).run(roomId, pausedBy);
	}

	resumeRoom(roomId: string): void {
		if (!this.db) return;
		this.db.prepare("DELETE FROM paused_rooms WHERE room_id = ?").run(roomId);
	}

	isRoomPaused(roomId: string): boolean {
		if (!this.db) return false;
		const result = this.db.prepare("SELECT 1 FROM paused_rooms WHERE room_id = ?").get(roomId);
		return result !== undefined;
	}

	getPausedRooms(): string[] {
		if (!this.db) return [];
		const rows = this.db.prepare("SELECT room_id FROM paused_rooms").all() as { room_id: string }[];
		return rows.map((r) => r.room_id);
	}

	// ─── Bot ignore list ───────────────────────────────────────────────────────

	addIgnoredBot(userId: string, addedBy: string): void {
		if (!this.db) return;
		this.db.prepare(
			"INSERT INTO ignored_bots (user_id, added_by) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET added_by = excluded.added_by, added_at = CURRENT_TIMESTAMP",
		).run(userId, addedBy);
	}

	removeIgnoredBot(userId: string): void {
		if (!this.db) return;
		this.db.prepare("DELETE FROM ignored_bots WHERE user_id = ?").run(userId);
	}

	isIgnoredBot(userId: string): boolean {
		if (!this.db) return false;
		const result = this.db.prepare("SELECT 1 FROM ignored_bots WHERE user_id = ?").get(userId);
		return result !== undefined;
	}

	getIgnoredBots(): string[] {
		if (!this.db) return [];
		const rows = this.db.prepare("SELECT user_id FROM ignored_bots").all() as { user_id: string }[];
		return rows.map((r) => r.user_id);
	}

	// ─── Storage Pruning ───────────────────────────────────────────────────────

	/**
	 * Prune old entries from audio_messages and message_mappings tables
	 * Returns array of {table, deletedCount} for each table pruned
	 * @param retentionDays - Delete entries older than this many days (default: 30)
	 * @returns Array of pruning results
	 */
	pruneOldEntries(retentionDays = 30): Array<{ table: string; deletedCount: number }> {
		if (!this.db) return [];

		const results: Array<{ table: string; deletedCount: number }> = [];

		try {
			// Calculate cutoff date
			const cutoffDate = new Date();
			cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
			const cutoffIso = cutoffDate.toISOString();

			// Prune audio_messages table
			const audioStmt = this.db.prepare(
				"DELETE FROM audio_messages WHERE created_at < ?"
			);
			const audioResult = audioStmt.run(cutoffIso);
			results.push({
				table: 'audio_messages',
				deletedCount: audioResult.changes
			});

			// Prune message_mappings table
			const mappingStmt = this.db.prepare(
				"DELETE FROM message_mappings WHERE created_at < ?"
			);
			const mappingResult = mappingStmt.run(cutoffIso);
			results.push({
				table: 'message_mappings',
				deletedCount: mappingResult.changes
			});

			// Log results
			if (results.some(r => r.deletedCount > 0)) {
				const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0);
				console.log(
					`[MatrixStorage] Pruned ${totalDeleted} old entry/entries ` +
					`(older than ${retentionDays} days): ` +
					results.map(r => `${r.table}=${r.deletedCount}`).join(', ')
				);
			}
		} catch (err) {
			console.error('[MatrixStorage] Failed to prune old entries:', err);
		}

		return results;
	}

	/**
	 * Get pruning statistics
	 */
	getPruningStats(): {
		audioMessagesCount: number;
		messageMappingsCount: number;
		oldestAudioMessage: string | null;
		oldestMessageMapping: string | null;
	} {
		if (!this.db) {
			return {
				audioMessagesCount: 0,
				messageMappingsCount: 0,
				oldestAudioMessage: null,
				oldestMessageMapping: null,
			};
		}

		try {
			const audioCountStmt = this.db.prepare("SELECT COUNT(*) as count FROM audio_messages");
			const audioCount = (audioCountStmt.get() as { count: number })?.count || 0;

			const mappingCountStmt = this.db.prepare("SELECT COUNT(*) as count FROM message_mappings");
			const mappingCount = (mappingCountStmt.get() as { count: number })?.count || 0;

			const oldestAudioStmt = this.db.prepare(
				"SELECT MIN(created_at) as oldest FROM audio_messages"
			);
			const oldestAudio = (oldestAudioStmt.get() as { oldest: string })?.oldest || null;

			const oldestMappingStmt = this.db.prepare(
				"SELECT MIN(created_at) as oldest FROM message_mappings"
			);
			const oldestMapping = (oldestMappingStmt.get() as { oldest: string })?.oldest || null;

			return {
				audioMessagesCount: audioCount,
				messageMappingsCount: mappingCount,
				oldestAudioMessage: oldestAudio,
				oldestMessageMapping: oldestMapping,
			};
		} catch (err) {
			console.error('[MatrixStorage] Failed to get pruning stats:', err);
			return {
				audioMessagesCount: 0,
				messageMappingsCount: 0,
				oldestAudioMessage: null,
				oldestMessageMapping: null,
			};
		}
	}

	/**
	 * Delete conversation mapping for a room (used when bot leaves room)
	 */
	deleteConversationForRoom(roomId: string): void {
		if (!this.db) return;

		try {
			const stmt = this.db.prepare("DELETE FROM room_conversations WHERE room_id = ?");
			const result = stmt.run(roomId);
			if (result.changes > 0) {
				console.log(`[MatrixStorage] Deleted conversation mapping for room ${roomId}`);
			}
		} catch (err) {
			console.error(`[MatrixStorage] Failed to delete conversation for room ${roomId}:`, err);
		}
	}

	/**
	 * Close the database
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
