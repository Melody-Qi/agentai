import { render, screen } from "@testing-library/react";
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

const FakeSpeech = require("speak-tts").default;

// Note: antd v6 injects CSS that jsdom's style engine cannot parse, so any query
// that needs getComputedStyle (getByRole with an accessible `name`, or
// byLabelText) throws inside jsdom. getByText does not, so the assertions below
// stay on text content. Real browsers render this tree fine — this is a test
// environment limitation, not an application bug.
test("renders the Agent AI shell", () => {
  render(<App />);
  expect(screen.getByText("Agent AI")).toBeInTheDocument();
  expect(screen.getByText(/click or drag a pdf file/i)).toBeInTheDocument();
  expect(screen.getByText(/upload a pdf, then ask/i)).toBeInTheDocument();
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

test("disables the voice controls until a document is selected", () => {
  render(<App />);

  // App starts with docId === null, so both lesson 48 controls must be inert:
  // asking /chat about a document that has not been uploaded can only 404.
  // getByText lands on antd's inner <span>, so walk up to the real <button>.
  expect(screen.getByText(/chat mode/i).closest("button")).toBeDisabled();
  // The record button only exists inside Chat Mode.
  expect(screen.queryByText(/click to record/i)).not.toBeInTheDocument();
});
