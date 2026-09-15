import React, { useState } from "react";
import {
  Button,
  Checkbox,
  Divider,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Tag,
  TimePicker,
  Typography,
} from "antd";
import { DeleteOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import {
  browserTimezone,
  buildSubscriptionPayload,
  describeNextRun,
  stateMeta,
} from "../dailyApi";

const { Text } = Typography;

// The browser's own zone first, since that is the answer for almost everyone,
// then a few zones the user actually travels between. Duplicates are dropped so
// a user already in Shanghai does not see the city twice.
const TIMEZONE_OPTIONS = Array.from(
  new Set([
    browserTimezone(),
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Europe/London",
    "America/New_York",
    "America/Los_Angeles",
    "UTC",
  ])
).map((zone) => ({ value: zone, label: zone }));

/**
 * The control half of the daily assistant: create a subscription, see when each
 * one next speaks, fire one by hand, delete one.
 *
 * All the state that matters lives in App (the single owner, as in lesson 47);
 * this component keeps only the form's draft values, because a half-typed topic
 * is nobody else's business.
 *
 * The timezone is a form field rather than a constant read from the browser at
 * send time: the subscription is stored with the zone the user chose, so 08:00
 * keeps meaning 08:00 where they are even if the server runs elsewhere.
 *
 * Counting the TimePicker as one control is a trap worth naming: in antd v6 its
 * value is committed when the panel *closes*, not when a cell is clicked --
 * rc-picker 1.12 routes a bare cell click through `panel-intermediate` and only
 * flushes on `popupClose`, which is why the panel keeps an explicit OK button
 * and why the form still holds null until the panel goes away.
 */
const DailySubscriptions = ({
  docId,
  documentName,
  subscriptions,
  busy,
  onCreate,
  onDelete,
  onRunNow,
}) => {
  const [form] = Form.useForm();
  const [formError, setFormError] = useState("");

  const submit = async (values) => {
    const { error, payload } = buildSubscriptionPayload({
      topic: values.topic,
      time: values.time,
      timezone: values.timezone,
      attachDoc: values.attachDoc,
      docId,
    });
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    const created = await onCreate(payload);
    // Clear only the topic. Adding a second topic at the same hour is the common
    // case, so throwing away the time and the timezone would just make the user
    // pick them again.
    if (created) form.resetFields(["topic"]);
  };

  return (
    <section className="daily-section">
      {/* v6.6 reads `orientation` as the *direction* (horizontal/vertical) and
          moved the label position to `titlePlacement`. */}
      <Divider titlePlacement="left">New daily message</Divider>

      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        disabled={busy}
        initialValues={{
          time: null,
          timezone: browserTimezone(),
          attachDoc: false,
        }}
      >
        <Form.Item name="topic" label="What should it tell you about?">
          <Input placeholder="e.g. Rust release news" maxLength={200} showCount />
        </Form.Item>

        <div className="daily-form-row">
          <Form.Item name="time" label="Every day at" className="daily-form-time">
            <TimePicker format="HH:mm" minuteStep={5} />
          </Form.Item>
          <Form.Item name="timezone" label="Timezone" className="daily-form-zone">
            <Select options={TIMEZONE_OPTIONS} showSearch />
          </Form.Item>
        </div>

        <Form.Item name="attachDoc" valuePropName="checked">
          <Checkbox disabled={!docId}>
            Attach the selected document
            {docId && documentName ? ` (${documentName})` : ""}
          </Checkbox>
        </Form.Item>

        {formError ? (
          <Text type="danger" className="daily-form-error" role="alert">
            {formError}
          </Text>
        ) : null}

        <Form.Item>
          <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={busy}>
            Add
          </Button>
        </Form.Item>
      </Form>

      <Divider titlePlacement="left">Scheduled ({subscriptions.length})</Divider>

      {subscriptions.length === 0 ? <Empty description="Nothing scheduled yet" /> : null}

      {subscriptions.map((sub) => {
        const meta = stateMeta(sub.state);
        return (
          <div className="sub-item" key={sub.id}>
            <div className="sub-body">
              <div className="sub-head">
                <Text strong>{sub.topic}</Text>
                <Tag color={meta.color}>{meta.label}</Tag>
              </div>
              <Text type="secondary" className="sub-line">
                {sub.time} in {sub.timezone} &middot; next: {describeNextRun(sub.nextRun)}
              </Text>
              <Text type="secondary" className="sub-line">
                {sub.docId ? "with a document attached · " : ""}
                last run: {sub.lastOutcome ?? "never"}
              </Text>
            </div>

            <div className="sub-actions">
              <Popconfirm
                title="Send one now?"
                // Honest about the side effect: a manual run consumes today, so
                // the scheduled time will not produce a second message. "One
                // message per day" is the invariant (server.js L378-L382).
                description="This uses up today's slot, so the scheduled time will not send another one."
                okText="Send now"
                onConfirm={() => onRunNow(sub.id)}
              >
                <Button size="small" icon={<PlayCircleOutlined />} disabled={busy}>
                  Run now
                </Button>
              </Popconfirm>
              <Popconfirm
                title="Delete this daily message?"
                description="Messages it already delivered stay in the inbox."
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDelete(sub.id)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} disabled={busy} />
              </Popconfirm>
            </div>
          </div>
        );
      })}
    </section>
  );
};

export default DailySubscriptions;
