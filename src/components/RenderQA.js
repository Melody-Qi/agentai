import React from "react";
import { Empty, Spin } from "antd";

const RenderQA = ({ conversation, isLoading }) => (
  <div className="qa-list" aria-live="polite">
    {conversation.length === 0 && !isLoading ? (
      <Empty description="Upload a PDF, then ask your first question" />
    ) : null}
    {conversation.map((each, index) => (
      <div key={`${each.question}-${index}`} className="qa-item">
        <div className="user-container"><div className="user-bubble">{each.question}</div></div>
        <div className="agent-container">
          <div className="answer-block">
            <div className="answer-label">RAG Answer (from document):</div>
            <div className="rag-answer">{each.answer.ragAnswer}</div>
          </div>
          <div className="answer-block">
            <div className="answer-label">MCP Answer (with web search):</div>
            <div className="mcp-answer">{each.answer.mcpAnswer}</div>
          </div>
        </div>
      </div>
    ))}
    {isLoading ? <Spin size="large" /> : null}
  </div>
);

export default RenderQA;
