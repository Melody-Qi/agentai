import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Layout, Typography, message } from "antd";
import { BellOutlined } from "@ant-design/icons";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import DocumentLibrary from "./components/DocumentLibrary";
import RenderQA from "./components/RenderQA";
import DailyPanel from "./components/DailyPanel";
import * as dailyApi from "./dailyApi";
import * as documentsApi from "./documentsApi";
import "./App.css";

const { Header, Content } = Layout;
const { Title } = Typography;
const CLIENT_KEY = "agentai-client-id";

// crypto.randomUUID() only exists in a secure context (https, or localhost).
// Opening the dev server through a LAN IP to demo it would otherwise crash on
// mount, and jsdom does not provide it either, so fall back to a random token.
// Both branches stay inside the backend's /^[A-Za-z0-9_-]{8,64}$/ rule.
function createClientId() {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `web_${uuid.replaceAll("-", "")}`;
}

// One place to turn any axios failure into something worth putting on screen.
// The backend answers every error with { error: "..." }, so that string is
// preferred over axios's own "Request failed with status code 502".
const errorText = (error) =>
  error?.response?.data?.error || error?.message || "Could not reach the server.";

function App() {
  const clientId = useMemo(() => {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved) return saved;
    const created = createClientId();
    localStorage.setItem(CLIENT_KEY, created);
    return created;
  }, []);
  // Every PDF this browser has indexed, and the subset the next question reads.
  // Two lists rather than one because they answer different questions: what
  // exists, and what is currently in play. Only the second one goes on the wire.
  //
  // A new upload is selected automatically -- having just dragged it in is a
  // strong statement of intent -- but it does NOT clear the conversation the way
  // the single-document version did. Adding a source no longer invalidates an
  // answer already given; switching TO and FROM a different set does, and that
  // is now the user's call rather than ours.
  const [documents, setDocuments] = useState([]);
  const [selectedDocIds, setSelectedDocIds] = useState([]);
  const [conversation, setConversation] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // The server is the record of what survived a reload. Its store is in memory,
  // so a backend restart legitimately returns an empty list -- which is why a
  // failure here is a console note and not an error banner: being unable to
  // remember old documents is not an obstacle to uploading new ones.
  useEffect(() => {
    let active = true;
    documentsApi
      .fetchDocuments(clientId)
      .then((existing) => {
        if (!active) return;
        setDocuments(existing);
        setSelectedDocIds((previous) => {
          const known = previous.filter((id) => existing.some((doc) => doc.docId === id));
          return known.length ? known : existing.map((doc) => doc.docId);
        });
      })
      .catch((error) => console.warn("Could not restore documents:", error.message));
    return () => {
      active = false;
    };
  }, [clientId]);

  // --- the daily assistant (HW5) ------------------------------------------
  // App stays the single state owner (lesson 47's rule): the bell's unread
  // count lives up here in the header while the list that produces it lives
  // down in the drawer, so this is shared state, not component state.
  const [messages, setMessages] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [dailyBusy, setDailyBusy] = useState(false);
  const [dailyError, setDailyError] = useState("");

  // Messages and subscriptions are refreshed together because they come from
  // one client id: a bell count that disagreed with the list right below it
  // would be worse than a stale one.
  const refreshDaily = useCallback(async () => {
    try {
      const [nextMessages, nextSubscriptions] = await Promise.all([
        dailyApi.fetchMessages(clientId),
        dailyApi.fetchSubscriptions(clientId),
      ]);
      setMessages(nextMessages);
      setSubscriptions(nextSubscriptions);
      setDailyError("");
    } catch (error) {
      setDailyError(errorText(error));
    }
  }, [clientId]);

  useEffect(() => {
    refreshDaily();
    const timer = setInterval(refreshDaily, dailyApi.POLL_INTERVAL_MS);
    // Browsers throttle timers in a background tab, so the moment the tab
    // regains focus is exactly when the poll is most out of date. This is the
    // cheap half of a push channel.
    window.addEventListener("focus", refreshDaily);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshDaily);
    };
  }, [refreshDaily]);

  // Every mutating action ends in the same place: refresh. The server owns the
  // schedule, so predicting what it now looks like is a losing game -- the next
  // run is computed from the clock in the subscription's timezone, not the
  // browser's. Returns false on failure so a form knows not to clear itself.
  const runDailyAction = useCallback(
    async (action) => {
      setDailyBusy(true);
      try {
        await action();
        await refreshDaily();
        setDailyError("");
        return true;
      } catch (error) {
        setDailyError(errorText(error));
        return false;
      } finally {
        setDailyBusy(false);
      }
    },
    [refreshDaily]
  );

  const handleCreateSubscription = (payload) =>
    runDailyAction(() => dailyApi.createSubscription(clientId, payload));

  const handleDeleteSubscription = (id) =>
    runDailyAction(() => dailyApi.deleteSubscription(clientId, id));

  const handleRunNow = (id) =>
    runDailyAction(() => dailyApi.runSubscriptionNow(clientId, id));

  // Marking one read is the single action that does NOT refetch: it flips a
  // boolean the client already holds, and a round trip to be told "true" would
  // be pure waste. The optimistic write is safe because the endpoint is
  // idempotent, and it is rolled back if the request fails.
  const handleMarkRead = async (message) => {
    const setRead = (value) =>
      setMessages((previous) =>
        previous.map((item) => (item.id === message.id ? { ...item, read: value } : item))
      );

    setRead(true);
    try {
      await dailyApi.markMessageRead(clientId, message.id);
    } catch (error) {
      setDailyError(errorText(error));
      setRead(false);
    }
  };

  const unreadCount = useMemo(
    () => messages.filter((message) => !message.read).length,
    [messages]
  );

  // The daily assistant (HW5) still schedules one question against one source, and
  // widening it is a different feature. It follows the first selected document --
  // predictable, and shown on the panel -- rather than guessing, refusing to run,
  // or silently reading everything.
  const primaryDocId = selectedDocIds[0] ?? null;
  const primaryDocumentName =
    documents.find((doc) => doc.docId === primaryDocId)?.originalName ?? "";

  const handleUploadSuccess = (documentInfo) => {
    setDocuments((previous) =>
      previous.some((doc) => doc.docId === documentInfo.docId)
        ? previous
        : [...previous, documentInfo]
    );
    setSelectedDocIds((previous) =>
      previous.includes(documentInfo.docId)
        ? previous
        : [...previous, documentInfo.docId]
    );
  };

  const handleToggleDocument = (docId, selected) => {
    setSelectedDocIds((previous) =>
      selected
        ? previous.includes(docId)
          ? previous
          : [...previous, docId]
        : previous.filter((id) => id !== docId)
    );
  };

  // Removed from both lists together, and only after the server agrees. Doing it
  // the other way round would leave a selected docId with no document behind it,
  // and the failure mode there is nastier than a slow row: the next question asks
  // for something that no longer exists and gets a 404 that reads like a bug.
  const handleDeleteDocument = async (doc) => {
    try {
      await documentsApi.deleteDocument(clientId, doc.docId);
      setDocuments((previous) => previous.filter((item) => item.docId !== doc.docId));
      setSelectedDocIds((previous) => previous.filter((id) => id !== doc.docId));
    } catch (error) {
      message.error(errorText(error));
    }
  };

  // One question used to reach the screen together with its answer, because both
  // went into `conversation` in the same setState -- and the answer is not ready
  // until the slowest half (a web search, up to 45s) is done. Splitting it in two
  // is what lets the question appear the instant it is asked.
  //
  // Patching by id, not by index: `conversation` is rebuilt on every update, so
  // an index captured before an answer arrived can point at a different question
  // by the time it lands. The counter lives in a ref because it only has to be
  // unique inside this tab -- and being a ref, bumping it does not re-render.
  const askCounter = useRef(0);

  const startQuestion = useCallback((question) => {
    const id = `ask-${Date.now()}-${askCounter.current++}`;
    // answer: null is the "asked, nothing back yet" state. It is deliberately
    // not {} -- a missing object and an empty object have to be different things
    // downstream, because only the first one means "still working".
    setConversation((previous) => [...previous, { id, question, answer: null }]);
    return id;
  }, []);

  // Merged into whatever is already there, which is what lets one answer arrive
  // in two pieces: the RAG request fills ragAnswer, the MCP request that follows
  // fills mcpAnswer, and neither overwrites the other.
  const updateAnswer = useCallback((id, patch) => {
    setConversation((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, answer: { ...(item.answer ?? {}), ...patch } } : item
      )
    );
  }, []);

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <Title level={2}>Agent AI</Title>
        {/* The entry point. A bell that stays quiet is also information: it
            means the scheduled question was asked and had nothing to add. */}
        <span className="daily-bell">
          <Badge count={unreadCount} size="small" offset={[-2, 6]}>
            <Button
              shape="circle"
              icon={<BellOutlined />}
              onClick={() => setDailyOpen(true)}
              aria-label="Daily messages"
            />
          </Badge>
        </span>
      </Header>
      <Content className="app-content">
        <section className="upload-section">
          <PdfUploader clientId={clientId} onUploadSuccess={handleUploadSuccess} />
          <DocumentLibrary
            documents={documents}
            selectedDocIds={selectedDocIds}
            onToggle={handleToggleDocument}
            onDelete={handleDeleteDocument}
          />
        </section>
        <RenderQA conversation={conversation} isLoading={isLoading} />
      </Content>
      <ChatComponent
        clientId={clientId}
        docIds={selectedDocIds}
        onAskStart={startQuestion}
        onAnswerPart={updateAnswer}
        isLoading={isLoading}
        setIsLoading={setIsLoading}
      />
      <DailyPanel
        open={dailyOpen}
        onClose={() => setDailyOpen(false)}
        docId={primaryDocId}
        documentName={primaryDocumentName}
        subscriptions={subscriptions}
        messages={messages}
        busy={dailyBusy}
        error={dailyError}
        onCreate={handleCreateSubscription}
        onDelete={handleDeleteSubscription}
        onRunNow={handleRunNow}
        onMarkRead={handleMarkRead}
        onRefresh={refreshDaily}
      />
    </Layout>
  );
}

export default App;
