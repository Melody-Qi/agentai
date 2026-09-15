import React from "react";
import { Alert, Button, Drawer, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import DailySubscriptions from "./DailySubscriptions";
import MessageInbox from "./MessageInbox";

const { Text, Title } = Typography;

/**
 * The drawer behind the header bell: the app's single entry point to everything
 * the daily assistant produces.
 *
 * A drawer rather than a section on the page, for one reason: the feature's
 * whole premise is that messages arrive *while you are not looking*. A block
 * that is always on screen cannot express "something new appeared"; a bell with
 * a count can. The inbox itself is the honest substitute for a push
 * notification -- the backend has no way to ring a browser, so the bell rings on
 * behalf of the last poll.
 *
 * Purely presentational: it owns no data, and every action is a callback into
 * App, which stays the single state owner (lesson 47's rule).
 */
const DailyPanel = ({
  open,
  onClose,
  docId,
  documentName,
  subscriptions,
  messages,
  busy,
  error,
  onCreate,
  onDelete,
  onRunNow,
  onMarkRead,
  onRefresh,
}) => (
  <Drawer
    title="Daily messages"
    placement="right"
    // v6.6 renamed this prop: `width`/`height` are deprecated in favour of
    // `size`, which takes a number or 'default' | 'large'.
    size={520}
    open={open}
    onClose={onClose}
    extra={
      <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} disabled={busy}>
        Check now
      </Button>
    }
  >
    <Text type="secondary" className="daily-hint">
      The page checks for new messages once a minute &mdash; there is no push channel. Everything
      the assistant said while the tab was closed is waiting in the inbox below.
    </Text>

    {error ? (
      <Alert type="warning" showIcon message={error} className="daily-alert" />
    ) : null}

    <Title level={5} className="daily-heading">
      Inbox
    </Title>
    <MessageInbox messages={messages} onMarkRead={onMarkRead} />

    <DailySubscriptions
      docId={docId}
      documentName={documentName}
      subscriptions={subscriptions}
      busy={busy}
      onCreate={onCreate}
      onDelete={onDelete}
      onRunNow={onRunNow}
    />
  </Drawer>
);

export default DailyPanel;
