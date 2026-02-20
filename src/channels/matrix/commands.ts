/**
 * Matrix Bot Command Processor
 *
 * Handles !commands sent by allowed users in Matrix rooms:
 *   !pause             — silence bot in current room (SQLite persisted)
 *   !resume            — re-enable bot in current room
 *   !status            — show paused rooms, ignored bots, heartbeat state
 *   !bot-add @u:s      — add user to global ignore list (prevents bot loops)
 *   !bot-remove @u:s   — remove user from ignore list
 *   !heartbeat on/off  — toggle the heartbeat cron (in-memory)
 *
 * Commands run AFTER access control (allowedUsers) but BEFORE the paused-room
 * check, so !resume always works even in a paused room.
 * Unrecognized !x commands fall through to Letta as normal text.
 */

import type { MatrixStorage } from "./storage.js";

interface CommandCallbacks {
  onHeartbeatStop?: () => void;
  onHeartbeatStart?: () => void;
  isHeartbeatEnabled?: () => boolean;
}

export class MatrixCommandProcessor {
  // Per-room bot-turn counters: roomId → remaining turns
  private botTurns = new Map<string, number>();

  constructor(
    private storage: MatrixStorage,
    private callbacks: CommandCallbacks = {},
  ) {}

  /**
   * Process a !command.
   * Returns:
   *   - string  → send as reply
   *   - ''      → silent ack (no reply sent)
   *   - undefined → not a recognized command, fall through to Letta
   */
  async handleCommand(
    body: string,
    roomId: string,
    sender: string,
    roomMeta?: { isDm: boolean; roomName: string },
  ): Promise<string | undefined> {
    const parts = body.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "pause":
        return this.doPause(roomId, sender);
      case "resume":
        return this.doResume(roomId);
      case "status":
        return this.doStatus(roomId);
      case "ignorebot-add":
        return this.doBotAdd(args[0], sender);
      case "ignorebot-remove":
        return this.doBotRemove(args[0]);
      case "heartbeat":
        return this.doHeartbeat(args[0]);
      case "restore":
        return this.doRestore(args[0], roomId, roomMeta?.isDm ?? false, roomMeta?.roomName ?? roomId);
      case "turns":
        return this.doTurns(args[0], roomId);
      default:
        return undefined;
    }
  }

  isRoomPaused(roomId: string): boolean {
    return this.storage.isRoomPaused(roomId);
  }

  isIgnoredBot(userId: string): boolean {
    return this.storage.isIgnoredBot(userId);
  }

  /**
   * Check if a bot message should be processed in this room.
   * Known bots are silenced UNLESS:
   *   - The message @mentions our userId (body contains display name or m.mentions)
   *   - !turns N is active for this room (and decrements the counter)
   */
  shouldRespondToBot(roomId: string, body: string, ourUserId: string): boolean {
    // Check @mention — body contains our display name or full user ID
    const displayName = ourUserId.match(/^@([^:]+):/)?.[1];
    if (displayName && body.toLowerCase().includes(displayName.toLowerCase())) {
      return true;
    }
    if (body.includes(ourUserId)) {
      return true;
    }

    // Check !turns counter
    const remaining = this.botTurns.get(roomId);
    if (remaining !== undefined && remaining > 0) {
      this.botTurns.set(roomId, remaining - 1);
      console.log(`[Commands] !turns: ${remaining - 1} turns remaining in ${roomId}`);
      if (remaining - 1 === 0) this.botTurns.delete(roomId);
      return true;
    }

    return false;
  }

  // ─── Command implementations ─────────────────────────────────────────────

  private doPause(roomId: string, sender: string): string {
    this.storage.pauseRoom(roomId, sender);
    return "⏸️ Bot paused in this room. Use !resume to re-enable.";
  }

  private doResume(roomId: string): string {
    this.storage.resumeRoom(roomId);
    return "▶️ Bot resumed in this room.";
  }

  private doStatus(roomId: string): string {
    const paused = this.storage.getPausedRooms();
    const ignored = this.storage.getIgnoredBots();
    const hbState = this.callbacks.isHeartbeatEnabled?.() ? "on" : "off";
    const thisRoomPaused = this.storage.isRoomPaused(roomId);
    const convId = this.storage.getConversationForRoom(roomId);

    const turnsRemaining = this.botTurns.get(roomId);
    const lines = [
      "📊 **Bot Status**",
      `This room: ${thisRoomPaused ? "⏸️ paused" : "▶️ active"}`,
      convId ? `Conversation: \`${convId}\`` : "Conversation: (not yet mapped)",
      turnsRemaining ? `Bot turns: ${turnsRemaining} remaining` : "Bot turns: off (observer mode in multi-bot rooms)",
      paused.length > 0 ? `Paused rooms: ${paused.length}` : "No rooms paused",
      ignored.length > 0
        ? `Known bots:\n${ignored.map((u) => `  • ${u}`).join("\n")}`
        : "No known bots",
      `Heartbeat: ${hbState}`,
    ];

    return lines.join("\n");
  }

  private doBotAdd(userId: string | undefined, sender: string): string {
    if (!userId?.startsWith("@")) {
      return "⚠️ Usage: !ignorebot-add @user:server";
    }
    this.storage.addIgnoredBot(userId, sender);
    return `🚫 Added ${userId} to ignore list`;
  }

  private doBotRemove(userId: string | undefined): string {
    if (!userId?.startsWith("@")) {
      return "⚠️ Usage: !ignorebot-remove @user:server";
    }
    this.storage.removeIgnoredBot(userId);
    return `✅ Removed ${userId} from ignore list`;
  }

  private doHeartbeat(arg: string | undefined): string {
    const normalized = arg?.toLowerCase();
    if (normalized === "off" || normalized === "stop") {
      this.callbacks.onHeartbeatStop?.();
      return "⏸️ Heartbeat cron stopped";
    }
    if (normalized === "on" || normalized === "start") {
      this.callbacks.onHeartbeatStart?.();
      return "▶️ Heartbeat cron started";
    }
    return "⚠️ Usage: !heartbeat on | !heartbeat off";
  }

  private doTurns(arg: string | undefined, roomId: string): string {
    const n = parseInt(arg || "", 10);
    if (!n || n < 1 || n > 50) {
      const current = this.botTurns.get(roomId);
      if (current) return `🔄 ${current} bot turns remaining in this room`;
      return "⚠️ Usage: !turns N (1-50) — respond to bot messages for the next N turns";
    }
    this.botTurns.set(roomId, n);
    return `🔄 Will respond to bot messages for the next ${n} turns in this room`;
  }

  private doRestore(
    convId: string | undefined,
    roomId: string,
    isDm: boolean,
    roomName: string,
  ): string {
    if (!convId?.startsWith("conv-")) {
      return "⚠️ Usage: !restore conv-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    }
    this.storage.createConversationForRoom(roomId, convId, roomName, isDm);
    return `✅ Room mapped to \`${convId}\`\nNext message will resume that conversation.`;
  }
}
