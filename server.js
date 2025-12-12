const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const {
  getRoom,
  createRoom,
  validateAndAddPlayer,
  removePlayerFromRoom,
  removePlayerFromAll,
  publicRoomState
} = require("./rooms");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ========================
// WORD LIST
// ========================
const WORDS = require("./words.json");

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // ========================
  // Create room & mark this socket as host
  // ========================
  socket.on("createRoom", (cb) => {
    const { roomCode } = createRoom(socket.id);
    socket.join(roomCode);
    cb({ roomCode });
  });

  // ========================
  // Join room as a player
  // ========================
  socket.on("joinRoom", ({ roomCode, name, icon }, cb) => {
    const result = validateAndAddPlayer({
      roomCode,
      socketId: socket.id,
      name,
      icon
    });

    if (!result.ok) {
      return cb(result); // contains { ok: false, error }
    }

    const { room, isHost, hostName } = result;

    socket.join(roomCode);

    io.to(roomCode).emit("roomUpdate", {
      ...publicRoomState(room)
    });

    cb({
      ok: true,
      isHost,
      hostName,
      round: room.round
    });
  });

  // ========================
  // Host-only: start a round
  // ========================
  socket.on("startRound", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    // Ensure host is still valid
    if (!room.players.some((p) => p.id === room.hostId)) {
      if (room.players.length > 0) {
        room.hostId = room.players[0].id;
      }
    }

    if (room.hostId !== socket.id) {
      console.log("Non-host tried to start round in", roomCode);
      return;
    }
    if (room.players.length < 3) return;

    if (!Array.isArray(WORDS) || WORDS.length === 0) {
      console.error("No words available – cannot start round");
      return;
    }

    room.round += 1;

    const { word, hint } = pickRandom(WORDS);

    const shuffledPlayers = shuffle(room.players);
    const imposterIndex = Math.floor(Math.random() * shuffledPlayers.length);
    const imposterId = shuffledPlayers[imposterIndex].id;

    room.order = shuffledPlayers.map((p) => p.name);

    room.players.forEach((p) => {
      p.isImposter = p.id === imposterId;
      p.roleWord = p.isImposter ? hint : word;

      io.to(p.id).emit("role", {
        isImposter: p.isImposter,
        word: p.roleWord,
        round: room.round
      });
    });

    const state = publicRoomState(room);

    io.to(roomCode).emit("roundStarted", {
      round: room.round,
      hostName: state.hostName,
      order: room.order
    });
  });

  // ========================
  // Leave room (manual)
  // ========================
  socket.on("leaveRoom", ({ roomCode }) => {
    const result = removePlayerFromRoom(roomCode, socket.id);
    if (!result) return;

    const { roomDeleted, room } = result;

    if (roomDeleted) {
      // Room is gone, nothing to broadcast
      return;
    }

    const state = publicRoomState(room);
    io.to(roomCode).emit("roomUpdate", state);
    socket.leave(roomCode);
  });

  // ========================
  // Disconnect handling
  // ========================
  socket.on("disconnect", () => {
    const result = removePlayerFromAll(socket.id);
    if (!result) return;

    const { roomCode, room, roomDeleted } = result;

    if (roomDeleted || !room) {
      return; // no one left to update
    }

    const state = publicRoomState(room);
    io.to(roomCode).emit("roomUpdate", state);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Server running on port ${PORT}`)
);
