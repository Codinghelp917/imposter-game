const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ========================
// WORD LIST
// ========================
const WORDS = require("./words.json");

// rooms[code] = { players, hostId, round, order, ... }
const rooms = {};

function randomCode(length = 4) {
  return Math.random().toString().slice(2, 2 + length);
}
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // Create room & mark this socket as host
  socket.on("createRoom", (cb) => {
    let code;
    do { code = randomCode(4); } while (rooms[code]);

    rooms[code] = {
      players: [],
      hostId: socket.id,
      round: 0,
      order: []
    };

    socket.join(code);
    cb({ roomCode: code });
  });

  // Join room as a player
  socket.on("joinRoom", ({ roomCode, name }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ ok: false, error: "Room not found" });

    if (room.players.some((p) => p.name === name)) {
      return cb({ ok: false, error: "Name already taken" });
    }

    const player = {
      id: socket.id,
      name,
      isImposter: false,
      roleWord: null
    };
    room.players.push(player);
    socket.join(roomCode);

    const hostPlayer = room.players.find((p) => p.id === room.hostId);
    const hostName = hostPlayer ? hostPlayer.name : null;

    io.to(roomCode).emit("roomUpdate", {
      players: room.players.map((p) => ({ name: p.name })),
      round: room.round,
      hostName,
      order: room.order || []
    });

    cb({
      ok: true,
      isHost: room.hostId === socket.id,
      hostName,
      round: room.round
    });
  });

  // Host-only: start a round
  socket.on("startRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) {
      console.log("Non-host tried to start round in", roomCode);
      return;
    }
    if (room.players.length < 3) return;

    room.round += 1;

    const { word, hint } = pickRandom(WORDS);
    const imposterIndex = Math.floor(Math.random() * room.players.length);

    // random speaking order (by name)
    const order = shuffle(room.players).map((p) => p.name);
    room.order = order;

    room.players.forEach((p, idx) => {
      p.isImposter = idx === imposterIndex;
      p.roleWord = p.isImposter ? hint : word;

      io.to(p.id).emit("role", {
        isImposter: p.isImposter,
        word: p.roleWord,
        round: room.round
      });
    });

    const hostPlayer = room.players.find((p) => p.id === room.hostId);
    const hostName = hostPlayer ? hostPlayer.name : null;

    io.to(roomCode).emit("roundStarted", {
      round: room.round,
      hostName,
      order
    });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);

        // If host left, we *could* promote someone else – for now we just leave hostId as-is
        const hostPlayer = room.players.find((p) => p.id === room.hostId);
        const hostName = hostPlayer ? hostPlayer.name : null;

        io.to(code).emit("roomUpdate", {
          players: room.players.map((p) => ({ name: p.name })),
          round: room.round,
          hostName,
          order: room.order || []
        });

        if (room.players.length === 0) {
          delete rooms[code];
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
