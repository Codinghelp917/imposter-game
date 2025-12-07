const socket = io();

let currentRoom = null;
let currentName = null;
let isHost = false;
let currentPlayers = [];
let currentHostName = null;
let selectedIcon = "mafia1.png"; // default icon

// Screens
const screenHome = document.getElementById("screen-home");
const screenLobby = document.getElementById("screen-lobby");

// Home / lobby elements
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

// Icon picker buttons (may not exist if you haven't added them yet)
const iconOptions = document.querySelectorAll(".icon-option");

function showScreen(id) {
  [screenHome, screenLobby].forEach((el) => el.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

// -----------------------------
// Icon picker logic
// -----------------------------
if (iconOptions.length > 0) {
  // Default to the first icon
  selectedIcon = iconOptions[0].dataset.icon || "mafia1.png";
  iconOptions[0].classList.add("selected");

  iconOptions.forEach((btn) => {
    btn.addEventListener("click", () => {
      iconOptions.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedIcon = btn.dataset.icon || "mafia1.png";
    });
  });
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
document.getElementById("btn-join-room").onclick = () => {
  const roomInput = document.getElementById("join-room-code");
  const nameInput = document.getElementById("join-name");

  const roomCode = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();

  roomInput.value = roomCode;

  if (!roomCode || !name) {
    homeError.textContent = "Enter both room code and name.";
    return;
  }

  socket.emit(
    "joinRoom",
    { roomCode, name, icon: selectedIcon },
    (res) => {
      if (!res || !res.ok) {
        homeError.textContent = (res && res.error) || "Could not join room.";
        return;
      }

      homeError.textContent = "";
      currentRoom = roomCode;
      currentName = name;
      isHost = !!res.isHost;
      currentHostName = res.hostName || null;

      roomCodeLabel.textContent = currentRoom;
      playerNameLabel.textContent = currentName;
      hostNameLabel.textContent = currentHostName || "Deciding host...";

      // Clear last role text on join
      roleRoundLabel.textContent = "";
      roleText.textContent = "";

      updateHostUI(res.round || 0);
      showScreen("screen-lobby");
    }
  );
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
  // Host name label (never "unknown")
  if (currentHostName) {
    hostNameLabel.textContent = currentHostName;
  } else {
    hostNameLabel.textContent = "Deciding host...";
  }

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

  if (round && round > 0) {
    roundLabel.textContent = `(Round ${round})`;
  } else {
    roundLabel.textContent = "";
  }
}

function renderOrder(order) {
  orderList.innerHTML = "";
  if (!order || !order.length) {
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

// -----------------------------
// Socket events
// -----------------------------
socket.on("roomUpdate", ({ players, round, hostName, order }) => {
  currentPlayers = players || [];

  // Update host name if provided
  if (typeof hostName === "string" && hostName.trim() !== "") {
    currentHostName = hostName;
  } else if (!currentHostName && currentPlayers.length > 0) {
    // fallback: show first player's name if no host yet
    currentHostName = currentPlayers[0].name;
  }

  // Recalculate if THIS client is host
  isHost =
    !!currentHostName &&
    !!currentName &&
    currentHostName === currentName;

  // Update player list with icons
  playerList.innerHTML = "";
  currentPlayers.forEach((p) => {
    const li = document.createElement("li");

    if (p.icon) {
      li.innerHTML = `
        <img src="images/icons/${p.icon}" alt="" class="player-icon-img">
        ${p.name}
      `;
    } else {
      li.textContent = p.name;
    }

    if (p.name === currentHostName) {
      li.classList.add("player-host");
    }

    playerList.appendChild(li);
  });

  updateHostUI(round || 0);
  renderOrder(order || []);
});

socket.on("roundStarted", ({ round, hostName, order }) => {
  if (typeof hostName === "string" && hostName.trim() !== "") {
    currentHostName = hostName;
    isHost =
      !!currentHostName &&
      !!currentName &&
      currentHostName === currentName;
  }

  updateHostUI(round || 0);
  renderOrder(order || []);

  roleRoundLabel.textContent = `Round ${round}`;
  // Don't change roleText here – it's set by the 'role' event
});

// Each player receives their private role here
socket.on("role", ({ isImposter, word, round }) => {
  roleRoundLabel.textContent = `Round ${round}`;

  if (isImposter) {
    roleText.innerHTML = `
      <strong>You are the IMPOSTER.</strong><br>
      Your hint: <span class="role-word">${word}</span>
    `;
  } else {
    roleText.innerHTML = `
      Your secret word: <span class="role-word">${word}</span>
    `;
  }
});

// Basic error handling
socket.on("disconnect", () => {
  homeError.textContent = "Disconnected from server. Refresh the page to reconnect.";
  showScreen("screen-home");
});

socket.on("connect_error", () => {
  homeError.textContent = "Unable to connect to server. Please try again.";
});
