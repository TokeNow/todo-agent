/** Exercise the chat and REST endpoints against isolated, file-backed task lists. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { reply } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

/** Start a local HTTP server, optionally running the agent with a scripted model. */
async function startTestApp(
  t: TestContext,
  interpret?: Parameters<typeof reply>[2],
  turnStartedAt?: Date,
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const tasks = createJsonTaskStore(filename);
  const app = createApp({
    tasks,
    async reply(messages) {
      conversations.push(messages);

      if (interpret) return reply(messages, tasks, interpret, turnStartedAt);

      return "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  /** Send JSON over HTTP and capture the status and decoded response. */
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("README 六轮对话通过聊天接口更新同一份持久化清单", async (t) => {
  const history: ChatMessage[] = [];
  let modelDecision: unknown;
  const { request, filename } = await startTestApp(t, async (messages) => {
    assert.deepEqual(messages, history);

    return JSON.stringify(modelDecision);
  });

  /** Carry the actual assistant answer into the next turn, as the browser does. */
  async function chat(content: string, decision: unknown): Promise<string> {
    modelDecision = decision;
    history.push({ role: "user", content });
    const response = await request("POST", "/api/chat", { messages: history });

    assert.equal(response.status, 200);
    history.push({ role: "assistant", content: response.body.reply });

    return response.body.reply;
  }

  /** Inspect the same records through the public task endpoint after each turn. */
  async function listTasks(): Promise<ReturnType<TaskStore["list"]>> {
    const response = await request("GET", "/api/tasks");

    assert.equal(response.status, 200);

    return response.body;
  }

  assert.equal(
    await chat("帮我记一下买牛奶", { action: "create", title: "买牛奶" }),
    "已添加「买牛奶」。",
  );
  const firstList = await listTasks();
  const [milkTask] = firstList;
  assert.deepEqual(firstList, [{ id: milkTask.id, title: "买牛奶", done: false }]);

  assert.equal(
    await chat("再记一条取快递", { action: "create", title: "取快递" }),
    "已添加「取快递」。",
  );
  const bothPending = await listTasks();
  const parcelTask = bothPending[1];
  assert.deepEqual(bothPending, [milkTask, { id: parcelTask.id, title: "取快递", done: false }]);

  assert.equal(
    await chat("我有哪些任务？", { action: "list", filter: "all" }),
    "待办：\n· 买牛奶\n· 取快递",
  );
  assert.deepEqual(await listTasks(), bothPending);

  assert.equal(
    await chat("牛奶买好了", { action: "complete", id: milkTask.id }),
    "已完成「买牛奶」。",
  );
  const completedMilk = { ...milkTask, done: true };
  assert.deepEqual(await listTasks(), [completedMilk, parcelTask]);

  assert.equal(
    await chat("取快递这条删掉吧", { action: "delete", id: parcelTask.id }),
    "已删除「取快递」。",
  );
  assert.deepEqual(await listTasks(), [completedMilk]);

  assert.equal(
    await chat("再给我看看清单", { action: "list", filter: "all" }),
    "已完成：\n· 买牛奶",
  );
  assert.deepEqual(await listTasks(), [completedMilk]);
  assert.deepEqual(createJsonTaskStore(filename).list(), [completedMilk]);
});

test("先澄清歧义，再根据用户的回答完成对应任务", async (t) => {
  const question = "你取的是公司快递，还是家里快递？";
  const { request } = await startTestApp(t, async (messages, snapshot) => {
    if (messages.length === 1) return JSON.stringify({ action: "clarify", question });

    assert.deepEqual(messages.slice(1), [
      { role: "assistant", content: question },
      { role: "user", content: "家里那个" },
    ]);
    const homeParcel = snapshot.find((task) => task.title === "取家里快递");
    assert.ok(homeParcel);

    return JSON.stringify({ action: "complete", id: homeParcel.id });
  });
  const office = (await request("POST", "/api/tasks", { title: "取公司快递" })).body;
  const home = (await request("POST", "/api/tasks", { title: "取家里快递" })).body;
  const messages: ChatMessage[] = [{ role: "user", content: "快递取好了" }];

  const clarification = await request("POST", "/api/chat", { messages });
  assert.deepEqual(clarification, { status: 200, body: { reply: question } });
  assert.deepEqual((await request("GET", "/api/tasks")).body, [office, home]);

  messages.push(
    { role: "assistant", content: clarification.body.reply },
    { role: "user", content: "家里那个" },
  );
  assert.deepEqual(await request("POST", "/api/chat", { messages }), {
    status: 200,
    body: { reply: "已完成「取家里快递」。" },
  });
  assert.deepEqual((await request("GET", "/api/tasks")).body, [office, { ...home, done: true }]);
});

test("无效决策、未知 ID 和在模型返回前被改名的任务都不会触发删除", async (t) => {
  let modelOutput = "";
  let renameBeforeReply = false;
  const { request, filename } = await startTestApp(t, async () => {
    if (renameBeforeReply) {
      const store = createJsonTaskStore(filename);
      const [task] = store.list();
      store.update(task.id, { title: "买面包" });
    }

    return modelOutput;
  });

  const original = (await request("POST", "/api/tasks", { title: "买牛奶" })).body;
  const body = { messages: [{ role: "user", content: "把买牛奶删掉" }] };

  for (const invalid of [
    "invalid JSON",
    '{"action":"create","title":" "}',
    JSON.stringify({ action: "delete", id: original.id, extra: true }),
    '{"action":"delete","id":"missing"}',
  ]) {
    modelOutput = invalid;
    const result = await request("POST", "/api/chat", body);

    assert.equal(result.status, 200);
    assert.doesNotMatch(result.body.reply, /已删除|已添加/);
    assert.deepEqual((await request("GET", "/api/tasks")).body, [original]);
  }

  modelOutput = JSON.stringify({ action: "delete", id: original.id });
  renameBeforeReply = true;
  const stale = await request("POST", "/api/chat", body);

  assert.match(stale.body.reply, /确认/);
  assert.deepEqual((await request("GET", "/api/tasks")).body, [{ ...original, title: "买面包" }]);
});

test("清单按状态筛选，重复完成一条任务时保留原有记录", async (t) => {
  let decision: unknown = { action: "list", filter: "pending" };
  const { request } = await startTestApp(t, async () => JSON.stringify(decision));

  /** Exercise a fresh chat turn against the current REST-visible records. */
  async function ask(content: string): Promise<string> {
    const result = await request("POST", "/api/chat", { messages: [{ role: "user", content }] });
    assert.equal(result.status, 200);

    return result.body.reply;
  }

  assert.equal(await ask("还有什么要做？"), "目前没有待办任务。");
  const milk = (await request("POST", "/api/tasks", { title: "买牛奶" })).body;
  const parcel = (await request("POST", "/api/tasks", { title: "取快递" })).body;
  await request("PATCH", `/api/tasks/${milk.id}`, { done: true });

  assert.equal(await ask("还有什么要做？"), "待办：\n· 取快递");
  decision = { action: "list", filter: "done" };
  assert.equal(await ask("哪些做完了？"), "已完成：\n· 买牛奶");
  decision = { action: "list", filter: "all" };
  assert.equal(await ask("看看清单"), "待办：\n· 取快递\n\n已完成：\n· 买牛奶");

  decision = { action: "complete", id: milk.id };
  assert.equal(await ask("牛奶买好了"), "「买牛奶」已经完成了。");
  assert.deepEqual((await request("GET", "/api/tasks")).body, [{ ...milk, done: true }, parcel]);
});

test("Due dates use the Hong Kong turn date and intersect with the requested status", async (t) => {
  const justAfterMidnight = new Date("2026-12-31T16:05:00Z");
  let decision: unknown;
  const { request, filename } = await startTestApp(
    t,
    async (_messages, _tasks, today) => {
      assert.equal(today, "2027-01-01");

      return JSON.stringify(decision);
    },
    justAfterMidnight,
  );

  /** Run an interpreted turn through the same HTTP entry point as the browser. */
  async function chat(content: string, modelDecision: unknown): Promise<string> {
    decision = modelDecision;
    const result = await request("POST", "/api/chat", { messages: [{ role: "user", content }] });
    assert.equal(result.status, 200);

    return result.body.reply;
  }

  const legacy = { id: "legacy", title: "散步", done: false };
  await writeFile(filename, JSON.stringify([legacy]));

  for (const [title, reference, expected] of [
    ["交报告", "today", "2027-01-01"],
    ["修电脑", "yesterday", "2026-12-31"],
    ["还书", "tomorrow", "2027-01-02"],
    ["寄信", "2027-01-01", "2027-01-01"],
  ]) {
    const answer = await chat(title, { action: "create", title, dueDate: reference });
    assert.ok(answer.includes(expected));
  }

  const saved = createJsonTaskStore(filename).list();
  assert.deepEqual(
    saved.map((task) => task.dueDate),
    [undefined, "2027-01-01", "2026-12-31", "2027-01-02", "2027-01-01"],
  );
  const letter = saved[4];
  await chat("信寄好了", { action: "complete", id: letter.id });

  assert.equal(
    await chat("今天有哪些任务到期？", { action: "list", dueDate: "today", filter: "pending" }),
    "待办：\n· 交报告",
  );
  assert.equal(
    await chat("今天到期的哪些已完成？", { action: "list", dueDate: "today", filter: "done" }),
    "已完成：\n· 寄信",
  );
  assert.equal(
    await chat("昨天有哪些任务到期？", { action: "list", dueDate: "yesterday", filter: "all" }),
    "待办：\n· 修电脑",
  );
  assert.equal(
    await chat("明天有哪些任务到期？", { action: "list", dueDate: "tomorrow", filter: "all" }),
    "待办：\n· 还书",
  );

  await chat("报告交好了", { action: "complete", id: saved[1].id });
  assert.equal(
    await chat("今天有哪些任务到期？", { action: "list", dueDate: "today", filter: "pending" }),
    "今天没有待办任务到期。",
  );
  const reopened = createJsonTaskStore(filename).list();
  assert.deepEqual(reopened[0], legacy);
  assert.deepEqual(reopened[4], { ...letter, done: true });
});

test("REST and chat reject invalid deadlines and preserve valid leap days", async (t) => {
  const { request } = await startTestApp(t, async () =>
    JSON.stringify({
      action: "create",
      title: "交报告",
      dueDate: "2026-02-30",
    }),
  );

  for (const invalid of ["2026-02-30", "2027-02-29", "2026-2-1", "today", null]) {
    const response = await request("POST", "/api/tasks", { title: "交报告", dueDate: invalid });
    assert.equal(response.status, 400);
  }

  await request("POST", "/api/chat", { messages: [{ role: "user", content: "2月30日交报告" }] });
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);

  const leapDay = await request("POST", "/api/tasks", { title: "交报告", dueDate: "2028-02-29" });
  assert.equal(leapDay.status, 201);
  assert.equal(leapDay.body.dueDate, "2028-02-29");
  const updated = await request("PATCH", "/api/tasks/" + leapDay.body.id, { done: true });
  assert.deepEqual(updated.body, { ...leapDay.body, done: true });
});
