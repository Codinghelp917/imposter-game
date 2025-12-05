const socket = io();

let currentRoom = null;
let currentName = null;
let isHost = false;

const screenHome = document.getElementById("screen-home");
const screenLobby = document.getElementById("screen-lobby");
const screenRole = document.getElementById("screen-role");

const homeError = document.getElementById("home-error");
const createRoomInfo = document.getElementById("create-room-info");
const roomCodeLabel = document.getElementById("room-code-label");
const playerNameLabel = document.getElementById("player-name-label");
const hostNameLabel = document.getElementById("host-name-label");
const playerList = document.getElementById("player-list");
const roundLabel = document.getElementById("round-label");
const orderList = document.getElementById("order-list");
const hostNote = document.getElementById("host-note");
const roleRoundLabel = document.getElementById("role-round-label");
const roleText = document.getElementById("role-text");
const btnStartRound = document.getElementById("btn-start-round");

function showScreen(id) {
  [screenHome, screenLobby, screenRole].forEach((el) =>
    el.classList.add("hidden")
  );
  document.getElementById(id).classList.remove("hidden");
}

// Create room (host only)
document.getElementById("btn-create-room").onclick = () => {
  socket.emit("createRoom", ({ roomCode }) => {
    document.getElementById("join-room-code").value = roomCode;
    createRoomInfo.textContent = `Room created: ${roomCode}. Now enter your name below to join as a player.`;
  });
};

// Join room
document.getElementById("btn-join-room").onclick = () => {
  const roomCode = document.getElementById("join-room-code").value.trim();
  const name = document.getElementById("join-name").value.trim();

  if (!roomCode || !name) {
    homeError.textContent = "Enter both room code and name.";
    return;
  }

  socket.emit("joinRoom", { roomCode, name }, (res) => {
    if (!res.ok) {
      homeError.textContent = res.error || "Could not join room.";
      return;
    }
    homeError.textContent = "";
    currentRoom = roomCode;
    currentName = name;
    isHost = !!res.isHost;

    roomCodeLabel.textContent = currentRoom;
    playerNameLabel.textContent = currentName;
    hostNameLabel.textContent = res.hostName || "(not set yet)";

    updateHostUI(res.round || 0, res.hostName);
    showScreen("screen-lobby");
  });
};

// Host-only: start round
btnStartRound.onclick = () => {
  if (!currentRoom || !isHost) return;
  socket.emit("startRound", { roomCode: currentRoom });
};

document.getElementById("btn-back-lobby").onclick = () => {
  showScreen("screen-lobby");
};

function updateHostUI(round, hostName) {
  // Host name
  hostNameLabel.textContent = hostName || "(unknown)";

  // Show/hide start button and note
  if (isHost) {
    btnStartRound.style.display = "block";
    hostNote.textContent = round
      ? "You are the host. Start the next round when everyone is ready."
      : "You are the host. Start the first round when everyone is ready.";
  } else {
    btnStartRound.style.display = "none";
    hostNote.textContent = "Waiting for the host to start the round.";
  }

  if (round && round > 0) {
    roundLabel.textContent = `(Round ${round})`;
  } else {
    roundLabel.textContent = "";
  }
}

// Server events

socket.on("roomUpdate", ({ players, round, hostName, order }) => {
  // Players list
  playerList.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.name;
    playerList.appendChild(li);
  });

  // Host / round labels
  updateHostUI(round || 0, hostName);

  // Speaking order (if we already have one)
  renderOrder(order || []);
});

socket.on("roundStarted", ({ round, hostName, order }) => {
  updateHostUI(round || 0, hostName);
  renderOrder(order || []);
});

socket.on("role", ({ isImposter, word, round }) => {
  roleRoundLabel.textContent = round || "";
  roleText.textContent = isImposter
    ? `You are the IMPOSTER.\nYour hint: ${word}`
    : `Your secret word: ${word}`;
  showScreen("screen-role");
});

function renderOrder(order) {
  orderList.innerHTML = "";
  if (!order.length) {
    const li = document.createElement("li");
    li.textContent = "No round started yet.";
    orderList.appendChild(li);
    return;
  }
  order.forEach((name, index) => {
    const li = document.createElement("li");
    li.textContent = `${index + 1}. ${name}`;
    orderList.appendChild(li);
  });
}
