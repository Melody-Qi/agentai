// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Ant Design reads these browser APIs while mounting its responsive and overlay
// components. jsdom implements neither, so without the stubs every test that
// renders an antd component fails before it reaches its assertions.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// antd v6's Form schedules part of its work through MessageChannel -- see
// @rc-component/form/lib/hooks/useNotifyWatch.js, whose whole implementation is
//
//   const channel = new MessageChannel();
//   channel.port1.onmessage = fn;
//   channel.port2.postMessage(null);
//
// i.e. "run fn in a macrotask". jsdom has no MessageChannel, so mounting any
// <Form> throws `ReferenceError: MessageChannel is not defined`, React 19
// aggregates it, and the whole tree is unmounted -- in a test that looks like an
// empty document and a mysterious AggregateError, not like a Form problem.
//
// Node does define a global MessageChannel, but borrowing it would not do: the
// worker_threads ports above are never closed, so each one stays ref'd and Jest
// hangs after the last test. A stand-in that only has to behave like a macrotask
// is both smaller and safer than the real thing.
if (typeof window.MessageChannel === "undefined") {
  class MessageChannelStub {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: () => {
          setTimeout(() => this.port1.onmessage && this.port1.onmessage({ data: null }), 0);
        },
      };
    }
  }
  window.MessageChannel = MessageChannelStub;
  global.MessageChannel = MessageChannelStub;
}

// jsdom cannot always walk the stylesheets antd injects at runtime: its selector
// engine (nwsapi) dies on the `::-webkit-scrollbar` rules and throws
// `Failed to execute 'contains' on 'Node': parameter 1 is not of type 'Node'`.
// antd calls getComputedStyle from a *layout effect* while measuring the
// scrollbar (Drawer -> useScrollLocker -> getTargetScrollBarSize), so the throw
// unmounts the whole tree and the test sees an empty document.
//
// Falling back to an empty declaration puts the caller on its own "no computed
// value" branch, which is the same branch a headless browser takes -- nothing in
// the app reads a computed colour or width in jsdom.
//
// The pseudo-element short-circuit is not an optimisation. jsdom answers a
// pseudo-element query by emitting a `jsdomError` on its virtual console *and
// then* throwing, so catching the throw still prints
// `Error: Not implemented: window.computedStyle(elt, pseudoElt)` on every run.
// Skipping the call is the only way to keep the suite quiet; no assertion in
// this app depends on a pseudo-element's computed style.
const realGetComputedStyle = window.getComputedStyle.bind(window);
const EMPTY_COMPUTED_STYLE = { getPropertyValue: () => "", width: "", height: "" };
window.getComputedStyle = (element, pseudoElement) => {
  if (pseudoElement) return EMPTY_COMPUTED_STYLE;
  try {
    return realGetComputedStyle(element, pseudoElement);
  } catch {
    return EMPTY_COMPUTED_STYLE;
  }
};

// react-speech-recognition (lesson 48) ships pre-compiled code whose module body
// calls regeneratorRuntime.mark(...). The webpack build injects that runtime into
// node_modules through babel-preset-react-app's polyfill plugins, but Jest skips
// node_modules entirely (transformIgnorePatterns), so the global is missing and
// the suite dies at import time with "regeneratorRuntime is not defined".
// regenerator-runtime is already in the tree as a react-app-polyfill dependency.
import "regenerator-runtime/runtime";
