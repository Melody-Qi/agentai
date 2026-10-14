import axios from "axios";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initSpeech } from "./components/ChatComponent";
import App from "./App";

// The questions below are about what is on screen between two network calls, so
// the HTTP layer is stubbed: axios is mocked, and the tests decide when each
// request finishes.
jest.mock("axios");

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
  // Plural since multi-document upload: the dragger now takes several PDFs at
  // once, and the empty library says so in a line of text rather than a graphic.
  expect(screen.getByText(/click or drag pdf files/i)).toBeInTheDocument();
  expect(screen.getByText(/no documents yet/i)).toBeInTheDocument();
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

/* ---- a question lands before its answer ---------------------------------- */

// A promise whose settle switch is handed to the test body. The point of these
// two tests is the state of the screen *while* a request is in flight, which is
// invisible if the mock resolves on its own.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const HANDBOOK = [
  { docId: "doc-1", originalName: "handbook.pdf", pageCount: 3, chunkCount: 5, embedder: "local" },
];

// One /chat per leg now, so the mock has to tell them apart. `legs` in the
// request is recorded, because the order the two are asked in is part of the
// behaviour under test.
const armBackend = ({ documents = HANDBOOK } = {}) => {
  const rag = deferred();
  const mcp = deferred();
  const legsAsked = [];

  axios.get.mockImplementation((url, config) => {
    if (url.includes("/documents")) return Promise.resolve({ data: { documents } });
    if (url.includes("/chat")) {
      legsAsked.push(config.params.legs);
      return config.params.legs === "mcp" ? mcp.promise : rag.promise;
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  return { rag, mcp, legsAsked };
};

test("shows the question first, then each half of the answer as it arrives", async () => {
  const { rag, mcp, legsAsked } = armBackend();
  const { container } = render(<App />);

  // The box is disabled until GET /documents answers, so waiting for its
  // placeholder is also waiting for the document to be selected.
  const box = await screen.findByPlaceholderText(/ask across 1 document/i);
  fireEvent.change(box, { target: { value: "What is the return window?" } });
  await act(async () => {
    fireEvent.click(screen.getByText("Ask").closest("button"));
  });

  // Nothing has been answered and the question is already readable -- the
  // behaviour that did not exist while one setState carried both.
  expect(screen.getByText("What is the return window?")).toBeInTheDocument();
  expect(container.querySelectorAll(".answer-pending")).toHaveLength(2);
  expect(container.querySelector(".rag-answer")).toBeNull();

  await act(async () => {
    rag.resolve({
      data: { ragAnswer: "30 days from delivery.", sources: ["handbook.pdf"] },
    });
  });
  expect(screen.getByText("30 days from delivery.")).toBeInTheDocument();
  // Scoped to the answer: "handbook.pdf" is also the row in the library above,
  // and matching both would say nothing about where the tag is.
  expect(container.querySelector(".answer-sources")).toHaveTextContent("handbook.pdf");
  // One block filled, one still working: the two halves are no longer joined.
  expect(container.querySelectorAll(".answer-pending")).toHaveLength(1);
  expect(container.querySelector(".mcp-answer")).toBeNull();

  await act(async () => {
    mcp.resolve({ data: { mcpAnswer: "USPS allows 7 business days." } });
  });
  expect(screen.getByText(/USPS allows 7 business days/)).toBeInTheDocument();
  expect(container.querySelectorAll(".answer-pending")).toHaveLength(0);

  // One leg per request, in the order the two blocks are read.
  expect(legsAsked).toEqual(["rag", "mcp"]);
  await settle();
});

test("does not spend a web search when the documents cannot answer", async () => {
  const { rag, legsAsked } = armBackend();
  const { container } = render(<App />);

  const box = await screen.findByPlaceholderText(/ask across 1 document/i);
  fireEvent.change(box, { target: { value: "Summarise the warranty." } });
  await act(async () => {
    fireEvent.click(screen.getByText("Ask").closest("button"));
  });

  await act(async () => {
    rag.reject(
      Object.assign(new Error("request failed"), {
        response: { data: { error: "document not found" } },
      })
    );
  });

  expect(screen.getByText("document not found")).toBeInTheDocument();
  // One request, not two: asking the web about a question the documents could
  // not even read would spend a search unit on an answer with nothing beside it.
  expect(legsAsked).toEqual(["rag"]);
  // And no block is left spinning for an answer that will never come.
  expect(container.querySelectorAll(".answer-pending")).toHaveLength(0);
  await settle();
});
