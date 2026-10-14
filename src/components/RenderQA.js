import React from "react";
import Markdown from "react-markdown";
import { Empty, Spin, Tag } from "antd";

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

const RenderQA = ({ conversation, isLoading }) => (
  <div className="qa-list" aria-live="polite">
    {conversation.length === 0 && !isLoading ? (
      <Empty description="Upload one or more PDFs, then ask your first question" />
    ) : null}
    {conversation.map((each, index) => (
      <div key={`${each.question}-${index}`} className="qa-item">
        <div className="user-container"><div className="user-bubble">{each.question}</div></div>
        <div className="agent-container">
          <div className="answer-block">
            <div className="answer-label">RAG Answer (from your documents):</div>
            <div className="rag-answer"><AnswerBody>{each.answer.ragAnswer}</AnswerBody></div>
            {/* Which files the answer was actually read from. This is the visible
                payoff of multi-document asking: without it, "asked three PDFs" and
                "asked one PDF and hoped" look exactly the same on screen. */}
            {each.answer.sources?.length ? (
              <div className="answer-sources">
                <span className="sources-label">Read from:</span>
                {each.answer.sources.map((source) => (
                  <Tag key={source} color="blue">{source}</Tag>
                ))}
              </div>
            ) : null}
          </div>
          <div className="answer-block">
            <div className="answer-label">MCP Answer (with web search):</div>
            <div className="mcp-answer"><AnswerBody>{each.answer.mcpAnswer}</AnswerBody></div>
          </div>
        </div>
      </div>
    ))}
    {isLoading ? <Spin size="large" /> : null}
  </div>
);

export default RenderQA;
