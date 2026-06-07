/**
 * Chat — Enterprise Realtime Messaging
 *
 * Performance Architecture (corp-grade):
 * ─ ChatInput   → local useState ONLY. Never re-renders from parent.
 * ─ MessageList → React.memo. Re-renders only when messages[] ref changes.
 * ─ UserList    → React.memo. Re-renders only when allUsers[] changes.
 * ─ Sidebar     → React.memo. Stable when activeRoom/channels/users stable.
 * ─ Jotai atoms → Only for cross-component state (activeRoom, channels, dmRooms).
 *                 Message input is NOT an atom — local to ChatInput.
 *
 * Presence Honesty:
 * ─ Online indicator shown ONLY for the current user (yourself).
 * ─ All other users shown as offline/neutral until real presence tracking
 *   is implemented (requires backend Presence class + heartbeat).
 *
 * Rules of Hooks: All hooks unconditionally at top level in every component.
 */

import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  memo,
} from "react";
import { atom, useAtom } from "jotai";
import {
  Box,
  Typography,
  TextField,
  Button,
  Paper,
  CircularProgress,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemAvatar,
  ListItemText,
  Avatar,
  Divider,
  Chip,
  Badge,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  InputAdornment,
  Tooltip,
  Container,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  Send as SendIcon,
  Upload as CloudUploadIcon,
  Users,
  MessageSquare,
  Plus,
  Search,
  Hash,
  X,
} from "lucide-react";
import {
  useZenithQuery,
  useZenithUser,
  useZenithFile,
} from "@zuccadev-labs/zenith/react";
import { ZenithQuery, ZenithObject, LiveQueryClient } from "@zuccadev-labs/zenith";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Room {
  id: string;
  label: string;
  type: "channel" | "dm";
  peerId?: string;
}

// ─── Module-level Jotai Atoms ─────────────────────────────────────────────────
// Only for state that must be shared across components.
// Message input is NOT here — it lives in ChatInput's local useState.

const GENERAL_ROOM: Room = { id: "general", label: "general", type: "channel" };

const activeRoomAtom = atom<Room>(GENERAL_ROOM);
const channelsAtom   = atom<Room[]>([GENERAL_ROOM]);
const dmRoomsAtom    = atom<Room[]>([]);
const addChOpenAtom  = atom(false);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dmRoomId(a: string, b: string) {
  return "dm_" + [a, b].sort().join("_");
}

/** Deterministic avatar color — stable for same username across sessions */
function avatarBg(str: string): string {
  const PALETTE = [
    "#7C3AED","#2563EB","#059669","#B45309",
    "#DB2777","#0891B2","#DC2626",
  ];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function scrollBottom(el: HTMLElement | null) {
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * Parse date helper — handles both plain ISO strings (from REST find())
 * and Parse's JSON date format { __type: "Date", iso: "..." } (from LiveQuery events).
 */
function parseDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === "string") { const d = new Date(val); return isNaN(d.getTime()) ? null : d; }
  if (typeof val === "object" && (val as any).iso) { const d = new Date((val as any).iso); return isNaN(d.getTime()) ? null : d; }
  return null;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const SIDEBAR = {
  bg:      "#1A1D23",
  active:  "rgba(255,255,255,0.13)",
  hover:   "rgba(255,255,255,0.07)",
  text:    "rgba(255,255,255,0.72)",
  label:   "rgba(255,255,255,0.38)",
  divider: "rgba(255,255,255,0.07)",
} as const;

// ─── SidebarLabel ─────────────────────────────────────────────────────────────

const SidebarLabel = memo(function SidebarLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        px: 1.75,
        pt: 1.5,
        pb: 0.25,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Typography
        component="div"
        sx={{
          fontSize: "0.6rem",
          fontWeight: 800,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: SIDEBAR.label,
        }}
      >
        {children}
      </Typography>
      {action}
    </Box>
  );
});

// ─── MessageBubble ────────────────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  msg,
  isMe,
}: {
  msg: any;
  isMe: boolean;
}) {
  const sender: string = msg.get("sender") ?? "Unknown";
  const text: string   = msg.get("text") ?? "";
  const fileUrl: string = msg.get("fileUrl") ?? "";
  const ts = parseDate(msg.createdAt);

  return (
    <ListItem
      disableGutters
      sx={{
        flexDirection: isMe ? "row-reverse" : "row",
        alignItems: "flex-end",
        gap: 0.75,
        py: 0.35,
        px: 1.5,
      }}
    >
      {/* Avatar */}
      <Avatar
        sx={{
          width: 28,
          height: 28,
          fontSize: "0.68rem",
          fontWeight: 700,
          bgcolor: avatarBg(sender),
          flexShrink: 0,
          mb: 0.5,
        }}
      >
        {sender.charAt(0).toUpperCase()}
      </Avatar>

      {/* Bubble */}
      <Box sx={{ maxWidth: "68%" }}>
        {!isMe && (
          <Typography
            variant="caption"
            sx={{
              px: 1.5,
              mb: 0.15,
              display: "block",
              color: avatarBg(sender),
              fontWeight: 700,
              fontSize: "0.72rem",
            }}
          >
            {sender}
          </Typography>
        )}

        <Paper
          elevation={0}
          sx={{
            px: 1.5,
            py: 0.85,
            bgcolor: isMe ? "primary.main" : (t) => alpha(t.palette.grey[200], 0.95),
            color: isMe ? "#fff" : "text.primary",
            borderRadius: isMe
              ? "18px 18px 4px 18px"
              : "18px 18px 18px 4px",
            wordBreak: "break-word",
            boxShadow: isMe
              ? "0 2px 10px rgba(99,102,241,0.35)"
              : "0 1px 3px rgba(0,0,0,0.07)",
          }}
        >
          {text && (
            <Typography
              variant="body2"
              component="div"
              sx={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}
            >
              {text}
            </Typography>
          )}
          {fileUrl && (
            <Box mt={text ? 0.75 : 0}>
              {/\.(jpe?g|png|gif|webp|bmp|svg)(\?|$)/i.test(fileUrl) ? (
                <img
                  src={fileUrl}
                  alt="attachment"
                  loading="lazy"
                  style={{
                    maxWidth: "100%",
                    maxHeight: 240,
                    borderRadius: 8,
                    display: "block",
                  }}
                />
              ) : (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: isMe ? "#e0e7ff" : "#4F46E5",
                    fontWeight: 600,
                    fontSize: "0.8rem",
                  }}
                >
                  📎 {decodeURIComponent(fileUrl.split("/").pop() ?? "file")}
                </a>
              )}
            </Box>
          )}
        </Paper>

        <Typography
          variant="caption"
          sx={{
            px: 1.5,
            display: "block",
            color: "text.disabled",
            fontSize: "0.62rem",
            mt: 0.2,
            textAlign: isMe ? "right" : "left",
          }}
        >
          {ts?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </Typography>
      </Box>
    </ListItem>
  );
});

// ─── MessageList ──────────────────────────────────────────────────────────────
// React.memo: re-renders ONLY when messages[] reference changes.
// Parent keystrokes (in ChatInput) never cause this to re-render.

const MessageList = memo(function MessageList({
  messages,
  isLoading,
  myId,
  myUsername,
  activeRoomLabel,
  logRef,
}: {
  messages: any[];
  isLoading: boolean;
  myId?: string;
  myUsername: string;
  activeRoomLabel: string;
  logRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (isLoading && messages.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <CircularProgress size={32} />
      </Box>
    );
  }

  if (messages.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
          opacity: 0.38,
        }}
      >
        <MessageSquare size={48} />
        <Typography variant="body1" fontWeight={600}>
          No messages yet
        </Typography>
        <Typography variant="body2">Be the first to say something!</Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={logRef}
      role="log"
      aria-live="polite"
      aria-label={`Messages in ${activeRoomLabel}`}
      sx={{ flex: 1, overflowY: "auto", py: 0.5 }}
    >
      <List disablePadding>
        {messages.map((msg: any, idx: number) => {
          const msgSenderId = msg.get("senderId");
          const msgSender   = msg.get("sender");
          // Primary: objectId match. Fallback: username match (for legacy messages)
          const isMe =
            Boolean(myId && msgSenderId && msgSenderId === myId) ||
            Boolean(!msgSenderId && msgSender && msgSender === myUsername);
          return (
            <MessageBubble key={msg.id ?? msg.objectId ?? idx} msg={msg} isMe={isMe} />
          );
        })}
      </List>
    </Box>
  );
});

// ─── ChatInput ────────────────────────────────────────────────────────────────
// Completely isolated from the parent Chat component.
// Uses LOCAL useState — parent is never notified on keystrokes.
// Only calls onSend(text) when the user submits.

const ChatInput = memo(function ChatInput({
  activeRoomLabel,
  activeRoomType,
  isUploading,
  uploadProgress,
  onSend,
  onFileUpload,
  sendError,
  onClearError,
}: {
  activeRoomLabel: string;
  activeRoomType: "channel" | "dm";
  isUploading: boolean;
  uploadProgress: number;
  onSend: (text: string) => Promise<void>;
  onFileUpload: (file: File) => Promise<void>;
  sendError: string | null;
  onClearError: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await onFileUpload(file);
      e.target.value = "";
    },
    [onFileUpload]
  );

  const placeholder =
    activeRoomType === "channel"
      ? `Message #${activeRoomLabel}…`
      : `Message ${activeRoomLabel}…`;

  return (
    <Box sx={{ flexShrink: 0 }}>
      {/* Error banner */}
      {sendError && (
        <Box
          sx={{
            px: 2,
            py: 0.75,
            bgcolor: "error.main",
            color: "#fff",
            fontSize: "0.8rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>{sendError}</span>
          <Button
            size="small"
            sx={{ color: "#fff", minWidth: 0, textDecoration: "underline", fontSize: "0.75rem" }}
            onClick={onClearError}
          >
            Dismiss
          </Button>
        </Box>
      )}

      {/* Upload progress */}
      {isUploading && (
        <LinearProgress
          variant="determinate"
          value={uploadProgress}
          sx={{ height: 2 }}
        />
      )}

      {/* Input row */}
      <Box
        sx={{
          px: 2,
          py: 1.25,
          bgcolor: "background.paper",
          display: "flex",
          gap: 1,
          borderTop: "1px solid",
          borderColor: "divider",
          alignItems: "flex-end",
        }}
      >
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/*,application/pdf,video/*,audio/*,.zip,.txt,.csv,.xlsx"
          onChange={handleFile}
        />

        <TextField
          fullWidth
          variant="outlined"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          size="small"
          multiline
          maxRows={5}
          disabled={sending}
          slotProps={{
            htmlInput: {
              id: "chat-message-input",
              "aria-label": "Message input",
              maxLength: 4000,
            },
          }}
          sx={{ "& fieldset": { borderRadius: 3 } }}
        />

        <Tooltip title="Attach file">
          <Button
            id="chat-upload-btn"
            variant="outlined"
            aria-label="Upload file"
            disabled={isUploading || sending}
            onClick={() => fileRef.current?.click()}
            sx={{ borderRadius: 3, minWidth: 42, height: 40, px: 1.25 }}
          >
            <CloudUploadIcon size={17} />
          </Button>
        </Tooltip>

        <Tooltip title="Send (Enter)">
          <span>
            <Button
              id="chat-send-btn"
              variant="contained"
              aria-label="Send message"
              disabled={!text.trim() || sending}
              onClick={handleSend}
              sx={{
                borderRadius: 3,
                minWidth: 42,
                height: 40,
                px: 1.25,
                background: "linear-gradient(135deg, #7C3AED 0%, #4F46E5 100%)",
                "&:hover": {
                  background: "linear-gradient(135deg, #6D28D9 0%, #4338CA 100%)",
                },
              }}
            >
              {sending ? <CircularProgress size={16} sx={{ color: "#fff" }} /> : <SendIcon size={17} />}
            </Button>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
});

// ─── UserList ─────────────────────────────────────────────────────────────────
// React.memo — only re-renders when users[], activeRoom, or myId changes.
// Pressing keys in ChatInput never triggers this component.

const UserList = memo(function UserList({
  users,
  myId,
  activeRoomId,
  dmRooms,
  onOpenDm,
  isLoading,
  error,
  onRefetch,
  onlineIds,
}: {
  users: any[];
  myId?: string;
  activeRoomId: string;
  dmRooms: Room[];
  onOpenDm: (peer: any) => void;
  isLoading?: boolean;
  error?: Error | null;
  onRefetch?: () => void;
  onlineIds?: Set<string>;
}) {
  // Loading skeleton
  if (isLoading) {
    return (
      <Box sx={{ px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
        {[...Array(5)].map((_, i) => (
          <Box
            key={i}
            sx={{
              height: 28,
              borderRadius: 1.5,
              bgcolor: "rgba(255,255,255,0.05)",
              animation: "pulse 1.5s ease-in-out infinite",
              animationDelay: `${i * 0.1}s`,
            }}
          />
        ))}
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
      </Box>
    );
  }

  // Error state with retry
  if (error) {
    return (
      <Box sx={{ px: 2, py: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="caption" sx={{ color: "error.main", fontSize: "0.7rem" }}>
          Failed to load users
        </Typography>
        {onRefetch && (
          <Button
            size="small"
            variant="text"
            onClick={onRefetch}
            sx={{ color: SIDEBAR.label, fontSize: "0.7rem", p: 0, justifyContent: "flex-start", textTransform: "none" }}
          >
            Retry
          </Button>
        )}
      </Box>
    );
  }

  return (
    <>
      {users.map((peer: any) => {
        const peerId   = peer.id ?? peer.objectId;
        const uname    = peer.get("username") ?? "user";
        const isMe     = peerId === myId;
        const dmRid    = myId ? dmRoomId(myId, peerId) : "";
        const isActive = activeRoomId === dmRid;

        return (
          <ListItemButton
            key={peerId}
            id={`user-${peerId}`}
            selected={isActive}
            disabled={isMe}
            onClick={() => !isMe && onOpenDm(peer)}
            sx={{
              borderRadius: 1.5,
              mx: 0.5,
              py: 0.35,
              color: SIDEBAR.text,
              "&.Mui-selected": { bgcolor: SIDEBAR.active, color: "#fff" },
              "&:hover:not(.Mui-disabled)": { bgcolor: SIDEBAR.hover, color: "#fff" },
              "&.Mui-disabled": { opacity: 0.45 },
            }}
          >
            <ListItemAvatar sx={{ minWidth: 32 }}>
            {/* Green dot for online users (presence heartbeat), disabled dot for self */}
            <Badge
              variant="dot"
              color="success"
              overlap="circular"
              invisible={!onlineIds?.has(peerId) && !isMe}
              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            >
              <Avatar
                sx={{
                  width: 24,
                  height: 24,
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  bgcolor: isMe ? "rgba(255,255,255,0.15)" : avatarBg(uname),
                }}
              >
                {uname.charAt(0).toUpperCase()}
              </Avatar>
            </Badge>
          </ListItemAvatar>
            <ListItemText
              primary={isMe ? `${uname} (you)` : uname}
              slotProps={{
                primary: {
                  variant: "body2",
                  noWrap: true,
                  sx: {
                    fontSize: "0.8rem",
                    fontWeight: isActive ? 700 : 400,
                    color: "inherit",
                  },
                } as any,
              }}
            />
          </ListItemButton>
        );
      })}
    </>
  );
});

// ─── ChannelList ──────────────────────────────────────────────────────────────

const ChannelList = memo(function ChannelList({
  channels,
  activeRoomId,
  onSelect,
}: {
  channels: Room[];
  activeRoomId: string;
  onSelect: (r: Room) => void;
}) {
  return (
    <>
      {channels.map((ch) => (
        <ListItemButton
          key={ch.id}
          id={`channel-${ch.id}`}
          selected={activeRoomId === ch.id}
          onClick={() => onSelect(ch)}
          sx={{
            borderRadius: 1.5,
            mx: 0.5,
            py: 0.4,
            color: SIDEBAR.text,
            "&.Mui-selected": { bgcolor: SIDEBAR.active, color: "#fff" },
            "&:hover": { bgcolor: SIDEBAR.hover, color: "#fff" },
          }}
        >
          <Hash
            size={13}
            style={{ marginRight: 8, flexShrink: 0, opacity: 0.6 }}
          />
          <ListItemText
            primary={ch.label}
            slotProps={{
              primary: {
                variant: "body2",
                noWrap: true,
                sx: {
                  fontSize: "0.82rem",
                  fontWeight: activeRoomId === ch.id ? 700 : 400,
                  color: "inherit",
                },
              } as any,
            }}
          />
        </ListItemButton>
      ))}
    </>
  );
});

// ─── DmList ───────────────────────────────────────────────────────────────────

const DmList = memo(function DmList({
  dmRooms,
  activeRoomId,
  onSelect,
  onClose,
  unreadCounts,
}: {
  dmRooms: Room[];
  activeRoomId: string;
  onSelect: (r: Room) => void;
  onClose: (id: string) => void;
  unreadCounts?: Record<string, number>;
}) {
  if (dmRooms.length === 0) return null;
  return (
    <>
      {dmRooms.map((room) => {
        const unread = unreadCounts?.[room.id] ?? 0;
        return (
          <ListItemButton
            key={room.id}
            id={`dm-${room.id}`}
            selected={activeRoomId === room.id}
            onClick={() => onSelect(room)}
            sx={{
              borderRadius: 1.5,
              mx: 0.5,
              py: 0.35,
              pr: 0.5,
              color: SIDEBAR.text,
              "&.Mui-selected": { bgcolor: SIDEBAR.active, color: "#fff" },
              "&:hover": { bgcolor: SIDEBAR.hover, color: "#fff" },
            }}
          >
            <ListItemAvatar sx={{ minWidth: 32 }}>
              <Avatar
                sx={{
                  width: 24,
                  height: 24,
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  bgcolor: avatarBg(room.label),
                }}
              >
                {room.label.charAt(0).toUpperCase()}
              </Avatar>
            </ListItemAvatar>
            <ListItemText
              primary={room.label}
              slotProps={{
                primary: {
                  variant: "body2",
                  noWrap: true,
                  sx: {
                    fontSize: "0.8rem",
                    color: "inherit",
                    fontWeight: unread > 0 ? 700 : 400,
                  },
                } as any,
              }}
            />
            {/* Unread bubble — WhatsApp / Telegram style */}
            {unread > 0 && (
              <Box
                sx={{
                  minWidth: 18,
                  height: 18,
                  px: 0.6,
                  borderRadius: 99,
                  bgcolor: "#22c55e",
                  color: "#fff",
                  fontSize: "0.6rem",
                  fontWeight: 800,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  mr: 0.5,
                }}
              >
                {unread > 99 ? "99+" : unread}
              </Box>
            )}
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onClose(room.id);
              }}
              sx={{ p: 0.25, opacity: 0.5, color: "#fff", "&:hover": { opacity: 1 } }}
            >
              <X size={12} />
            </IconButton>
          </ListItemButton>
        );
      })}
    </>
  );
});

// ─── SidebarFooter ────────────────────────────────────────────────────────────

const SidebarFooter = memo(function SidebarFooter({
  username,
}: {
  username: string;
}) {
  return (
    <Box
      sx={{
        px: 1.75,
        py: 1.25,
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexShrink: 0,
        borderTop: `1px solid ${SIDEBAR.divider}`,
      }}
    >
      {/* Green badge ONLY for self — only thing we know for certain is online */}
      <Badge
        variant="dot"
        color="success"
        overlap="circular"
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Avatar
          sx={{
            width: 30,
            height: 30,
            fontSize: "0.72rem",
            fontWeight: 700,
            bgcolor: avatarBg(username),
          }}
        >
          {username.charAt(0).toUpperCase()}
        </Avatar>
      </Badge>
        <Box sx={{ overflow: "hidden" }}>
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontWeight: 700,
              color: "#fff",
              fontSize: "0.82rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {username}
          </Typography>
          {/* Online status communicated by the green Badge dot on avatar — no redundant text */}
          <Typography variant="caption" sx={{ color: SIDEBAR.label, fontSize: "0.64rem" }}>
            You
          </Typography>
        </Box>
    </Box>
  );
});

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const Sidebar = memo(function Sidebar({
  channels,
  dmRooms,
  allUsers,
  usersLoading,
  usersError,
  onRefetchUsers,
  activeRoom,
  myId,
  myUsername,
  onSelectRoom,
  onOpenDm,
  onCloseDm,
  onAddChannel,
  onlineIds,
  unreadCounts,
}: {
  channels: Room[];
  dmRooms: Room[];
  allUsers: any[];
  usersLoading?: boolean;
  usersError?: Error | null;
  onRefetchUsers?: () => void;
  activeRoom: Room;
  myId?: string;
  myUsername: string;
  onSelectRoom: (r: Room) => void;
  onOpenDm: (peer: any) => void;
  onCloseDm: (id: string) => void;
  onAddChannel: () => void;
  onlineIds: Set<string>;
  unreadCounts: Record<string, number>;
}) {
  return (
    <Box
      sx={{
        width: 230,
        flexShrink: 0,
        bgcolor: SIDEBAR.bg,
        borderRight: `1px solid ${SIDEBAR.divider}`,
        // CSS Grid — the ONLY reliable way to give the middle section
        // a concrete pixel height without depending on a multi-level flex chain.
        //   Row 1 (auto): Channels section — shrinks to its content
        //   Row 2 (1fr):  Users + DMs     — gets ALL remaining px
        //   Row 3 (auto): Footer          — shrinks to its content
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        overflow: "hidden",
      }}
    >
      {/* ── ROW 1: CHANNELS ───────────────────────────────────────────────── */}
      <Box sx={{ bgcolor: SIDEBAR.bg }}>
        <SidebarLabel
          action={
            <Tooltip title="Create channel">
              <IconButton
                size="small"
                onClick={onAddChannel}
                sx={{ p: 0.3, color: SIDEBAR.label, "&:hover": { color: "#fff" } }}
              >
                <Plus size={13} />
              </IconButton>
            </Tooltip>
          }
        >
          Channels
        </SidebarLabel>
        <Box sx={{ pb: 0.5, bgcolor: "transparent" }}>
          <ChannelList
            channels={channels}
            activeRoomId={activeRoom.id}
            onSelect={onSelectRoom}
          />
        </Box>
        <Box sx={{ height: 1, bgcolor: SIDEBAR.divider, mx: 1.5, my: 0.25 }} />
      </Box>

      {/* ── ROW 2: USERS + DMs (1fr = all remaining height) ───────────────── */}
      <Box
        sx={{
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          bgcolor: SIDEBAR.bg,
        }}
      >
        {/* USERS section header — pinned to top, never scrolls */}
        <SidebarLabel>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Users size={10} /> Users
          </Box>
        </SidebarLabel>

        {/* Scrollable user list — fills all remaining space inside row 2 */}
        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0, bgcolor: SIDEBAR.bg }}>
          <UserList
            users={allUsers}
            myId={myId}
            activeRoomId={activeRoom.id}
            dmRooms={dmRooms}
            onOpenDm={onOpenDm}
            isLoading={usersLoading}
            error={usersError}
            onRefetch={onRefetchUsers}
            onlineIds={onlineIds}
          />
        </Box>

        {/* DMs — below user list, shrinks to content (flex-shrink:0) */}
        {dmRooms.length > 0 && (
          <>
            <Box sx={{ height: 1, bgcolor: SIDEBAR.divider, mx: 1.5, my: 0.25, flexShrink: 0 }} />
            <SidebarLabel>Direct Messages</SidebarLabel>
            <Box sx={{ flexShrink: 0, pb: 0.5 }}>
              <DmList
                dmRooms={dmRooms}
                activeRoomId={activeRoom.id}
                onSelect={onSelectRoom}
                onClose={onCloseDm}
                unreadCounts={unreadCounts}
              />
            </Box>
          </>
        )}
      </Box>

      {/* ── ROW 3: FOOTER ─────────────────────────────────────────────────── */}
      <SidebarFooter username={myUsername} />
    </Box>
  );
});



// ─── AddChannelDialog ─────────────────────────────────────────────────────────

const AddChannelDialog = memo(function AddChannelDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string) => Promise<void>;
}) {
  const [name, setName]       = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  const handleAdd = useCallback(async () => {
    const slug = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!slug) { setError("Channel name required"); return; }
    setLoading(true);
    setError("");
    try {
      await onAdd(slug);
      setName("");
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Failed to create channel");
    } finally {
      setLoading(false);
    }
  }, [name, onAdd, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Hash size={18} /> Create Channel
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Channel name"
          placeholder="e.g. announcements"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          error={!!error}
          helperText={error || "Letters, numbers, dashes only"}
          slotProps={{ input: { startAdornment: <InputAdornment position="start">#</InputAdornment> } }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>Cancel</Button>
        <Button variant="contained" onClick={handleAdd} disabled={loading}>
          {loading ? <CircularProgress size={17} /> : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
});

// ─── Chat (Root) ──────────────────────────────────────────────────────────────
// Minimal state in root — only atoms + query results.
// Does NOT hold message text — that lives in ChatInput.

export default function Chat() {
  // ── Hooks (unconditional — Rules of Hooks) ───────────────────────────────
  const { user, loading: userLoading } = useZenithUser();
  const { upload, isUploading, progress } = useZenithFile();

  const [activeRoom, setActiveRoom] = useAtom(activeRoomAtom);
  const [channels,   setChannels]   = useAtom(channelsAtom);
  const [dmRooms,    setDmRooms]    = useAtom(dmRoomsAtom);
  const [addChOpen,  setAddChOpen]  = useAtom(addChOpenAtom);

  const [sendError, setSendError]   = useState<string | null>(null);
  // ── Presence: who is online ───────────────────────────────────────────────
  const [onlineIds,    setOnlineIds]    = useState<Set<string>>(new Set());
  // ── Unread message counts per room ───────────────────────────────────────
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const logRef       = useRef<HTMLDivElement>(null);
  const presenceRef  = useRef<string | null>(null);  // objectId of our Presence record
  // Ref tracks activeRoom for use inside LiveQuery callbacks (avoids stale closure)
  const activeRoomRef = useRef<Room>(GENERAL_ROOM);
  useEffect(() => { activeRoomRef.current = activeRoom; }, [activeRoom]);

  // ── Queries ──────────────────────────────────────────────────────────────
  const messagesQuery = useMemo(
    () =>
      new ZenithQuery("Message")
        .equalTo("roomId", activeRoom.id)
        .ascending("createdAt")
        .limit(200),
    [activeRoom.id]
  );
  const { data: messages, isLoading, refetch } = useZenithQuery(messagesQuery, true);

  // ── Users: fetch ONCE on mount, never re-fetch on re-renders ─────────────────────────
  // ROOT CAUSE of "users disappear in DM": useZenithQuery resets data=[]
  // whenever its internal query key changes, which happens on every Jotai
  // atom update (activeRoom, dmRooms). Fix: useRef guard — one execution only.
  const [allUsers,     setAllUsers]     = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError,   setUsersError]   = useState<Error | null>(null);
  const usersFetchedRef = useRef(false);

  const refetchUsers = useCallback(() => {
    setUsersLoading(true);
    setUsersError(null);
    new ZenithQuery("_User").ascending("username").limit(200).find()
      .then((r: any[]) => { setAllUsers(r); setUsersLoading(false); })
      .catch((e: Error)  => { setUsersError(e); setUsersLoading(false); });
  }, []);

  // ── Fetch users once when authenticated ─────────────────────────────────────
  useEffect(() => {
    if (!user || usersFetchedRef.current) return;
    usersFetchedRef.current = true;
    refetchUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.objectId]);


  // ── Channel persistence ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    new ZenithQuery("Channel").ascending("createdAt").limit(100).find()
      .then((res: any[]) => {
        const fetched: Room[] = res.map((c) => ({
          id: c.get("roomId"),
          label: c.get("name"),
          type: "channel" as const,
        }));
        setChannels([GENERAL_ROOM, ...fetched.filter((c) => c.id !== "general")]);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.objectId]);

  // ── Presence heartbeat ───────────────────────────────────────────────────
  // Writes/updates a Presence record every 30 s. Backend stores lastSeenAt.
  // Using a ref so the interval callback always has the latest userId.
  useEffect(() => {
    if (!user) return;
    const uid      = user.id!;
    const uname    = user.get("username") ?? uid;
    let cancelled  = false;

    const beat = async () => {
      try {
        if (presenceRef.current) {
          // Update existing record
          const rec = new ZenithObject("Presence");
          rec.objectId = presenceRef.current;
          rec.set("lastSeenAt", new Date().toISOString());
          await rec.save();
        } else {
          // Try to find existing, otherwise create
          const existing = await new ZenithQuery("Presence")
            .equalTo("userId", uid).limit(1).find();
          if (existing.length > 0) {
            presenceRef.current = existing[0].objectId!;
            existing[0].set("lastSeenAt", new Date().toISOString());
            await existing[0].save();
          } else {
            const p = new ZenithObject("Presence");
            p.set("userId", uid);
            p.set("username", uname);
            p.set("lastSeenAt", new Date().toISOString());
            await p.save();
            if (!cancelled) presenceRef.current = p.objectId!;
          }
        }
      } catch { /* silent — presence is best-effort */ }
    };

    beat(); // immediate first beat
    const timer = setInterval(beat, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.objectId]);

  // ── Presence poll — who is online? ───────────────────────────────────────
  // Query Presence records updated in the last 90 seconds.
  useEffect(() => {
    if (!user) return;
    const fetchOnline = async () => {
      try {
        const cutoffISO = new Date(Date.now() - 90_000).toISOString();
        const results = await new ZenithQuery("Presence")
          .greaterThan("lastSeenAt", cutoffISO)
          .limit(200)
          .find();
        setOnlineIds(new Set(results.map((p: any) => p.get("userId"))));
      } catch { /* silent */ }
    };
    fetchOnline();
    const timer = setInterval(fetchOnline, 60_000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.objectId]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    scrollBottom(logRef.current);
  }, [messages.length]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const myId       = user?.id;
  const myUsername = user?.get("username") ?? "";

  // ── Handlers (stable refs — useCallback with minimal deps) ───────────────

  const handleSend = useCallback(
    async (text: string) => {
      if (!user) return;
      const obj = new ZenithObject("Message");
      obj.set("text", text);
      obj.set("roomId", activeRoom.id);
      obj.set("sender", myUsername);
      obj.set("senderId", user.id); // user.id → objectId via the getter
      try {
        await obj.save();
      } catch (e: any) {
        setSendError(`[${e?.code ?? "ERR"}] ${e?.message}`);
        throw e; // ChatInput catches and restores text
      }
    },
    [user, activeRoom.id, myUsername]
  );

  const handleFileUpload = useCallback(
    async (file: File) => {
      if (!user) return;
      setSendError(null);
      try {
        const zenFile = await upload(file.name, file);
        const obj = new ZenithObject("Message");
        obj.set("text", "");
        obj.set("fileUrl", zenFile.url());
        obj.set("roomId", activeRoom.id);
        obj.set("sender", myUsername);
        obj.set("senderId", user.id);
        await obj.save();
      } catch (err: any) {
        setSendError(`Upload failed: [${err?.code ?? "ERR"}] ${err?.message}`);
      }
    },
    [user, upload, activeRoom.id, myUsername]
  );

  const handleCreateChannel = useCallback(
    async (name: string) => {
      const roomId = `ch_${name}`;
      const ch = new ZenithObject("Channel");
      ch.set("name", name);
      ch.set("roomId", roomId);
      ch.set("createdBy", user?.id);
      await ch.save();
      const newRoom: Room = { id: roomId, label: name, type: "channel" };
      setChannels((prev) => [...prev, newRoom]);
      setActiveRoom(newRoom);
    },
    [user, setChannels, setActiveRoom]
  );

  const handleOpenDm = useCallback(
    (peer: any) => {
      if (!user) return;
      const peerId = peer.id ?? peer.objectId;
      const uname  = peer.get("username") ?? peerId?.slice(0, 8) ?? "User";
      const rid    = dmRoomId(user.id!, peerId);
      const room: Room = { id: rid, label: uname, type: "dm", peerId };
      setDmRooms((prev) => (prev.some((r) => r.id === rid) ? prev : [...prev, room]));
      setActiveRoom(room);
      // Clear unread for this DM when opening it
      setUnreadCounts((prev) => ({ ...prev, [rid]: 0 }));
    },
    [user, setDmRooms, setActiveRoom]
  );

  const handleCloseDm = useCallback(
    (roomId: string) => {
      setDmRooms((prev) => prev.filter((r) => r.id !== roomId));
      if (activeRoom.id === roomId) setActiveRoom(GENERAL_ROOM);
    },
    [activeRoom.id, setDmRooms, setActiveRoom]
  );

  const handleSelectRoom = useCallback(
    (r: Room) => {
      setActiveRoom(r);
      // Clear unread badge when user navigates into the room
      setUnreadCounts((prev) => ({ ...prev, [r.id]: 0 }));
    },
    [setActiveRoom]
  );

  // ── Global LiveQuery for unread message counting ──────────────────────────────
  // Subscribes to ALL Message objects (no room filter).
  // When a new message arrives for a room the user is NOT currently viewing,
  // increment that room’s unread count — shows as a badge on the DM/channel item.
  useEffect(() => {
    if (!user) return;
    const globalQuery = new ZenithQuery("Message").limit(1);
    const sub = LiveQueryClient.subscribe(globalQuery);

    sub.on("create", (msg: any) => {
      const roomId   = msg.get("roomId");
      const senderId = msg.get("senderId");
      // Ignore own messages and messages for the room we’re currently in
      if (!roomId) return;
      if (senderId === user.id) return;
      if (roomId === activeRoomRef.current.id) return;

      setUnreadCounts((prev) => ({
        ...prev,
        [roomId]: (prev[roomId] ?? 0) + 1,
      }));
    });

    return () => { try { LiveQueryClient.unsubscribe(sub); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.objectId]);

  // ── Guards (after all hooks) ─────────────────────────────────────────────
  if (userLoading) {
    return (
          <Box sx={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center" }}>
        <CircularProgress size={48} />
      </Box>
    );
  }
  if (!user) {
    return (
      <Container maxWidth="sm" sx={{ mt: 10, textAlign: "center" }}>
        <Typography variant="h5" color="text.secondary">
          Please log in to use chat.
        </Typography>
      </Container>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", bgcolor: "background.default", overflow: "hidden", minHeight: 0 }}>

      {/* ─── Top bar ─────────────────────────────────────────────────────── */}
      <Box
        sx={{
          px: 3,
          py: 1.1,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          bgcolor: SIDEBAR.bg,
          borderBottom: `1px solid ${SIDEBAR.divider}`,
          flexShrink: 0,
        }}
      >
        <MessageSquare size={20} color="#7C3AED" />
        <Typography
          variant="h6"
          sx={{ fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", fontSize: "1rem" }}
        >
          Zenith Chat
        </Typography>
        <Chip
          label="LiveQuery ●"
          size="small"
          sx={{
            ml: 0.5,
            bgcolor: "rgba(124,58,237,0.2)",
            color: "#A78BFA",
            fontWeight: 700,
            fontSize: "0.62rem",
            height: 17,
          }}
        />
      </Box>

      {/* ─── Body (sidebar + chat area) ──────────────────────────────────── */}
      <Box sx={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Sidebar — memoized, re-renders only on structural changes */}
        <Sidebar
          channels={channels}
          dmRooms={dmRooms}
          allUsers={allUsers}
          usersLoading={usersLoading}
          usersError={usersError}
          onRefetchUsers={refetchUsers}
          activeRoom={activeRoom}
          myId={myId}
          myUsername={myUsername}
          onSelectRoom={handleSelectRoom}
          onOpenDm={handleOpenDm}
          onCloseDm={handleCloseDm}
          onAddChannel={() => setAddChOpen(true)}
          onlineIds={onlineIds}
          unreadCounts={unreadCounts}
        />

        {/* ─── Chat area ─────────────────────────────────────────────────── */}
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Room header */}
          <Box
            sx={{
              px: 2.5,
              py: 1.1,
              borderBottom: "1px solid",
              borderColor: "divider",
              display: "flex",
              alignItems: "center",
              gap: 1,
              bgcolor: "background.paper",
              flexShrink: 0,
              boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}
          >
            {activeRoom.type === "channel" ? (
              <Hash size={17} style={{ opacity: 0.55 }} />
            ) : (
              <Avatar sx={{ width: 24, height: 24, fontSize: "0.65rem", bgcolor: avatarBg(activeRoom.label) }}>
                {activeRoom.label.charAt(0).toUpperCase()}
              </Avatar>
            )}
            <Typography variant="subtitle1" fontWeight={700} sx={{ letterSpacing: "-0.01em", flex: 1 }}>
              {activeRoom.type === "channel" ? `# ${activeRoom.label}` : activeRoom.label}
            </Typography>
            {activeRoom.type === "dm" && (
              <>
                <Chip label="DM" size="small" color="secondary" sx={{ mr: 1 }} />
                <Tooltip title="Close DM — back to General">
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<X size={13} />}
                    onClick={() => {
                      handleCloseDm(activeRoom.id);
                      handleSelectRoom(GENERAL_ROOM);
                    }}
                    sx={{
                      borderRadius: 2,
                      fontSize: "0.72rem",
                      borderColor: "rgba(255,255,255,0.15)",
                      color: "text.secondary",
                      "&:hover": { borderColor: "primary.main", color: "primary.main" },
                    }}
                  >
                    General
                  </Button>
                </Tooltip>
              </>
            )}
          </Box>

          {/* Messages — memoized, never re-renders on input keystrokes */}
          <MessageList
            messages={messages}
            isLoading={isLoading}
            myId={myId}
            myUsername={myUsername}
            activeRoomLabel={activeRoom.label}
            logRef={logRef}
          />

          {/* Input — fully isolated, local state only */}
          <ChatInput
            activeRoomLabel={activeRoom.label}
            activeRoomType={activeRoom.type}
            isUploading={isUploading}
            uploadProgress={progress}
            onSend={handleSend}
            onFileUpload={handleFileUpload}
            sendError={sendError}
            onClearError={() => setSendError(null)}
          />
        </Box>
      </Box>

      {/* Dialogs */}
      <AddChannelDialog
        open={addChOpen}
        onClose={() => setAddChOpen(false)}
        onAdd={handleCreateChannel}
      />
    </Box>
  );
}
