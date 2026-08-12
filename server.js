const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const R = require("./rooms");
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// categories.json -> { "Name": { emoji, words:[...] } }
const CATEGORIES = require("./categories.json");
const CATEGORY_LIST = Object.keys(CATEGORIES).map((name) => ({
  name, emoji: CATEGORIES[name].emoji, count: CATEGORIES[name].words.length
}));

function broadcast(code) {
  const room = R.getRoom(code);
  if (!room) return;
  io.to(code).emit("roomUpdate", R.publicRoomState(room));
}

// send each player their private role for the current game
function dealRoles(room, code) {
  room.players.forEach((p) => {
    if (!p.connected) return;
    io.to(p.id).emit("role", {
      isImposter: p.isImposter,
      word: p.isImposter ? null : room.word,
      category: room.category,
      round: room.round,
      maxRounds: room.maxRounds
    });
  });
}

function doResolve(code, force) {
  const room = R.getRoom(code);
  if (!room) return;
  const res = force ? R.forceResolve(room) : R.resolveVote(room);
  if (!res) return;
  io.to(code).emit("voteResolved", { resolution: res, state: R.publicRoomState(room) });
}

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.emit("categories", CATEGORY_LIST);

  // ---- create room ----
  socket.on("createRoom", (...args) => {
    const cb = args[args.length - 1];
    const { roomCode } = R.createRoom(socket.id);
    socket.join(roomCode);
    if (typeof cb === "function") cb({ ok: true, roomCode, categories: CATEGORY_LIST });
  });

  // ---- join ----
  socket.on("joinRoom", ({ roomCode, name, icon }, cb) => {
    const result = R.validateAndAddPlayer({ roomCode, socketId: socket.id, name, icon });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    if (typeof cb === "function")
      cb({ ok: true, pid: player.pid, isHost: room.hostId === socket.id, state: R.publicRoomState(room), categories: CATEGORY_LIST });
    broadcast(roomCode);
  });

  // ---- reconnect to an existing seat ----
  socket.on("rejoinRoom", ({ roomCode, pid, name, icon }, cb) => {
    const result = R.rejoinByPid({ roomCode, socketId: socket.id, pid, name, icon });
    if (!result.ok) { if (typeof cb === "function") cb(result); return; }
    const { room, player } = result;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    // if a game is live, re-send their private role
    if (room.phase !== "lobby") {
      socket.emit("role", {
        isImposter: player.isImposter,
        word: player.isImposter ? null : room.word,
        category: room.category,
        round: room.round,
        maxRounds: room.maxRounds
      });
    }
    if (typeof cb === "function")
      cb({ ok: true, pid: player.pid, isHost: room.hostId === socket.id,
           state: R.publicRoomState(room), chat: room.chat.slice(-60),
           gameResult: room.gameResult, categories: CATEGORY_LIST });
    broadcast(roomCode);
  });

  // ---- host: update settings (categories / imposter count) ----
  socket.on("updateSettings", ({ roomCode, categories, imposters }) => {
    const room = R.getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return;
    R.setSettings(room, { categories, imposters }, CATEGORIES);
    broadcast(roomCode);
  });

  // ---- host: start the game ----
  socket.on("startGame", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("toast", { type: "error", message: "Only the host can start." });
    const result = R.startGame(room, CATEGORIES);
    if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    dealRoles(room, roomCode);
    io.to(roomCode).emit("gameStarted", { state: R.publicRoomState(room) });
    broadcast(roomCode);
  });

  // ---- host: reveal -> discussion ----
  socket.on("beginDiscussion", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return;
    const result = R.beginDiscussion(room);
    if (!result.ok) return;
    io.to(roomCode).emit("discussionStarted", { state: R.publicRoomState(room), chat: room.chat.slice(-60) });
  });

  // ---- chat ----
  socket.on("chat", ({ roomCode, text }) => {
    const room = R.getRoom(roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (room.phase === "lobby" || room.phase === "gameover") return; // chat during play only
    if (!player.alive) return; // eliminated players spectate, they don't chat
    const msg = R.addChat(room, player.pid, text);
    if (msg) io.to(roomCode).emit("chat", msg);
  });

  // ---- host: call the vote ----
  socket.on("callVote", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return;
    const result = R.callVote(room);
    if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    io.to(roomCode).emit("votingStarted", { state: R.publicRoomState(room) });
  });

  // ---- cast a vote (player or skip) ----
  socket.on("castVote", ({ roomCode, target }) => {
    const room = R.getRoom(roomCode);
    if (!room) return;
    const voter = room.players.find((p) => p.id === socket.id);
    if (!voter) return;
    const result = R.castVote(room, voter.pid, target);
    if (!result.ok) return socket.emit("toast", { type: "error", message: result.error });
    broadcast(roomCode);
    if (result.complete) doResolve(roomCode, false);
  });

  // ---- host: force the vote to end early ----
  socket.on("endVoting", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== "voting") return;
    doResolve(roomCode, true);
  });

  // ---- host: new game / back to lobby ----
  socket.on("newGame", ({ roomCode }) => {
    const room = R.getRoom(roomCode);
    if (!room || room.hostId !== socket.id) return;
    R.backToLobby(room);
    broadcast(roomCode);
    io.to(roomCode).emit("returnedToLobby", { state: R.publicRoomState(room) });
  });

  // ---- manual leave ----
  socket.on("leaveRoom", ({ roomCode }) => {
    const result = R.removePlayerFromRoom(roomCode, socket.id, true);
    socket.leave(roomCode);
    if (!result || result.roomDeleted || !result.room) return;
    broadcast(roomCode);
    if (result.votingComplete) doResolve(roomCode, false);
  });

  // ---- disconnect ----
  socket.on("disconnect", () => {
    const result = R.removePlayerFromAll(socket.id);
    if (!result || result.roomDeleted || !result.room) return;
    broadcast(result.roomCode);
    if (result.votingComplete) doResolve(result.roomCode, false);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`\u2705 Imposter server on port ${PORT}`));
