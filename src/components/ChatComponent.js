import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Button, Input, message } from "antd";
import { AudioOutlined } from "@ant-design/icons";
import SpeechRecognition, { useSpeechRecognition } from "react-speech-recognition";
import Speech from "speak-tts";

const { Search } = Input;
// Deployment: set REACT_APP_API_DOMAIN to the App Runner URL at build time.
// Defaults to the local Express server so local dev is unchanged.
const DOMAIN = process.env.REACT_APP_API_DOMAIN || "http://localhost:5001";

// speak-tts options, as in the lecture. `voice` is deliberately NOT part of this
// base object -- see initSpeech() below for why it gets special treatment.
const SPEECH_CONFIG = {
  volume: 1,
  lang: "en-US",
  rate: 1,
  pitch: 1,
  splitSentences: false,
};
const PREFERRED_VOICE = "Google US English";

// speak-tts's init({ voice }) throws when that voice is not installed, and the
// throw happens inside init()'s own .then(), so init() rejects and the caller
// never gets an instance. "Google US English" ships with desktop Chrome but not
// with Edge or Firefox, and init() applies volume/rate/pitch only *after*
// setVoice(), so a rejected init is also a half-configured instance.
// Retry once with a fresh instance and the browser's default voice: without this
// the Chat Mode toggle would turn on while talk() had nothing to speak with.
// Returns the *initialised* instance together with the voice report, so the
// caller can store the very object it will later call speak() on.
// Exported (alongside the default export) so it can be unit-tested without a
// browser: this is the one branch lesson 48 adds that a working machine never
// exercises.
export const initSpeech = async () => {
  const preferred = new Speech();
  try {
    const info = await preferred.init({ ...SPEECH_CONFIG, voice: PREFERRED_VOICE });
    return { instance: preferred, info };
  } catch (error) {
    console.warn(`Voice "${PREFERRED_VOICE}" is unavailable, using the browser default.`, error);
    const fallback = new Speech();
    const info = await fallback.init(SPEECH_CONFIG);
    return { instance: fallback, info };
  }
};

const ChatComponent = ({
  clientId,
  docIds,
  onAskStart, // appends the question to the conversation, returns its id
  onAnswerPart, // merges one finished half of the answer into that question
  isLoading,
  setIsLoading,
}) => {
  const [searchValue, setSearchValue] = useState("");
  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speech, setSpeech] = useState();

  // The documents in play for the next question. Plural since multi-document:
  // these are the ones the user ticked in the library, and the question is asked
  // across all of them at once rather than against whichever one arrived last.
  const selectedCount = docIds?.length ?? 0;

  const {
    transcript,
    listening,
    resetTranscript,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
  } = useSpeechRecognition();

  // The resolved promise lives in a ref so React 19's StrictMode double-mount
  // (effect -> cleanup -> effect) reuses ONE Speech instance instead of building a
  // second one and leaking the first.
  //
  // The two guards below do different jobs and must not be collapsed into one:
  // the ref guards *creation*, while `active` is per-effect-run and guards the
  // setState. A single `cancelled` flag would be flipped by the first cleanup and
  // never restored, so the resolved promise would be dropped on the floor --
  // speech would stay undefined, Chat Mode would still turn on, and answering
  // would silently never speak. That is invisible in the UI and only shows up in
  // a real browser, so it is worth keeping the two flags apart.
  const speechPromise = useRef(null);

  useEffect(() => {
    if (!speechPromise.current) {
      speechPromise.current = initSpeech();
    }

    let active = true;
    speechPromise.current
      .then(({ instance, info }) => {
        // The "data" object contains the list of available voices and the voice synthesis params
        if (!active) return;
        console.log("Speech is ready, voices are available", info);
        setSpeech(instance);
      })
      .catch((e) => {
        if (!active) return;
        console.error("An error occured while initializing : ", e);
      });

    return () => {
      active = false;
    };
  }, []);

  const talk = (what2say) => {
    // speech is undefined while init is still pending, when the browser has no
    // speechSynthesis at all, or when init failed twice. Guarding here is what
    // keeps Chat Mode from turning a missing voice into a TypeError.
    if (!speech || !what2say) return;

    speech
      .speak({
        text: what2say,
        queue: false, // current speech will be interrupted,
        listeners: {
          onstart: () => {
            console.log("Start utterance");
          },
          onend: () => {
            console.log("End utterance");
          },
          onresume: () => {
            console.log("Resume utterance");
          },
          onboundary: (event) => {
            console.log(
              event.name +
                " boundary reached after " +
                event.elapsedTime +
                " milliseconds."
            );
          },
        },
      })
      .then(() => {
        // if everything went well, start listening again
        console.log("Success !");
        userStartConvo();
      })
      .catch((e) => {
        console.error("An error occured :", e);
      });
  };

  const userStartConvo = () => {
    SpeechRecognition.startListening().catch((error) => {
      console.error("Could not start listening:", error);
      setIsRecording(false);
    });
    setIsRecording(true);
    resetTranscript();
  };

  const chatModeClickHandler = () => {
    if (!browserSupportsSpeechRecognition) {
      message.warning(
        "This browser does not support speech recognition. Try desktop Chrome or Edge."
      );
      return;
    }
    setIsChatModeOn(!isChatModeOn);
    setIsRecording(false);
    SpeechRecognition.stopListening();
    resetTranscript();
  };

  const recordingClickHandler = () => {
    if (isRecording) {
      setIsRecording(false);
      SpeechRecognition.stopListening();
      resetTranscript();
    } else {
      setIsRecording(true);
      SpeechRecognition.startListening().catch((error) => {
        console.error("Could not start listening:", error);
        setIsRecording(false);
      });
    }
  };

  const onSearch = async (question) => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;
    if (!selectedCount) {
      message.warning("Select at least one document in your knowledge base first.");
      return;
    }

    setSearchValue("");
    setIsLoading(true);
    // On screen before either answer exists -- this is the whole point of asking
    // in two steps.
    const askId = onAskStart(trimmedQuestion);

    // Shared by both requests. docId is comma-separated: the server splits it
    // back into a list and searches each one separately. A single id still
    // works -- it is simply a list of one.
    const sharedParams = { docId: docIds.join(","), question: trimmedQuestion };

    try {
      // Leg 1: the answer from the user's own documents. Fires first and lands
      // first, so it is on screen while the web search is still running.
      const ragResponse = await axios.get(`${DOMAIN}/chat`, {
        headers: { "x-client-id": clientId },
        params: { ...sharedParams, legs: "rag" },
      });
      onAnswerPart(askId, {
        ragAnswer: ragResponse.data.ragAnswer,
        sources: ragResponse.data.sources,
      });
      if (isChatModeOn) {
        talk(ragResponse.data?.ragAnswer);
      }

      try {
        // Leg 2: the same question, answered from the open web. Awaited after the
        // first leg rather than Promise.all'd with it -- the two calls share one
        // model rate limit, and a 429 that could belong to either is a 429 that
        // cannot be attributed.
        const mcpResponse = await axios.get(`${DOMAIN}/chat`, {
          headers: { "x-client-id": clientId },
          params: { ...sharedParams, legs: "mcp" },
        });
        onAnswerPart(askId, { mcpAnswer: mcpResponse.data.mcpAnswer });
      } catch (webError) {
        // Half an answer beats none: the RAG block is already readable, so this
        // only has to stop the second block from spinning forever.
        onAnswerPart(askId, {
          mcpAnswer: webError.response?.data?.error || webError.message || "Request failed",
        });
      }
    } catch (error) {
      // The RAG leg failed, and there is no second leg without it: asking the web
      // about a question the documents could not even read would spend a search
      // unit on an answer with nothing to stand next to it.
      onAnswerPart(askId, {
        ragAnswer: error.response?.data?.error || error.message || "Request failed",
        mcpAnswer: "N/A",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Recognition ends on its own after a pause (and when stopListening() is
  // called). Turn the finished microphone input into a question, and clear the
  // recording flag even when nothing was heard -- otherwise the button would sit
  // on "Recording..." forever after a silent attempt.
  //
  // `wasListening` distinguishes "recognition ended" from "recognition has not
  // started yet": both look like `listening === false`, but only the first one
  // should end the recording. Without it, any render that happens between
  // setIsRecording(true) and the library flipping `listening` to true would be
  // mistaken for a finished, silent attempt and reset the button immediately.
  const wasListening = useRef(false);

  useEffect(() => {
    if (listening) {
      wasListening.current = true;
      return;
    }
    if (!wasListening.current) return;
    wasListening.current = false;

    if (transcript) {
      (async () => await onSearch(transcript))();
    }
    setIsRecording(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, transcript]);

  const handleChange = (e) => {
    // Update searchValue state when the user types in the input box
    setSearchValue(e.target.value);
  };

  return (
    <div className="chat-component">
      <div className="chat-controls">
        {!isChatModeOn && (
          <Search
            placeholder={
              selectedCount
                ? `Ask across ${selectedCount} document${selectedCount === 1 ? "" : "s"}`
                : "Select at least one document before asking"
            }
            enterButton="Ask"
            size="large"
            onSearch={onSearch}
            loading={isLoading}
            value={searchValue} // Control the value
            onChange={handleChange} // Update the value when changed
            disabled={!selectedCount}
          />
        )}
        <Button
          type="primary"
          size="large"
          danger={isChatModeOn}
          onClick={chatModeClickHandler}
          disabled={!selectedCount}
          style={{ marginLeft: "5px" }}
        >
          Chat Mode: {isChatModeOn ? "On" : "Off"}
        </Button>
        {isChatModeOn && (
          <Button
            type="primary"
            size="large"
            icon={<AudioOutlined />}
            danger={isRecording}
            onClick={recordingClickHandler}
            style={{ marginLeft: "5px" }}
          >
            {isRecording ? "Recording..." : "Click to record"}
          </Button>
        )}
      </div>
      {isChatModeOn && !isMicrophoneAvailable ? (
        <p className="chat-hint">
          Microphone access is required. Allow it in the browser address bar, then click
          &ldquo;Click to record&rdquo;.
        </p>
      ) : null}
    </div>
  );
};

export default ChatComponent;
