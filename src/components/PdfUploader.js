import React from "react";
import axios from "axios";
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";

const { Dragger } = Upload;
const DOMAIN = "http://localhost:5001";

const PdfUploader = ({ clientId, onUploadSuccess }) => {
  const uploadToBackend = async (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return axios.post(`${DOMAIN}/upload`, formData, {
      headers: { "x-client-id": clientId },
    });
  };

  const uploadProps = {
    name: "file",
    multiple: false,
    accept: ".pdf,application/pdf",
    showUploadList: true,
    customRequest: async ({ file, onSuccess, onError }) => {
      try {
        const response = await uploadToBackend(file);
        if (response.status >= 200 && response.status < 300) {
          onUploadSuccess(response.data);
          onSuccess(response.data);
        } else {
          onError(new Error("Upload failed"));
        }
      } catch (error) {
        onError(error);
      }
    },
    onChange(info) {
      const { status } = info.file;
      if (status === "done") message.success(`${info.file.name} uploaded successfully.`);
      if (status === "error") message.error(`${info.file.name} upload failed.`);
    },
  };

  return (
    <Dragger {...uploadProps}>
      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
      <p className="ant-upload-text">Click or drag a PDF file to this area to upload</p>
      <p className="ant-upload-hint">The uploaded PDF becomes the knowledge source for your questions.</p>
    </Dragger>
  );
};

export default PdfUploader;
