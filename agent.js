import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
// import { ChatOllama } from "@langchain/ollama";
import fs from 'fs';
import path from 'path';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableWithMessageHistory, RunnableSequence, RunnableLambda } from "@langchain/core/runnables";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import "./envConfig.js";

// Import ALL GitHub functions
import { 
  getRepoIssues, createRepoIssue, 
  listCommits, listPullRequests, 
  getPullRequest, getCommit, createRepository,
  getRepoChecks
} from "./githubTool.js";
import { getJiraIssues, createJiraIssue, updateJiraIssue, deleteJiraIssue, createJiraProject } from "./jiraTool.js";
import { EDITH_SYSTEM_PROMPT, getSystemPrompt } from "./systemPrompt.js";
import { getSystemStatus, executeSystemCommand, openApplication } from "./systemTool.js";
import { getFigmaFileStructure, getFigmaComments, postFigmaComment } from "./figmaTool.js";
import { transcribeAudio, generateSpeech } from "./audioTool.js";
import { getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, findFreeTime } from "./calendarTool.js";
import { readFile, readTextFile, readWordDocument, readPdfDocument, listDirectory, getLatestFile } from "./fileTool.js";
import { sendSlackMessage, sendSlackAnnouncement, sendSlackLink } from "./slackTool.js";
import { generateImage } from "./imageTool.js";


const googleApiKey = process.env.GOOGLE_API_KEY;
if (!googleApiKey) throw new Error("GOOGLE_API_KEY not found.");

// --- MAIN LLM (for agent execution) ---
const llm = new ChatGoogleGenerativeAI({
  apiKey: googleApiKey,
  model: "gemini-3-flash-preview", 
});

// --- CLASSIFIER LLM (small, fast model for intent classification) ---
const classifierLlm = new ChatGoogleGenerativeAI({
  apiKey: googleApiKey,
  model: "gemini-2.0-flash-lite",  // Fast, lightweight model for classification
  temperature: 0, // Deterministic
});

console.log(" E.D.I.T.H. Online (Gemini 3 Flash) - Semantic Classification Enabled.");

// =============================================================================
// TOOL DEFINITIONS BY CATEGORY
// =============================================================================

// --- JIRA READ TOOLS ---
const jiraReadTools = [
  new DynamicStructuredTool({
    name: "search_jira_issues",
    description: "Search Jira issues using JQL. For FASTER searches, include the project key in the JQL (e.g., 'project = FDIT'). If user doesn't specify a project/space, ASK them which project to search in - do NOT search all projects blindly. Example JQL: 'project = FDIT AND status = Open'.",
    schema: z.object({
      jql: z.string().describe("REQUIRED: The JQL query string. Should include 'project = KEY' for faster results. ASK user for project key if not provided."),
    }),
    func: getJiraIssues,
  }),
];

// --- JIRA WRITE TOOLS ---
const jiraWriteTools = [
  new DynamicStructuredTool({
    name: "create_jira_issue",
    description: "Create a Jira ticket. REQUIRES 'projectKey'. If user doesn't specify which project/space, ASK them - do NOT guess or retry.",
    schema: z.object({
      projectKey: z.string().describe("REQUIRED: Project Key (e.g., 'FDIT'). ASK the user if not provided."),
      summary: z.string().describe("REQUIRED: Ticket title"),
      description: z.string().optional(),
      issueType: z.string().optional(),
    }),
    func: createJiraIssue,
  }),
  new DynamicStructuredTool({
    name: "update_jira_issue",
    description: "Update a Jira ticket's fields. REQUIRES 'issueKey' (e.g., 'FDIT-12'). If user doesn't specify the ticket key, ASK them - do NOT guess or retry. Supports: Status, Priority, Summary, Description, Assignee, Due Date, Labels, and Parent. Do NOT change the summary unless explicitly asked.",
    schema: z.object({
      issueKey: z.string().describe("REQUIRED: The ticket key (e.g., 'FDIT-12'). ASK the user if not provided."),
      summary: z.string().optional().describe("New title for the ticket."),
      description: z.string().optional().describe("New description text."),
      status: z.string().optional().describe("Target status to move to (e.g., 'In Progress', 'Done')."),
      priority: z.string().optional().describe("Target priority. MUST be one of: 'Highest', 'High', 'Medium', 'Low', 'Lowest'."),
      assignee: z.string().optional().describe("Account ID of the user to assign to."),
      duedate: z.string().optional().describe("Due date in 'YYYY-MM-DD' format."),
      labels: z.array(z.string()).optional().describe("Array of label strings."),
      parent: z.string().optional().describe("Key of the parent issue (e.g. for subtasks)."),
    }),
    func: updateJiraIssue,
  }),
  new DynamicStructuredTool({
    name: "delete_jira_issue",
    description: "Delete a Jira ticket by its key. REQUIRES 'issueKey' (e.g., 'FDIT-123'). If user doesn't specify the ticket key, ASK them - do NOT guess or retry.",
    schema: z.object({
        issueKey: z.string().describe("REQUIRED: The ticket key to delete (e.g., 'FDIT-123'). ASK the user if not provided."),
    }),
    func: deleteJiraIssue,
  }),
  new DynamicStructuredTool({
    name: "create_jira_project",
    description: "Create a new Jira Project (sometimes referred to as a Space). REQUIRES ADMIN RIGHTS. REQUIRES 'key' and 'name'. If user doesn't specify project key or name, ASK them - do NOT guess or retry.",
    schema: z.object({
        key: z.string().describe("REQUIRED: The Project Key (e.g., 'NEWPROJ'). Must be unique and uppercase. ASK user if not provided."),
        name: z.string().describe("REQUIRED: The name of the project. ASK user if not provided."),
        description: z.string().optional().describe("Project description."),
        templateKey: z.string().optional().describe("Template key (default: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic')."),
        projectTypeKey: z.string().optional().describe("Type key (default: 'software')."),
    }),
    func: createJiraProject,
  }),
];

// Combined jira tools for backwards compatibility
const jiraTools = [...jiraReadTools, ...jiraWriteTools];

// --- GITHUB READ TOOLS ---
const githubReadTools = [
  new DynamicStructuredTool({
    name: "get_github_issues",
    description: "List issues in a GitHub repo. REQUIRES both 'owner' (GitHub username/org) and 'repo' name. If user doesn't provide the owner, ASK them - do NOT guess or retry.",
    schema: z.object({
      owner: z.string().describe("REQUIRED: GitHub username or organization (e.g., 'microsoft', 'facebook'). ASK the user if not provided."),
      repo: z.string().describe("REQUIRED: Repository name (e.g., 'vscode', 'react')"),
    }),
    func: getRepoIssues,
  }),
  new DynamicStructuredTool({
    name: "list_github_commits",
    description: "List recent commits in a repo. REQUIRES both 'owner' (GitHub username/org) and 'repo' name. If user doesn't provide the owner, ASK them - do NOT guess or retry.",
    schema: z.object({
      owner: z.string().describe("REQUIRED: GitHub username or organization (e.g., 'microsoft', 'facebook'). ASK the user if not provided."),
      repo: z.string().describe("REQUIRED: Repository name (e.g., 'vscode', 'react')"),
      limit: z.number().optional().describe("Number of commits to return (default 5)"),
    }),
    func: listCommits,
  }),
  new DynamicStructuredTool({
    name: "list_github_pull_requests",
    description: "List pull requests in a repo. REQUIRES both 'owner' (GitHub username/org) and 'repo' name. If user doesn't provide the owner, ASK them - do NOT guess or retry.",
    schema: z.object({
      owner: z.string().describe("REQUIRED: GitHub username or organization (e.g., 'microsoft', 'facebook'). ASK the user if not provided."),
      repo: z.string().describe("REQUIRED: Repository name (e.g., 'vscode', 'react')"),
      state: z.enum(['open', 'closed', 'all']).optional().describe("Filter by state (default 'open')"),
    }),
    func: listPullRequests,
  }),
  new DynamicStructuredTool({
    name: "get_github_pull_request_details",
    description: "Get full details of a specific Pull Request. REQUIRES 'owner', 'repo', and 'pullNumber'. If user doesn't provide the owner, ASK them - do NOT guess or retry.",
    schema: z.object({
      owner: z.string().describe("REQUIRED: GitHub username or organization. ASK the user if not provided."),
      repo: z.string().describe("REQUIRED: Repository name"),
      pullNumber: z.number().describe("REQUIRED: The PR number (e.g. 42)"),
    }),
    func: getPullRequest,
  }),
  new DynamicStructuredTool({
    name: "get_github_commit_details",
    description: "Get full details of a specific commit by SHA. REQUIRES 'owner', 'repo', and 'sha'. If user doesn't provide the owner, ASK them - do NOT guess or retry.",
    schema: z.object({
      owner: z.string().describe("REQUIRED: GitHub username or organization. ASK the user if not provided."),
      repo: z.string().describe("REQUIRED: Repository name"),
      sha: z.string().describe("REQUIRED: The full or partial commit hash"),
    }),
    func: getCommit,
  }),
  new DynamicStructuredTool({
    name: "get_github_repo_checks",
    description: "Get check runs for a specific commit reference. REQUIRES 'owner', 'repo', and 'ref'. If user doesn't provide the owner, ASK them - do NOT guess or retry.",
    schema: z.object({
      owner: z.string().describe("REQUIRED: GitHub username or organization. ASK the user if not provided."),
      repo: z.string().describe("REQUIRED: Repository name"),
      ref: z.string().describe("REQUIRED: The commit SHA, branch name, or tag name."),
    }),
    func: getRepoChecks,
  }),
];

// --- GITHUB WRITE TOOLS ---
const githubWriteTools = [
  new DynamicStructuredTool({
    name: "create_github_repository",
    description: "Create a new GitHub repository.",
    schema: z.object({
      name: z.string().describe("The name of the repository"),
      description: z.string().optional().describe("Description of the repository"),
      isPrivate: z.boolean().optional().describe("Whether the repo should be private (default false)"),
    }),
    func: createRepository,
  }),
  new DynamicStructuredTool({
    name: "create_github_issue",
    description: "Create a GitHub issue.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
    }),
    func: createRepoIssue,
  }),
];

// Combined github tools for backwards compatibility
const githubTools = [...githubReadTools, ...githubWriteTools];

const systemTools = [
  new DynamicStructuredTool({
    name: "system_status_report",
    description: "Get current hardware and OS status.",
    schema: z.object({}),
    func: getSystemStatus,
  }),
  new DynamicStructuredTool({
    name: "execute_terminal_command",
    description: "EXECUTE SHELL COMMANDS. Use for file manipulation, running scripts, or system ops.",
    schema: z.object({
      command: z.string().describe("The shell command to run (e.g., 'ls -la', 'mkdir test')."),
    }),
    func: executeSystemCommand,
  }),
  new DynamicStructuredTool({
    name: "launch_application",
    description: "Launch any application on the user's computer. ARGUMENT is the app name.",
    schema: z.object({
      appName: z.string().describe("The name of the application (e.g., 'Google Chrome', 'Spotify')."),
      target: z.string().optional().describe("Optional URL or file to open with the application (e.g., 'https://figma.com', 'mydoc.txt')."),
    }),
    func: openApplication,
  }),
];

const figmaTools = [
  new DynamicStructuredTool({
    name: "scan_figma_file",
    description: "Get the structure (pages & frames) of a Figma file. Needs the 'fileKey' from the URL.",
    schema: z.object({
        fileKey: z.string().describe("The unique key from the Figma URL (e.g. '8w9d8s...')."),
    }),
    func: getFigmaFileStructure,
  }),
  new DynamicStructuredTool({
    name: "read_figma_comments",
    description: "Read recent comments on a Figma file.",
    schema: z.object({
        fileKey: z.string().describe("The Figma file key."),
    }),
    func: getFigmaComments,
  }),
  new DynamicStructuredTool({
    name: "post_figma_comment",
    description: "Post a comment or feedback on a Figma file.",
    schema: z.object({
        fileKey: z.string().describe("The Figma file key."),
        message: z.string().describe("The text content of the comment."),
        node_id: z.string().optional().describe("Optional ID of the specific node/frame to attach the comment to."),
    }),
    func: postFigmaComment,
  }),
];

const audioTools = [
  new DynamicStructuredTool({
    name: "transcribe_audio_whisper",
    description: "Transcribe an audio file to text using OpenAI Whisper. Requires a valid file path.",
    schema: z.object({
        filePath: z.string().describe("Absolute path to the audio file (mp3, wav, m4a)."),
    }),
    func: transcribeAudio,
  }),
  new DynamicStructuredTool({
    name: "generate_speech_elevenlabs",
    description: "Generate spoken audio from text using ElevenLabs. Returns the path to the saved mp3 file.",
    schema: z.object({
        text: z.string().describe("The text to speak."),
        voiceId: z.string().optional().describe("Optional ElevenLabs Voice ID."),
    }),
    func: generateSpeech,
  }),
];

// --- CALENDAR TOOLS ---
const calendarTools = [
  new DynamicStructuredTool({
    name: "get_calendar_events",
    description: "Get upcoming events from Google Calendar. Use this to check what meetings or events are scheduled.",
    schema: z.object({
      maxResults: z.number().optional().describe("Maximum number of events to return. Default is 10."),
      timeMin: z.string().optional().describe("Start time for events query in ISO format (e.g., 2026-01-15T09:00:00). Defaults to now."),
      timeMax: z.string().optional().describe("End time for events query in ISO format. Optional."),
      calendarId: z.string().optional().describe("Calendar ID to query. Defaults to 'primary'."),
    }),
    func: getCalendarEvents,
  }),
  new DynamicStructuredTool({
    name: "create_calendar_event",
    description: "Create a new event on Google Calendar. Use this to schedule meetings, appointments, or reminders. YOU must calculate ISO timestamps from natural language dates.",
    schema: z.object({
      summary: z.string().describe("Title of the event"),
      description: z.string().optional().describe("Description or notes for the event"),
      startDateTime: z.string().describe("Start date and time in ISO format (e.g., 2026-01-15T14:00:00). Calculate this from user's natural language like 'next Tuesday at 2pm'."),
      endDateTime: z.string().describe("End date and time in ISO format (e.g., 2026-01-15T15:00:00). Default to 1 hour after start if not specified."),
      location: z.string().optional().describe("Location of the event"),
      attendees: z.array(z.string()).optional().describe("Array of email addresses to invite"),
      timeZone: z.string().optional().describe("Timezone for the event. Defaults to system timezone."),
    }),
    func: createCalendarEvent,
  }),
  new DynamicStructuredTool({
    name: "update_calendar_event",
    description: "Update an existing event on Google Calendar. Use this to change meeting details.",
    schema: z.object({
      eventId: z.string().describe("The ID of the event to update"),
      summary: z.string().optional().describe("New title for the event"),
      description: z.string().optional().describe("New description for the event"),
      startDateTime: z.string().optional().describe("New start date and time in ISO format"),
      endDateTime: z.string().optional().describe("New end date and time in ISO format"),
      location: z.string().optional().describe("New location for the event"),
    }),
    func: updateCalendarEvent,
  }),
  new DynamicStructuredTool({
    name: "delete_calendar_event",
    description: "Delete an event from Google Calendar.",
    schema: z.object({
      eventId: z.string().describe("The ID of the event to delete"),
    }),
    func: deleteCalendarEvent,
  }),
  new DynamicStructuredTool({
    name: "find_free_time",
    description: "Check for free/busy time in a given time range. Use this to find available slots for scheduling.",
    schema: z.object({
      timeMin: z.string().describe("Start of time range to check in ISO format"),
      timeMax: z.string().describe("End of time range to check in ISO format"),
    }),
    func: findFreeTime,
  }),
];

// --- FILE TOOLS ---
const fileTools = [
  new DynamicStructuredTool({
    name: "read_file",
    description: "Read any file (auto-detects type). Supports .txt, .docx, .pdf, .json, .md, .csv, and more. Use this to read documents the user mentions.",
    schema: z.object({
      filePath: z.string().describe("Path to the file. Can be absolute or relative to Downloads folder (e.g., 'Downloads/report.docx' or full path)."),
    }),
    func: readFile,
  }),
  new DynamicStructuredTool({
    name: "list_directory",
    description: "List files in a directory. Defaults to Downloads folder. Use this to find files when user asks about their files.",
    schema: z.object({
      directoryPath: z.string().optional().describe("Path to directory. Defaults to Downloads folder."),
      filter: z.string().optional().describe("Filter by name or extension (e.g., 'docx', 'report')."),
      sortBy: z.enum(['modified', 'name', 'size']).optional().describe("Sort order. Defaults to 'modified' (newest first)."),
      limit: z.number().optional().describe("Max files to return. Defaults to 20."),
    }),
    func: listDirectory,
  }),
  new DynamicStructuredTool({
    name: "get_latest_file",
    description: "Get the most recently modified file in a directory. Use this when user asks about their 'last download' or 'newest file'.",
    schema: z.object({
      directoryPath: z.string().optional().describe("Path to directory. Defaults to Downloads folder."),
      extension: z.string().optional().describe("Filter by extension (e.g., 'pdf', 'docx')."),
    }),
    func: getLatestFile,
  }),
  new DynamicStructuredTool({
    name: "read_word_document",
    description: "Read a .docx Word document and extract its text content.",
    schema: z.object({
      filePath: z.string().describe("Path to the .docx file."),
    }),
    func: readWordDocument,
  }),
  new DynamicStructuredTool({
    name: "read_pdf_document",
    description: "Read a PDF file and extract its text content.",
    schema: z.object({
      filePath: z.string().describe("Path to the .pdf file."),
    }),
    func: readPdfDocument,
  }),
];

// --- SLACK TOOLS (Write-Only Announcements) ---
const slackTools = [
  new DynamicStructuredTool({
    name: "send_slack_message",
    description: "Send a simple message to a Slack channel. Use this to notify the team about updates, fixes, or announcements.",
    schema: z.object({
      channel: z.string().optional().describe("Channel name (e.g., 'dev-team' or '#dev-team'). Uses default channel if not specified."),
      message: z.string().describe("The message to send to the channel."),
    }),
    func: sendSlackMessage,
  }),
  new DynamicStructuredTool({
    name: "send_slack_announcement",
    description: "Send a formatted announcement to Slack with title, body, and optional footer. Use for structured updates like deployments or releases.",
    schema: z.object({
      channel: z.string().optional().describe("Channel name. Uses default channel if not specified."),
      title: z.string().describe("Headline of the announcement."),
      body: z.string().describe("Main content of the announcement. Supports Slack markdown."),
      footer: z.string().optional().describe("Optional footer text."),
      type: z.enum(['info', 'success', 'warning', 'error']).optional().describe("Type of announcement for visual styling."),
    }),
    func: sendSlackAnnouncement,
  }),
  new DynamicStructuredTool({
    name: "send_slack_link",
    description: "Share a link in Slack with optional context. Perfect for sharing Jira tickets, GitHub PRs, or documentation.",
    schema: z.object({
      channel: z.string().optional().describe("Channel name. Uses default channel if not specified."),
      url: z.string().describe("The URL to share."),
      context: z.string().optional().describe("Optional message to accompany the link."),
    }),
    func: sendSlackLink,
  }),
];

// --- IMAGE TOOLS ---
const imageTools = [
  new DynamicStructuredTool({
    name: "generate_image_nano_banana",
    description: "Generate an image from a text description using Google's Nano Banana (Gemini 2.5 Flash Image). Use this when the user asks to create, generate, draw, design, or visualise an image, picture, illustration, graphic, logo, or artwork. Returns the local URL path of the generated image.",
    schema: z.object({
      prompt: z.string().describe("REQUIRED: A detailed description of the image to generate. Be as descriptive as possible for best results."),
      aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional().describe("Aspect ratio. '1:1' (square), '9:16' (portrait/phone), '16:9' (landscape/widescreen), '3:2' (photo), etc. Default is '1:1'."),
    }),
    func: generateImage,
  }),
];

// Map categories to their tool arrays
const toolsByCategory = {
  jira_read: jiraReadTools,
  jira_write: jiraWriteTools,
  github_read: githubReadTools,
  github_write: githubWriteTools,
  system: systemTools,
  figma: figmaTools,
  audio: audioTools,
  calendar: calendarTools,
  files: fileTools,
  slack: slackTools,
  image: imageTools,
  general: [], // No tools needed for general conversation
};

// All tools combined (for fallback or multi-category queries)
const allTools = [...jiraTools, ...githubTools, ...systemTools, ...figmaTools, ...audioTools, ...calendarTools, ...fileTools, ...slackTools, ...imageTools];

// =============================================================================
// SEMANTIC CLASSIFIER (The Traffic Cop)
// =============================================================================

const CLASSIFIER_PROMPT = `You are a fast intent classifier for an AI assistant named E.D.I.T.H.
Your ONLY job is to classify the user's message into ONE OR MORE categories.

CATEGORIES:
- jira_read: Reading/searching Jira tickets, issues, epics, sprints, backlogs (queries, lookups, listing)
- jira_write: Creating, updating, or deleting Jira tickets, issues, projects
- github_read: Reading GitHub data: commits, PRs, issues, checks, repo info (queries, lookups, listing)
- github_write: Creating repos, issues, or any write operation on GitHub
- figma: Anything about designs, mockups, UI/UX, wireframes, Figma files, design comments
- system: Anything about opening apps, running commands, terminal, system status, launching programs
- audio: Anything about transcription, text-to-speech, voice, audio files, speaking
- calendar: Anything about scheduling, meetings, appointments, events, calendar, free time, availability, reminders
- files: Reading documents, files, PDFs, Word docs, downloads, listing files, latest download, file contents, summarizing documents
- slack: Sending messages to Slack, posting announcements, notifying team, messaging channels, team notifications
- image: Generating images, pictures, illustrations, graphics, logos, artwork, drawings, visualisations
- general: Casual conversation, greetings, questions that don't need tools, chitchat

RULES:
1. Output ONLY the category name(s), comma-separated if multiple apply
2. If unsure, output "general"
3. Do NOT explain, do NOT add any other text
4. Be fast and decisive
5. For queries that both read and write, include both (e.g., jira_read,jira_write)

EXAMPLES:
User: "How many epics do I have?" -> jira_read
User: "Check my open PRs on the EDITH repo" -> github_read
User: "Open Chrome and go to Figma" -> system,figma
User: "Hello, how are you?" -> general
User: "Create a ticket for the login bug" -> jira_write
User: "Update ticket FDIT-123 to done" -> jira_write
User: "List all my Jira tickets and mark the first one done" -> jira_read,jira_write
User: "Read the comments on the dashboard design" -> figma
User: "What's my CPU usage?" -> system
User: "Create a new repo called test-app" -> github_write
User: "What meetings do I have today?" -> calendar
User: "Schedule a call with John next Tuesday at 2pm" -> calendar
User: "Am I free tomorrow afternoon?" -> calendar
User: "Cancel my 3pm meeting" -> calendar
User: "What's my latest download?" -> files
User: "Read that document for me" -> files
User: "Summarize the PDF I just downloaded" -> files
User: "List my recent downloads" -> files
User: "Tell the dev-team I fixed the bug" -> slack
User: "Post to #general that deployment is complete" -> slack
User: "Notify the team about the new release" -> slack
User: "Generate an image of a sunset over mountains" -> image
User: "Draw me a logo for my app" -> image
User: "Create a picture of a robot" -> image

User message: `;

// Define keywords for the "Fast Pass"
const KEYWORD_MAP = {
    jira_read: [
        'list tickets', 'show tickets', 'get tickets', 'search jira', 'find ticket',
        'how many epics', 'what tickets', 'show epics', 'backlog', 'sprint status'
    ],
    jira_write: [
        'create ticket', 'make ticket', 'new ticket', 'update ticket', 'delete ticket',
        'mark as done', 'change status', 'assign to', 'set priority', 'create issue',
        'create epic', 'create project'
    ],
    github_read: [
        'list commits', 'show commits', 'check pr', 'list pr', 'show pull requests',
        'get checks', 'repo status', 'list issues'
    ],
    github_write: [
        'create repo', 'new repository', 'create issue', 'make issue'
    ],
    figma: [
        'figma', 'design', 'mockup', 'wireframe', 'ux', 'ui', 'color', 'frame', 
        'layer', 'canvas', 'prototype', 'comment' 
    ],
    system: [
        'open', 'launch', 'run command', 'terminal', 'cpu', 'memory', 'status'
    ],
    audio: [
        'transcribe', 'speech', 'voice', 'audio', 'speak'
    ],
    calendar: [
        'schedule', 'meeting', 'appointment', 'calendar', 'event', 'free time',
        'availability', 'busy', 'remind', 'reminder', 'book', 'block time'
    ],
    files: [
        'download', 'downloaded', 'document', 'pdf', 'docx', 'word doc', 'file',
        'read file', 'read that', 'summarize', 'summary', 'latest file', 'recent file',
        'my files', 'list files', 'what file', 'that document', 'the file', 'the document',
        'brief me', 'overview', 'contents of', 'open the', 'what does it say'
    ],
    slack: [
        'slack', 'tell the team', 'notify team', 'post to', 'announce', 'message channel',
        'send message', 'tell dev', 'tell #', 'post announcement', 'team notification'
    ],
    image: [
        'generate image', 'create image', 'draw', 'make a picture', 'generate a picture',
        'create a logo', 'make an image', 'illustration', 'visualize', 'visualise',
        'generate art', 'create art', 'make art', 'dall-e', 'dalle', 'artwork',
        'render an image', 'design a logo', 'generate a logo', 'picture of'
    ]
};

// Fallback keywords that map to both read and write
const FALLBACK_KEYWORD_MAP = {
    jira: ['jira', 'ticket', 'sprint', 'epic', 'kanban', 'issue', 'bug', 'board'],
    github: ['github', 'repo', 'pr', 'pull request', 'commit', 'branch', 'push', 'merge', 'clone', 'check', 'code'],
};

async function classifyIntent(userMessage, chatHistory = []) {
    const lowerMsg = userMessage.toLowerCase();
    const detectedCategories = new Set();

    // 1. FAST PASS: Check specific keywords first (< 1ms)
    for (const [category, keywords] of Object.entries(KEYWORD_MAP)) {
        if (keywords.some(k => lowerMsg.includes(k))) {
            detectedCategories.add(category);
        }
    }

    // 2. Check fallback keywords - if found, add BOTH read and write for that service
    for (const [service, keywords] of Object.entries(FALLBACK_KEYWORD_MAP)) {
        if (keywords.some(k => lowerMsg.includes(k)) && detectedCategories.size === 0) {
            // Add both read and write tools for ambiguous queries
            detectedCategories.add(`${service}_read`);
            detectedCategories.add(`${service}_write`);
        }
    }

    if (detectedCategories.size > 0) {
        console.log(`[Traffic Cop] ⚡ Fast-Pass Intent: ${Array.from(detectedCategories)}`);
        return Array.from(detectedCategories);
    }

    // 3. CONTEXT PASS: For short messages OR messages with reference words, check conversation context
    const wordCount = userMessage.split(' ').length;
    const hasReferenceWord = /\b(that|it|this|the file|the document|the pdf|same|above|previous)\b/i.test(userMessage);
    
    if ((wordCount < 10 || hasReferenceWord) && chatHistory.length > 0) {
        console.log("[Traffic Cop] Follow-up detected (short or reference word). Checking conversation context...");
        
        // Look at the last few messages to determine context
        const recentMessages = chatHistory.slice(-4); // Last 2 exchanges (human + AI each)
        const recentContext = recentMessages.map(m => m.content || '').join(' ').toLowerCase();
        
        // Check if recent context mentions any service keywords
        const contextCategories = new Set();
        
        for (const [service, keywords] of Object.entries(FALLBACK_KEYWORD_MAP)) {
            if (keywords.some(k => recentContext.includes(k))) {
                contextCategories.add(`${service}_read`);
                contextCategories.add(`${service}_write`);
            }
        }
        
        // Also check specific keywords in context
        for (const [category, keywords] of Object.entries(KEYWORD_MAP)) {
            if (keywords.some(k => recentContext.includes(k))) {
                contextCategories.add(category);
            }
        }
        
        if (contextCategories.size > 0) {
            console.log(`[Traffic Cop] 🔗 Context-Pass Intent (follow-up): ${Array.from(contextCategories)}`);
            return Array.from(contextCategories);
        }
    }

    if (wordCount < 5) {
        console.log("[Traffic Cop] Short query with no context. Defaulting to General.");
        return ['general']; 
    }

    // 4. SLOW PASS: Fallback to LLM for ambiguous queries
    try {
        const response = await classifierLlm.invoke(CLASSIFIER_PROMPT + userMessage);
        const categories = response.content.toLowerCase().trim().split(',').map(c => c.trim());
        const validCategories = categories.filter(c => toolsByCategory.hasOwnProperty(c));
        
        if (validCategories.length === 0) return ['general'];
        
        console.log(`[Traffic Cop] Intent classified: ${validCategories.join(', ')}`);
        return validCategories;
    } catch (error) {
        console.error("[Traffic Cop] Classification error:", error.message);
        return ['general']; 
    }
}

function getToolsForCategories(categories) {
    const tools = new Set();
    
    for (const category of categories) {
        const categoryTools = toolsByCategory[category] || [];
        categoryTools.forEach(tool => tools.add(tool));
    }
    
    // If no tools selected (general conversation), return empty array
    return Array.from(tools);
}

// =============================================================================
// CHAT HISTORY PERSISTENCE
// =============================================================================

const HISTORY_FILE_PATH = path.join(process.cwd(), "chat_history.json");

// Global cache variable
const historyCache = {}; 

class JSONFileChatMessageHistory extends BaseListChatMessageHistory {
    constructor(sessionId) {
        super();
        this.sessionId = sessionId;
    }

    async getMessages() {
        // 1. Check Memory (Instant)
        if (historyCache[this.sessionId]) {
            // Convert simple objects back to LangChain classes
            return historyCache[this.sessionId].map(msg => {
                switch (msg.type) {
                     case 'human': return new HumanMessage(msg.content);
                     case 'ai': return new AIMessage(msg.content);
                     case 'system': return new SystemMessage(msg.content);
                     default: return new HumanMessage(msg.content);
                }
            });
        }
        
        // 2. Fallback to Disk (Async)
        if (!fs.existsSync(HISTORY_FILE_PATH)) return [];
        try {
            const fileContent = await fs.promises.readFile(HISTORY_FILE_PATH, 'utf-8');
            // Handle empty or whitespace-only files
            if (!fileContent || !fileContent.trim()) {
                historyCache[this.sessionId] = [];
                return [];
            }
            const allHistory = JSON.parse(fileContent);
            historyCache[this.sessionId] = allHistory[this.sessionId] || [];
            return this.getMessages(); // Recursive call now hits memory
        } catch (e) {
            console.error("Error reading history:", e);
            historyCache[this.sessionId] = []; // Initialize cache to prevent repeated failures
            return [];
        }
    }

    async addMessage(message) {
        // Update Memory immediately
        if (!historyCache[this.sessionId]) historyCache[this.sessionId] = [];
        
        const simpleMsg = {
            type: message.getType ? message.getType() : message._getType(),
            content: message.content
        };
        historyCache[this.sessionId].push(simpleMsg);

        // Save to Disk Asynchronously (Fire and forget - doesn't block response)
        this.saveToDisk();
    }

    async saveToDisk() {
        try {
            // We read first to ensure we don't overwrite other sessions
            let allHistory = {};
            if (fs.existsSync(HISTORY_FILE_PATH)) {
                 const data = await fs.promises.readFile(HISTORY_FILE_PATH, 'utf-8');
                 // Handle empty or malformed files
                 if (data && data.trim()) {
                     try {
                         allHistory = JSON.parse(data);
                     } catch (parseErr) {
                         console.warn("[History] Corrupted history file, resetting.", parseErr.message);
                         allHistory = {};
                     }
                 }
            }
            allHistory[this.sessionId] = historyCache[this.sessionId];
            await fs.promises.writeFile(HISTORY_FILE_PATH, JSON.stringify(allHistory, null, 2));
        } catch(e) {
            console.error("[History] Failed to save to disk:", e.message);
        }
    }
    
    // ... clear() method remains similar ...
}

function getMessageHistory(sessionId) {
  return new JSONFileChatMessageHistory(sessionId);
}

// =============================================================================
// DYNAMIC AGENT CREATION (Traffic Cop Pattern)
// =============================================================================

// Create agent with fresh timestamp each time (don't cache system prompt)
function getOrCreateAgent(tools) {
    // Always get fresh system prompt with current time
    const systemPrompt = getSystemPrompt();
    
    // Create a signature based on tool names
    const toolSignature = tools.map(t => t.name).sort().join(',');
    
    // Don't cache agents - always create fresh to ensure current timestamp
    const agent = createReactAgent({
        llm,
        tools,
        stateModifier: systemPrompt,
    });
    
    console.log(`[Agent Factory] Created agent with tools: ${toolSignature || '(none)'}`);
    return agent;
}

// The main processing function that classifies intent and routes to appropriate agent
async function processWithSemanticRouting(input) {
    const { input: userQuery, chat_history } = input;
    const history = Array.isArray(chat_history) ? chat_history : [];
    
    // Step 1: Classify intent using the Traffic Cop (now with context)
    const categories = await classifyIntent(userQuery, history);
    
    // Step 2: Get the appropriate tools for the classified categories
    const selectedTools = getToolsForCategories(categories);
    
    console.log(`[Traffic Cop] Selected ${selectedTools.length} tools for categories: ${categories.join(', ')}`);
    
    // Step 3: Handle "general" conversation directly with LLM (no agent needed)
    if (selectedTools.length === 0) {
        console.log("[Traffic Cop] General conversation - using direct LLM call");
        
        const systemPrompt = getSystemPrompt();
        const messages = [
            new SystemMessage(systemPrompt),
            ...history,
            new HumanMessage(userQuery)
        ];
        
        const response = await llm.invoke(messages);
        return { messages: [...history, new HumanMessage(userQuery), response] };
    }
    
    // Step 4: Get or create an agent with these specific tools
    const agent = getOrCreateAgent(selectedTools);
    
    // Step 5: Execute the agent
    const result = await agent.invoke({
        messages: [...history, new HumanMessage(userQuery)]
    });
    
    return result;
}

// Streaming version for the server to use
export async function* streamWithSemanticRouting(userQuery, sessionId) {
    const messageHistory = getMessageHistory(sessionId);
    const history = await messageHistory.getMessages();
    
    // Step 1: Classify intent using the Traffic Cop (with conversation context)
    const categories = await classifyIntent(userQuery, history);

    const lowerQuery = userQuery.toLowerCase();

    if (lowerQuery.includes('system status') || lowerQuery.includes('battery') || lowerQuery.includes('uptime')) {
        console.log("⚡️ Reflex triggered: System Status");
        
        // Run the tool directly (ensure getSystemStatus is imported from ./systemTool.js)
        const status = await getSystemStatus(); 
        const reflexResponse = `**Reflex Response:**\n${status}`;
        
        // Fake the streaming event so the frontend handles it normally
        yield { 
            event: "on_chat_model_stream", 
            data: { chunk: { content: reflexResponse } } 
        };
        
        // Save reflex response to history
        await messageHistory.addMessage(new HumanMessage(userQuery));
        await messageHistory.addMessage(new AIMessage(reflexResponse));
        return;
    }
    
    // Step 2: Get the appropriate tools for the classified categories
    const selectedTools = getToolsForCategories(categories);
    
    console.log(`[Traffic Cop] Selected ${selectedTools.length} tools for categories: ${categories.join(', ')}`);
    
    // Step 3: Handle "general" conversation directly with LLM (no agent needed)
    if (selectedTools.length === 0) {
        console.log("[Traffic Cop] General conversation - using direct LLM call");
        
        const systemPrompt = getSystemPrompt();
        const messages = [
            new SystemMessage(systemPrompt),
            ...history,
            new HumanMessage(userQuery)
        ];
        
        const stream = await llm.stream(messages);
        
        let completeResponse = "";
        for await (const chunk of stream) {
            const content = chunk.content;
            if (content) {
                completeResponse += content;
                yield { 
                    event: "on_chat_model_stream", 
                    data: { chunk: { content } } 
                };
            }
        }
        
        // Save to history after streaming completes
        await messageHistory.addMessage(new HumanMessage(userQuery));
        if (completeResponse) {
            await messageHistory.addMessage(new AIMessage(completeResponse));
        }
        return;
    }
    
    // Step 4: Get or create an agent with these specific tools
    const agent = getOrCreateAgent(selectedTools);
    
    // Step 5: Stream events from the agent
    const stream = agent.streamEvents(
        { messages: [...history, new HumanMessage(userQuery)] },
        { version: "v2" }
    );
    
    let completeResponse = "";
    
    for await (const event of stream) {
        // Forward the event
        yield event;
        
        // Capture final response for history
        if (event.event === "on_chat_model_stream") {
            const content = event.data?.chunk?.content;
            if (content) {
                completeResponse += content;
            }
        }
    }
    
    // Save to history after streaming completes
    await messageHistory.addMessage(new HumanMessage(userQuery));
    if (completeResponse) {
        await messageHistory.addMessage(new AIMessage(completeResponse));
    }
}

const outputAdapter = (state) => {
   // Compatibility handling for different LangGraph versions/returns
   let messages = state.messages;
   
   // Sometimes the state is nested under the node name (e.g. 'agent')
   if (!messages && state.agent && state.agent.messages) {
       messages = state.agent.messages;
   }
   
   if (!messages || !Array.isArray(messages) || messages.length === 0) {
       // DEBUG: If state is missing, return keys to help diagnosis
       const keys = state ? Object.keys(state).join(", ") : "NULL_STATE";
       const dump = state ? JSON.stringify(state).substring(0, 500) : "N/A";
       return { output: `[System Error] agentGraph returned invalid state. Keys: ${keys}. Dump: ${dump}` };
   }
   const lastMessage = messages[messages.length - 1];
   return { output: lastMessage.content };
};

const agentChain = RunnableSequence.from([
    new RunnableLambda({ func: processWithSemanticRouting }),
    outputAdapter
]);

export const agentExecutor = new RunnableWithMessageHistory({
  runnable: agentChain,
  getMessageHistory: getMessageHistory,
  inputMessagesKey: "input",
  historyMessagesKey: "chat_history", 
  outputMessagesKey: "output",
});

console.log(" Tactical Systems Ready.");
