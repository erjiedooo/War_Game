import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { createRoomStore } from "./persistence.js";
import { createRoomManager } from "./room-manager.js";

const HOST = "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? "4173", 10);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(rootDirectory, "dist");
const roomStore = createRoomStore();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  serveClient: true,
  cors: { origin: false },
});

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "War_Game", transport: "socket.io", persistence: "disk", rooms: roomManager.rooms.size });
});
app.use(express.static(distDirectory, { extensions: ["html"] }));
app.get("*", (_request, response) => response.sendFile(path.join(distDirectory, "index.html")));

const roomManager = createRoomManager(io, { roomStore });

io.on("connection", (socket) => {
  socket.emit("serverHello", { socketId: socket.id, serverTime: Date.now() });
  roomManager.register(socket);
});

function localIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

httpServer.listen(PORT, HOST, () => {
  console.log(`War_Game server ready: http://127.0.0.1:${PORT}/`);
  console.log(`Loaded ${roomManager.rooms.size} saved room(s) from ${roomStore.savePath}`);
  for (const address of localIpv4Addresses()) console.log(`LAN: http://${address}:${PORT}/`);
});

function shutdown(signal) {
  console.log(`\n${signal}: shutting down War_Game server...`);
  roomManager.persist();
  io.close(() => httpServer.close(() => process.exit(0)));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

export { app, httpServer, io, roomManager, roomStore };
