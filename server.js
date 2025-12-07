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

// rooms[code] = { players, hostId, round, order }
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

  // ========================
  // Create room & mark this socket as host
  // ========================
  socket.on("createRoom", (cb) => {
    let code;
    do {
      code = randomCode(4);
    } while (rooms[code]);

    rooms[code] = {
      players: [],
      hostId: socket.id, // host will still join as a player
      round: 0,
      order: []
    };

    socket.join(code);
    cb({ roomCode: code });
  });

  // ========================
  // Join room as a player
  // ========================
  socket.on("joinRoom", ({ roomCode, name, icon }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ ok: false, error: "Room not found" });

    if (!roomCode || !name) {
      return cb({ ok: false, error: "Room code and name are required" });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 16) {
      return cb({ ok: false, error: "Name must be 2–16 characters" });
    }

    if (
      room.players.some(
        (p) => p.name.toLowerCase() === trimmedName.toLowerCase()
      )
    ) {
      return cb({ ok: false, error: "Name already taken" });
    }

    const player = {
      id: socket.id,
      name: trimmedName,
      isImposter: false,
      roleWord: null,
      icon: icon || null
    };
    room.players.push(player);
    socket.join(roomCode);

    // Ensure hostId always points at a real player
    if (!room.hostId || !room.players.some((p) => p.id === room.hostId)) {
      room.hostId = room.players[0].id;
    }

    const hostPlayer = room.players.find((p) => p.id === room.hostId);
    const hostName = hostPlayer ? hostPlayer.name : null;

    io.to(roomCode).emit("roomUpdate", {
      players: room.players.map((p) => ({
        name: p.name,
        icon: p.icon || null
      })),
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

  // ========================
  // Host-only: start a round
  // ========================
  socket.on("startRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // If hostId somehow got out of sync, fix it
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

    // random speaking order
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

    const hostPlayer = room.players.find((p) => p.id === room.hostId);
    const hostName = hostPlayer ? hostPlayer.name : null;

    io.to(roomCode).emit("roundStarted", {
      round: room.round,
      hostName,
      order: room.order
    });
  });

  // ========================
  // Disconnect handling
  // ========================
  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) continue;

      const leavingPlayer = room.players[idx];
      room.players.splice(idx, 1);

      console.log(`Player ${leavingPlayer.name} left room ${code}`);

      if (room.players.length === 0) {
        console.log(`Room ${code} is now empty, deleting.`);
        delete rooms[code];
        break;
      }

      const hostStillHere = room.players.some((p) => p.id === room.hostId);
      if (!hostStillHere) {
        room.hostId = room.players[0].id;
        console.log(
          `Host left in room ${code}, promoting ${room.players[0].name} as new host`
        );
      }

      const hostPlayer = room.players.find((p) => p.id === room.hostId);
      const hostName = hostPlayer ? hostPlayer.name : null;

      io.to(code).emit("roomUpdate", {
        players: room.players.map((p) => ({
          name: p.name,
          icon: p.icon || null
        })),
        round: room.round,
        hostName,
        order: room.order || []
      });

      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
// 0.0.0.0 so other devices on same Wi-Fi can join
server.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Server running on port ${PORT}`)
);
