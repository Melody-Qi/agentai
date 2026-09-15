import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import MessageInbox from "./components/MessageInbox";
import {
  buildSubscriptionPayload,
  describeNextRun,
  stateMeta,
  toHourMinute,
} from "./dailyApi";

/**
 * The daily-message UI, tested where it does not need a server: the pure
 * translation layer between the form and POST /daily, and the inbox renderer.
 *
 * The App-level half (the bell, the unread count) lives in App.test.js, which
 * already carries the speak-tts mock that rendering <App /> requires.
 */

const message = {
  id: "m1",
  subscriptionId: "s1",
  dateKey: "2026-09-15",
  text: "Rust 1.92 is out. The new borrow checker diagnostics are the interesting part.",
  read: false,
  createdAt: "2026-09-15T00:00:05.000Z",
  rounds: 2,
  webSearches: 0,
  trace: [],
  docMissing: false,
};

/* ---- the form -> request translation ------------------------------------ */

test("toHourMinute accepts a dayjs-style object and a plain string", () => {
  // antd's TimePicker hands back a dayjs instance, not a string.
  expect(toHourMinute({ hour: () => 8, minute: () => 5 })).toEqual({ hour: 8, minute: 5 });
  expect(toHourMinute("08:05")).toEqual({ hour: 8, minute: 5 });
  // "8:5" is not what the backend accepts, and neither is a non-time.
  expect(toHourMinute("8:5")).toBeNull();
  expect(toHourMinute("")).toBeNull();
  expect(toHourMinute(undefined)).toBeNull();
  expect(toHourMinute("25:00")).toBeNull();
});

test("buildSubscriptionPayload trims the topic and refuses an empty one", () => {
  const ok = buildSubscriptionPayload({
    topic: "  Rust release news  ",
    time: "08:00",
    timezone: "Asia/Shanghai",
    attachDoc: false,
    docId: null,
  });
  expect(ok.error).toBeUndefined();
  expect(ok.payload).toEqual({
    topic: "Rust release news",
    hour: 8,
    minute: 0,
    timezone: "Asia/Shanghai",
    docId: null,
  });

  // Whitespace alone is not a topic -- the backend would accept the request and
  // then ask the model to write about nothing, every day, forever.
  expect(buildSubscriptionPayload({ topic: "   ", time: "08:00" }).error).toMatch(/tell you about/);
  expect(buildSubscriptionPayload({ topic: "x", time: null }).error).toMatch(/time of day/);
});

test("a document is attached only when the box is ticked and one is selected", () => {
  const withDoc = buildSubscriptionPayload({
    topic: "t",
    time: "09:30",
    timezone: "UTC",
    attachDoc: true,
    docId: "doc-1",
  });
  expect(withDoc.payload.docId).toBe("doc-1");

  // Ticked but no upload yet: send null rather than undefined, so "no document"
  // is stated out loud instead of leaning on a default.
  const noDoc = buildSubscriptionPayload({
    topic: "t",
    time: "09:30",
    timezone: "UTC",
    attachDoc: true,
    docId: null,
  });
  expect(noDoc.payload.docId).toBeNull();
});

test("describeNextRun spells out a run that is due but not yet fired", () => {
  expect(
    describeNextRun({ dateKey: "2026-09-16", time: "08:00", timezone: "UTC", pending: false })
  ).toBe("08:00 on 2026-09-16");
  // "due" belongs to today even though its minute has passed -- the next tick
  // is what fires it, so tomorrow would contradict the state next to it.
  expect(
    describeNextRun({ dateKey: "2026-09-15", time: "08:00", timezone: "UTC", pending: true })
  ).toMatch(/^due now/);
});

test("stateMeta names every state the scheduler can return", () => {
  expect(stateMeta("done").label).toMatch(/today/);
  expect(stateMeta("missed").color).toBe("red");
  // An unknown state from a newer backend must not blank the row out.
  expect(stateMeta("something-new").label).toBe("something-new");
});

/* ---- the inbox itself --------------------------------------------------- */

test("renders a delivered message with its date, text and unread marker", () => {
  render(<MessageInbox messages={[message]} onMarkRead={() => {}} />);

  expect(screen.getByText("2026-09-15")).toBeInTheDocument();
  expect(screen.getByText(/The new borrow checker diagnostics/)).toBeInTheDocument();
  expect(screen.getByText("new")).toBeInTheDocument();
});

test("shows the search trace, which is the only way to tell a quiet day from a broken one", () => {
  render(
    <MessageInbox
      messages={[{ ...message, webSearches: 2, rounds: 3 }]}
      onMarkRead={() => {}}
    />
  );

  expect(screen.getByText("2 web searches")).toBeInTheDocument();
  expect(screen.getByText("3 agent rounds")).toBeInTheDocument();
});

test("says so when the attached document had gone missing", () => {
  render(
    <MessageInbox messages={[{ ...message, docMissing: true }]} onMarkRead={() => {}} />
  );

  expect(screen.getByText(/document missing/i)).toBeInTheDocument();
});

test("clicking an unread message marks it read; clicking a read one does nothing", () => {
  const onMarkRead = jest.fn();
  render(
    <MessageInbox
      messages={[message, { ...message, id: "m2", read: true, text: "Second message" }]}
      onMarkRead={onMarkRead}
    />
  );

  fireEvent.click(screen.getByText("Second message"));
  expect(onMarkRead).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText(/The new borrow checker diagnostics/));
  expect(onMarkRead).toHaveBeenCalledTimes(1);
  expect(onMarkRead.mock.calls[0][0].id).toBe("m1");
});

test("an empty inbox says why it is empty", () => {
  render(<MessageInbox messages={[]} onMarkRead={() => {}} />);
  expect(screen.getByText(/a daily message lands here/i)).toBeInTheDocument();
});
