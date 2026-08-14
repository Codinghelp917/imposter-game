// rooms.js — Among Us–style imposter word game.
//
// A game = one secret word + hidden imposter(s). Players take turns dropping a
// clue, then the crew votes. Skipping (or a tie) advances to the next round.
// You get 3 rounds per imposter to catch them.
//   - Eject a crewmate  -> they're out, game continues.
//   - Eject an imposter -> they get one last guess at the word. Name it and the
//                          imposters steal the win; miss it and the crew win.
//   - Run out of rounds / reach parity -> imposters win.
//
// A living imposter can also gamble a guess mid-discussion at any time.
//
// phase: "lobby" | "reveal" | "discussion" | "voting" | "guessing" | "gameover"

const crypto = require("crypto");

const rooms = {};
const MAX_CHAT = 120;
const DEFAULT_TURN_DURATION_MS = 30_000;
const DEFAULT_GUESS_DURATION_MS = 25_000;
const EMPTY_ROOM_TTL_MS = 2 * 60_000;       // created but nobody ever joined
const ABANDONED_ROOM_TTL_MS = 30 * 60_000;  // everybody has been gone this long

// ---------------- helpers ----------------
function randomCode() {
  // Always exactly 4 digits. (The old slice-of-a-float trick could, very rarely,
  // produce a 1–3 digit code that the 4-digit join box could never enter.)
  if (Object.keys(rooms).length >= 9000) return null;
  let code;
  do { code = String(Math.floor(Math.random() * 10000)).padStart(4, "0"); } while (rooms[code]);
  return code;
}
function randomPid() {
  // A pid is a bearer token for a seat — it restores your role on reconnect, so
  // it should not be guessable from Math.random + a timestamp.
  return crypto.randomBytes(9).toString("base64url");
}
function normalize(s) {
  // NFD splits "é" into "e" + a combining mark; \p{Mn} strips the marks.
  return (s || "").toString().normalize("NFD").replace(/\p{Mn}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}
// Fisher-Yates. The old `sort(() => Math.random() - 0.5)` is not a shuffle: a
// random comparator is inconsistent, so the sort leaves elements near where they
// started. With 4 players the first to join drew position 0 — and therefore the
// imposter role — 36% of the time instead of 25%, which is why the same person
// kept being the imposter.
function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getRoom(code) { return rooms[code] || null; }
function getPlayerByPid(room, pid) { return room ? room.players.find((p) => p.pid === pid) || null : null; }
function getHostPlayer(room) { return room ? room.players.find((p) => p.id === room.hostId) || null : null; }

function ensureHost(room) {
  if (!room) return;
  if (!room.hostId || !room.players.some((p) => p.id === room.hostId)) {
    const firstConnected = room.players.find((p) => p.connected) || room.players[0];
    room.hostId = firstConnected ? firstConnected.id : null;
  }
}

// The host's *seat* stays reserved while they are temporarily away, but their
// *powers* must not: otherwise one person locking their phone freezes the game
// for everyone until the reconnect grace window expires.
function actingHost(room) {
  if (!room) return null;
  const host = getHostPlayer(room);
  if (host && host.connected) return host;
  return room.players.find((p) => p.connected) || host || null;
}
function isActingHost(room, socketId) {
  const h = actingHost(room);
  return !!(h && socketId && h.id === socketId);
}
function hostIsAway(room) {
  const host = getHostPlayer(room);
  return !!(host && !host.connected);
}

function aliveConnected(room) {
  return room.players.filter((p) => p.alive && p.connected);
}
function impostersAlive(room) {
  return room.players.filter((p) => p.isImposter && p.alive).length;
}
function crewAlive(room) {
  return room.players.filter((p) => !p.isImposter && p.alive).length;
}

function currentTurnPlayer(room) {
  if (!room || room.phase !== "discussion" || room.cluesComplete) return null;
  const pid = room.turnOrder && room.turnOrder[room.turnIndex];
  return pid ? getPlayerByPid(room, pid) : null;
}

// startDelayMs lets the clock begin *after* a client-side cutscene finishes, so
// the first player of a new round is not silently robbed of those seconds.
function setTurnClock(room, durationMs, startDelayMs = 0) {
  const ms = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
    ? Number(durationMs) : DEFAULT_TURN_DURATION_MS;
  const delay = Math.max(0, Number(startDelayMs) || 0);
  room.turnDurationMs = ms;
  room.turnStartedAt = Date.now() + delay;
  room.turnEndsAt = room.turnStartedAt + ms;
}

// The speaking order is drawn once per game and then held. Reshuffling every
// round would throw away the read on who followed whom, which is half the game.
// Ejected and disconnected players drop out; the survivors keep their places.
function setupTurnOrder(room, durationMs = DEFAULT_TURN_DURATION_MS, startDelayMs = 0) {
  const byPid = new Map(room.players.map((p) => [p.pid, p]));
  let participants;
  if (room.baseOrder && room.baseOrder.length) {
    participants = room.baseOrder.map((pid) => byPid.get(pid)).filter((p) => p && p.alive && p.connected);
    // Anyone eligible but missing from the draw (e.g. reconnected after the
    // order was set) goes on the end rather than being skipped forever.
    const seen = new Set(participants.map((p) => p.pid));
    aliveConnected(room).forEach((p) => { if (!seen.has(p.pid)) { participants.push(p); room.baseOrder.push(p.pid); } });
  } else {
    participants = shuffle(aliveConnected(room));
    room.baseOrder = participants.map((p) => p.pid);
  }
  room.turnOrder = participants.map((p) => p.pid);
  room.order = participants.map((p) => p.name);
  room.turnIndex = participants.length ? 0 : -1;
  room.cluesComplete = participants.length === 0;
  if (participants.length) setTurnClock(room, durationMs, startDelayMs);
  else { room.turnStartedAt = null; room.turnEndsAt = null; }
  return currentTurnPlayer(room);
}

function advanceTurn(room, reason = "submitted", durationMs = room && room.turnDurationMs) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "discussion") return { ok: false, error: "Clue turns are not active." };
  if (room.cluesComplete) return { ok: true, complete: true, room, activePlayer: null };

  const previous = currentTurnPlayer(room);
  if (reason === "timeout" && previous) addSystem(room, `${previous.name} ran out of time.`);

  let nextIndex = room.turnIndex + 1;
  let nextPlayer = null;
  while (nextIndex < room.turnOrder.length) {
    const candidate = getPlayerByPid(room, room.turnOrder[nextIndex]);
    if (candidate && candidate.alive && candidate.connected) { nextPlayer = candidate; break; }
    nextIndex += 1;
  }

  if (!nextPlayer) {
    room.turnIndex = room.turnOrder.length;
    room.cluesComplete = true;
    room.turnStartedAt = null;
    room.turnEndsAt = null;
    addSystem(room, "Everyone has had their turn — the host can call the vote.");
    return { ok: true, complete: true, room, previousPlayer: previous, activePlayer: null };
  }

  room.turnIndex = nextIndex;
  room.cluesComplete = false;
  setTurnClock(room, durationMs);
  return { ok: true, complete: false, room, previousPlayer: previous, activePlayer: nextPlayer };
}

function ensureActiveTurn(room, durationMs = room && room.turnDurationMs) {
  if (!room || room.phase !== "discussion" || room.cluesComplete)
    return { ok: true, changed: false, complete: !!(room && room.cluesComplete) };
  const active = currentTurnPlayer(room);
  if (active && active.alive && active.connected)
    return { ok: true, changed: false, complete: false, activePlayer: active };
  return { ...advanceTurn(room, "unavailable", durationMs), changed: true };
}

// ---------------- auto-advance ----------------
// The room drives itself: the host starts the game and starts the next one,
// everything in between advances on its own. autoKind/autoAt tell the client
// what it is counting down to so it can show the same deadline the server holds.
function setAuto(room, kind, ms) {
  if (!room) return;
  room.autoKind = kind;
  room.autoMs = ms;
  room.autoAt = Date.now() + ms;
}
function clearAuto(room) {
  if (!room) return;
  room.autoKind = null;
  room.autoMs = null;
  room.autoAt = null;
}

// Players confirm they have seen their role by flipping the card. Once everyone
// still in the room has peeked, there is nothing left to wait for.
function markReady(room, pid) {
  if (!room || room.phase !== "reveal") return { ok: false };
  const p = getPlayerByPid(room, pid);
  if (!p) return { ok: false };
  room.ready = room.ready || [];
  if (!room.ready.includes(pid)) room.ready.push(pid);
  return { ok: true, ...readyTally(room) };
}
function readyTally(room) {
  const waiting = room.players.filter((p) => p.connected && p.alive);
  const ready = (room.ready || []).filter((pid) => waiting.some((p) => p.pid === pid));
  return { count: ready.length, total: waiting.length, allReady: waiting.length > 0 && ready.length >= waiting.length };
}

// The guess in flight, minus anything that would spoil the reveal.
function publicGuess(room) {
  const g = room && room.guess;
  if (!g) return null;
  return {
    pid: g.pid, name: g.name, icon: g.icon || null,
    startsAt: g.startsAt, endsAt: g.endsAt, durationMs: g.durationMs,
    fromEjection: !!g.fromEjection, resolved: !!g.resolved
  };
}

// Public snapshot — never leaks who the imposter is or the secret word.
function publicRoomState(room) {
  if (!room) return null;
  const host = actingHost(room);
  return {
    mode: room.mode || "classic",
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    hostPid: host ? host.pid : null,
    hostName: host ? host.name : null,
    hostAway: hostIsAway(room),
    settings: {
      categories: room.settings.categories.slice(),
      imposters: room.settings.imposters,
      hintsEnabled: room.settings.hintsEnabled !== false,
      guessEnabled: room.settings.guessEnabled !== false
    },
    order: room.order || [],
    turn: {
      index: room.turnIndex ?? -1,
      total: room.turnOrder ? room.turnOrder.length : 0,
      activePid: currentTurnPlayer(room)?.pid || null,
      activeName: currentTurnPlayer(room)?.name || null,
      startedAt: room.turnStartedAt || null,
      endsAt: room.turnEndsAt || null,
      durationMs: room.turnDurationMs || DEFAULT_TURN_DURATION_MS,
      complete: !!room.cluesComplete
    },
    guess: publicGuess(room),
    auto: room.autoKind ? { kind: room.autoKind, endsAt: room.autoAt, durationMs: room.autoMs } : null,
    ready: readyTally(room),
    players: room.players.map((p) => ({
      pid: p.pid,
      name: p.name,
      icon: p.icon || null,
      color: p.color || null,
      dev: !!p.dev,
      score: p.score || 0,
      isHost: !!(host && p.pid === host.pid),
      alive: p.alive,
      connected: p.connected,
      hasVoted: !!(room.votes && room.votes[p.pid])
    }))
  };
}

// ---------------- room lifecycle ----------------
function createRoom(hostSocketId, mode = "classic", defaultCategories = []) {
  const code = randomCode();
  if (!code) return { roomCode: null, room: null };
  rooms[code] = {
    createdAt: Date.now(),
    mode,
    players: [],
    hostId: hostSocketId,
    phase: "lobby",
    round: 0,
    maxRounds: 0,
    settings: {
      categories: defaultCategories.slice(),
      imposters: 1, hintsEnabled: true, guessEnabled: true
    },
    word: null,
    category: null,
    hint: null,
    order: [],
    turnOrder: [],
    baseOrder: [],
    turnIndex: -1,
    turnStartedAt: null,
    turnEndsAt: null,
    turnDurationMs: DEFAULT_TURN_DURATION_MS,
    cluesComplete: false,
    votes: {},
    chat: [],
    ejection: null,
    guess: null,
    gameResult: null,
    ready: [],
    autoKind: null, autoAt: null, autoMs: null
  };
  return { roomCode: code, room: rooms[code] };
}

// Two crewmates in the same lobby should not wear the same colour. If the one
// you picked is taken we quietly slide you to the next free colour rather than
// bouncing you back to the home screen.
// Every player gets a crewmate colour, even if they picked a custom picture
// icon, so the UI can tint their chat and turn chip. Colours stay unique per
// room for as long as the palette holds out.
const CREW_COLOR_KEYS = ["red", "blue", "green", "pink", "orange", "yellow",
                         "black", "white", "purple", "brown", "cyan", "lime"];
function assignColor(room, icon) {
  if (typeof icon === "string" && icon.startsWith("crew:")) {
    const c = icon.slice(5);
    if (CREW_COLOR_KEYS.includes(c)) return c;
  }
  const taken = new Set(room.players.map((p) => p.color).filter(Boolean));
  return CREW_COLOR_KEYS.find((c) => !taken.has(c))
    || CREW_COLOR_KEYS[room.players.length % CREW_COLOR_KEYS.length];
}

function resolveIcon(room, wanted, iconPool) {
  if (typeof wanted !== "string" || !wanted.startsWith("crew:")) return wanted;
  const taken = new Set(room.players.map((p) => p.icon));
  if (!taken.has(wanted)) return wanted;
  const free = (iconPool || []).find((i) => typeof i === "string" && i.startsWith("crew:") && !taken.has(i));
  return free || wanted;
}

function validateAndAddPlayer({ roomCode, socketId, name, icon, iconPool, dev }) {
  if (!roomCode || !name) return { ok: false, error: "Enter a room code and a name to join." };
  const room = getRoom(roomCode);
  if (!room) return { ok: false, error: "No room with that code. Check the digits and try again." };

  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 16) return { ok: false, error: "Name must be 2–16 characters." };
  if (room.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase()))
    return { ok: false, error: "That name is taken in this room. Pick another." };
  if (room.phase !== "lobby") return { ok: false, error: "That game is already in progress." };
  if (room.players.length >= 15) return { ok: false, error: "This room is full (15 players)." };

  const finalIcon = resolveIcon(room, icon, iconPool) || null;
  const player = {
    id: socketId, pid: randomPid(), name: trimmed, icon: finalIcon,
    color: assignColor(room, finalIcon), dev: !!dev,
    score: 0, connected: true, isImposter: false, role: "crew", alive: true
  };
  room.players.push(player);
  ensureHost(room);
  return { ok: true, room, player };
}

// Reconnect by pid: restore an existing seat (keeps role/alive/score).
function rejoinByPid({ roomCode, socketId, pid, name, icon, iconPool, dev }) {
  const room = getRoom(roomCode);
  if (!room) return { ok: false, error: "That room has closed." };
  const existing = getPlayerByPid(room, pid);
  if (!existing) {
    // seat gone (e.g. removed in lobby) -> try a fresh join if still in lobby
    if (room.phase === "lobby") return validateAndAddPlayer({ roomCode, socketId, name, icon, iconPool, dev });
    return { ok: false, error: "Your seat is no longer in this game." };
  }
  const wasHost = room.hostId === existing.id;
  existing.id = socketId;
  existing.connected = true;
  if (dev) existing.dev = true;
  if (icon && icon !== existing.icon) {
    const taken = new Set(room.players.filter((p) => p !== existing).map((p) => p.icon));
    if (!taken.has(icon)) existing.icon = icon;
  }
  if (wasHost) room.hostId = socketId;
  else ensureHost(room);
  return { ok: true, room, player: existing, rejoined: true };
}

function setSettings(room, { categories, imposters, hintsEnabled, guessEnabled }, CATEGORIES) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "lobby") return { ok: false, error: "Can only change settings in the lobby." };
  if (Array.isArray(categories)) {
    const valid = categories.filter((c) => CATEGORIES[c]);
    // Fall back to whatever the room's own library offers, not a hardcoded
    // classic category — a football room has no "Famous People" to fall back to.
    room.settings.categories = valid.length ? valid : Object.keys(CATEGORIES).slice(0, 1);
  }
  if (imposters === 1 || imposters === 2) room.settings.imposters = imposters;
  if (typeof hintsEnabled === "boolean") room.settings.hintsEnabled = hintsEnabled;
  if (typeof guessEnabled === "boolean") room.settings.guessEnabled = guessEnabled;
  // cap imposters so a game is always winnable
  const maxImp = Math.max(1, Math.floor((room.players.length - 1) / 2));
  if (room.settings.imposters > maxImp) room.settings.imposters = 1;
  return { ok: true, room };
}

// ---------------- chat ----------------
function addChat(room, pid, text) {
  if (!room) return null;
  const p = getPlayerByPid(room, pid);
  if (!p) return null;
  const clean = (text || "").toString().slice(0, 240).trim();
  if (!clean) return null;
  const msg = { pid: p.pid, name: p.name, icon: p.icon || null, color: p.color || null, text: clean, ts: Date.now(), system: false };
  room.chat.push(msg);
  if (room.chat.length > MAX_CHAT) room.chat.shift();
  return msg;
}
function addSystem(room, text) {
  const msg = { pid: null, name: null, icon: null, text, ts: Date.now(), system: true };
  room.chat.push(msg);
  if (room.chat.length > MAX_CHAT) room.chat.shift();
  return msg;
}

// ---------------- game flow ----------------
function startGame(room, CATEGORIES) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "lobby") return { ok: false, error: "A game is already going." };
  const connected = room.players.filter((p) => p.connected);
  if (connected.length < 3) return { ok: false, error: "You need at least 3 players to start." };

  const cats = room.settings.categories.filter((c) => CATEGORIES[c]);
  if (!cats.length) return { ok: false, error: "Pick at least one category." };

  // build pool of {word, category, hints}
  const pool = [];
  cats.forEach((c) => CATEGORIES[c].words.forEach((w) => {
    const word = typeof w === "string" ? w : w.word;
    const hints = w && Array.isArray(w.hints) ? w.hints : [];
    if (!word) return;
    pool.push({ word, category: c, hints });
  }));
  if (!pool.length) return { ok: false, error: "No words in the chosen categories." };

  const maxImp = Math.max(1, Math.floor((connected.length - 1) / 2));
  const impCount = Math.min(room.settings.imposters, maxImp);

  const pick = pool[Math.floor(Math.random() * pool.length)];
  room.word = pick.word;
  room.category = pick.category;
  room.wordHints = pick.hints || [];
  room.hintRotation = room.wordHints.length ? Math.floor(Math.random() * room.wordHints.length) : 0;

  // assign roles among connected players
  const order = shuffle(connected);
  const imposterSet = new Set(order.slice(0, impCount).map((p) => p.pid));
  room.players.forEach((p) => {
    p.alive = p.connected;              // disconnected players sit out
    p.isImposter = imposterSet.has(p.pid);
    p.role = p.isImposter ? "imposter" : "crew";
  });

  room.settings.imposters = impCount;
  room.maxRounds = 3 * impCount;
  room.round = 1;
  room.phase = "reveal";
  room.votes = {};
  room.ejection = null;
  room.guess = null;
  room.gameResult = null;
  room.chat = [];
  room.order = [];
  room.turnOrder = [];
  room.baseOrder = [];      // a fresh game draws a fresh speaking order
  room.turnIndex = -1;
  room.turnStartedAt = null;
  room.turnEndsAt = null;
  room.cluesComplete = false;
  room.ready = [];
  clearAuto(room);
  addSystem(room, `Game on — ${impCount} imposter${impCount > 1 ? "s" : ""} among us. ${room.maxRounds} rounds to catch ${impCount > 1 ? "them" : "them"}.`);

  return { ok: true, room };
}

// reveal -> discussion (host presses "start discussion", or auto)
function beginDiscussion(room, durationMs = DEFAULT_TURN_DURATION_MS) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "reveal") return { ok: false, error: "Nothing to discuss yet." };
  room.phase = "discussion";
  room.ready = [];
  clearAuto(room);
  const first = setupTurnOrder(room, durationMs);
  addSystem(room, first
    ? `Round ${room.round} — ${first.name} goes first. You each have ${Math.round(room.turnDurationMs / 1000)} seconds.`
    : `Round ${room.round} — no connected players can give a clue.`);
  return { ok: true, room, activePlayer: first };
}

function submitClue(room, pid, text, durationMs = room && room.turnDurationMs) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "discussion") return { ok: false, error: "Clues are not being entered right now." };
  if (room.cluesComplete) return { ok: false, error: "Everyone has already had their turn." };
  const active = currentTurnPlayer(room);
  if (!active) return { ok: false, error: "There is no active clue turn." };
  if (active.pid !== pid) return { ok: false, error: `It is ${active.name}'s turn.` };
  const msg = addChat(room, pid, text);
  if (!msg) return { ok: false, error: "Enter a clue before submitting." };
  const turnResult = advanceTurn(room, "submitted", durationMs);
  return { ok: true, room, msg, ...turnResult };
}

// discussion -> voting
function callVote(room) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "discussion") return { ok: false, error: "Can only call a vote during discussion." };
  if (!room.cluesComplete) return { ok: false, error: "Everyone needs to have their clue turn before voting." };
  room.phase = "voting";
  room.turnStartedAt = null;
  room.turnEndsAt = null;
  room.votes = {};
  addSystem(room, `Round ${room.round} vote — who's the imposter? (or skip)`);
  return { ok: true, room };
}

// record a vote. target = pid of an alive player, or "skip".
function castVote(room, voterPid, target) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "voting") return { ok: false, error: "Voting isn't open." };
  const voter = getPlayerByPid(room, voterPid);
  if (!voter || !voter.alive) return { ok: false, error: "Only living players can vote." };

  if (target === "skip") {
    room.votes[voterPid] = "skip";
  } else {
    const t = getPlayerByPid(room, target);
    if (!t || !t.alive) return { ok: false, error: "That player is out of the game." };
    if (target === voterPid) return { ok: false, error: "You can't vote for yourself." };
    room.votes[voterPid] = target;
  }
  return { ok: true, room, complete: everyoneVoted(room) };
}

function everyoneVoted(room) {
  if (!room || room.phase !== "voting") return false;
  const voters = aliveConnected(room);
  return voters.length > 0 && voters.every((p) => room.votes[p.pid]);
}

// ---------------- the imposter's word guess ----------------
// "the eiffel tower" matches "Eiffel Tower"; accents and punctuation are ignored.
function wordMatches(guess, word) {
  const bare = (s) => normalize(s).replace(/^the/, "");
  const g = normalize(guess), w = normalize(word);
  if (!g || !w) return false;
  return g === w || (bare(guess) !== "" && bare(guess) === bare(word));
}

function startImposterGuess(room, guesser, durationMs = DEFAULT_GUESS_DURATION_MS, fromEjection = true, startDelayMs = 0) {
  room.phase = "guessing";
  room.turnStartedAt = null;
  room.turnEndsAt = null;
  room.votes = {};
  const startsAt = Date.now() + Math.max(0, startDelayMs || 0);
  room.guess = {
    pid: guesser.pid, name: guesser.name, icon: guesser.icon || null,
    durationMs, startsAt, endsAt: startsAt + durationMs,
    text: null, correct: null, resolved: false, fromEjection
  };
  addSystem(room, `${guesser.name} was the Imposter — one last guess at the word decides it.`);
  return room.guess;
}

function endGame(room, result) {
  awardScores(room, result);
  room.gameResult = result;
  room.phase = "gameover";
  addSystem(room, result.winner === "crew" ? "Crew win! 🎉" : "Imposters win! 🔪");
  return result;
}

function imposterNamesOf(room) {
  return room.players.filter((p) => p.isImposter).map((p) => p.name);
}

// Everything the game-over screen needs, for a player who reloads or reconnects
// after the game already ended. Safe to send: the game is over, nothing to spoil.
function finishedSummary(room) {
  if (!room || room.phase !== "gameover") return null;
  const g = room.guess;
  return {
    word: room.word,
    category: room.category,
    imposterNames: imposterNamesOf(room),
    guess: g && g.resolved
      ? { name: g.name, icon: g.icon || null, text: g.text, correct: g.correct, fromEjection: !!g.fromEjection }
      : null
  };
}

// Resolve the last-words guess. text === null means the clock ran out.
function finalizeGuess(room, text) {
  if (!room || room.phase !== "guessing" || !room.guess || room.guess.resolved) return null;
  const g = room.guess;
  g.resolved = true;
  g.text = typeof text === "string" ? text.slice(0, 60).trim() : null;
  g.correct = !!g.text && wordMatches(g.text, room.word);

  const result = g.correct
    ? { winner: "imposters", reason: `${g.name} was caught — then named the word anyway.`, viaGuess: true }
    : {
        winner: "crew",
        reason: g.text ? `${g.name} guessed "${g.text}" — not the word.` : `${g.name} ran out of time to guess.`
      };

  addSystem(room, g.correct
    ? `${g.name} guessed "${g.text}" — correct. The imposters steal it.`
    : g.text ? `${g.name} guessed "${g.text}" — wrong.` : `${g.name} never guessed.`);
  endGame(room, result);

  return {
    guess: { name: g.name, icon: g.icon || null, text: g.text, correct: g.correct, fromEjection: g.fromEjection },
    result,
    word: room.word,
    category: room.category,
    imposterNames: imposterNamesOf(room)
  };
}

// A living imposter gambling a guess mid-discussion. Right = instant win.
// Wrong = they blow their cover and are out.
function imposterSnapGuess(room, pid, text, durationMs = room && room.turnDurationMs) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.settings.guessEnabled === false) return { ok: false, error: "Word guessing is off in this room." };
  if (room.phase !== "discussion") return { ok: false, error: "You can only guess during the discussion." };
  const p = getPlayerByPid(room, pid);
  if (!p || !p.isImposter) return { ok: false, error: "Only the imposter can guess the word." };
  if (!p.alive) return { ok: false, error: "You're already out." };
  const clean = (text || "").toString().slice(0, 60).trim();
  if (!clean) return { ok: false, error: "Type the word you think it is." };

  const correct = wordMatches(clean, room.word);
  const payload = {
    guess: { name: p.name, icon: p.icon || null, text: clean, correct, fromEjection: false },
    word: room.word, category: room.category
  };

  if (correct) {
    addSystem(room, `${p.name} called it: the word was "${room.word}".`);
    payload.result = endGame(room, {
      winner: "imposters", reason: `${p.name} named the word out of nowhere.`, viaGuess: true
    });
    payload.imposterNames = imposterNamesOf(room);
    return { ok: true, room, ...payload };
  }

  // Wrong: they've outed themselves.
  p.alive = false;
  addSystem(room, `${p.name} tried to call the word with "${clean}" — wrong. They're out.`);

  if (impostersAlive(room) === 0) {
    payload.result = endGame(room, { winner: "crew", reason: `${p.name} blew their cover on a bad guess.` });
    payload.imposterNames = imposterNamesOf(room);
    return { ok: true, room, ...payload };
  }
  if (impostersAlive(room) >= crewAlive(room)) {
    payload.result = endGame(room, { winner: "imposters", reason: "Imposters reached the crew in numbers." });
    payload.imposterNames = imposterNamesOf(room);
    return { ok: true, room, ...payload };
  }

  payload.result = null;
  payload.turn = ensureActiveTurn(room, durationMs);
  return { ok: true, room, ...payload };
}

// Tally, decide ejection, advance the game. Returns a resolution payload.
function resolveVote(room, opts = {}) {
  if (!room) return null;
  const turnDurationMs = opts.turnDurationMs || DEFAULT_TURN_DURATION_MS;
  const ejectionDelayMs = Math.max(0, opts.ejectionDelayMs || 0);
  const guessDurationMs = opts.guessDurationMs || DEFAULT_GUESS_DURATION_MS;

  const counts = {}; // pid -> votes
  let skipVotes = 0;
  room.players.filter((p) => p.alive).forEach((p) => (counts[p.pid] = 0));
  Object.values(room.votes).forEach((t) => {
    if (t === "skip") skipVotes += 1;
    else if (counts[t] !== undefined) counts[t] += 1;
  });

  // find top player(s)
  let maxVotes = 0;
  Object.values(counts).forEach((c) => (maxVotes = Math.max(maxVotes, c)));
  const topPids = Object.keys(counts).filter((pid) => counts[pid] === maxVotes && maxVotes > 0);

  // ejection only on a clear plurality that also beats skip
  let ejectPid = null;
  if (maxVotes > 0 && topPids.length === 1 && maxVotes > skipVotes) ejectPid = topPids[0];

  let ejection = null;
  if (ejectPid) {
    const p = getPlayerByPid(room, ejectPid);
    p.alive = false;
    ejection = { pid: p.pid, name: p.name, icon: p.icon || null, color: p.color || null,
                 dev: !!p.dev, wasImposter: p.isImposter };
    addSystem(room, `${p.name} was ejected — ${p.isImposter ? "the Imposter!" : "not the Imposter."}`);
  } else {
    addSystem(room, skipVotes > 0 ? "The crew skipped the vote." : "No majority — nobody was ejected.");
  }

  // build vote tally for the reveal
  const tally = room.players.filter((p) => counts[p.pid] !== undefined)
    .map((p) => ({ pid: p.pid, name: p.name, icon: p.icon || null, color: p.color || null, votes: counts[p.pid] || 0 }))
    .sort((a, b) => b.votes - a.votes);
  tally.push({ pid: "skip", name: "Skip", icon: "⏭️", color: null, votes: skipVotes, isSkip: true });

  const impAlive = impostersAlive(room);
  const crAlive = crewAlive(room);
  const base = { ejection, tally, skipVotes, impostersLeft: impAlive };

  // Caught the last imposter — but they get one last shot at the word.
  if (ejection && ejection.wasImposter && impAlive === 0 && room.settings.guessEnabled !== false && room.word) {
    const guesser = getPlayerByPid(room, ejection.pid);
    startImposterGuess(room, guesser, guessDurationMs, true, ejectionDelayMs);
    room.ejection = ejection;
    return { ...base, result: null, pendingGuess: true, guess: publicGuess(room), nextPhase: "guessing", nextRound: room.round };
  }

  // decide game outcome
  let result = null;
  if (impAlive === 0) {
    result = { winner: "crew", reason: "All imposters were ejected." };
  } else if (impAlive >= crAlive) {
    result = { winner: "imposters", reason: "Imposters reached the crew in numbers." };
  } else if (room.round >= room.maxRounds) {
    result = { winner: "imposters", reason: "The rounds ran out — the imposter survived." };
  }

  let nextPhase, nextRound = room.round;
  if (result) {
    endGame(room, result);
    nextPhase = "gameover";
  } else {
    room.round += 1;
    nextRound = room.round;
    room.phase = "discussion";
    room.votes = {};
    const first = setupTurnOrder(room, turnDurationMs, ejectionDelayMs);
    nextPhase = "discussion";
    addSystem(room, first
      ? `Round ${room.round} — ${first.name} goes first. You each have ${Math.round(room.turnDurationMs / 1000)} seconds.`
      : `Round ${room.round} — no connected players can give a clue.`);
  }

  room.ejection = ejection;
  return {
    ...base,
    result,            // {winner,reason} or null
    pendingGuess: false,
    nextPhase,
    nextRound,
    imposterNames: result ? imposterNamesOf(room) : null,
    word: result ? room.word : null,
    category: result ? room.category : null
  };
}

function awardScores(room, result) {
  if (result.winner === "crew") {
    room.players.forEach((p) => { if (!p.isImposter && p.alive) p.score += 1; });
  } else {
    const points = result.viaGuess ? 3 : 2;   // naming the word is worth more
    room.players.forEach((p) => { if (p.isImposter) p.score += points; });
  }
}

// host force-resolve
function forceResolve(room, opts = {}) {
  if (!room || room.phase !== "voting") return null;
  return resolveVote(room, opts);
}

// gameover/any -> lobby for a fresh game (keep players + scores)
function backToLobby(room) {
  if (!room) return;
  room.phase = "lobby";
  room.round = 0;
  room.maxRounds = 0;
  room.word = null;
  room.category = null;
  room.hint = null;
  room.order = [];
  room.turnOrder = [];
  room.baseOrder = [];
  room.turnIndex = -1;
  room.turnStartedAt = null;
  room.turnEndsAt = null;
  room.turnDurationMs = DEFAULT_TURN_DURATION_MS;
  room.cluesComplete = false;
  room.votes = {};
  room.ejection = null;
  room.guess = null;
  room.gameResult = null;
  room.chat = [];
  room.ready = [];
  clearAuto(room);
  room.players.forEach((p) => { p.alive = true; p.isImposter = false; p.role = "crew"; });
}

// ---------------- removal ----------------
function _handleLeave(room, code, player, hard) {
  // A Socket.IO disconnect can be caused by switching apps, locking a phone,
  // changing network, or a browser suspending the tab. Keep that seat reserved.
  // Only an explicit leave (or grace-period cleanup) removes the player.
  if (hard) {
    const idx = room.players.indexOf(player);
    if (idx !== -1) room.players.splice(idx, 1);
    if (room.votes && room.votes[player.pid]) delete room.votes[player.pid];
  } else {
    player.connected = false;
    player.lastSeenAt = Date.now();
  }

  if (room.players.length === 0) {
    delete rooms[code];
    return { roomCode: code, room: null, roomDeleted: true, votingComplete: false, guesserGone: false };
  }

  if (hard) ensureHost(room);
  return {
    roomCode: code, room, roomDeleted: false,
    votingComplete: everyoneVoted(room),
    // If the imposter making their final guess vanishes, the room must not hang.
    guesserGone: room.phase === "guessing" && !!room.guess && !room.guess.resolved &&
      (hard ? !getPlayerByPid(room, room.guess.pid) : false)
  };
}

function removePlayerFromRoom(roomCode, socketId, hard) {
  const room = getRoom(roomCode);
  if (!room) return null;
  const player = room.players.find((p) => p.id === socketId);
  if (!player) return null;
  return _handleLeave(room, roomCode, player, hard);
}

function removePlayerFromAll(socketId) {
  for (const [code, room] of Object.entries(rooms)) {
    const player = room.players.find((p) => p.id === socketId);
    if (!player) continue;
    return _handleLeave(room, code, player, false);
  }
  return null;
}

// Rooms live in process memory, so nothing reclaims a room that was created but
// never joined (tap "Create", close the tab) — those used to leak forever.
function sweepRooms(now = Date.now()) {
  const dropped = [];
  for (const [code, room] of Object.entries(rooms)) {
    if (!room.players.length) {
      if (now - (room.createdAt || 0) > EMPTY_ROOM_TTL_MS) dropped.push(code);
      continue;
    }
    const anyConnected = room.players.some((p) => p.connected);
    if (anyConnected) continue;
    const lastSeen = Math.max(...room.players.map((p) => p.lastSeenAt || room.createdAt || 0));
    if (now - lastSeen > ABANDONED_ROOM_TTL_MS) dropped.push(code);
  }
  dropped.forEach((code) => delete rooms[code]);
  return dropped;
}

module.exports = {
  rooms, getRoom, getPlayerByPid, getHostPlayer, actingHost, isActingHost, hostIsAway,
  createRoom, validateAndAddPlayer, rejoinByPid, setSettings,
  addChat, addSystem,
  startGame, beginDiscussion, submitClue, advanceTurn, ensureActiveTurn, currentTurnPlayer,
  callVote, castVote, everyoneVoted,
  wordMatches, startImposterGuess, finalizeGuess, imposterSnapGuess, publicGuess, finishedSummary,
  setAuto, clearAuto, markReady, readyTally,
  resolveVote, forceResolve, backToLobby,
  removePlayerFromRoom, removePlayerFromAll, publicRoomState, sweepRooms,
  impostersAlive, crewAlive, aliveConnected,
  DEFAULT_GUESS_DURATION_MS
};
