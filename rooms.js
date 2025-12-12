// rooms.js

// In-memory store of all rooms
// rooms[code] = { players, hostId, round, order }
const rooms = {};

// -----------------------------
// Helpers
// -----------------------------
function randomCode(length = 4) {
  let code;
  do {
    code = Math.random().toString().slice(2, 2 + length);
  } while (rooms[code]);
  return code;
}

function getRoom(roomCode) {
  return rooms[roomCode] || null;
}

function getHostPlayer(room) {
  if (!room) return null;
  return room.players.find((p) => p.id === room.hostId) || null;
}

function ensureHost(room) {
  if (!room) return;
  if (!room.hostId || !room.players.some((p) => p.id === room.hostId)) {
    if (room.players.length > 0) {
      room.hostId = room.players[0].id;
    } else {
      room.hostId = null;
    }
  }
}

function publicRoomState(room) {
  if (!room) return null;
  const hostPlayer = getHostPlayer(room);
  const hostName = hostPlayer ? hostPlayer.name : null;

  return {
    players: room.players.map((p) => ({
      name: p.name,
      icon: p.icon || null
    })),
    round: room.round,
    hostName,
    order: room.order || []
  };
}

// -----------------------------
// Room management API
// -----------------------------

function createRoom(hostSocketId) {
  const code = randomCode(4);
  rooms[code] = {
    players: [],
    hostId: hostSocketId,
    round: 0,
    order: []
  };
  return { roomCode: code, room: rooms[code] };
}

function validateAndAddPlayer({ roomCode, socketId, name, icon }) {
  const room = getRoom(roomCode);
  if (!room) {
    return { ok: false, error: "Room not found" };
  }

  if (!roomCode || !name) {
    return { ok: false, error: "Room code and name are required" };
  }

  const trimmedName = name.trim();
  if (trimmedName.length < 2 || trimmedName.length > 16) {
    return { ok: false, error: "Name must be 2–16 characters" };
  }

  if (
    room.players.some(
      (p) => p.name.toLowerCase() === trimmedName.toLowerCase()
    )
  ) {
    return { ok: false, error: "Name already taken" };
  }

  const player = {
    id: socketId,
    name: trimmedName,
    isImposter: false,
    roleWord: null,
    icon: icon || null
  };

  room.players.push(player);
  ensureHost(room);

  const hostPlayer = getHostPlayer(room);
  const hostName = hostPlayer ? hostPlayer.name : null;

  return {
    ok: true,
    room,
    isHost: room.hostId === socketId,
    hostName
  };
}

/**
 * Remove a player from a specific room (manual leave).
 * Returns:
 * - { roomCode, room, hostName, roomDeleted: boolean } or null
 */
function removePlayerFromRoom(roomCode, socketId) {
  const room = getRoom(roomCode);
  if (!room) return null;

  const idx = room.players.findIndex((p) => p.id === socketId);
  if (idx === -1) return null;

  const leavingPlayer = room.players[idx];
  room.players.splice(idx, 1);

  console.log(`Player ${leavingPlayer.name} left room ${roomCode}`);

  // If room empty, delete it
  if (room.players.length === 0) {
    console.log(`Room ${roomCode} is now empty, deleting.`);
    delete rooms[roomCode];
    return {
      roomCode,
      room: null,
      hostName: null,
      roomDeleted: true
    };
  }

  ensureHost(room);
  const hostPlayer = getHostPlayer(room);
  const hostName = hostPlayer ? hostPlayer.name : null;

  return {
    roomCode,
    room,
    hostName,
    roomDeleted: false
  };
}

/**
 * Remove a player from whichever room they are in (for disconnect).
 * Returns same shape as removePlayerFromRoom or null if not found.
 */
function removePlayerFromAll(socketId) {
  for (const [code, room] of Object.entries(rooms)) {
    const idx = room.players.findIndex((p) => p.id === socketId);
    if (idx === -1) continue;

    const leavingPlayer = room.players[idx];
    room.players.splice(idx, 1);

    console.log(`Player ${leavingPlayer.name} disconnected from room ${code}`);

    if (room.players.length === 0) {
      console.log(`Room ${code} is now empty, deleting.`);
      delete rooms[code];
      return {
        roomCode: code,
        room: null,
        hostName: null,
        roomDeleted: true
      };
    }

    ensureHost(room);
    const hostPlayer = getHostPlayer(room);
    const hostName = hostPlayer ? hostPlayer.name : null;

    return {
      roomCode: code,
      room,
      hostName,
      roomDeleted: false
    };
  }
  return null;
}

module.exports = {
  rooms,
  getRoom,
  createRoom,
  validateAndAddPlayer,
  removePlayerFromRoom,
  removePlayerFromAll,
  publicRoomState
};
