import express from "express";
import {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  startTaskTimer,
  stopTaskTimer,
  markTaskViewed,
  completeTask
} from "../controllers/taskController.js";
import { authenticateToken } from "../middlewares/auth.js";

const router = express.Router();

router.use(authenticateToken);
router.get("/", getTasks);
router.post("/", createTask);
router.patch("/:id", updateTask);
router.delete("/:id", deleteTask);
router.post("/:id/start-timer", startTaskTimer);
router.post("/:id/stop-timer", stopTaskTimer);
router.post("/:id/view", markTaskViewed);
router.post("/:id/complete", completeTask);

export default router;
