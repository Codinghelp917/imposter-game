// rooms.js — Among Us–style imposter word game.
//
// A game = one secret word + hidden imposter(s). Players discuss via chat over
// several rounds. Each round ends with an OPTIONAL vote. Skipping (or a tie)
// advances to the next round. You get 3 rounds per imposter to catch them.
//   - Eject a crewmate  -> they're out, game continues.
//   - Eject an imposter -> crew win.
//   - Run out of rounds / reach parity -> imposters win.
//
// phase: "lobby" | "reveal" | "discussion" | "voting" | "ejection" | "gameover"

const rooms = {};
const MAX_CHAT = 120;

// ---------------- helpers ----------------
function randomCode() {
  let code;
  do { code = Math.random().toString().slice(2, 6); } while (rooms[code]);
  return code;
}
function randomPid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}
function normalize(s) {
  return (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

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

function aliveConnected(room) {
  return room.players.filter((p) => p.alive && p.connected);
}
function impostersAlive(room) {
  return room.players.filter((p) => p.isImposter && p.alive).length;
}
function crewAlive(room) {
  return room.players.filter((p) => !p.isImposter && p.alive).length;
}

// Public snapshot — never leaks who the imposter is or the secret word.
function publicRoomState(room) {
  if (!room) return null;
  const host = getHostPlayer(room);
  return {
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    hostPid: host ? host.pid : null,
    hostName: host ? host.name : null,
    settings: { categories: room.settings.categories.slice(), imposters: room.settings.imposters },
    order: room.order || [],
    players: room.players.map((p) => ({
      pid: p.pid,
      name: p.name,
      icon: p.icon || null,
      score: p.score || 0,
      isHost: p.id === room.hostId,
      alive: p.alive,
      connected: p.connected,
      hasVoted: !!(room.votes && room.votes[p.pid])
    }))
  };
}

// ---------------- room lifecycle ----------------
function createRoom(hostSocketId) {
  const code = randomCode();
  rooms[code] = {
    players: [],
    hostId: hostSocketId,
    phase: "lobby",
    round: 0,
    maxRounds: 0,
    settings: { categories: ["Famous People"], imposters: 1 },
    word: null,
    category: null,
    order: [],
    votes: {},
    chat: [],
    ejection: null,
    gameResult: null
  };
  return { roomCode: code, room: rooms[code] };
}

function validateAndAddPlayer({ roomCode, socketId, name, icon }) {
  if (!roomCode || !name) return { ok: false, error: "Enter a room code and a name to join." };
  const room = getRoom(roomCode);
  if (!room) return { ok: false, error: "No room with that code. Check the digits and try again." };

  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 16) return { ok: false, error: "Name must be 2\u201316 characters." };
  if (room.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase()))
    return { ok: false, error: "That name is taken in this room. Pick another." };
  if (room.phase !== "lobby") return { ok: false, error: "That game is already in progress." };

  const player = {
    id: socketId, pid: randomPid(), name: trimmed, icon: icon || null,
    score: 0, connected: true, isImposter: false, role: "crew", alive: true
  };
  room.players.push(player);
  ensureHost(room);
  return { ok: true, room, player };
}

// Reconnect by pid: restore an existing seat (keeps role/alive/score).
function rejoinByPid({ roomCode, socketId, pid, name, icon }) {
  const room = getRoom(roomCode);
  if (!room) return { ok: false, error: "That room has closed." };
  const existing = getPlayerByPid(room, pid);
  if (!existing) {
    // seat gone (e.g. removed in lobby) -> try a fresh join if still in lobby
    if (room.phase === "lobby") return validateAndAddPlayer({ roomCode, socketId, name, icon });
    return { ok: false, error: "Your seat is no longer in this game." };
  }
  existing.id = socketId;
  existing.connected = true;
  if (icon) existing.icon = icon;
  ensureHost(room);
  return { ok: true, room, player: existing, rejoined: true };
}

function setSettings(room, { categories, imposters }, CATEGORIES) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "lobby") return { ok: false, error: "Can only change settings in the lobby." };
  if (Array.isArray(categories)) {
    const valid = categories.filter((c) => CATEGORIES[c]);
    room.settings.categories = valid.length ? valid : ["Famous People"];
  }
  if (imposters === 1 || imposters === 2) room.settings.imposters = imposters;
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
  const msg = { pid: p.pid, name: p.name, icon: p.icon || null, text: clean, ts: Date.now(), system: false };
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

  // build pool of {word, category}
  const pool = [];
  cats.forEach((c) => CATEGORIES[c].words.forEach((w) => pool.push({ word: w, category: c })));
  if (!pool.length) return { ok: false, error: "No words in the chosen categories." };

  const maxImp = Math.max(1, Math.floor((connected.length - 1) / 2));
  const impCount = Math.min(room.settings.imposters, maxImp);

  const pick = pool[Math.floor(Math.random() * pool.length)];
  room.word = pick.word;
  room.category = pick.category;

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
  room.gameResult = null;
  room.chat = [];
  room.order = shuffle(aliveConnected(room)).map((p) => p.name);
  addSystem(room, `Game on — ${impCount} imposter${impCount > 1 ? "s" : ""} hiding. ${room.maxRounds} rounds to catch ${impCount > 1 ? "them" : "them"}.`);

  return { ok: true, room };
}

// reveal -> discussion (host presses "start discussion", or auto)
function beginDiscussion(room) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "reveal") return { ok: false, error: "Nothing to discuss yet." };
  room.phase = "discussion";
  addSystem(room, `Round ${room.round} — drop your clues.`);
  return { ok: true, room };
}

// discussion -> voting
function callVote(room) {
  if (!room) return { ok: false, error: "Room not found." };
  if (room.phase !== "discussion") return { ok: false, error: "Can only call a vote during discussion." };
  room.phase = "voting";
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

// Tally, decide ejection, advance the game. Returns a resolution payload.
function resolveVote(room) {
  if (!room) return null;

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
    ejection = { pid: p.pid, name: p.name, icon: p.icon || null, wasImposter: p.isImposter };
    addSystem(room, `${p.name} was ejected — ${p.isImposter ? "the Imposter!" : "not the Imposter."}`);
  } else {
    addSystem(room, skipVotes > 0 ? "The crew skipped the vote." : "No majority — nobody was ejected.");
  }

  // build vote tally for the reveal
  const tally = room.players.filter((p) => counts[p.pid] !== undefined)
    .map((p) => ({ pid: p.pid, name: p.name, icon: p.icon || null, votes: counts[p.pid] || 0 }))
    .sort((a, b) => b.votes - a.votes);
  tally.push({ pid: "skip", name: "Skip", icon: "\u23ED\uFE0F", votes: skipVotes, isSkip: true });

  // decide game outcome
  let result = null;
  const impAlive = impostersAlive(room);
  const crAlive = crewAlive(room);

  if (impAlive === 0) {
    result = { winner: "crew", reason: "All imposters were ejected." };
  } else if (impAlive >= crAlive) {
    result = { winner: "imposters", reason: "Imposters reached the crew in numbers." };
  } else if (room.round >= room.maxRounds) {
    result = { winner: "imposters", reason: "The rounds ran out — imposter survived." };
  }

  let nextPhase, nextRound = room.round;
  if (result) {
    awardScores(room, result);
    room.gameResult = result;
    room.phase = "gameover";
    nextPhase = "gameover";
    addSystem(room, result.winner === "crew" ? "Crew win! 🎉" : "Imposters win! 🕵️");
  } else {
    room.round += 1;
    nextRound = room.round;
    room.phase = "discussion";
    room.votes = {};
    room.order = shuffle(aliveConnected(room)).map((p) => p.name);
    nextPhase = "discussion";
    addSystem(room, `Round ${room.round} — clues, please.`);
  }

  room.ejection = ejection;
  return {
    ejection,          // {pid,name,icon,wasImposter} or null
    tally,
    skipVotes,
    result,            // {winner,reason} or null
    nextPhase,
    nextRound,
    imposterNames: result ? room.players.filter((p) => p.isImposter).map((p) => p.name) : null,
    word: result ? room.word : null,
    category: result ? room.category : null
  };
}

function awardScores(room, result) {
  if (result.winner === "crew") {
    room.players.forEach((p) => { if (!p.isImposter && p.alive) p.score += 1; });
  } else {
    room.players.forEach((p) => { if (p.isImposter) p.score += 2; });
  }
}

// host force-resolve
function forceResolve(room) {
  if (!room || room.phase !== "voting") return null;
  return resolveVote(room);
}

// gameover/any -> lobby for a fresh game (keep players + scores)
function backToLobby(room) {
  if (!room) return;
  room.phase = "lobby";
  room.round = 0;
  room.maxRounds = 0;
  room.word = null;
  room.category = null;
  room.order = [];
  room.votes = {};
  room.ejection = null;
  room.gameResult = null;
  room.chat = [];
  room.players.forEach((p) => { p.alive = true; p.isImposter = false; p.role = "crew"; });
}

// ---------------- removal ----------------
function _handleLeave(room, code, player, hard) {
  // In lobby, or a hard removal, drop the seat. Mid-game, keep the seat but mark
  // disconnected so the player can reconnect (and the game can continue).
  if (room.phase === "lobby" || hard) {
    const idx = room.players.indexOf(player);
    if (idx !== -1) room.players.splice(idx, 1);
  } else {
    player.connected = false;
  }

  if (room.players.length === 0 || room.players.every((p) => !p.connected)) {
    delete rooms[code];
    return { roomCode: code, room: null, roomDeleted: true, votingComplete: false };
  }
  if (room.votes && room.votes[player.pid] && (room.phase === "lobby" || hard)) delete room.votes[player.pid];
  ensureHost(room);
  return { roomCode: code, room, roomDeleted: false, votingComplete: everyoneVoted(room) };
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

module.exports = {
  rooms, getRoom, getPlayerByPid, getHostPlayer,
  createRoom, validateAndAddPlayer, rejoinByPid, setSettings,
  addChat, addSystem,
  startGame, beginDiscussion, callVote, castVote, everyoneVoted,
  resolveVote, forceResolve, backToLobby,
  removePlayerFromRoom, removePlayerFromAll, publicRoomState,
  impostersAlive, crewAlive, aliveConnected
};
