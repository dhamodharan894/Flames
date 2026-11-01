import http from "http";
import app from "./app.js";
import { Server } from "socket.io";
import dotenv from "dotenv";
import { setSecuritySocketIO } from "./services/securityDetector.js";
import { ensureFaceService, stopFaceServiceProcess } from "./services/faceServiceManager.js";
import { runGeofenceDefaultsMigration } from "../scripts/migrate-geofence-defaults.js";
import { startComplianceSupervisor } from "./services/complianceSupervisor.js";

dotenv.config();

let PORT = parseInt(process.env.PORT || "5001", 10);
const server = http.createServer(app);

// Socket.io for live updates
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
app.set("io", io);
setSecuritySocketIO(io);

io.on("connection", (socket) => {
  console.log(`⚡ Socket client connected: ${socket.id}`);

  socket.on("join_company", (companyId) => {
    socket.join(`company_${companyId}`);
  });

  socket.on("join_user", (userId) => {
    socket.join(`user_${userId}`);
  });

  socket.on("typing_start", ({ threadId, userId, userName }) => {
    socket.to(`channel_${threadId}`).emit("user_typing", { threadId, userId, userName });
  });

  socket.on("typing_stop", ({ threadId, userId }) => {
    socket.to(`channel_${threadId}`).emit("user_stopped_typing", { threadId, userId });
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket client disconnected: ${socket.id}`);
  });
});

export { io };

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`⚠️ Port ${PORT} is in use, attempting to use port ${PORT + 1}...`);
    PORT = PORT + 1;
    server.listen(PORT, () => {
      console.log(`🚀 HRMS Backend Server running on fallback port ${PORT}`);
      console.log(`📡 Health check available at: http://localhost:${PORT}/api/health`);
      startComplianceSupervisor(io);
    });
  } else {
    console.error("Server error:", err);
  }
});

let isShuttingDown = false;
async function handleShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("\n[Server] Graceful shutdown initiated...");
  
  // Stop Python Face Verification microservice
  try {
    await stopFaceServiceProcess();
  } catch (e) {}

  server.close(() => {
    console.log("[Server] HTTP and Socket.io server closed.");
    process.exit(0);
  });
  
  setTimeout(() => {
    console.warn("[Server] Force exiting after timeout.");
    process.exit(1);
  }, 5000).unref();
}

process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);

async function startServer() {
  // 1. Ensure Python FastAPI Face Verification microservice is running or start it
  try {
    await ensureFaceService();
  } catch (faceErr) {
    console.error(`❌ [FaceService] Failed to initialize face verification microservice: ${faceErr.message}`);
    console.warn(`⚠️ [FaceService] Biometric attendance operations will fail-closed (503) until the service is restored.`);
  }

  // 2. Run geofence defaults migration (non-blocking)
  try {
    await runGeofenceDefaultsMigration();
  } catch (migErr) {
    console.warn(`⚠️ [Migration] Geofence defaults migration check: ${migErr.message}`);
  }

  // 3. Start Express server
  server.listen(PORT, () => {
    console.log(`🚀 HRMS Backend Server running on port ${PORT}`);
    console.log(`📡 Health check available at: http://localhost:${PORT}/api/health`);
    startComplianceSupervisor(io);
  });
}

startServer();
