import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Layout, Tag, Typography } from "antd";
import { BellOutlined } from "@ant-design/icons";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import DailyPanel from "./components/DailyPanel";
import * as dailyApi from "./dailyApi";
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
  const [docId, setDocId] = useState(null);
  const [documentName, setDocumentName] = useState("");
  const [conversation, setConversation] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

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

  const handleUploadSuccess = (documentInfo) => {
    setDocId(documentInfo.docId);
    setDocumentName(documentInfo.originalName);
    setConversation([]);
  };

  const handleResp = (question, answer) => {
    setConversation((previous) => [...previous, { question, answer }]);
  };

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
          {documentName ? <Tag color="blue">Current document: {documentName}</Tag> : null}
        </section>
        <RenderQA conversation={conversation} isLoading={isLoading} />
      </Content>
      <ChatComponent
        clientId={clientId}
        docId={docId}
        handleResp={handleResp}
        isLoading={isLoading}
        setIsLoading={setIsLoading}
      />
      <DailyPanel
        open={dailyOpen}
        onClose={() => setDailyOpen(false)}
        docId={docId}
        documentName={documentName}
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
