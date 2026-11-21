const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get("/", (req, res) => {
  res.send("Fogo Nos Bacon - Servidor Online!");
});

const players = {};

io.on("connection", (socket) => {
  console.log("Jogador conectado:", socket.id);

  socket.on("joinRoom", (roomCode) => {
    if (!roomCode) return;

    socket.join(roomCode);

    players[socket.id] = {
      id: socket.id,
      room: roomCode,
      x: 0,
      y: 0,
      z: 0
    };

    socket.emit("currentPlayers", players);

    socket.to(roomCode).emit("playerJoined", players[socket.id]);
  });

  socket.on("playerMove", (data) => {
    if (!players[socket.id]) return;

    players[socket.id] = {
      ...players[socket.id],
      ...data
    };

    socket.to(players[socket.id].room).emit("playerMoved", {
      id: socket.id,
      ...data
    });
  });

  socket.on("disconnect", () => {
    const player = players[socket.id];

    if (player) {
      io.to(player.room).emit("playerLeft", socket.id);
      delete players[socket.id];
    }

    console.log("Jogador desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
