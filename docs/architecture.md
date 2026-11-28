# Xiaoming task agent architecture

A user can create, list, complete, and delete tasks in Chinese. Each turn can change at most one task. DeepSeek interprets the request, and the local server validates the decision, applies it to the saved list, and reports the outcome in Chinese. Tasks may carry a Hong Kong calendar due date. [PlantUML diagram](architecture.puml)

## Modules and responsibilities

| Module | Responsibility and interactions |
| --- | --- |
| [Chat UI](../src/App.tsx) and [history view](../src/ChatHistory.tsx) | Hold the current conversation in browser memory, send the history with each new message, and display Xiaoming’s reply. On a failed request, the UI restores the draft for the user. Refreshing starts a fresh conversation. |
| [Chat client](../src/chat-client.ts) and [chat contract](../shared/chat.ts) | The client posts `{ messages }` to `/api/chat` and reads `{ reply }` or an error. The shared contract defines message roles and content and requires the last message to come from the user. |
| [HTTP entry point](../server/app.ts) | Validate incoming chat history, invoke the supplied `reply(messages)` function, and return its text as JSON. Mount the task REST router and translate request or server failures into HTTP errors for the client. |
| [Startup wiring](../server/index.ts) | Create one JSON task store at startup. Pass it to the REST router through the existing app factory and bind that same instance to the chat handler. Both entry points then operate on the same list. |
| [Chat agent](../server/agent.ts) | Read current tasks, build the interpretation request, validate the model’s decision with Zod, and call the corresponding store method. Own Chinese confirmations, clarification questions, and grouped list formatting. |
| [Model client](../server/model.ts) and DeepSeek | The existing helper supplies a server-side SDK client and configured model name. The agent uses it to send the conversation and the current task IDs, titles, completion states, optional deadlines, and the turn’s Hong Kong date. DeepSeek returns one structured decision for the agent to inspect. |
| [Task REST router](../server/tasks.ts) | Expose the same saved list to direct API callers. Validate request fields, delegate CRUD operations to the store, and translate results into HTTP status codes. A reviewer can use `GET /api/tasks` to verify a chat action independently. [Endpoint contract](../server/openapi.yaml) |
| [JSON task store](../server/task-store.ts) | Own task IDs and persistence. Read `data/tasks.json`, assign a UUID and `done: false` on creation, and replace the file via a temporary file on each write. A new server process can read the previous process’s tasks. |
| [Due dates](../server/due-date.ts) | Supply the shared calendar-date validator for the agent, REST router, and JSON store. Resolve relative dates from the Hong Kong calendar day captured at the start of a turn. |

## Due dates

A saved task may include `dueDate`, a real Gregorian date written as `YYYY-MM-DD`. An omitted field represents an undated task, including records created before this milestone. Creating a task through REST accepts an optional absolute date. Renaming or completing a task preserves its deadline.

In chat, DeepSeek can return `yesterday`, `today`, `tomorrow`, or an explicit date when creating or listing tasks. The agent resolves relative values against one date in `Asia/Hong_Kong` recorded before the model call. A request crossing midnight uses its original date. A vague deadline prompts a clarification before any write.

For “今天有哪些任务到期？” (Which tasks are due today?), the decision is `{"action":"list","filter":"pending","dueDate":"today"}`. Yesterday’s unqualified due-date query includes both statuses. Explicit requests for all, completed, or pending tasks select the requested status. The agent compares the resolved date for equality and then applies the status filter.

## Decision contract

The agent asks for one JSON object per turn. The `action` field selects one of the shapes below. Conversation history resolves references such as “家里那个” (the one at home). Saved task IDs identify the records that can change.

| Action | Payload | Agent behavior |
| --- | --- | --- |
| `create` | `title`, optional `dueDate` | Trim and validate the title using the REST API’s 1–200 character rule. Pass the title and resolved deadline to the store and confirm the saved values. |
| `list` | `filter` equal to `all`, `pending`, or `done`, optional `dueDate` | Read the latest list, apply the filter, and format the matching tasks under 待办 (pending) and 已完成 (completed). Give an explicit empty result when nothing matches. |
| `complete` | `id` | Resolve the ID against the supplied snapshot and current store. If already done, say so. Otherwise call `update(id, { done: true })` and confirm using the returned task. |
| `delete` | `id` | Resolve the ID the same way, call `remove(id)`, and name the deleted task only after the store reports success. |
| `clarify` | `question` | Return a short Chinese question and perform zero writes. Use this when the target is ambiguous, required information is missing, or the user needs to choose one action. |

**Where a turn can stop.** The model is responsible for recognizing ambiguity. An ID can be valid even when the model has misunderstood the user, so the two-parcel scenario below needs a live language check. The agent rejects malformed decisions before dispatch. If a referenced record disappeared or its title changed while the model was responding, ask the user to identify the task again. Provider and filesystem errors follow the existing HTTP error path. A successful mutation reply is produced only after the store operation succeeds.

## Walkthrough of an ambiguous completion

1. The saved list contains two pending tasks, 取公司快递 (pick up the office parcel) and 取家里快递 (pick up the home parcel). The user says “快递取好了” (I picked up the parcel). The browser sends the conversation to the chat endpoint.
2. The agent reads both tasks and sends their IDs and titles with the conversation to DeepSeek. The proposed decision is `clarify`. Xiaoming asks “你取的是公司快递，还是家里快递？” (Did you pick up the office parcel or the home parcel?) Both tasks are still pending.
3. The user replies “家里那个” (the one at home). This request includes the clarification question. The agent reads the current tasks again and receives a `complete` decision naming the home parcel’s ID.
4. The agent checks that record and persists the update. Xiaoming replies “已完成「取家里快递」。” (Marked the home parcel as complete.) A direct REST query now shows the home parcel complete and the office parcel pending.

## How to validate the design after implementation

| Check | Observable result |
| --- | --- |
| Run the six-turn [README conversation](../README.md) through chat with DeepSeek. | 买牛奶 (buy milk) and 取快递 (pick up the parcel) are initially pending. Completing the milk task changes only that record. The final list contains only the completed milk task. |
| Refresh the browser, then restart the server and ask for the list again. | Both new conversations show the same saved task and completion state. |
| Run the two-parcel walkthrough. Inspect `GET /api/tasks` after each user turn. | The first turn changes zero records. The second changes exactly the home parcel. |
| Exercise the chat endpoint with a stubbed model and a temporary store. | Valid decisions cause the specified operation. A malformed decision or missing target leaves the stored records intact. Repeating a completion reports the existing state. |
| Ask what is due today with pending, completed, undated, and adjacent-day tasks present. | Only pending tasks with today’s Hong Kong date appear. Explicit status filters can show completed tasks. |
| Fix the clock around midnight on January 1 in Hong Kong, then reopen the saved list. | Yesterday, today, and tomorrow span the correct year boundary. Dated and legacy undated records survive restart. |
