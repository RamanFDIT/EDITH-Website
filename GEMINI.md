# GEMINI.md - Project Overview: E.D.I.T.H. Core

## 🤖 Project Description
**E.D.I.T.H.** (Even Dead I'm The Hero) is a sophisticated local AI assistant and tactical interface designed for developer productivity. It functions as a multi-user, tool-augmented agent capable of managing development workflows (GitHub, Jira, Figma), communication (Slack, Gmail), and system operations.

---

## 🏗️ Architecture Summary

### 1. **Backend (Express + Node.js)**
- **Entry Point:** `server.js`
- **Core Logic:** `agent.js` (LangChain/LangGraph)
- **Authentication:** Firebase Auth integration via `authMiddleware`.
- **Real-time Communication:** Uses **Server-Sent Events (SSE)** for streaming AI responses and token-by-token generation.
- **Dynamic Multi-tenancy:** `envConfig.js` and `store.js` dynamically inject user-specific OAuth tokens (stored in Firestore) into the environment at runtime, ensuring secure, isolated tool access for different users.

### 2. **AI Engine (The "Traffic Cop" Pattern)**
E.D.I.T.H. uses a semantic routing architecture in `agent.js`:
1. **Classification:** A "Classifier LLM" or keyword-based logic determines user intent (e.g., "Jira", "GitHub", "System").
2. **Routing:** Based on intent, the request is routed to a specialized React Agent equipped *only* with the relevant tools. This improves accuracy and reduces token overhead.
3. **Execution:** LangGraph manages the stateful execution of these agents.

### 3. **Tool Integrations**
Modular JS files in the root directory handle external API interactions:
- `jiraTool.js`: Project and issue management.
- `githubTool.js`: Repository, PR, and issue tracking.
- `figmaTool.js`: File structure scanning and commenting.
- `slackTool.js` / `gmailTool.js`: Communication.
- `calendarTool.js`: Google Calendar events.
- `audioTool.js` / `imageTool.js`: Multi-modal capabilities.

### 4. **Frontend (React + Vite)**
- **Location:** `/frontend`
- **Styling:** Tailwind CSS + Vanilla CSS Modules.
- **State Management:** React Context (Auth, NavBar).
- **Communication:** `api.js` service handles requests to the Express backend, including SSE streaming and file uploads.
- **Key Pages:** 
  - `Home`: Main chat interface.
  - `ConnectionPage`: OAuth management for external services.
  - `Onboarding`: Initial setup flow.
  - `Settings`: User profile and configuration.

---

## 🛠️ Key Technical Patterns
- **Per-Request Env Injection:** Tools do not use static `.env` keys for user data. Instead, `loadUserTokensIntoEnv` fetches tokens from Firestore based on the authenticated UID.
- **SSE Streaming:** The `/api/ask` endpoint streams `data: { chunk: "..." }` to provide a responsive UI.
- **Modular Tooling:** Each tool is a standalone module, making it easy to add new integrations without modifying core agent logic.

---

## 🚀 Development Workflow
- **Root:** Backend and AI logic (`npm run dev` to start `server.js`).
- **Frontend Folder:** React UI (`npm run dev` inside `/frontend`).
- **Environment:** Requires a `.env` file for core AI (Gemini) and Firebase configuration.
