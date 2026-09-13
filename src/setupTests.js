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

// react-speech-recognition (lesson 48) ships pre-compiled code whose module body
// calls regeneratorRuntime.mark(...). The webpack build injects that runtime into
// node_modules through babel-preset-react-app's polyfill plugins, but Jest skips
// node_modules entirely (transformIgnorePatterns), so the global is missing and
// the suite dies at import time with "regeneratorRuntime is not defined".
// regenerator-runtime is already in the tree as a react-app-polyfill dependency.
import "regenerator-runtime/runtime";


