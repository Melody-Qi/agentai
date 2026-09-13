// Note: antd v6 injects CSS that jsdom's style engine cannot parse, so any
// query that needs getComputedStyle (getByRole with an accessible `name`, or
// byLabelText) throws inside jsdom. getByText does not, so the assertions below
// stay on text content. Real browsers render this tree fine — this is a test
// environment limitation, not an application bug.
import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders the Agent AI shell", () => {
  render(<App />);
  expect(screen.getByText("Agent AI")).toBeInTheDocument();
  expect(screen.getByText(/click or drag a pdf file/i)).toBeInTheDocument();
  expect(screen.getByText(/upload a pdf, then ask/i)).toBeInTheDocument();
});
