import { Router } from "express";
import { z } from "zod";
import { calendarDate } from "./due-date.ts";
import type { TaskStore } from "./task-store.ts";

const title = z.string().trim().min(1).max(200);
const createTaskSchema = z.strictObject({ title, dueDate: calendarDate.optional() });
const updateTaskSchema = z
  .strictObject({ title: title.optional(), done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      if (input.error.issues.some((issue) => issue.path[0] === "dueDate")) {
        return res.status(400).json({ error: "截止日期必须是有效的 YYYY-MM-DD 日期。" });
      }
      return res.status(400).json({ error: "请提供 1 至 200 个字符的任务标题。" });
    }
    res.status(201).json(tasks.create(input.data.title, input.data.dueDate));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的 title 或 done 字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
