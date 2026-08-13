const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const R = require("./rooms");
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Mobile browsers can pause timers/networking while backgrounded. A longer
  // timeout avoids treating a short app switch as an immediate dead connection.
  pingInterval: 25_000,
  pingTimeout: 60_000
});
const PUBLIC_DIR = path.join(__dirname, "public");
const ICON_DIR = path.join(PUBLIC_DIR, "images", "icons");
const ICON_EXTENSIONS = new Set([".png", ".webp", ".jpg", ".jpeg", ".gif", ".svg"]);

function getIconList() {
  try {
    return fs.readdirSync(ICON_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ICON_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => `/images/icons/${encodeURIComponent(entry.name)}`)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return [];
  }
}

function safePlayerIcon(icon) {
  const icons = getIconList();
  if (typeof icon === "string" && icons.includes(icon)) return icon;
  if (icons.length) return icons[0];
  // Keep the old emoji fallback if there are no picture icons in the folder.
  return typeof icon === "string" && icon.length <= 16 ? icon : "🎭";
}

// Inject the black starry theme into the existing game page.
app.get("/", (req, res, next) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  fs.readFile(indexPath, "utf8", (err, html) => {
    if (err) return next();
    const tag = '<link rel="stylesheet" href="/starry-theme.css">';
    if (!html.includes("/starry-theme.css")) {
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${tag}\n</head>`) : `${tag}\n${html}`;
    }
    res.type("html").send(html);
  });
});
app.use(express.static(PUBLIC_DIR));

const CATEGORIES = require("./categories.json");
const WORD_HINTS = require("./words.json");
const CATEGORY_LIST = Object.keys(CATEGORIES).map((name) => ({
  name, emoji: CATEGORIES[name].emoji, count: CATEGORIES[name].words.length
}));
const parsedTurnDuration = Number(process.env.TURN_DURATION_MS || 30_000);
const TURN_DURATION_MS = Number.isFinite(parsedTurnDuration) && parsedTurnDuration > 0 ? parsedTurnDuration : 30_000;

const parsedReconnectGrace = Number(process.env.RECONNECT_GRACE_MS || 5 * 60_000);
const RECONNECT_GRACE_MS = Number.isFinite(parsedReconnectGrace) && parsedReconnectGrace >= 0
  ? parsedReconnectGrace
  : 5 * 60_000;

// Temporary disconnects reserve the player seat so switching apps/tabs does not
// kick somebody out of a room. Timers are keyed by stable player PID, not socket id.
const disconnectTimers = new Map();
function disconnectKey(roomCode, pid) { return `${roomCode}:${pid}`; }
function clearDisconnectGrace(roomCode, pid) {
  if (!roomCode || !pid) return;
  const key = disconnectKey(roomCode, pid);
  const timer = disconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  disconnectTimers.delete(key);
}

function hintKey(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
const HINT_BY_WORD = new Map(WORD_HINTS.filter((x) => x && x.word && x.hint).map((x) => [hintKey(x.word), x.hint]));
function getHintForWord(word) { return HINT_BY_WORD.get(hintKey(word)) || null; }

function broadcast(code) {
  const room = R.getRoom(code);
  if (room) io.to(code).emit("roomUpdate", R.publicRoomState(room));
}
function rolePayload(room, player) {
  return {
    isImposter: player.isImposter,
    word: player.isImposter ? null : room.word,
    category: player.isImposter ? null : room.category,
    hint: player.isImposter ? (room.hint || null) : null,
    round: room.round,
    maxRounds: room.maxRounds
  };
}
function dealRoles(room) {
  room.players.forEach((p) => { if (p.connected) io.to(p.id).emit("role", rolePayload(room, p)); });
}

const turnTimers = new Map();
function clearTurnTimer(code) {
  const timer = turnTimers.get(code);
  if (timer) clearTimeout(timer);
  turnTimers.delete(code);
}
function scheduleTurnTimer(code) {
  clearTurnTimer(code);
  const room = R.getRoom(code);
  const active = R.currentTurnPlayer(room);
  if (!room || room.phase !== "discussion" || room.cluesComplete || !active || !room.turnEndsAt) return;
  const expectedPid = active.pid;
  const expectedEndsAt = room.turnEndsAt;
  const delay = Math.max(0, expectedEndsAt - Date.now());
  turnTimers.set(code, setTimeout(() => {
    turnTimers.delete(code);
    const latest = R.getRoom(code);
    const latestActive = R.currentTurnPlayer(latest);
    if (!latest || latest.phase !== "discussion" || latest.cluesComplete || !latestActive) return;
    if (latestActive.pid !== expectedPid || latest.turnEndsAt !== expectedEndsAt) return scheduleTurnTimer(code);
    const player = { pid: latestActive.pid, name: latestActive.name };
    R.advanceTurn(latest, "timeout", TURN_DURATION_MS);
    const state = R.publicRoomState(latest);
    io.to(code).emit("turnTimedOut", { player, state });
    io.to(code).emit("turnAdvanced", { reason: "timeout", state });
    broadcast(code);
    scheduleTurnTimer(code);
  }, delay + 5));
}
function advanceUnavailableTurn(code) {
  const room = R.getRoom(code);
  if (!room || room.phase !== "discussion" || room.cluesComplete) return;
  const result = R.ensureActiveTurn(room, TURN_DURATION_MS);
  if (result.changed) io.to(code).emit("turnAdvanced", { reason: "player-left", state: R.publicRoomState(room) });
  scheduleTurnTimer(code);
}
function scheduleDisconnectCleanup(roomCode, pid) {
  clearDisconnectGrace(roomCode, pid);
  if (RECONNECT_GRACE_MS === 0) return;

  const key = disconnectKey(roomCode, pid);
  const timer = setTimeout(() => {
    disconnectTimers.delete(key);
    const room = R.getRoom(roomCode);
    if (!room) return;
    const player = R.getPlayerByPid(room, pid);
    if (!player || player.connected) return;

    const result = R.removePlayerFromRoom(roomCode, player.id, true);
    if (!result || result.roomDeleted || !result.room) {
      clearTurnTimer(roomCode);
      return;
    }

    advanceUnavailableTurn(roomCode);
    broadcast(roomCode);
    if (result.votingComplete) doResolve(roomCode, false);
  }, RECONNECT_GRACE_MS);

  disconnectTimers.set(key, timer);
}
function submitClueFromSocket(socket, roomCode, text, cb) {
  const room = R.getRoom(roomCode);
  if (!room) return typeof cb === "function" && cb({ ok: false, error: "Room not found." });
  const player = room.players.find((p) => p.id === socket.id);
  if (!player || !player.alive) return typeof cb === "function" && cb({ ok: false, error: "You cannot submit a clue." });
  const result = R.submitClue(room, player.pid, text, TURN_DURATION_MS);
  if (!result.ok) {
    socket.emit("toast", { type: "error", message: result.error });
    if (typeof cb === "function") cb(result);
    return;
  }
  io.to(roomCode).emit("chat", result.msg);
  const state = R.publicRoomState(room);
  io.to(roomCode).emit("turnAdvanced", { reason: "submitted", state });
  broadcast(roomCode);
  scheduleTurnTimer(roomCode);
  if (typeof cb === "function") cb({ ok: true, state });
}
function doResolve(code, force) {
  clearTurnTimer(code);
  const room = R.getRoom(code);
  if (!room) return;
  const res = force ? R.forceResolve(room, TURN_DURATION_MS) : R.resolveVote(room, TURN_DURATION_MS);
  if (!res) return;
  io.to(code).emit("voteResolved", { resolution: res, state: R.publicRoomState(room) });
  broadcast(code);
  if (room.phase === "discussion") scheduleTurnTimer(code);
}

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);
  socket.emit("categories", CATEGORY_LIST);
  socket.emit("icons", getIconList());

  socket.on("createRoom", (...args) => {
    const cb = args[args.length - 1];
    const { roomCode } = R.createRoom(socket.id);
    socket.join(roomCode);
    if (typeof cb === "function") cb({ ok: true, roomCode, categories: CATEGORY_LIST });
  });
  socket.on("joinRoom", ({ roomCode, name, icon }, cb) => {
    const result = R.validateAndAddPlayer({ roomCode, socketId: socket.id, name, icon: safePlayerIcon(icon) });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    socket.join(roomCode); socket.data.roomCode = roomCode; socket.data.pid = player.pid;
    if (typeof cb === "function") cb({ ok: true, pid: player.pid, isHost: room.hostId === socket.id, state: R.publicRoomState(room), categories: CATEGORY_LIST });
    broadcast(roomCode);
  });
  socket.on("rejoinRoom", ({ roomCode, pid, name, icon }, cb) => {
    const result = R.rejoinByPid({ roomCode, socketId: socket.id, pid, name, icon: safePlayerIcon(icon) });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    clearDisconnectGrace(roomCode, player.pid);
    socket.join(roomCode); socket.data.roomCode = roomCode; socket.data.pid = player.pid;
    if (room.phase !== "lobby") socket.emit("role", rolePayload(room, player));
    if (typeof cb === "function") cb({ ok: true, pid: player.pid, isHost: room.hostId === socket.id, state: R.publicRoomState(room), chat: room.chat.slice(-60), gameResult: room.gameResult, categories: CATEGORY_LIST });
    broadcast(roomCode); scheduleTurnTimer(roomCode);
  });
  socket.on("updateSettings", ({ roomCode, categories, imposters }) => {
    const room = R.getRoom(roomCode); if (!room || room.hostId !== socket.id) return;
    R.setSettings(room, { categories, imposters }, CATEGORIES); broadcast(roomCode);
  });
  socket.on("startGame", ({ roomCode }) => {
    const room = R.getRoom(roomCode); if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("toast", { type: "error", message: "Only the host can start." });
    const result = R.startGame(room, CATEGORIES);
    if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    room.hint = getHintForWord(room.word);
    dealRoles(room); io.to(roomCode).emit("gameStarted", { state: R.publicRoomState(room) }); broadcast(roomCode);
  });
  socket.on("beginDiscussion", ({ roomCode }) => {
    const room = R.getRoom(roomCode); if (!room || room.hostId !== socket.id) return;
    const result = R.beginDiscussion(room, TURN_DURATION_MS); if (!result.ok) return;
    const state = R.publicRoomState(room);
    io.to(roomCode).emit("discussionStarted", { state, chat: room.chat.slice(-60) });
    io.to(roomCode).emit("turnAdvanced", { reason: "round-start", state });
    broadcast(roomCode); scheduleTurnTimer(roomCode);
  });
  socket.on("chat", ({ roomCode, text }) => {
    const room = R.getRoom(roomCode); if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.alive || room.phase === "lobby" || room.phase === "gameover") return;
    if (room.phase === "discussion") return submitClueFromSocket(socket, roomCode, text);
    const msg = R.addChat(room, player.pid, text); if (msg) io.to(roomCode).emit("chat", msg);
  });
  socket.on("submitClue", ({ roomCode, text }, cb) => submitClueFromSocket(socket, roomCode, text, cb));
  socket.on("callVote", ({ roomCode }) => {
    const room = R.getRoom(roomCode); if (!room || room.hostId !== socket.id) return;
    const result = R.callVote(room); if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    clearTurnTimer(roomCode); io.to(roomCode).emit("votingStarted", { state: R.publicRoomState(room) }); broadcast(roomCode);
  });
  socket.on("castVote", ({ roomCode, target }) => {
    const room = R.getRoom(roomCode); if (!room) return;
    const voter = room.players.find((p) => p.id === socket.id); if (!voter) return;
    const result = R.castVote(room, voter.pid, target); if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    broadcast(roomCode); if (result.complete) doResolve(roomCode, false);
  });
  socket.on("endVoting", ({ roomCode }) => {
    const room = R.getRoom(roomCode); if (!room || room.hostId !== socket.id || room.phase !== "voting") return;
    doResolve(roomCode, true);
  });
  socket.on("newGame", ({ roomCode }) => {
    const room = R.getRoom(roomCode); if (!room || room.hostId !== socket.id) return;
    clearTurnTimer(roomCode); R.backToLobby(room); broadcast(roomCode); io.to(roomCode).emit("returnedToLobby", { state: R.publicRoomState(room) });
  });
  socket.on("leaveRoom", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    const leaving = room ? room.players.find((p) => p.id === socket.id) : null;
    if (leaving) clearDisconnectGrace(roomCode, leaving.pid);

    const result = R.removePlayerFromRoom(roomCode, socket.id, true); socket.leave(roomCode);
    if (!result || result.roomDeleted || !result.room) { clearTurnTimer(roomCode); return; }
    advanceUnavailableTurn(roomCode); broadcast(roomCode); if (result.votingComplete) doResolve(roomCode, false);
  });
  socket.on("disconnect", () => {
    const pid = socket.data.pid;
    const result = R.removePlayerFromAll(socket.id); if (!result) return;
    if (result.roomDeleted || !result.room) { clearTurnTimer(result.roomCode); return; }

    if (pid) scheduleDisconnectCleanup(result.roomCode, pid);
    advanceUnavailableTurn(result.roomCode);
    broadcast(result.roomCode);
    if (result.votingComplete) doResolve(result.roomCode, false);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Imposter server on port ${PORT}`));
