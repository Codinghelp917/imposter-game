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
// Dev-only icons. These are never sent to a normal client and the server
// refuses to equip one unless that socket has unlocked it, so knowing the image
// URL is not enough to wear it.
const SECRET_DIR = path.join(PUBLIC_DIR, "images", "secret");
const BUILTIN_SECRET = ["secret:itachi"];
const DEV_CODE = (process.env.DEV_CODE || "sharingan").trim();
const MAX_UNLOCK_TRIES = 8;

let secretCache = { at: 0, list: [] };
function getSecretIcons() {
  const now = Date.now();
  if (now - secretCache.at < ICON_CACHE_MS) return secretCache.list;
  let files = [];
  try {
    files = fs.readdirSync(SECRET_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && ICON_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map((e) => `/images/secret/${encodeURIComponent(e.name)}`)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    files = [];
  }
  secretCache = { at: now, list: [...BUILTIN_SECRET, ...files] };
  return secretCache.list;
}

function getIconList() { return [...CREW_ICONS, ...getPictureIcons()]; }
function getAllIcons() { return [...getIconList(), ...getSecretIcons()]; }

function safePlayerIcon(icon, allowSecret) {
  const allowed = allowSecret ? getAllIcons() : getIconList();
  if (typeof icon === "string" && allowed.includes(icon)) return icon;
  return getIconList()[0];
}

app.use(express.static(PUBLIC_DIR));

/* ---------------- game modes ----------------
   One engine, one room system, separate word libraries. Adding a mode here is
   all it takes on the server — the room remembers which one it is, so only the
   host picks and everyone joining by code inherits it.                       */
function loadLibrary(file) {
  const raw = require(file);
  // Word files may carry a leading `_readme` block; it is documentation, not a
  // category, so drop anything that has no words array.
  const out = {};
  Object.keys(raw).forEach((k) => { if (raw[k] && Array.isArray(raw[k].words)) out[k] = raw[k]; });
  return out;
}
const LIBRARIES = {
  classic: loadLibrary("./categories.json"),
  football: loadLibrary("./football_list.json")
};
const DEFAULT_MODE = "classic";
const isMode = (m) => Object.prototype.hasOwnProperty.call(LIBRARIES, m);
const libraryFor = (room) => LIBRARIES[(room && room.mode) || DEFAULT_MODE] || LIBRARIES[DEFAULT_MODE];

const CATEGORY_LISTS = {};
Object.keys(LIBRARIES).forEach((mode) => {
  const lib = LIBRARIES[mode];
  CATEGORY_LISTS[mode] = Object.keys(lib).map((name) => ({
    name, emoji: lib[name].emoji, count: lib[name].words.length
  }));
});
const categoryListFor = (mode) => CATEGORY_LISTS[isMode(mode) ? mode : DEFAULT_MODE];
// A new room starts with every category in its library ticked, so a mode is
// playable the moment it is created.
const defaultCategoriesFor = (mode) => categoryListFor(mode).map((c) => c.name);

Object.keys(LIBRARIES).forEach((mode) => {
  const words = Object.values(LIBRARIES[mode]).reduce((n, c) => n + c.words.length, 0);
  console.log(`mode "${mode}": ${Object.keys(LIBRARIES[mode]).length} categories, ${words} words`);
});

// Deep links: /football and /classic serve the same page, which reads the path
// to preselect a mode. Everything else still falls through to static files.
app.get(["/classic", "/football"], (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

function envMs(name, fallback, { min = 0 } = {}) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
const TURN_DURATION_MS = envMs("TURN_DURATION_MS", 30_000, { min: 1 });
const GUESS_DURATION_MS = envMs("GUESS_DURATION_MS", 25_000, { min: 1 });
const RECONNECT_GRACE_MS = envMs("RECONNECT_GRACE_MS", 5 * 60_000);
// Vote tally screen (2.6s) + ejection cutscene (3.6s). Turn and guess clocks are
// scheduled to start only once this whole sequence has played, so nobody loses
// time to an animation they are still watching. Must match the client.
const EJECTION_REVEAL_MS = envMs("EJECTION_REVEAL_MS", 6_200);
// The room runs itself between "Start game" and "New game". These are the
// backstops; each phase normally advances as soon as everyone has acted.
const REVEAL_MAX_MS = envMs("REVEAL_MAX_MS", 45_000, { min: 1 });      // if someone never flips
const CLUES_TO_VOTE_MS = envMs("CLUES_TO_VOTE_MS", 4_000, { min: 0 }); // beat to read the last clue
const VOTE_MAX_MS = envMs("VOTE_MAX_MS", 60_000, { min: 1 });          // if someone never votes

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
  // One hint is picked at random when the game starts and stays put for the
  // whole game. The extra hints per word exist so the same word plays
  // differently across games — not to hand the imposter a fresh angle each
  // round, which made them far too easy to piece together.
  return h[(room.hintRotation || 0) % h.length];
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
    syncAuto(code);
  }, delay + 5));
}
function advanceUnavailableTurn(code) {
  const room = R.getRoom(code);
  if (!room || room.phase !== "discussion" || room.cluesComplete) return;
  const result = R.ensureActiveTurn(room, TURN_DURATION_MS);
  if (result.changed) io.to(code).emit("turnAdvanced", { reason: "player-left", state: R.publicRoomState(room) });
  scheduleTurnTimer(code);
  syncAuto(code);
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
  syncAuto(code);
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
  syncAuto(roomCode);
  if (typeof cb === "function") cb({ ok: true, state });
}

/* ---------------- auto-advance ----------------
   The host presses Start game and, later, New game. Everything between those
   two runs itself: the reveal ends when everyone has flipped their card, the
   vote opens when the last clue lands, and the vote resolves when the last
   ballot is in. The timers below are only backstops for someone who wanders
   off, so one idle player can never strand the room.                        */
const phaseTimers = new Map();
function clearPhaseTimer(code) {
  const entry = phaseTimers.get(code);
  if (entry) clearTimeout(entry.timer);
  phaseTimers.delete(code);
}
function armAuto(code, kind, ms, fn) {
  const current = phaseTimers.get(code);
  if (current && current.kind === kind) return;   // already ticking — don't push the deadline back
  clearPhaseTimer(code);
  const room = R.getRoom(code);
  if (!room) return;
  R.setAuto(room, kind, ms);
  const timer = setTimeout(() => { phaseTimers.delete(code); fn(); }, ms + 5);
  phaseTimers.set(code, { kind, timer });
}
// Single source of truth: look at the room and arm whatever it is waiting on.
// Callers usually broadcast before reaching here, so re-broadcast whenever the
// countdown actually changed — otherwise clients never see the new deadline.
function syncAuto(code) {
  const room = R.getRoom(code);
  if (!room) return clearPhaseTimer(code);
  const before = room.autoKind;

  if (room.phase === "reveal")
    armAuto(code, "discussion", REVEAL_MAX_MS, () => doBeginDiscussion(code));
  else if (room.phase === "discussion" && room.cluesComplete)
    armAuto(code, "vote", CLUES_TO_VOTE_MS, () => doCallVote(code));
  else if (room.phase === "voting")
    armAuto(code, "resolve", VOTE_MAX_MS, () => doResolve(code, true));
  else { clearPhaseTimer(code); R.clearAuto(room); }

  if (room.autoKind !== before) broadcast(code);
}

function doBeginDiscussion(code) {
  const room = R.getRoom(code);
  if (!room || room.phase !== "reveal") return;
  const result = R.beginDiscussion(room, TURN_DURATION_MS);
  if (!result.ok) return;
  const state = R.publicRoomState(room);
  io.to(code).emit("discussionStarted", { state, chat: room.chat.slice(-60) });
  io.to(code).emit("turnAdvanced", { reason: "round-start", state });
  broadcast(code);
  scheduleTurnTimer(code);
  syncAuto(code);
}
function doCallVote(code) {
  const room = R.getRoom(code);
  if (!room || room.phase !== "discussion" || !room.cluesComplete) return;
  const result = R.callVote(room);
  if (!result.ok) return;
  clearTurnTimer(code);
  io.to(code).emit("votingStarted", { state: R.publicRoomState(room) });
  broadcast(code);
  syncAuto(code);
}
// A player leaving during the reveal can be the one everyone was waiting on.
function maybeAdvanceReveal(code) {
  const room = R.getRoom(code);
  if (!room || room.phase !== "reveal") return;
  if (R.readyTally(room).allReady) doBeginDiscussion(code);
}

function doResolve(code, force) {
  clearTurnTimer(code);
  const room = R.getRoom(code);
  if (!room) return;
  const res = force ? R.forceResolve(room, resolveOpts()) : R.resolveVote(room, resolveOpts());
  if (!res) return;
  io.to(code).emit("voteResolved", { resolution: res, state: R.publicRoomState(room) });
  broadcast(code);
  if (res.pendingGuess) { scheduleGuessTimer(code); syncAuto(code); return; }
  if (room.phase === "discussion") { dealRoles(room); scheduleTurnTimer(code); }
  syncAuto(code);
}

io.on("connection", (socket) => {
  socket.emit("categories", categoryListFor(DEFAULT_MODE));
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
    // Only the room's creator picks the mode; everyone joining by code inherits
    // it from the room, so nobody else has to know which game they're joining.
    const payload = (args[0] && typeof args[0] === "object") ? args[0] : {};
    const mode = isMode(payload.mode) ? payload.mode : DEFAULT_MODE;
    const { roomCode } = R.createRoom(socket.id, mode, defaultCategoriesFor(mode));
    if (!roomCode) {
      if (typeof cb === "function") cb({ ok: false, error: "The server is full of rooms right now. Try again in a minute." });
      return;
    }
    socket.join(roomCode);
    if (typeof cb === "function") cb({ ok: true, roomCode, mode, categories: categoryListFor(mode) });
  });

  // Unlock the dev icons for this connection. Rate limited so the code can't be
  // brute forced over the socket.
  let unlockTries = 0;
  socket.on("devUnlock", ({ code } = {}, cb) => {
    const reply = (ok, icons) => { if (typeof cb === "function") cb({ ok, icons: icons || [] }); };
    if (unlockTries >= MAX_UNLOCK_TRIES) return reply(false);
    unlockTries += 1;
    const ok = !!DEV_CODE && typeof code === "string" && code.trim() === DEV_CODE;
    if (ok) {
      socket.data.dev = true; unlockTries = 0;
      // Unlocking while already sat in a room should light the badge up there
      // and then, rather than only on the next join.
      const room = R.getRoom(socket.data.roomCode);
      const player = room && room.players.find((p) => p.id === socket.id);
      if (player && !player.dev) { player.dev = true; broadcast(socket.data.roomCode); }
    }
    reply(ok, ok ? getSecretIcons() : []);
  });

  socket.on("joinRoom", ({ roomCode, name, icon }, cb) => {
    const result = R.validateAndAddPlayer({
      roomCode, socketId: socket.id, name,
      icon: safePlayerIcon(icon, socket.data.dev), iconPool: getIconList(), dev: socket.data.dev
    });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    socket.join(roomCode); socket.data.roomCode = roomCode; socket.data.pid = player.pid;
    if (typeof cb === "function") cb({
      ok: true, pid: player.pid, icon: player.icon,
      isHost: R.isActingHost(room, socket.id),
      state: R.publicRoomState(room), categories: categoryListFor(room.mode)
    });
    broadcast(roomCode);
  });

  socket.on("rejoinRoom", ({ roomCode, pid, name, icon }, cb) => {
    const result = R.rejoinByPid({
      roomCode, socketId: socket.id, pid, name,
      icon: safePlayerIcon(icon, socket.data.dev), iconPool: getIconList(), dev: socket.data.dev
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
      gameResult: room.gameResult, finished: R.finishedSummary(room), categories: categoryListFor(room.mode)
    });
    broadcast(roomCode); scheduleTurnTimer(roomCode); scheduleGuessTimer(roomCode); syncAuto(roomCode);
  });

  socket.on("updateSettings", ({ roomCode, categories, imposters, hintsEnabled, guessEnabled, tier }) => {
    const room = hostGate(roomCode); if (!room) return;
    R.setSettings(room, { categories, imposters, hintsEnabled, guessEnabled, tier }, libraryFor(room)); broadcast(roomCode);
  });

  socket.on("startGame", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room) return;
    const result = R.startGame(room, libraryFor(room));
    if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    dealRoles(room); io.to(roomCode).emit("gameStarted", { state: R.publicRoomState(room) }); broadcast(roomCode);
    syncAuto(roomCode);
  });

  // Flipping the role card is the "I've seen it" signal. When the last person
  // flips, the discussion starts on its own.
  socket.on("revealReady", ({ roomCode }) => {
    const room = R.getRoom(roomCode); if (!room || room.phase !== "reveal") return;
    const player = room.players.find((p) => p.id === socket.id); if (!player) return;
    const res = R.markReady(room, player.pid);
    if (!res.ok) return;
    broadcast(roomCode);
    if (res.allReady) doBeginDiscussion(roomCode);
  });

  // Host override: skip the wait and start now.
  socket.on("beginDiscussion", ({ roomCode }) => {
    if (!hostGate(roomCode)) return;
    doBeginDiscussion(roomCode);
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
    syncAuto(roomCode);
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

  // Host override: open the vote without waiting out the beat.
  socket.on("callVote", ({ roomCode }) => {
    if (!hostGate(roomCode)) return;
    doCallVote(roomCode);
  });

  socket.on("castVote", ({ roomCode, target }) => {
    const room = R.getRoom(roomCode); if (!room) return;
    const voter = room.players.find((p) => p.id === socket.id); if (!voter) return;
    const result = R.castVote(room, voter.pid, target); if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    broadcast(roomCode);
    if (result.complete) doResolve(roomCode, false);
  });

  socket.on("endVoting", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room || room.phase !== "voting") return;
    doResolve(roomCode, true);
  });

  // Mid-game escape hatches for the host: someone already knew the word, or the
  // group just wants to stop. Scores are kept either way — an abandoned game
  // scores nothing because it never reached a result.
  socket.on("abandonGame", ({ roomCode, mode }) => {
    const room = hostGate(roomCode); if (!room) return;
    if (room.phase === "lobby") return;
    clearTurnTimer(roomCode); clearGuessTimer(roomCode); clearPhaseTimer(roomCode);
    const hostName = (R.actingHost(room) || {}).name || "The host";

    R.backToLobby(room);

    if (mode === "redeal") {
      const result = R.startGame(room, libraryFor(room));
      if (result.ok) {
        R.addSystem(room, `${hostName} redealt — fresh word, fresh imposter.`);
        dealRoles(room);
        io.to(roomCode).emit("toast", { type: "info", message: "Redealt — new word and new roles." });
        io.to(roomCode).emit("gameStarted", { state: R.publicRoomState(room) });
        broadcast(roomCode); syncAuto(roomCode);
        return;
      }
      // Not enough players left to redeal — fall back to the lobby.
      io.to(roomCode).emit("toast", { type: "error", message: result.error });
    }

    io.to(roomCode).emit("toast", { type: "info", message: `${hostName} ended the game.` });
    broadcast(roomCode);
    io.to(roomCode).emit("returnedToLobby", { state: R.publicRoomState(room) });
  });

  socket.on("newGame", ({ roomCode }) => {
    const room = hostGate(roomCode); if (!room) return;
    clearTurnTimer(roomCode); clearGuessTimer(roomCode); clearPhaseTimer(roomCode);
    R.backToLobby(room); broadcast(roomCode); io.to(roomCode).emit("returnedToLobby", { state: R.publicRoomState(room) });
  });

  socket.on("leaveRoom", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    const leaving = room ? room.players.find((p) => p.id === socket.id) : null;
    if (leaving) clearDisconnectGrace(roomCode, leaving.pid);

    const result = R.removePlayerFromRoom(roomCode, socket.id, true); socket.leave(roomCode);
    if (!result || result.roomDeleted || !result.room) { clearTurnTimer(roomCode); clearGuessTimer(roomCode); clearPhaseTimer(roomCode); return; }
    if (result.guesserGone) finishGuess(roomCode, null);
    advanceUnavailableTurn(roomCode); broadcast(roomCode);
    if (result.votingComplete) doResolve(roomCode, false);
    maybeAdvanceReveal(roomCode); syncAuto(roomCode);
  });

  socket.on("disconnect", () => {
    const pid = socket.data.pid;
    const result = R.removePlayerFromAll(socket.id); if (!result) return;
    if (result.roomDeleted || !result.room) { clearTurnTimer(result.roomCode); clearGuessTimer(result.roomCode); clearPhaseTimer(result.roomCode); return; }

    if (pid) scheduleDisconnectCleanup(result.roomCode, pid);
    advanceUnavailableTurn(result.roomCode);
    broadcast(result.roomCode);
    if (result.votingComplete) doResolve(result.roomCode, false);
    maybeAdvanceReveal(result.roomCode); syncAuto(result.roomCode);
  });
});

// Rooms only ever lived in memory and nothing reclaimed one that was created but
// never joined. Sweep those, plus rooms everybody abandoned long ago.
const sweeper = setInterval(() => {
  const dropped = R.sweepRooms();
  dropped.forEach((code) => { clearTurnTimer(code); clearGuessTimer(code); clearPhaseTimer(code); });
  if (dropped.length) console.log(`swept ${dropped.length} stale room(s)`);
}, 60_000);
if (typeof sweeper.unref === "function") sweeper.unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Imposter server on port ${PORT}`));
