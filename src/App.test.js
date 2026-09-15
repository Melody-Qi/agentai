import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initSpeech } from "./components/ChatComponent";
import App from "./App";

// A stand-in for speak-tts that reproduces the behaviour the real library has and
// that the slides' code does not survive: init({ voice }) rejects when that voice
// is not installed, and setVoice() is the *first* config call inside init(), so a
// rejected init also leaves volume/rate/pitch unapplied.
jest.mock("speak-tts", () => {
  const calls = [];
  class FakeSpeech {
    constructor() {
      this.speak = jest.fn(() => Promise.resolve());
      calls.push(this);
    }

    init(conf = {}) {
      if (conf.voice) {
        return Promise.reject(
          "Error setting voice. The voice you passed is not valid or the voices have not been loaded yet."
        );
      }
      return Promise.resolve({ voices: [], voice: null, browserSupport: true });
    }
  }
  FakeSpeech.calls = calls;
  return { __esModule: true, default: FakeSpeech };
});

// HW5's daily-message layer fetches on mount and then once a minute, so rendering
// <App /> now reaches the network. No test in this file is about the network, so
// the HTTP half is stubbed and the pure helpers are kept exactly as they are --
// a mock that also faked toHourMinute() would hide bugs in the form.
jest.mock("./dailyApi", () => ({
  ...jest.requireActual("./dailyApi"),
  fetchMessages: jest.fn(() => Promise.resolve([])),
  fetchSubscriptions: jest.fn(() => Promise.resolve([])),
  createSubscription: jest.fn(() => Promise.resolve({})),
  deleteSubscription: jest.fn(() => Promise.resolve()),
  runSubscriptionNow: jest.fn(() => Promise.resolve({})),
  markMessageRead: jest.fn(() => Promise.resolve()),
}));

const FakeSpeech = require("speak-tts").default;
const dailyApi = require("./dailyApi");

/**
 * Rendering <App /> starts two async chains that finish after the test body
 * returns (the daily fetch, and lesson 48's speech init), and React warns when
 * their setState lands outside act(). One flush of the microtask queue inside
 * act() lets both settle.
 */
const settle = () => act(async () => {});

const delivered = {
  id: "m-daily-1",
  subscriptionId: "s-1",
  dateKey: "2026-09-15",
  text: "Rust 1.92 is out, and the new borrow checker diagnostics are the interesting part.",
  read: false,
  createdAt: "2026-09-15T00:00:05.000Z",
  rounds: 2,
  webSearches: 1,
  trace: [],
  docMissing: false,
};

beforeEach(() => {
  // CRA's Jest config sets `resetMocks: true`, so by the time a test body runs
  // every jest.fn() in the mocks above has already lost its implementation.
  // Two consequences worth remembering: a mock must be re-armed here, and an
  // un-armed one returns undefined -- which Promise.all happily turns into an
  // undefined list, and `undefined.map` then takes the whole App down.
  dailyApi.fetchMessages.mockResolvedValue([]);
  dailyApi.fetchSubscriptions.mockResolvedValue([]);
});

// Note: antd v6 injects CSS that jsdom's selector engine cannot always parse, so
// queries that need getComputedStyle (getByRole with an accessible `name`, or
// byLabelText) are avoided below -- setupTests.js stubs the worst of it, but
// getByText is both simpler and closer to what the user sees. Real browsers
// render this tree fine; this is a test environment limitation.
test("renders the Agent AI shell", async () => {
  render(<App />);
  expect(screen.getByText("Agent AI")).toBeInTheDocument();
  expect(screen.getByText(/click or drag a pdf file/i)).toBeInTheDocument();
  expect(screen.getByText(/upload a pdf, then ask/i)).toBeInTheDocument();
  await settle();
});

test("falls back to a fresh instance when the preferred voice is missing", async () => {
  FakeSpeech.calls.length = 0;

  const { instance } = await initSpeech();

  // Two instances: the one that asked for "Google US English" and failed, then
  // the fallback. Reusing the first would keep a half-configured object, because
  // setVoice() threw before volume/rate/pitch were applied.
  expect(FakeSpeech.calls).toHaveLength(2);
  expect(instance).toBe(FakeSpeech.calls[1]);
  expect(instance.speak).toBeDefined();
});

test("disables the voice controls until a document is selected", async () => {
  render(<App />);

  // App starts with docId === null, so both lesson 48 controls must be inert:
  // asking /chat about a document that has not been uploaded can only 404.
  // getByText lands on antd's inner <span>, so walk up to the real <button>.
  expect(screen.getByText(/chat mode/i).closest("button")).toBeDisabled();
  // The record button only exists inside Chat Mode.
  expect(screen.queryByText(/click to record/i)).not.toBeInTheDocument();
  await settle();
});

/* ---- the daily-message entry point (HW5) -------------------------------- */

test("the bell counts only the messages that have not been read", async () => {
  dailyApi.fetchMessages.mockResolvedValue([
    delivered,
    { ...delivered, id: "m-daily-0", read: true, text: "Yesterday's message." },
  ]);

  const { container } = render(<App />);

  // Two messages, one read: the badge is the app's only way of saying "something
  // arrived while you were not looking", and it must not count what you have
  // already seen. Queried through the class because of the jsdom note above.
  await waitFor(() => {
    expect(container.querySelector(".daily-bell .ant-badge-count")).toHaveTextContent("1");
  });
  await settle();
});

test("the bell opens the inbox, and clicking a message marks it read", async () => {
  dailyApi.fetchMessages.mockResolvedValue([delivered]);

  const { container } = render(<App />);

  // Nothing is fetched into a hidden drawer: before the bell is clicked there is
  // no inbox on screen at all, which is what makes the bell the entry point.
  await waitFor(() => expect(dailyApi.fetchMessages).toHaveBeenCalled());
  expect(screen.queryByText(/new borrow checker diagnostics/)).not.toBeInTheDocument();

  fireEvent.click(container.querySelector(".daily-bell button"));

  // The message the scheduler wrote with nobody watching is now readable, and
  // so is the trace that explains how it was produced.
  expect(await screen.findByText(/new borrow checker diagnostics/)).toBeInTheDocument();
  expect(screen.getByText("1 web search")).toBeInTheDocument();

  fireEvent.click(screen.getByText(/new borrow checker diagnostics/));
  await waitFor(() => expect(dailyApi.markMessageRead).toHaveBeenCalled());
  // Identity first: an inbox that leaked another client's message id would be
  // the whole multi-tenant story failing, so the arguments are checked too.
  expect(dailyApi.markMessageRead.mock.calls[0][1]).toBe("m-daily-1");
  await settle();
});
