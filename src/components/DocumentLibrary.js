import React from "react";
import { Button, Checkbox, Empty, Tag, Tooltip } from "antd";
import { DeleteOutlined } from "@ant-design/icons";

/**
 * The knowledge library: every PDF this browser has uploaded, and which of them
 * the next question should read from.
 *
 * Selection being plural is the whole point. With one document, "which PDF is
 * this question about" was answered by whichever was uploaded last; with three,
 * guessing wrong is a silent failure -- you get a fluent answer drawn from the
 * wrong source and nothing tells you.
 */
/**
 * "1 page" rather than "1 pages". Every card metadata pass has the same problem
 * because the naive form is `${count} ${word}s`; counts of one are common here
 * (a one-page PDF is one chunk) and it is the first thing anyone reads.
 */
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const DocumentLibrary = ({ documents, selectedDocIds, onToggle, onDelete }) => {
  if (!documents.length) {
    return (
      <Empty
        className="library-empty"
        description="No documents yet. Upload one or more PDFs, then pick which ones each question reads from."
      />
    );
  }

  const allSelected = selectedDocIds.length === documents.length;

  const toggleAll = () => {
    // Absolute, not per-document: onToggle sets membership (true = add,
    // false = remove), so each row has to be told the same destination.
    // Deriving it per row instead -- `allSelected && !selected.includes(doc)` --
    // reads like it should work and silently does the opposite: with A ticked and
    // B,C not, it sends false for A and true for B,C, which is an invert, not a
    // select-all. The button label says "Select all"; it must never untick A.
    const select = !allSelected;
    documents.forEach((doc) => onToggle(doc.docId, select));
  };

  return (
    <div className="document-library">
      <div className="library-header">
        <strong>Knowledge base</strong>
        <span className="library-count">
          {documents.length} document{documents.length === 1 ? "" : "s"} ·{" "}
          {selectedDocIds.length} selected
        </span>
        <Button
          type="link"
          size="small"
          onClick={toggleAll}
        >
          {allSelected ? "Deselect all" : "Select all"}
        </Button>
      </div>

      {documents.map((doc) => (
        <div
          key={doc.docId}
          className={
            selectedDocIds.includes(doc.docId) ? "library-row is-selected" : "library-row"
          }
        >
          <Checkbox
            checked={selectedDocIds.includes(doc.docId)}
            onChange={(event) => onToggle(doc.docId, event.target.checked)}
          >
            <span className="library-name">{doc.originalName}</span>
          </Checkbox>

          <span className="library-meta">
            <Tag>{plural(doc.pageCount, "page")}</Tag>
            <Tag>{plural(doc.chunkCount, "chunk")}</Tag>
            {/* Not cosmetic. "local" is the lexical fallback: retrieval matches
                words, not meaning, so a user who thinks they are getting semantic
                search is better told here than left to deduce it from an answer
                that missed the obvious synonym. */}
            {doc.embedder === "local" ? (
              <Tooltip title="No paid embedding key is configured, so this document is matched by keyword instead of by meaning. Answers will be more literal.">
                <Tag color="orange">keyword matching</Tag>
              </Tooltip>
            ) : (
              <Tag color="green">{doc.embedder}</Tag>
            )}
          </span>

          <Tooltip title="Remove this document">
            <Button
              danger
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => onDelete(doc)}
              aria-label={`Delete ${doc.originalName}`}
            />
          </Tooltip>
        </div>
      ))}
    </div>
  );
};

export default DocumentLibrary;
