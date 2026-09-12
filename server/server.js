import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import chat from "./chat.js";

dotenv.config(); // load .env into process.env before anything reads it

const app = express();
app.use(cors()); // allow the React dev server (5173/3000) to call port 5001

// multer: where the uploaded file goes and what it is called
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

const PORT = 5001;
// NOTE (course compromise): a module-level variable shared by every request.
// Two users uploading different PDFs will overwrite each other's path.
// Production: return a fileId/sessionId on upload and scope it per user.
let filePath;

// POST /upload -> stores the PDF on disk and remembers its path
app.post("/upload", upload.single("file"), (req, res) => {
  filePath = req.file.path;
  res.send(filePath + " upload successfully.");
});

// GET /chat?question=... -> runs the RAG pipeline over the last uploaded PDF
app.get("/chat", async (req, res) => {
  const resp = await chat(filePath, req.query.question);
  res.send({
    ragAnswer: resp.text,
    mcpAnswer: "N/A", // placeholder, wired up in the next lesson
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
