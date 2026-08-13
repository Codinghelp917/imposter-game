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

// Classic crewmate colours, drawn client-side as SVG. These are the default
// look; anything dropped into public/images/icons/ is offered alongside them.
const CREW_COLORS = ["red", "blue", "green", "pink", "orange", "yellow",
                     "black", "white", "purple", "brown", "cyan", "lime"];
const CREW_ICONS = CREW_COLORS.map((c) => `crew:${c}`);

// The icon folder was being re-read with readdirSync on every join, rejoin and
// connection. Cache it briefly so a busy lobby is not hammering the disk.
const ICON_CACHE_MS = 5_000;
let iconCache = { at: 0, list: [] };
function getPictureIcons() {
  const now = Date.now();
  if (now - iconCache.at < ICON_CACHE_MS) return iconCache.list;
  let list = [];
  try {
    list = fs.readdirSync(ICON_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ICON_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => `/images/icons/${encodeURIComponent(entry.name)}`)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    list = [];
  }
  iconCache = { at: now, list };
  return list;
}
function getIconList() { return [...CREW_ICONS, ...getPictureIcons()]; }

function safePlayerIcon(icon) {
  const icons = getIconList();
  if (typeof icon === "string" && icons.includes(icon)) return icon;
  return icons[0];
}

app.use(express.static(PUBLIC_DIR));

const CATEGORIES = require("./categories.json");
const CATEGORY_LIST = Object.keys(CATEGORIES).map((name) => ({
  name, emoji: CATEGORIES[name].emoji, count: CATEGORIES[name].words.length
}));

function envMs(name, fallback, { min = 0 } = {}) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
const TURN_DURATION_MS = envMs("TURN_DURATION_MS", 30_000, { min: 1 });
const GUESS_DURATION_MS = envMs("GUESS_DURATION_MS", 25_000, { min: 1 });
const RECONNECT_GRACE_MS = envMs("RECONNECT_GRACE_MS", 5 * 60_000);
// How long the client spends on the ejection cutscene. The next round's clock
// (and the imposter's guess clock) start only once it has finished, so nobody
// loses time to an animation they are still watching.
const EJECTION_REVEAL_MS = envMs("EJECTION_REVEAL_MS", 3_600);

const resolveOpts = () => ({
  turnDurationMs: TURN_DURATION_MS,
  guessDurationMs: GUESS_DURATION_MS,
  ejectionDelayMs: EJECTION_REVEAL_MS
});

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

function broadcast(code) {
  const room = R.getRoom(code);
  if (room) io.to(code).emit("roomUpdate", R.publicRoomState(room));
}
function imposterHint(room) {
  if (!room.settings || room.settings.hintsEnabled === false) return null;
  const h = room.wordHints || [];
  if (!h.length) return null;
  const rot = room.hintRotation || 0;
  const idx = (rot + Math.max(0, (room.round || 1) - 1)) % h.length;
  return h[idx];
}
function rolePayload(room, player) {
  return {
    isImposter: player.isImposter,
    word: player.isImposter ? null : room.word,
    category: player.isImposter ? null : room.category,
    hint: player.isImposter ? imposterHint(room) : null,
    hintsEnabled: room.settings ? room.settings.hintsEnabled !== false : true,
    guessEnabled: room.settings ? room.settings.guessEnabled !== false : true,
    round: room.round,
    maxRounds: room.maxRounds
  };
}
function dealRoles(room) {
  room.players.forEach((p) => { if (p.connected) io.to(p.id).emit("role", rolePayload(room, p)); });
}

/* ---------------- turn clock ---------------- */
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

/* ---------------- imposter's last-words guess ---------------- */
const guessTimers = new Map();
function clearGuessTimer(code) {
  const timer = guessTimers.get(code);
  if (timer) clearTimeout(timer);
  guessTimers.delete(code);
}
function scheduleGuessTimer(code) {
  clearGuessTimer(code);
  const room = R.getRoom(code);
  if (!room || room.phase !== "guessing" || !room.guess || room.guess.resolved) return;
  const delay = Math.max(0, room.guess.endsAt - Date.now());
  guessTimers.set(code, setTimeout(() => {
    guessTimers.delete(code);
    finishGuess(code, null);
  }, delay + 5));
}
function finishGuess(code, text) {
  clearGuessTimer(code);
  const room = R.getRoom(code);
  if (!room) return null;
  const res = R.finalizeGuess(room, text);
  if (!res) return null;
  io.to(code).emit("guessResolved", { resolution: res, state: R.publicRoomState(room) });
  broadcast(code);
  return res;
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
      clearGuessTimer(roomCode);
      return;
    }

    if (result.guesserGone) finishGuess(roomCode, null);
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
  const res = force ? R.forceResolve(room, resolveOpts()) : R.resolveVote(room, resolveOpts());
  if (!res) return;
  io.to(code).emit("voteResolved", { resolution: res, state: R.publicRoomState(room) });
  broadcast(code);
  if (res.pendingGuess) { scheduleGuessTimer(code); return; }
  if (room.phase === "discussion") { dealRoles(room); scheduleTurnTimer(code); }
}

io.on("connection", (socket) => {
  socket.emit("categories", CATEGORY_LIST);
  socket.emit("icons", getIconList());

  const hostGate = (roomCode) => {
    const room = R.getRoom(roomCode);
    if (!room) return null;
    if (!R.isActingHost(room, socket.id)) {
      socket.emit("toast", { type: "error", message: "Only the host can do that." });
      return null;
    }
    return room;
  };

  socket.on("createRoom", (...args) => {
    const cb = args[args.length - 1];
    const { roomCode } = R.createRoom(socket.id);
    if (!roomCode) {
      if (typeof cb === "function") cb({ ok: false, error: "The server is full of rooms right now. Try again in a minute." });
      return;
    }
    socket.join(roomCode);
    if (typeof cb === "function") cb({ ok: true, roomCode, categories: CATEGORY_LIST });
  });

  socket.on("joinRoom", ({ roomCode, name, icon }, cb) => {
    const result = R.validateAndAddPlayer({
      roomCode, socketId: socket.id, name,
      icon: safePlayerIcon(icon), iconPool: getIconList()
    });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    socket.join(roomCode); socket.data.roomCode = roomCode; socket.data.pid = player.pid;
    if (typeof cb === "function") cb({
      ok: true, pid: player.pid, icon: player.icon,
      isHost: R.isActingHost(room, socket.id),
      state: R.publicRoomState(room), categories: CATEGORY_LIST
    });
    broadcast(roomCode);
  });

  socket.on("rejoinRoom", ({ roomCode, pid, name, icon }, cb) => {
    const result = R.rejoinByPid({
      roomCode, socketId: socket.id, pid, name,
      icon: safePlayerIcon(icon), iconPool: getIconList()
    });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    clearDisconnectGrace(roomCode, player.pid);
    socket.join(roomCode); socket.data.roomCode = roomCode; socket.data.pid = player.pid;
    if (room.phase !== "lobby") socket.emit("role", rolePayload(room, player));
    if (typeof cb === "function") cb({
      ok: true, pid: player.pid, icon: player.icon,
      isHost: R.isActingHost(room, socket.id),
      state: R.publicRoomState(room), chat: room.chat.slice(-60),
      gameResult: room.gameResult, finished: R.finishedSummary(room), categories: CATEGORY_LIST
    });
    broadcast(roomCode); scheduleTurnTimer(roomCode); scheduleGuessTimer(roomCode);
  });

  socket.on("updateSettings", ({ roomCode, categories, imposters, hintsEnabled, guessEnabled }) => {
    const room = hostGate(roomCode); if (!room) return;
    R.setSettings(room, { categories, imposters, hintsEnabled, guessEnabled }, CATEGORIES); broadcast(roomCode);
  });

  socket.on("startGame", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room) return;
    const result = R.startGame(room, CATEGORIES);
    if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    dealRoles(room); io.to(roomCode).emit("gameStarted", { state: R.publicRoomState(room) }); broadcast(roomCode);
  });

  socket.on("beginDiscussion", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room) return;
    const result = R.beginDiscussion(room, TURN_DURATION_MS); if (!result.ok) return;
    const state = R.publicRoomState(room);
    io.to(roomCode).emit("discussionStarted", { state, chat: room.chat.slice(-60) });
    io.to(roomCode).emit("turnAdvanced", { reason: "round-start", state });
    broadcast(roomCode); scheduleTurnTimer(roomCode);
  });

  socket.on("chat", ({ roomCode, text }) => {
    const room = R.getRoom(roomCode); if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.alive) return;
    if (room.phase === "discussion") return submitClueFromSocket(socket, roomCode, text);
    // Free-for-all accusations are only open while the meeting is voting.
    if (room.phase !== "voting") return;
    const msg = R.addChat(room, player.pid, text); if (msg) io.to(roomCode).emit("chat", msg);
  });

  socket.on("submitClue", ({ roomCode, text }, cb) => submitClueFromSocket(socket, roomCode, text, cb));

  // A living imposter gambling on the word mid-discussion.
  socket.on("imposterGuess", ({ roomCode, text }, cb) => {
    const room = R.getRoom(roomCode);
    if (!room) return typeof cb === "function" && cb({ ok: false, error: "Room not found." });
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return typeof cb === "function" && cb({ ok: false, error: "You're not in this room." });
    const res = R.imposterSnapGuess(room, player.pid, text, TURN_DURATION_MS);
    if (!res.ok) {
      socket.emit("toast", { type: "error", message: res.error });
      if (typeof cb === "function") cb(res);
      return;
    }
    clearTurnTimer(roomCode);
    const state = R.publicRoomState(room);
    const resolution = {
      guess: res.guess, result: res.result, word: res.word,
      category: res.category, imposterNames: res.imposterNames || null
    };
    io.to(roomCode).emit("guessResolved", { resolution, state });
    broadcast(roomCode);
    if (!res.result && room.phase === "discussion") scheduleTurnTimer(roomCode);
    if (typeof cb === "function") cb({ ok: true, correct: res.guess.correct });
  });

  // The ejected imposter's final guess.
  socket.on("submitGuess", ({ roomCode, text }, cb) => {
    const room = R.getRoom(roomCode);
    if (!room) return typeof cb === "function" && cb({ ok: false, error: "Room not found." });
    if (room.phase !== "guessing" || !room.guess || room.guess.resolved)
      return typeof cb === "function" && cb({ ok: false, error: "The guess window has closed." });
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.pid !== room.guess.pid)
      return typeof cb === "function" && cb({ ok: false, error: "This isn't your guess to make." });
    const clean = (text || "").toString().trim();
    if (!clean) return typeof cb === "function" && cb({ ok: false, error: "Type a word first." });
    const res = finishGuess(roomCode, clean);
    if (typeof cb === "function") cb({ ok: true, correct: !!(res && res.guess && res.guess.correct) });
  });

  socket.on("callVote", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room) return;
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
    const room = hostGate(roomCode); if (!room || room.phase !== "voting") return;
    doResolve(roomCode, true);
  });

  socket.on("newGame", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room) return;
    clearTurnTimer(roomCode); clearGuessTimer(roomCode);
    R.backToLobby(room); broadcast(roomCode); io.to(roomCode).emit("returnedToLobby", { state: R.publicRoomState(room) });
  });

  socket.on("leaveRoom", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    const leaving = room ? room.players.find((p) => p.id === socket.id) : null;
    if (leaving) clearDisconnectGrace(roomCode, leaving.pid);

    const result = R.removePlayerFromRoom(roomCode, socket.id, true); socket.leave(roomCode);
    if (!result || result.roomDeleted || !result.room) { clearTurnTimer(roomCode); clearGuessTimer(roomCode); return; }
    if (result.guesserGone) finishGuess(roomCode, null);
    advanceUnavailableTurn(roomCode); broadcast(roomCode); if (result.votingComplete) doResolve(roomCode, false);
  });

  socket.on("disconnect", () => {
    const pid = socket.data.pid;
    const result = R.removePlayerFromAll(socket.id); if (!result) return;
    if (result.roomDeleted || !result.room) { clearTurnTimer(result.roomCode); clearGuessTimer(result.roomCode); return; }

    if (pid) scheduleDisconnectCleanup(result.roomCode, pid);
    advanceUnavailableTurn(result.roomCode);
    broadcast(result.roomCode);
    if (result.votingComplete) doResolve(result.roomCode, false);
  });
});

// Rooms only ever lived in memory and nothing reclaimed one that was created but
// never joined. Sweep those, plus rooms everybody abandoned long ago.
const sweeper = setInterval(() => {
  const dropped = R.sweepRooms();
  dropped.forEach((code) => { clearTurnTimer(code); clearGuessTimer(code); });
  if (dropped.length) console.log(`swept ${dropped.length} stale room(s)`);
}, 60_000);
if (typeof sweeper.unref === "function") sweeper.unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Imposter server on port ${PORT}`));
