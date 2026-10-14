import React from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";

const { Dragger } = Upload;
// Deployment: set REACT_APP_API_DOMAIN to the App Runner URL at build time.
// Defaults to the local Express server so local dev is unchanged.
const DOMAIN = process.env.REACT_APP_API_DOMAIN || "http://localhost:5001";

// A drag-and-drop of a whole folder becomes sixty embedding jobs before anyone
// has read a word of it, and the cost is invisible at the moment it is spent:
// every PDF turns into ~1 request plus one embedding call per chunk, billed per
// thousand tokens. The cap is deliberately small so that the consequence of a
// careless selection is a warning, not an invoice.
const MAX_FILES_PER_BATCH = 5;

// Same extraction App.js does, repeated rather than shared: this file has no
// business importing App's internals for six lines, and the backend answers every
// failure with { error: "..." }, which is far more useful than axios's own
// "Request failed with status code 502".
const serverMessage = (error) =>
  error?.response?.data?.error || error?.message || "Upload failed.";

const PdfUploader = ({ clientId, onUploadSuccess, disabled }) => {
  const uploadToBackend = async (file) => {
    const formData = new FormData();
    formData.append("file", file);
    // Still one file per request, even now that several can be selected. The
    // backend tags each arrival with its own docId and builds its own index, so
    // a batch upload would only buy one round trip while costing every file its
    // individual progress: with five PDFs and a failure on the third, one request
    // would have to fail five legitimate documents to report it.
    return axios.post(`${DOMAIN}/upload`, formData, {
      headers: { "x-client-id": clientId },
    });
  };

  const uploadProps = {
    name: "file",
    multiple: true,
    accept: ".pdf,application/pdf",
    showUploadList: true,
    disabled,
    // Runs once per selected file, before any request. Returning LIST_IGNORE
    // drops just that file -- the rest of the batch still goes through, which is
    // what makes "one non-PDF in the folder" a skipped file rather than a
    // cancelled batch.
    beforeUpload: (file, batchFiles) => {
      if (batchFiles.length > MAX_FILES_PER_BATCH) {
        message.warning(
          `Upload at most ${MAX_FILES_PER_BATCH} PDFs at a time. Each one is split, embedded and indexed, so batches this large are slow and expensive.`
        );
        return Upload.LIST_IGNORE;
      }
      // accept= only filters what the picker OFFERS; anything can still be
      // dragged in, and the backend's PDF parser is not forgiving.
      const looksPdf =
        file.type === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf");
      if (!looksPdf) {
        message.warning(`${file.name} is not a PDF and was skipped.`);
        return Upload.LIST_IGNORE;
      }
      return true;
    },
    customRequest: async ({ file, onSuccess, onError }) => {
      try {
        const response = await uploadToBackend(file);
        if (response.status >= 200 && response.status < 300) {
          // App first: it owns the document list, and the antd entry is marked
          // done only once the rest of the UI already knows about this docId.
          onUploadSuccess(response.data);
          onSuccess(response.data);
        } else {
          onError(new Error("Upload failed"));
        }
      } catch (error) {
        const detail = serverMessage(error);
        message.error(`${file.name}: ${detail}`);
        onError(error);
      }
    },
    // Fired per file, not per batch -- five PDFs produce five callbacks, each
    // named, so a partial failure reads as partial rather than as a red box.
    onChange(info) {
      const { status, name } = info.file;
      if (status === "done") message.success(`${name} uploaded successfully.`);
    },
  };

  return (
    <Dragger {...uploadProps}>
      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
      <p className="ant-upload-text">Click or drag PDF files to this area to upload</p>
      <p className="ant-upload-hint">
        Select up to {MAX_FILES_PER_BATCH} at a time. Every uploaded PDF becomes part of
        your knowledge source, and you choose which ones each question reads from.
      </p>
    </Dragger>
  );
};

export default PdfUploader;
