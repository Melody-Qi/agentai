import React from "react";
import { Empty, Tag, Typography } from "antd";

const { Paragraph, Text } = Typography;

/**
 * The inbox: what the assistant said while nobody was looking.
 *
 * This is the half of HW5 that needs a UI. A daily message has no request to
 * answer and no response body to land in, so every message arrives here and
 * waits to be read (backend: GET /messages, server/server.js L394-L399).
 *
 * `read` is the only UI state a message carries, and it is deliberately kept
 * apart from the message itself: "I have seen this" is a fact about the reader,
 * not about what was said. Marking one read never touches its text.
 *
 * Rendered as plain elements rather than antd's List: in v6.6 List is deprecated
 * in favour of Listy, a *virtualised* list that measures each row with a
 * ResizeObserver. Every row here is styled by hand anyway, so the wrapper bought
 * nothing and the replacement would measure 0 in jsdom and render no rows at all.
 */
const MessageInbox = ({ messages, onMarkRead }) => (
  <div className="message-inbox">
    {messages.length === 0 ? (
      <Empty description="Nothing yet. A daily message lands here when its time comes." />
    ) : null}

    {messages.map((message) => (
      <div
        key={message.id}
        className={message.read ? "inbox-item" : "inbox-item inbox-item-unread"}
        // Clicking anywhere on the card marks it read; nothing else in the row
        // is interactive, so there is no button to miss.
        onClick={() => {
          if (!message.read) onMarkRead(message);
        }}
        style={{ cursor: message.read ? "default" : "pointer" }}
      >
        <div className="inbox-head">
          <Text strong>{message.dateKey}</Text>
          <Text type="secondary">
            arrived {new Date(message.createdAt).toLocaleTimeString()}
          </Text>
          {message.read ? null : <Tag color="red">new</Tag>}
        </div>

        <Paragraph className="inbox-text">{message.text}</Paragraph>

        {/* The trace is shown because a daily message that quietly stopped
            searching looks identical to one that had nothing to say. These two
            tags are the difference. */}
        <div className="inbox-meta">
          {message.docMissing ? (
            <Tag color="orange">document missing &mdash; answered without it</Tag>
          ) : null}
          {message.rounds === null ? null : (
            <Tag>
              {message.rounds} agent round{message.rounds === 1 ? "" : "s"}
            </Tag>
          )}
          {message.webSearches ? (
            <Tag color="green">
              {message.webSearches} web search{message.webSearches === 1 ? "" : "es"}
            </Tag>
          ) : null}
        </div>
      </div>
    ))}
  </div>
);

export default MessageInbox;
