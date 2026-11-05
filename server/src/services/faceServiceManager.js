/**
 * Face Service Manager (Supervisor)
 * ============================================================================
 * Manages the lifecycle of the Python FastAPI Biometric Microservice:
 *  - Checks whether the service is already healthy before spawning.
 *  - Spawns the Python uvicorn microservice if not running.
 *  - Waits for /health readiness with configurable timeout.
 *  - Detects premature exit, missing dependencies, or crash.
 *  - Prevents duplicate processes via concurrency locks and health detection.
 *  - Handles graceful cross-platform shutdown (Windows taskkill & POSIX SIGTERM).
 *  - Fails closed: ensures attendance biometrics are never silently bypassed.
 * ============================================================================
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root & service directories
const rootDir = path.resolve(__dirname, "../../..");
const defaultFaceServiceDir = path.resolve(rootDir, "face_service");

let managedChild = null;
let startupPromise = null;
let shutdownRegistered = false;

/**
 * Get configured face service URL
 */
export function getFaceServiceUrl() {
  return process.env.FACE_SERVICE_URL || "http://127.0.0.1:5002";
}

/**
 * Check if the face service is currently responsive and healthy
 * @param {string} [baseUrl]
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ healthy: boolean, data?: any, error?: string, status?: number }>}
 */
export async function checkFaceServiceHealth(baseUrl = getFaceServiceUrl(), timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/health`;
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { healthy: true, data, status: res.status };
    }
    return { healthy: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    clearTimeout(timer);
    return { healthy: false, error: err.message };
  }
}

/**
 * Resolve python command executable
 */
export function resolvePythonCommand() {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  if (process.env.PYTHON_CMD) return process.env.PYTHON_CMD;

  const venvWin = path.resolve(defaultFaceServiceDir, ".venv/Scripts/python.exe");
  const venvPosix = path.resolve(defaultFaceServiceDir, ".venv/bin/python");
  if (fs.existsSync(venvWin)) return venvWin;
  if (fs.existsSync(venvPosix)) return venvPosix;

  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Get the currently active managed child process (if any)
 */
export function getManagedProcess() {
  return managedChild;
}

/**
 * Gracefully stop the managed face service child process
 */
export async function stopFaceServiceProcess() {
  if (!managedChild) return;
  const child = managedChild;
  managedChild = null;
  child._intentionalStop = true;

  const pid = child.pid;
  if (!pid || child.killed) return;

  try {
    if (process.platform === "win32") {
      try {
        const { execSync } = await import("child_process");
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      } catch (e) {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch (err) {
    // Process might have already exited
  }
}

/**
 * Register signal handlers for clean process termination
 */
export function registerShutdownHandlers() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const handleExit = () => {
    stopFaceServiceProcess();
  };

  process.once("SIGINT", () => {
    stopFaceServiceProcess();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stopFaceServiceProcess();
    process.exit(0);
  });
  process.once("exit", handleExit);
}

/**
 * Start the Python Face Verification Microservice child process
 * and wait for readiness.
 */
export async function startFaceServiceProcess(options = {}) {
  const pythonCmd = options.pythonCmd || resolvePythonCommand();
  const faceServiceDir = options.faceServiceDir || process.env.FACE_SERVICE_DIR || defaultFaceServiceDir;
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const silent = options.silent ?? false;
  const targetUrl = options.targetUrl || getFaceServiceUrl();

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch (e) {
    urlObj = new URL("http://127.0.0.1:5002");
  }
  const host = urlObj.hostname || "127.0.0.1";
  const port = urlObj.port || "5002";

  // Prevent duplicate child processes if one is already running and alive
  if (managedChild && !managedChild.killed) {
    const health = await checkFaceServiceHealth(targetUrl, 2000);
    if (health.healthy) {
      return { process: managedChild, pid: managedChild.pid, alreadyRunning: true };
    }
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let stderrChunks = [];

    const cleanupTimers = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    let child;
    try {
      child = spawn(
        pythonCmd,
        ["-m", "uvicorn", "app:app", "--host", host, "--port", String(port)],
        {
          cwd: faceServiceDir,
          stdio: silent ? "pipe" : ["ignore", "pipe", "pipe"],
          env: { ...process.env, PYTHONUNBUFFERED: "1" }
        }
      );
    } catch (spawnErr) {
      return reject(
        new Error(`Failed to spawn Python process with '${pythonCmd}': ${spawnErr.message}`)
      );
    }

    managedChild = child;

    if (child.stdout && !silent) {
      child.stdout.on("data", (data) => {
        process.stdout.write(`[FaceService] ${data}`);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderrChunks.push(data.toString());
        if (!silent) {
          process.stderr.write(`[FaceService] ${data}`);
        }
      });
    }

    child.on("error", (err) => {
      cleanupTimers();
      if (!resolved) {
        resolved = true;
        managedChild = null;
        reject(
          new Error(
            `Failed to start Python face service ('${pythonCmd}'): ${err.message}. ` +
            `Ensure Python is installed and available in PATH.`
          )
        );
      }
    });

    child.on("exit", (code, signal) => {
      cleanupTimers();
      const lastStderr = stderrChunks.slice(-5).join("").trim();
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      if (!resolved) {
        resolved = true;
        managedChild = null;
        reject(
          new Error(
            `Face verification microservice exited prematurely before ready with ${reason}. ` +
            (lastStderr ? `Details: ${lastStderr}` : "Check Python dependencies (fastapi, uvicorn, deepface).")
          )
        );
      } else {
        if (!child._intentionalStop) {
          console.warn(`⚠️ [FaceServiceManager] Python face service exited unexpectedly with ${reason}.`);
        }
        managedChild = null;
      }
    });

    // Polling function
    const checkReadiness = async () => {
      if (resolved) return;
      const res = await checkFaceServiceHealth(targetUrl, 1000);
      if (res.healthy) {
        cleanupTimers();
        if (!resolved) {
          resolved = true;
          resolve({ process: child, pid: child.pid, alreadyRunning: false });
        }
      }
    };

    // Start polling immediately then at intervals
    checkReadiness();
    pollTimer = setInterval(checkReadiness, pollIntervalMs);

    // Timeout handler
    timeoutTimer = setTimeout(() => {
      cleanupTimers();
      if (!resolved) {
        resolved = true;
        try {
          stopFaceServiceProcess();
        } catch (e) {}
        reject(
          new Error(
            `Timed out waiting for Face Verification Service on ${targetUrl}/health after ${timeoutMs}ms.`
          )
        );
      }
    }, timeoutMs);
  });
}

/**
 * Ensure the Face Verification Service is up and responsive.
 * If already running and healthy, reuses the existing instance.
 * If not running, spawns and waits for readiness.
 *
 * @param {object} [options]
 * @returns {Promise<{ healthy: boolean, alreadyRunning: boolean, spawned: boolean, pid?: number }>}
 */
export async function ensureFaceService(options = {}) {
  if (startupPromise) {
    return startupPromise;
  }

  startupPromise = (async () => {
    const targetUrl = options.targetUrl || getFaceServiceUrl();
    const isProduction = process.env.NODE_ENV === "production";
    const autoStartEnabled =
      options.autoStart ??
      (process.env.AUTO_START_FACE_SERVICE === "true" ||
        (process.env.AUTO_START_FACE_SERVICE !== "false" && !isProduction));

    // 1. First probe if the service is already healthy
    const initialCheck = await checkFaceServiceHealth(targetUrl, 2000);
    if (initialCheck.healthy) {
      console.log(
        `[FaceServiceManager] Biometric face service is already running on ${targetUrl} (reusing existing instance).`
      );
      return { healthy: true, alreadyRunning: true, spawned: false };
    }

    // 2. If auto-start is disabled (e.g. production container deployment)
    if (!autoStartEnabled) {
      console.warn(
        `[FaceServiceManager] Face verification service is offline at ${targetUrl} and auto-start is disabled ` +
        `(AUTO_START_FACE_SERVICE=false or NODE_ENV=production). Biometric operations will fail-closed.`
      );
      if (options.throwOnError) {
        throw new Error(`Face service is offline at ${targetUrl} and auto-start is disabled.`);
      }
      return { healthy: false, alreadyRunning: false, spawned: false };
    }

    // 3. Start the service
    console.log(`[FaceServiceManager] Face verification service not detected at ${targetUrl}. Starting Python FastAPI microservice...`);
    const startResult = await startFaceServiceProcess({
      ...options,
      targetUrl
    });

    if (options.registerSignalHandlers !== false) {
      registerShutdownHandlers();
    }

    console.log(
      `[FaceServiceManager] ✅ Face verification microservice is ready on ${targetUrl} (PID: ${startResult.pid}).`
    );

    return {
      healthy: true,
      alreadyRunning: false,
      spawned: true,
      pid: startResult.pid
    };
  })().finally(() => {
    startupPromise = null;
  });

  return startupPromise;
}

export default {
  checkFaceServiceHealth,
  startFaceServiceProcess,
  stopFaceServiceProcess,
  ensureFaceService,
  getManagedProcess,
  getFaceServiceUrl,
  resolvePythonCommand
};
