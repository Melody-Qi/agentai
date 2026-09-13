import React, { useState } from "react";
import axios from "axios";
import { Input, message } from "antd";

const { Search } = Input;
const DOMAIN = "http://localhost:5001";

const ChatComponent = ({ clientId, docId, handleResp, isLoading, setIsLoading }) => {
  const [searchValue, setSearchValue] = useState("");

  const onSearch = async (question) => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;
    if (!docId) {
      message.warning("Please upload and select a PDF first.");
      return;
    }

    setSearchValue("");
    setIsLoading(true);
    try {
      const response = await axios.get(`${DOMAIN}/chat`, {
        headers: { "x-client-id": clientId },
        params: { docId, question: trimmedQuestion },
      });
      handleResp(trimmedQuestion, response.data);
    } catch (error) {
      const answer = {
        ragAnswer: error.response?.data?.error || error.message || "Request failed",
        mcpAnswer: "N/A",
      };
      handleResp(trimmedQuestion, answer);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="chat-component">
      <Search
        placeholder={docId ? "Ask a question about the selected PDF" : "Upload a PDF before asking"}
        enterButton="Ask"
        size="large"
        onSearch={onSearch}
        loading={isLoading}
        value={searchValue}
        onChange={(event) => setSearchValue(event.target.value)}
        disabled={!docId}
      />
    </div>
  );
};

export default ChatComponent;
