/**
 * Lesson 51 (prep) -- the assistant that speaks first.
 *
 * Every route in this project so far has had the same shape:
 *
 *     a request arrives  ->  a question is answered  ->  a response leaves
 *
 * The user supplies the question and the clock is irrelevant. This file inverts
 * both halves. There is no request: a timer supplies the question. There is no
 * response: the answer is written down and the user reads it whenever they next
 * open the app.
 *
 * That is the whole feature, and it is worth being precise about what it costs,
 * because "send a message every day" sounds like one cron line and is in fact
 * three new pieces of machinery:
 *
 *   1. a clock.
 *      In-process timer here; an external scheduler in production, for a reason
 *      that is not obvious -- see "where the timer lives" below.
 *
 *   2. state that outlives the process.
 *      store.js is a Map: restart the server and every document is gone. A
 *      subscription that disappears on deploy is not a subscription, so this
 *      module owns a JSON file. This is the first durable thing in the project.
 *
 *   3. somewhere for the message to land.
 *      You cannot push to a browser that is not open. The inbox below is the
 *      honest minimum -- and it doubles as the assistant's memory, because
 *      yesterday's message is what lets today's say something new instead of the
 *      same thing again.
 *
 * What it deliberately does NOT add is a second agent. The message is produced by
 * HW4's runAgent(), given a different system prompt and no user question. Lesson
 * 50 moved "should I use a tool?" into the model. This file moves only "when
 * should anyone speak at all?" into a clock.
 *
 * ---------------------------------------------------------------------------
 * Why the tick is idempotent, and why that is the load-bearing word
 *
 * "Every day at 08:00" is a promise about a *date*, not about a process. A timer
 * that wakes every 60 seconds therefore sees the same date 1440 times, and in
 * the production setup two schedulers (the in-process one and an external cron
 * job) see it simultaneously.
 *
 * So a subscription records the local date it last spoke, and a tick claims that
 * date *before* it awaits anything. The claim is written to disk before the model
 * is called, so the worst case of a crash mid-generation is a missing message,
 * never a duplicate one -- and a duplicate is what the user actually notices.
 * Same idea as the in-flight marker guarding the MCP connection in chat-mcp.js,
 * one layer up.
 *
 * The cost of that choice is real, so it is stated rather than hidden: a
 * generation that fails still owns the date and is not retried automatically.
 * lastOutcome records why, GET /daily reports it, POST /daily/:id/run is the
 * retry. A timer that retries a paid API unattended is a worse failure than a
 * late message.
 * ---------------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import runAgent from "./chat-agent.js";
import { getDocument } from "./store.js";

// Loaded here, not only in server.js. ESM evaluates every import before the
// importing module's body runs, so by the time server.js calls dotenv.config()
// this module has already been evaluated -- reading process.env at module scope
// would silently see the defaults. mcp-server.js solves the same problem the same
// way; the lesson 49 notes call it out as a trap, not a style choice.
dotenv.config();

/* -------------------------------------------------------------------------- *
 * Tunables
 * -------------------------------------------------------------------------- */
const DATA_FILE = path.join("data", "daily.json");

// The project's user is in China and the eventual deployment target is us-east-2.
// Those are eight hours apart, which is the entire difference between "08:00" and
// "the middle of the night" -- so the timezone is data on the subscription, never
// the process's local time. Default only decides what a client that omits it gets.
export const DEFAULT_TIMEZONE = process.env.DAILY_TIMEZONE ?? "Asia/Shanghai";

// How late a missed message may still be delivered. Without a window, a server
// that was down all day comes up at 23:40 and sends a cheerful morning briefing.
// Zero would mean "only if the timer happens to fire in the same minute", which
// is fragile; an hour or two absorbs a restart without moving the message.
export const CATCH_UP_MINUTES = Number(process.env.DAILY_CATCH_UP_MINUTES ?? 120);

const TICK_INTERVAL_MS = Number(process.env.DAILY_TICK_MS ?? 60_000);

// A deadline for one generation. Without it, a model call that never returns
// leaves the tick awaiting forever, which means `running` never clears and every
// later tick reports "already running" -- a stalled message silently becomes a
// stalled scheduler. Note what this can and cannot do: the abandoned call is not
// cancelled, it is merely no longer waited for, so a very late answer is
// discarded rather than delivered twice.
const GENERATE_TIMEOUT_MS = Number(process.env.DAILY_GENERATE_TIMEOUT_MS ?? 120_000);
const HISTORY_IN_PROMPT = Number(process.env.DAILY_HISTORY ?? 1);
export const MAX_SUBSCRIPTIONS_PER_CLIENT = Number(
  process.env.DAILY_MAX_SUBSCRIPTIONS ?? 5
);
const MAX_STORED_MESSAGES_PER_CLIENT = Number(
  process.env.DAILY_MAX_MESSAGES ?? 30
);

export const isValidTime = (hour, minute) =>
  Number.isInteger(hour) &&
  Number.isInteger(minute) &&
  hour >= 0 &&
  hour <= 23 &&
  minute >= 0 &&
  minute <= 59;

/* -------------------------------------------------------------------------- *
 * Storage -- one JSON file, one writer
 *
 * Deliberately not a database, and deliberately not shared with a second
 * process: read-modify-write on a file from two writers is a race that no amount
 * of care in this code fixes. So the rule is one writer, and the external
 * scheduler talked about in the header calls the HTTP tick rather than running a
 * second copy of this module.
 *
 * Writes go through a temp file and a rename, so a crash mid-write cannot leave
 * a half-parsed file -- the next boot either sees the old state or the new one.
 * -------------------------------------------------------------------------- */
let state = { subscriptions: [], messages: [] };
let running = false;
let timer = null;

const load = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    state = {
      subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
      messages: Array.isArray(raw.messages) ? raw.messages : [],
    };
  } catch (error) {
    // Missing file is the normal first run; a corrupt one is worth shouting about
    // but must not stop the server from booting.
    if (error.code !== "ENOENT") {
      console.error(`[daily] could not read ${DATA_FILE}: ${error.message}`);
    }
    state = { subscriptions: [], messages: [] };
  }
};

const save = () => {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
};

load();

/**
 * A claim is only as durable as the process that made it.
 *
 * deliver() writes "generating" to disk *before* calling the model, so a crash
 * can lose a message but never duplicate one. That leaves a third outcome the
 * first version of this file did not handle, and it is easy to hit: kill the
 * server (or deploy it) between the claim and the answer, and the subscription
 * now owns a date on which nothing was ever sent. No later tick will touch it --
 * the date looks spent -- so the day's message is silently gone.
 *
 * Only the boot path can decide this, because only at boot is it certain that no
 * generation from a previous lifetime is still in flight. And the decision is
 * just "did a message for that date survive?", which is the one question that
 * distinguishes the two ways a process can die here:
 *
 *   message present -> the delivery finished and only the bookkeeping was lost
 *   message absent  -> the delivery did not finish; release the claim so the
 *                      next tick retries it inside the catch-up window, or
 *                      records it as missed if the window has closed
 *
 * Deliberately runs before startScheduler(): the recovery has to be part of the
 * state the first tick sees.
 */
const recoverInterrupted = () => {
  let changed = false;
  for (const sub of state.subscriptions) {
    if (sub.lastOutcome !== "generating") continue;
    changed = true;
    // Read the claimed date before the branches below start clearing it.
    const claimed = sub.lastRunDate;
    const delivered = state.messages.some(
      (message) => message.subscriptionId === sub.id && message.dateKey === claimed
    );
    if (delivered) {
      sub.lastOutcome = "fired";
    } else {
      sub.lastOutcome = "interrupted";
      sub.lastRunDate = null;
    }
    console.log(
      `[daily] ${sub.id} was interrupted mid-generation for ${claimed}: ` +
        (delivered ? "the message survived, restoring the record" : "no message survived, releasing the claim")
    );
  }
  if (changed) save();
};

recoverInterrupted();

/* -------------------------------------------------------------------------- *
 * Time
 *
 * "08:00" without a timezone is not a time. Everything below resolves a
 * subscription's time in that subscription's own zone using Intl, which ships
 * with Node -- a date library would be the obvious dependency here and is not
 * needed for "what hour is it in Shanghai".
 * -------------------------------------------------------------------------- */
const formatters = new Map();

const formatterFor = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  }
  return formatters.get(timeZone);
};

export const isValidTimezone = (timeZone) => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * What day and time it is *there*, given an instant here.
 *
 * The hour is taken modulo 24 because some ICU versions render midnight as "24"
 * for hour12:false. It is one character, it is invisible in testing, and it turns
 * a midnight subscription into one that fires at midnight and then reports the
 * wrong date for the rest of the day.
 */
export const localParts = (date, timeZone) => {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    minutesSinceMidnight: hour * 60 + minute,
  };
};

const hhmm = (hour, minute) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/**
 * The decision, as a pure function of (subscription, instant).
 *
 * Split out and exported because it is the only part of this file worth arguing
 * about, and because a scheduler you cannot ask "what would you do at 07:59?"
 * is a scheduler you debug by waiting.
 *
 *   waiting  -- not yet today
 *   due      -- scheduled time has passed, inside the catch-up window
 *   missed   -- scheduled time has passed, outside it
 *   done     -- already spoke today
 *   disabled -- switched off
 */
export const scheduleState = (sub, now = new Date()) => {
  if (!sub.enabled) return { state: "disabled" };

  const local = localParts(now, sub.timezone);
  if (sub.lastRunDate === local.dateKey) return { state: "done", local };

  const scheduled = sub.hour * 60 + sub.minute;
  const late = local.minutesSinceMidnight - scheduled;
  if (late < 0) return { state: "waiting", local, dueInMinutes: -late };
  if (late > CATCH_UP_MINUTES) return { state: "missed", local, lateMinutes: late };
  return { state: "due", local, lateMinutes: late };
};

/**
 * The local time this subscription will next speak, for display.
 *
 * A label, not a deadline -- which matters, because the arithmetic for "tomorrow"
 * in another timezone is a trip through DST and this does not attempt it. On the
 * two days a year a DST zone shifts, this label can be off by an hour; the actual
 * firing logic above reads the clock fresh every minute and is unaffected.
 */
export const nextRun = (sub, now = new Date(), verdict = scheduleState(sub, now)) => {
  const pending = verdict.state === "due";
  // "due" belongs to today even though the scheduled minute has passed -- the
  // next tick is what fires it. Reporting tomorrow here would contradict the
  // state sitting next to it in the same response.
  const today = verdict.state === "waiting" || pending;
  const date = today ? now : new Date(now.getTime() + 86_400_000);
  return {
    dateKey: localParts(date, sub.timezone).dateKey,
    time: hhmm(sub.hour, sub.minute),
    timezone: sub.timezone,
    pending,
  };
};

/* -------------------------------------------------------------------------- *
 * Message generation
 *
 * The prompt is the feature. Everything else here is scheduling.
 * -------------------------------------------------------------------------- */
export const DAILY_SYSTEM_PROMPT = `You write one short message a day for a single user. They did not ask you anything: produce the message itself, addressed to them, and nothing else.

- Three sentences at most. Shorter is better.
- Use your tools when the topic needs current information. Answer from what you know when it does not.
- If there is genuinely nothing worth saying today, say exactly that in one sentence. A one-line message is a good outcome, not a failure.
- Do not greet, do not sign off, do not describe what you are or what you are about to do.`;

const truncate = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * The prompt, assembled.
 *
 * Exported and pure because this string *is* the feature -- everything else in
 * this file is scheduling -- and a string you cannot read without calling a paid
 * API is a string nobody tests. Everything that varies about a daily message
 * varies here: the date, the zone, what was said before, whether the document
 * this subscription was pointed at is still loaded.
 *
 * That last part is the difference between a reminder and an assistant: a cron
 * job that sends the same sentence every morning is a notification, and a model
 * told what it said yesterday can either build on it or say there is nothing new.
 */
export const dailyPrompt = ({ sub, now = new Date(), history = [], docMissing = false }) => {
  const local = localParts(now, sub.timezone);
  const lines = [
    `It is ${hhmm(local.hour, local.minute)} on ${local.dateKey} (${sub.timezone}).`,
    `Write the user's daily message about: ${sub.topic}`,
  ];

  if (history.length === 1) {
    lines.push(
      `Your message on ${history[0].dateKey} said: "${truncate(history[0].text, 300)}"`,
      "Say something new, or say there is nothing new."
    );
  } else if (history.length > 1) {
    lines.push(
      "Your recent messages were:",
      ...history.map((message) => `${message.dateKey}: ${truncate(message.text, 200)}`),
      "Say something new, or say there is nothing new."
    );
  }

  if (docMissing) {
    lines.push(
      "You were given a document to follow, but it is no longer available. Do not mention it; just write.",
      "If the topic is about that document, say that the document is no longer loaded."
    );
  }

  return lines.join("\n");
};

const composeMessage = async (sub, now) => {
  // The document registry is in memory, so a restart loses it while the
  // subscription survives -- the two halves of this project have different
  // lifetimes now, and a subscription will eventually find its document gone.
  // Degrade by writing without it rather than throwing on a timer nobody watches.
  // The ownership test is repeated here, not only at creation: this runs with no
  // request and therefore no middleware in front of it.
  const stored = sub.docId ? getDocument(sub.docId) : null;
  const doc = stored && stored.ownerId === sub.clientId ? stored : null;
  const docMissing = Boolean(sub.docId) && !doc;

  const question = dailyPrompt({
    sub,
    now,
    history: recentMessagesFor(sub.id, HISTORY_IN_PROMPT),
    docMissing,
  });

  const { text, ...meta } = await runAgent(question, {
    vectorStore: doc?.vectorStore ?? null,
    systemPrompt: DAILY_SYSTEM_PROMPT,
  });

  return { text, meta: { ...meta, docMissing } };
};

/* -------------------------------------------------------------------------- *
 * The tick
 * -------------------------------------------------------------------------- */

/**
 * Stop waiting on a promise after a while.
 *
 * Promise.race, so the loser is not cancelled -- there is no way to cancel a
 * model call in flight -- it is only abandoned. That is the honest trade: a
 * generation that outlives its deadline is recorded as failed and its eventual
 * answer is dropped, because the alternative is a scheduler that stops
 * scheduling and never says so.
 */
const withDeadline = (promise, ms, label) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

/**
 * Generate one message for one subscription and file it in the inbox.
 *
 * The date is claimed before the first await and the claim is on disk before the
 * model is called, so the two ways this can fail are "no message" and "a message
 * that says why it failed" -- never two messages. Shared by the timer and by
 * POST /daily/:id/run, so a manual run cannot behave differently from an
 * automatic one: both consume today.
 */
export const deliver = async (sub, { now = new Date(), composer = composeMessage } = {}) => {
  const local = localParts(now, sub.timezone);
  sub.lastRunDate = local.dateKey;
  sub.lastOutcome = "generating";
  save();

  try {
    const { text, meta } = await withDeadline(
      composer(sub, now),
      GENERATE_TIMEOUT_MS,
      "generating the daily message"
    );
    const message = addMessage({
      subscriptionId: sub.id,
      clientId: sub.clientId,
      dateKey: local.dateKey,
      text,
      meta,
    });
    sub.lastRunAt = now.toISOString();
    sub.lastOutcome = "fired";
    save();
    return message;
  } catch (error) {
    sub.lastOutcome = `failed: ${error.message}`;
    save();
    throw error;
  }
};

/**
 * Check every subscription once, and speak for the ones whose time has come.
 *
 * `composer` is injectable so the scheduler can be driven without calling a paid
 * API -- the tests use it, and so does anyone wanting to see the firing decision
 * without paying for it.
 */
export const tick = async ({ now = new Date(), composer = composeMessage } = {}) => {
  // Two ticks in the same process, overlapping: the second would read state the
  // first is halfway through changing. Cheap to prevent, awkward to debug.
  if (running) return { skipped: "a tick is already running" };
  running = true;

  const report = {
    at: now.toISOString(),
    checked: 0,
    waiting: 0,
    settled: 0,
    fired: [],
    missed: [],
    failed: [],
  };

  try {
    for (const sub of state.subscriptions) {
      report.checked += 1;
      const verdict = scheduleState(sub, now);

      if (verdict.state === "waiting") {
        report.waiting += 1;
        continue;
      }
      if (verdict.state === "missed") {
        // Claim the date so that being late does not become being sent at 23:40.
        sub.lastRunDate = verdict.local.dateKey;
        sub.lastOutcome = `missed by ${verdict.lateMinutes} minutes`;
        report.missed.push({ id: sub.id, lateMinutes: verdict.lateMinutes });
        save();
        continue;
      }
      if (verdict.state === "disabled" || verdict.state === "done") {
        report.settled += 1;
        continue;
      }

      try {
        const message = await deliver(sub, { now, composer });
        report.fired.push({
          id: sub.id,
          messageId: message.id,
          chars: message.text.length,
          rounds: message.meta.rounds,
          webSearches: message.meta.webSearches,
        });
      } catch (error) {
        report.failed.push({ id: sub.id, error: error.message });
      }
    }
    return report;
  } finally {
    running = false;
  }
};

/**
 * Where the timer lives.
 *
 * In this process, so that `npm start` alone gives you a working daily assistant.
 * That is the right default for a course project and the wrong one for most
 * deployments, for a reason worth stating: any host that scales to zero (App
 * Runner, Cloud Run, Lambda, a sleeping free tier) runs no process while idle,
 * and a timer inside a process that does not exist never fires. The production
 * shape is an external scheduler -- EventBridge, a GitHub Action, plain cron --
 * calling POST /daily/tick, and the tick being idempotent is what makes it safe
 * to have both running at once.
 *
 * unref() so the interval never holds the event loop open on its own account:
 * importing this module in a script should not make the script hang.
 */
export const startScheduler = () => {
  if (timer) return timer;
  timer = setInterval(() => {
    tick()
      .then((report) => {
        if (report.fired?.length) {
          console.log(`[daily] sent ${report.fired.length} message(s)`);
        }
        if (report.failed?.length) {
          console.error(`[daily] ${report.failed.length} subscription(s) failed`);
        }
      })
      .catch((error) => console.error("[daily] tick failed:", error.message));
  }, TICK_INTERVAL_MS);
  timer.unref();
  return timer;
};

export const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/* -------------------------------------------------------------------------- *
 * Subscriptions and the inbox
 * -------------------------------------------------------------------------- */
export const createSubscription = ({ clientId, topic, hour, minute, timezone, docId }) => {
  const sub = {
    id: crypto.randomUUID(),
    clientId,
    topic,
    hour,
    minute,
    timezone,
    docId: docId ?? null,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunDate: null, // the local date it last spoke on, or null
    lastRunAt: null, // the instant, for display
    lastOutcome: "never run",
  };
  state.subscriptions.push(sub);
  save();
  return sub;
};

export const listSubscriptions = (clientId) =>
  state.subscriptions.filter((sub) => sub.clientId === clientId);

export const getSubscription = (id, clientId) => {
  const sub = state.subscriptions.find((item) => item.id === id);
  return sub && sub.clientId === clientId ? sub : undefined;
};

export const deleteSubscription = (id, clientId) => {
  const sub = getSubscription(id, clientId);
  if (!sub) return false;
  state.subscriptions = state.subscriptions.filter((item) => item.id !== id);
  // The messages it produced stay: they were delivered, and the inbox is a
  // record of what the user was told, not a view over the subscription.
  save();
  return true;
};

const addMessage = ({ subscriptionId, clientId, dateKey, text, meta }) => {
  const message = {
    id: crypto.randomUUID(),
    subscriptionId,
    clientId,
    dateKey,
    text,
    meta,
    read: false,
    createdAt: new Date().toISOString(),
  };
  state.messages.unshift(message); // newest first, so the inbox is already sorted
  trimInbox(clientId);
  save();
  return message;
};

export const listMessages = (clientId, { limit = 20 } = {}) =>
  state.messages
    .filter((message) => message.clientId === clientId)
    .slice(0, Math.max(0, limit));

export const markMessageRead = (id, clientId) => {
  const message = state.messages.find(
    (item) => item.id === id && item.clientId === clientId
  );
  if (!message) return false;
  message.read = true;
  save();
  return true;
};

/**
 * The last N messages this subscription sent, newest first.
 *
 * This is the whole of the assistant's memory, and it is stored as a by-product
 * of delivery rather than as a separate thing to keep in sync: the inbox is what
 * the user was told, which is exactly what the next message needs to know.
 */
const recentMessagesFor = (subscriptionId, limit) =>
  state.messages
    .filter((message) => message.subscriptionId === subscriptionId)
    .slice(0, Math.max(0, limit));

/** Keep each client's inbox bounded; a daily message is worthless at year three. */
const trimInbox = (clientId) => {
  const mine = state.messages.filter((message) => message.clientId === clientId);
  if (mine.length <= MAX_STORED_MESSAGES_PER_CLIENT) return;
  const doomed = new Set(
    mine.slice(MAX_STORED_MESSAGES_PER_CLIENT).map((message) => message.id)
  );
  state.messages = state.messages.filter((message) => !doomed.has(message.id));
};

/** Strip the fields a client has no business seeing, and add the schedule view. */
export const toPublicSubscription = (sub, now = new Date()) => {
  const verdict = scheduleState(sub, now);
  return {
    id: sub.id,
    topic: sub.topic,
    hour: sub.hour,
    minute: sub.minute,
    time: hhmm(sub.hour, sub.minute),
    timezone: sub.timezone,
    docId: sub.docId,
    enabled: sub.enabled,
    createdAt: sub.createdAt,
    state: verdict.state, // waiting | due | missed | done | disabled
    nextRun: nextRun(sub, now, verdict),
    lastRunDate: sub.lastRunDate,
    lastRunAt: sub.lastRunAt,
    lastOutcome: sub.lastOutcome,
  };
};

export const toPublicMessage = ({
  id,
  subscriptionId,
  dateKey,
  text,
  meta,
  read,
  createdAt,
}) => ({
  id,
  subscriptionId,
  dateKey,
  text,
  read,
  createdAt,
  // Kept because in this design the interesting output is still the sequence of
  // choices -- a daily message that silently stopped searching for news looks
  // exactly like one that had nothing to say.
  rounds: meta?.rounds ?? null,
  webSearches: meta?.webSearches ?? null,
  trace: meta?.trace ?? [],
  docMissing: meta?.docMissing ?? false,
});
