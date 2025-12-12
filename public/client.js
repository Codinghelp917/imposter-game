const socket = io();
const SESSION_KEY = "mafiaWordGameSession"; // for auto-rejoin

let currentRoom = null;
let currentName = null;
let isHost = false;
let currentPlayers = [];
let currentHostName = null;
let selectedIcon = "mafia1.png"; // default icon

// Screens
const screenHome = document.getElementById("screen-home");
const screenLobby = document.getElementById("screen-lobby");

// Elements
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
const iconOptions = document.querySelectorAll(".icon-option");

function showScreen(id) {
  [screenHome, screenLobby].forEach((el) => el.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

// -----------------------------
// Icon picker logic
// -----------------------------
function setSelectedIcon(iconName) {
  selectedIcon = iconName;
  iconOptions.forEach((btn) => {
    if (btn.dataset.icon === iconName) {
      btn.classList.add("selected");
    } else {
      btn.classList.remove("selected");
    }
  });
}

if (iconOptions.length > 0) {
  setSelectedIcon(iconOptions[0].dataset.icon || "mafia1.png");
  iconOptions.forEach((btn) => {
    btn.addEventListener("click", () => setSelectedIcon(btn.dataset.icon));
  });
}

// -----------------------------
// Shared helper for successful join
// -----------------------------
function handleJoinSuccess(res, roomCode, name, iconFromSession = false) {
  homeError.textContent = "";
  currentRoom = roomCode;
  currentName = name;
  isHost = !!res.isHost;
  currentHostName = res.hostName || null;

  // Save session (skip if iconFromSession === false)
  const iconToSave = iconFromSession || selectedIcon;
  if (iconFromSession !== false) {
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ roomCode, name, icon: iconToSave })
      );
    } catch (e) {}
  }

  roomCodeLabel.textContent = roomCode;
  playerNameLabel.textContent = name;
  hostNameLabel.textContent = currentHostName || "Deciding host...";
  roleRoundLabel.textContent = "";
  roleText.textContent = "";

  updateHostUI(res.round || 0);
  showScreen("screen-lobby");
}

// -----------------------------
// Create room (host)
// -----------------------------
document.getElementById("btn-create-room").onclick = () => {
  socket.emit("createRoom", ({ roomCode }) => {
    const code = (roomCode || "").toUpperCase();
    const roomInput = document.getElementById("join-room-code");
    roomInput.value = code;
    createRoomInfo.textContent = `Room created: ${code}. Now enter your name below to join as a player.`;
  });
};

// -----------------------------
// Join room
// -----------------------------
let joining = false;
document.getElementById("btn-join-room").onclick = () => {
  if (joining) return;
  joining = true;

  const roomInput = document.getElementById("join-room-code");
  const nameInput = document.getElementById("join-name");
  const roomCode = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();

  if (!roomCode || !name) {
    homeError.textContent = "Enter both room code and name.";
    joining = false;
    return;
  }

  socket.emit("joinRoom", { roomCode, name, icon: selectedIcon }, (res) => {
    joining = false;
    if (!res || !res.ok) {
      homeError.textContent = (res && res.error) || "Could not join room.";
      return;
    }
    handleJoinSuccess(res, roomCode, name, selectedIcon);
  });
};

// -----------------------------
// Host-only: start round
// -----------------------------
btnStartRound.onclick = () => {
  if (!currentRoom || !isHost) return;
  socket.emit("startRound", { roomCode: currentRoom });
};

// -----------------------------
// UI helpers
// -----------------------------
function updateHostUI(round) {
  hostNameLabel.textContent = currentHostName || "Deciding host...";
  const playerCount = currentPlayers.length || 0;

  if (isHost) {
    btnStartRound.style.display = "block";
    if (playerCount < 3) {
      btnStartRound.disabled = true;
      hostNote.textContent = `You are the host. Waiting for at least 3 players to start (currently ${playerCount}).`;
    } else {
      btnStartRound.disabled = false;
      hostNote.textContent = round
        ? "You are the host. Start the next round when everyone is ready."
        : "You are the host. Start the first round when everyone is ready.";
    }
  } else {
    btnStartRound.style.display = "none";
    hostNote.textContent = "Waiting for the host to start the round.";
  }

  roundLabel.textContent = round && round > 0 ? `(Round ${round})` : "";
}

function renderOrder(order) {
  orderList.innerHTML = "";
  if (!order || !order.length) {
    orderList.innerHTML = "<li>No round started yet.</li>";
    return;
  }
  order.forEach((name, index) => {
    const li = document.createElement("li");
    li.textContent = `${index + 1}. ${name}`;
    orderList.appendChild(li);
  });
}

// -----------------------------
// Socket events
// -----------------------------
socket.on("roomUpdate", ({ players, round, hostName, order }) => {
  currentPlayers = players || [];
  if (typeof hostName === "string" && hostName.trim()) currentHostName = hostName;

  isHost = currentHostName === currentName;
  playerList.innerHTML = "";

  currentPlayers.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = p.icon
      ? `<img src="images/icons/${p.icon}" alt="" class="player-icon-img"> ${p.name}`
      : p.name;

    if (p.name === currentHostName) li.classList.add("player-host");
    if (p.name === currentName) li.classList.add("player-self");

    playerList.appendChild(li);
  });

  updateHostUI(round || 0);
  renderOrder(order || []);
});

socket.on("roundStarted", ({ round, hostName, order }) => {
  if (typeof hostName === "string" && hostName.trim()) currentHostName = hostName;
  isHost = currentHostName === currentName;

  updateHostUI(round || 0);
  renderOrder(order || []);
  roleRoundLabel.textContent = `Round ${round}`;
});

socket.on("role", ({ isImposter, word, round }) => {
  roleRoundLabel.textContent = `Round ${round}`;
  roleText.innerHTML = isImposter
    ? `<strong>You are the IMPOSTER.</strong><br>Your hint: <span class="role-word">${word}</span>`
    : `Your secret word: <span class="role-word">${word}</span>`;
});

// -----------------------------
// Connection handling (auto-rejoin)
// -----------------------------
socket.on("disconnect", () => {
  if (hostNote) hostNote.textContent = "Connection lost. Trying to reconnect...";
  btnStartRound.disabled = true;
});

socket.on("connect", () => {
  if (currentRoom) return; // already connected
  let saved;
  try {
    saved = localStorage.getItem(SESSION_KEY);
  } catch (e) { return; }
  if (!saved) return;

  let session;
  try {
    session = JSON.parse(saved);
  } catch (e) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  const { roomCode, name, icon } = session || {};
  if (!roomCode || !name) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  setSelectedIcon(icon || "mafia1.png");
  homeError.textContent = `Rejoining room ${roomCode} as ${name}...`;

  socket.emit("joinRoom", { roomCode, name, icon }, (res) => {
    if (!res || !res.ok) {
      localStorage.removeItem(SESSION_KEY);
      homeError.textContent = "Your room has ended or your name is taken. Join again.";
      return;
    }
    handleJoinSuccess(res, roomCode, name, icon);
  });
});

socket.on("connect_error", () => {
  homeError.textContent = "Unable to connect to server. Please try again.";
});

// -----------------------------
// Optional: leave room button (if exists)
// -----------------------------
document.getElementById("btn-leave-room")?.addEventListener("click", () => {
  if (currentRoom) socket.emit("leaveRoom", { roomCode: currentRoom });
  localStorage.removeItem(SESSION_KEY);
  currentRoom = null;
  currentName = null;
  isHost = false;
  currentHostName = null;
  currentPlayers = [];
  showScreen("screen-home");
});
