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
const WORDS = [
  // Shops / brands
  { word: "Asda", hint: "Shopping" },
  { word: "Tesco", hint: "Groceries" },
  { word: "IKEA", hint: "Furniture" },
  { word: "McDonald’s", hint: "Burger" },
  { word: "Starbucks", hint: "Drink" },
  { word: "Primark", hint: "Clothes" },
  { word: "Apple Store", hint: "Electronics" },
  { word: "JD Sports", hint: "Trainers" },
  { word: "KFC", hint: "Chicken" },
  { word: "Subway", hint: "Sandwich" },

  // Food & drink
  { word: "Pizza", hint: "Cheese" },
  { word: "Sushi", hint: "Rice" },
  { word: "Curry", hint: "Spice" },
  { word: "Chocolate", hint: "Sweet" },
  { word: "Ice cream", hint: "Cold" },
  { word: "Noodles", hint: "Bowl" },
  { word: "Burger", hint: "Bun" },
  { word: "Doughnut", hint: "Sugar" },
  { word: "Coffee", hint: "Caffeine" },
  { word: "Bubble tea", hint: "Pearls" },

  // Celebrities
  { word: "Taylor Swift", hint: "Concerts" },
  { word: "Rihanna", hint: "Makeup" },
  { word: "Drake", hint: "Rap" },
  { word: "Beyoncé", hint: "Stage" },
  { word: "Lionel Messi", hint: "Goals" },
  { word: "Cristiano Ronaldo", hint: "Football" },
  { word: "Ariana Grande", hint: "High notes" },
  { word: "Dwayne Johnson", hint: "Muscles" },
  { word: "Zendaya", hint: "Series" },
  { word: "Tom Holland", hint: "Spider" },

  // Places
  { word: "Paris", hint: "Romance" },
  { word: "London", hint: "Rain" },
  { word: "New York", hint: "Skyscrapers" },
  { word: "Tokyo", hint: "Neon" },
  { word: "Dubai", hint: "Luxury" },
  { word: "Sydney", hint: "Harbour" },
  { word: "Maldives", hint: "Islands" },
  { word: "Disneyland", hint: "Rides" },
  { word: "Wembley Stadium", hint: "Finals" },
  { word: "Hollywood", hint: "Stars" },

  // Objects
  { word: "iPhone", hint: "Touchscreen" },
  { word: "PlayStation", hint: "Controller" },
  { word: "Laptop", hint: "Keyboard" },
  { word: "Headphones", hint: "Music" },
  { word: "Toothbrush", hint: "Bathroom" },
  { word: "Backpack", hint: "Straps" },
  { word: "Sunglasses", hint: "Sun" },
  { word: "AirPods", hint: "Wireless" },
  { word: "Wallet", hint: "Cards" },
  { word: "Camera", hint: "Lens" },

  // Jobs
  { word: "Doctor", hint: "Checkups" },
  { word: "Teacher", hint: "Homework" },
  { word: "Chef", hint: "Kitchen" },
  { word: "Police officer", hint: "Uniform" },
  { word: "Nurse", hint: "Ward" },
  { word: "Barista", hint: "Coffee" },
  { word: "Pilot", hint: "Cockpit" },
  { word: "Taxi driver", hint: "Meter" },
  { word: "Footballer", hint: "Pitch" },
  { word: "Dentist", hint: "Teeth" },

  // Random fun
  { word: "Unicorn", hint: "Horn" },
  { word: "Dragon", hint: "Fire" },
  { word: "Mermaid", hint: "Tail" },
  { word: "Spider-Man", hint: "Web" },
  { word: "Batman", hint: "Cape" },
  { word: "Hogwarts", hint: "Wands" },
  { word: "Lightsaber", hint: "Glow" },
  { word: "TikTok", hint: "Scrolling" },
  { word: "Instagram", hint: "Stories" },
  { word: "Netflix", hint: "Binge" },

  // Animals
  { word: "Dog", hint: "Walks" },
  { word: "Cat", hint: "Whiskers" },
  { word: "Elephant", hint: "Trunk" },
  { word: "Shark", hint: "Teeth" },
  { word: "Lion", hint: "Roar" },
  { word: "Penguin", hint: "Waddle" },
  { word: "Monkey", hint: "Bananas" },
  { word: "Rabbit", hint: "Ears" },
  { word: "Snake", hint: "Slither" },
  { word: "Dolphin", hint: "Jump" },

  // Locations / activities
  { word: "Airport", hint: "Suitcases" },
  { word: "Cinema", hint: "Popcorn" },
  { word: "Gym", hint: "Weights" },
  { word: "Library", hint: "Shelves" },
  { word: "Museum", hint: "Exhibits" },
  { word: "Beach", hint: "Sand" },
  { word: "Mountain", hint: "Hiking" },
  { word: "Football stadium", hint: "Crowd" },
  { word: "Train station", hint: "Platform" },
  { word: "Nightclub", hint: "Lights" }
];

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
