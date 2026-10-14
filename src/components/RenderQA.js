import React, { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import { Spin, Tag } from "antd";

/**
 * Both answers come out of LLMs, and both answer in Markdown whether asked to or
 * not -- "**USPS**: 7 business days" reached the screen as literal asterisks
 * while the bubble rendered raw text.
 *
 * Guarded on string because not every answer is one: the error path in
 * ChatComponent can hand over a caught Error, and a Markdown parser handed an
 * object throws rather than rendering nothing.
 *
 * The `white-space: pre-wrap` already on these bubbles stays load-bearing.
 * remark keeps a soft line break as a real newline inside the text node, so a
 * single newline still breaks the line exactly as it did before this change --
 * dropping it here would silently join every wrapped line together.
 */
const AnswerBody = ({ children }) =>
  typeof children === "string" && children ? <Markdown>{children}</Markdown> : null;

const RAG_LABEL = "RAG Answer (from your documents):";
const MCP_LABEL = "MCP Answer (with web search):";

/**
 * The block that stands in for an answer that has not arrived yet.
 *
 * It carries the same heading as the finished block so nothing shifts when the
 * real text replaces it -- a placeholder that appeared and disappeared would
 * make the whole column jump twice per question.
 */
const PendingAnswer = ({ label, hint }) => (
  <div className="answer-block">
    <div className="answer-label">{label}</div>
    <div className="answer-pending">
      <Spin size="small" />
      <span>{hint}</span>
    </div>
  </div>
);

/**
 * A question and its answer no longer land together.
 *
 * `answer` is null from the moment the question is asked until the first half
 * comes back, and after that it is filled in one key at a time -- ragAnswer
 * first, mcpAnswer when the web search finishes. "Is this key present?" is
 * therefore the question that decides what this renders, not "is the answer
 * non-empty": an answer that is legitimately empty and one that has not been
 * asked for yet must look different.
 */
const RenderQA = ({ conversation, isLoading }) => {
  const listRef = useRef(null);

  // Keep the newest turn in view. Without this the second half of an answer
  // renders below the fold, because the input box is fixed to the bottom of the
  // window and the page does not move on its own. "nearest" scrolls only as far
  // as it has to, so a short answer that already fits is not yanked around.
  useEffect(() => {
    // Optional call on purpose: jsdom does not implement scrollIntoView, so an
    // unguarded one takes the test suite down. Scrolling is a nicety and must
    // never be the reason a screen fails to render.
    listRef.current?.lastElementChild?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
    });
  }, [conversation]);

  return (
    <div className="qa-list" ref={listRef} aria-live="polite">
      {conversation.length === 0 && !isLoading ? (
        // One quiet line rather than another big grey illustration: the screen
        // already has the uploader's call-to-action and the library's empty note.
        <p className="qa-empty">Your questions and the answers will appear here.</p>
      ) : null}
      {conversation.map((each) => {
        const answer = each.answer;
        return (
          <div key={each.id} className="qa-item">
            <div className="user-container">
              <div className="user-bubble">{each.question}</div>
            </div>
            <div className="agent-container">
              {answer?.ragAnswer !== undefined ? (
                <div className="answer-block">
                  <div className="answer-label">{RAG_LABEL}</div>
                  <div className="rag-answer">
                    <AnswerBody>{answer.ragAnswer}</AnswerBody>
                  </div>
                  {/* Which files the answer was actually read from. This is the
                      visible payoff of multi-document asking: without it,
                      "asked three PDFs" and "asked one PDF and hoped" look
                      exactly the same on screen. */}
                  {answer.sources?.length ? (
                    <div className="answer-sources">
                      <span className="sources-label">Read from:</span>
                      {answer.sources.map((source) => (
                        <Tag key={source} color="blue">
                          {source}
                        </Tag>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <PendingAnswer label={RAG_LABEL} hint="Reading your documents…" />
              )}

              {answer?.mcpAnswer !== undefined ? (
                <div className="answer-block">
                  <div className="answer-label">{MCP_LABEL}</div>
                  <div className="mcp-answer">
                    <AnswerBody>{answer.mcpAnswer}</AnswerBody>
                  </div>
                </div>
              ) : (
                <PendingAnswer label={MCP_LABEL} hint="Searching the web…" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default RenderQA;
