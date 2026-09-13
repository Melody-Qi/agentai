import React, { useMemo, useState } from "react";
import { Layout, Tag, Typography } from "antd";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
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
      <Header className="app-header"><Title level={2}>Agent AI</Title></Header>
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
    </Layout>
  );
}

export default App;
