import axios from "axios";

/* ---------------------------------------------------------------------------
 * The HTTP contract of the daily assistant, in one file.
 *
 * Six routes, every one of them scoped by the x-client-id header -- the same
 * rule /chat and /upload follow. The header carries more weight here than
 * anywhere else in the app: the scheduler writes messages while no request is
 * in flight, so the inbox has to answer "whose messages?" with nobody logged
 * in to lean on (server/server.js L301-L407).
 *
 * Kept apart from the components so the URL shapes live in exactly one place
 * and the pure helpers below stay testable without a DOM.
 * ------------------------------------------------------------------------- */

const DOMAIN = "http://localhost:5001";

/**
 * There is no push channel: the backend cannot reach a browser tab, and that
 * absence is the reason the inbox exists at all.
 *
 * So the page polls. 60s is the trade-off -- fast enough that a message still
 * feels like it arrives on its own, slow enough that a tab left open all day
 * costs one request a minute. Change it here, not in a component.
 */
export const POLL_INTERVAL_MS = 60_000;

export const DEFAULT_MESSAGE_LIMIT = 20;

const authHeaders = (clientId) => ({ "x-client-id": clientId });

/**
 * A list endpoint that answers 200 with something that is not a list is a
 * contract violation, and it must not travel any further: the panels call
 * .map() on it during render, so a stray object would unmount the whole app
 * instead of showing a message. Failing here turns it into an ordinary error,
 * which the drawer already knows how to display.
 */
const asList = (value, what) => {
  if (!Array.isArray(value)) {
    throw new Error(`the server returned an unexpected ${what} response`);
  }
  return value;
};

/** GET /messages?limit= -> [message], newest first. */
export const fetchMessages = async (clientId, limit = DEFAULT_MESSAGE_LIMIT) => {
  const { data } = await axios.get(`${DOMAIN}/messages`, {
    headers: authHeaders(clientId),
    params: { limit },
  });
  return asList(data.messages, "messages");
};

/** GET /daily -> [subscription], each carrying its own `state` and `nextRun`. */
export const fetchSubscriptions = async (clientId) => {
  const { data } = await axios.get(`${DOMAIN}/daily`, {
    headers: authHeaders(clientId),
  });
  return asList(data.subscriptions, "subscriptions");
};

/** POST /daily -> 201 { subscription }. */
export const createSubscription = async (clientId, payload) => {
  const { data } = await axios.post(`${DOMAIN}/daily`, payload, {
    headers: authHeaders(clientId),
  });
  return data.subscription;
};

/** DELETE /daily/:id -> 204. Messages it already sent stay in the inbox. */
export const deleteSubscription = async (clientId, id) => {
  await axios.delete(`${DOMAIN}/daily/${id}`, {
    headers: authHeaders(clientId),
  });
};

/**
 * POST /daily/:id/run -> 201 { message }.
 *
 * Runs the very same code path the timer runs, which is why it can come back
 * 502: the schedule is fine, the thing that writes the message is not.
 */
export const runSubscriptionNow = async (clientId, id) => {
  const { data } = await axios.post(`${DOMAIN}/daily/${id}/run`, null, {
    headers: authHeaders(clientId),
  });
  return data.message;
};

/** POST /messages/:id/read -> 204. */
export const markMessageRead = async (clientId, id) => {
  await axios.post(`${DOMAIN}/messages/${id}/read`, null, {
    headers: authHeaders(clientId),
  });
};

/* ---------------------------------------------------------------------------
 * Display helpers -- pure, no HTTP.
 * ------------------------------------------------------------------------- */

/**
 * The five states scheduleState() can return (server/daily.js L283-L294), said
 * in the user's words rather than the scheduler's. `due` is worth spelling out:
 * it means "the minute has passed and the next tick will fire", which is not
 * the same as "it just sent" and not the same as "waiting".
 */
const STATE_META = {
  waiting: { color: "blue", label: "waiting" },
  due: { color: "gold", label: "sending on the next tick" },
  missed: { color: "red", label: "missed today" },
  done: { color: "green", label: "said today's" },
  disabled: { color: "default", label: "paused" },
};

export const stateMeta = (state) =>
  STATE_META[state] ?? { color: "default", label: state ?? "unknown" };

/**
 * `nextRun` is an object, not a timestamp: { dateKey, time, timezone, pending }
 * (server/daily.js L304-L317). Rendered as a label rather than a countdown
 * because that is all the backend promises -- on the two DST days a year this
 * label can be an hour out, while the firing logic reads the clock fresh every
 * minute and is unaffected.
 */
export const describeNextRun = (nextRun) => {
  if (!nextRun) return "not scheduled";
  const when = `${nextRun.time} on ${nextRun.dateKey}`;
  return nextRun.pending ? `due now (${when})` : when;
};

/**
 * The browser's own zone, used as the default so the common case needs no
 * decision. It is stored on the subscription rather than read at send time:
 * the process may well run in another timezone, and 08:00 has to keep meaning
 * 08:00 where the user is.
 */
export const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * antd's TimePicker hands back a dayjs object; a test or a caller may pass
 * "08:30". Both become { hour, minute }, and anything else becomes null.
 */
export const toHourMinute = (time) => {
  if (!time) return null;
  if (
    typeof time === "object" &&
    typeof time.hour === "function" &&
    typeof time.minute === "function"
  ) {
    return { hour: time.hour(), minute: time.minute() };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
};

/**
 * Form values -> the exact body POST /daily accepts.
 *
 * Returns { error } instead of throwing so the form can print the complaint
 * under the button. The backend repeats every one of these checks anyway
 * (server/server.js L304-L320): a client validates to be helpful, never to be
 * the place an invariant is enforced.
 */
export const buildSubscriptionPayload = ({ topic, time, timezone, attachDoc, docId }) => {
  const trimmed = String(topic ?? "").trim();
  if (!trimmed) return { error: "Say what it should tell you about." };
  if (trimmed.length > 200) return { error: "Keep the topic under 200 characters." };

  const hourMinute = toHourMinute(time);
  if (!hourMinute) return { error: "Pick a time of day." };

  return {
    payload: {
      topic: trimmed,
      hour: hourMinute.hour,
      minute: hourMinute.minute,
      timezone: timezone || browserTimezone(),
      // An explicit null, not a missing key: "no document" is a real choice
      // here, and saying it out loud reads better than relying on a default.
      docId: attachDoc && docId ? docId : null,
    },
  };
};
