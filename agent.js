import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { ChatOllama } from "@langchain/ollama";
import fs from 'fs';
import path from 'path';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableWithMessageHistory, RunnableSequence, RunnableLambda } from "@langchain/core/runnables";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import "./envConfig.js";

import { EDITH_SYSTEM_PROMPT, getSystemPrompt } from "./systemPrompt.js";
import { generateImage } from "./imageTool.js";
import { getJiraIssues, createJiraIssue, updateJiraIssue, deleteJiraIssue, createJiraProject } from "./jiraTool.js";
import { getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, findFreeTime } from "./calendarTool.js";
import { sendSlackMessage, sendSlackAnnouncement, sendSlackLink } from "./slackTool.js";
import { createRepository, getRepoIssues, createRepoIssue, listCommits, listPullRequests, getPullRequest, getCommit, getRepoChecks } from "./githubTool.js";
import { getFigmaFileStructure, getFigmaComments, postFigmaComment } from "./figmaTool.js";
import { sendGmail, searchGmailContacts, getRecentEmails } from "./gmailTool.js";

// =============================================================================
// LLM PROVIDER SELECTION: Gemini (cloud) or Ollama (local, zero API keys)
// =============================================================================

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

let llm;
let classifierLlm;

if (LLM_PROVIDER === 'ollama') {
  // --- OLLAMA: Fully local, zero API keys required ---
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';

  llm = new ChatOllama({
    baseUrl: ollamaBaseUrl,
    model: ollamaModel,
  });

  // Use the same local model for classification (or a smaller one if available)
  classifierLlm = new ChatOllama({
    baseUrl: ollamaBaseUrl,
    model: ollamaModel,
    temperature: 0,
  });

  console.log(` E.D.I.T.H. Online (Ollama: ${ollamaModel}) - LOCAL MODE, Zero API Keys.`);
} else if (LLM_PROVIDER === 'gemini' && process.env.GOOGLE_VERTEX_AI_OAUTH === 'true' && process.env.GOOGLE_REFRESH_TOKEN) {
  // --- VERTEX AI: OAuth 2.0 (User Consent Flow) ---
  // Uses the Google OAuth refresh token instead of an API key.
  // Requires: Vertex AI API enabled in GCP, GOOGLE_CLOUD_PROJECT set.
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;
  const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

  if (!gcpProject) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT not set. Required for Vertex AI OAuth mode. " +
      "Set it in .env to your GCP project ID (e.g., 'my-edith-project-12345')."
    );
  }

  const vertexAuthOptions = {
    credentials: {
      type: 'authorized_user',
      client_id: process.env.OAUTH_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  };

  llm = new ChatVertexAI({
    model: "gemini-2.5-flash-preview-05-20",
    project: gcpProject,
    location: gcpLocation,
    authOptions: vertexAuthOptions,
  });

  classifierLlm = new ChatVertexAI({
    model: "gemini-2.0-flash-lite",
    project: gcpProject,
    location: gcpLocation,
    temperature: 0,
    authOptions: vertexAuthOptions,
  });

  console.log(` E.D.I.T.H. Online (Vertex AI OAuth: gemini-2.5-flash) - Project: ${gcpProject}, Region: ${gcpLocation}`);
} else {
  // --- GEMINI: Cloud-based (requires GOOGLE_API_KEY) ---
  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (!googleApiKey) throw new Error("GOOGLE_API_KEY not found. Set it in .env or switch to Ollama (LLM_PROVIDER=ollama) for zero-key mode.");

  llm = new ChatGoogleGenerativeAI({
    apiKey: googleApiKey,
    model: "gemini-3-flash-preview",
  });

  classifierLlm = new ChatGoogleGenerativeAI({
    apiKey: googleApiKey,
    model: "gemini-2.0-flash-lite",
    temperature: 0,
  });

  console.log(" E.D.I.T.H. Online (Gemini 3 Flash) - Semantic Classification Enabled.");
}



// =============================================================================
// CUSTOM TOOL DEFINITIONS
// =============================================================================

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

// --- JIRA TOOLS ---
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

// --- SLACK TOOLS ---
const slackCustomTools = [
  new DynamicStructuredTool({
    name: "send_slack_message",
    description: "Send a message to a Slack channel. Use for team notifications, updates, or announcements.",
    schema: z.object({
      channel: z.string().optional().describe("Channel name (with or without #) or channel ID. Defaults to SLACK_DEFAULT_CHANNEL."),
      message: z.string().describe("The message text to send."),
    }),
    func: sendSlackMessage,
  }),
  new DynamicStructuredTool({
    name: "send_slack_announcement",
    description: "Post a formatted announcement with title, body, and optional footer using Slack Block Kit. Great for deployment notices or status reports.",
    schema: z.object({
      channel: z.string().optional().describe("Channel name or ID. Defaults to SLACK_DEFAULT_CHANNEL."),
      title: z.string().describe("Announcement headline."),
      body: z.string().describe("Main content of the announcement."),
      footer: z.string().optional().describe("Optional footer text."),
      type: z.enum(['info', 'success', 'warning', 'error']).optional().describe("Type of announcement for emoji styling."),
    }),
    func: sendSlackAnnouncement,
  }),
  new DynamicStructuredTool({
    name: "send_slack_link",
    description: "Share a URL with contextual message in a Slack channel. Perfect for sharing Jira tickets, GitHub PRs, or docs.",
    schema: z.object({
      channel: z.string().optional().describe("Channel name or ID. Defaults to SLACK_DEFAULT_CHANNEL."),
      url: z.string().describe("The URL to share."),
      context: z.string().optional().describe("Contextual message to accompany the link."),
    }),
    func: sendSlackLink,
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

// --- GITHUB TOOLS (custom) ---
const githubReadTools = [
  new DynamicStructuredTool({
    name: "get_repo_issues",
    description: "List issues for a GitHub repository. Requires owner and repo name.",
    schema: z.object({
      owner: z.string().describe("Repository owner (e.g., 'octocat')."),
      repo: z.string().describe("Repository name (e.g., 'Hello-World')."),
    }),
    func: getRepoIssues,
  }),
  new DynamicStructuredTool({
    name: "list_commits",
    description: "List recent commits for a GitHub repository.",
    schema: z.object({
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      limit: z.number().optional().describe("Number of commits to return. Default 5."),
    }),
    func: listCommits,
  }),
  new DynamicStructuredTool({
    name: "list_pull_requests",
    description: "List pull requests for a GitHub repository.",
    schema: z.object({
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      state: z.string().optional().describe("PR state: 'open', 'closed', or 'all'. Default 'open'."),
    }),
    func: listPullRequests,
  }),
  new DynamicStructuredTool({
    name: "get_pull_request",
    description: "Get details of a specific pull request.",
    schema: z.object({
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      pullNumber: z.number().describe("The pull request number."),
    }),
    func: getPullRequest,
  }),
  new DynamicStructuredTool({
    name: "get_commit",
    description: "Get details of a specific commit by SHA.",
    schema: z.object({
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      sha: z.string().describe("The commit SHA."),
    }),
    func: getCommit,
  }),
  new DynamicStructuredTool({
    name: "get_repo_checks",
    description: "Get check runs for a specific git ref (branch, tag, or SHA).",
    schema: z.object({
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      ref: z.string().describe("Git ref (branch name, tag, or commit SHA)."),
    }),
    func: getRepoChecks,
  }),
];

const githubWriteTools = [
  new DynamicStructuredTool({
    name: "create_repository",
    description: "Create a new GitHub repository for the authenticated user.",
    schema: z.object({
      name: z.string().describe("Repository name."),
      description: z.string().optional().describe("Repository description."),
      isPrivate: z.boolean().optional().describe("Whether the repo should be private. Default false."),
    }),
    func: createRepository,
  }),
  new DynamicStructuredTool({
    name: "create_repo_issue",
    description: "Create a new issue on a GitHub repository.",
    schema: z.object({
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      title: z.string().describe("Issue title."),
      body: z.string().optional().describe("Issue body/description."),
    }),
    func: createRepoIssue,
  }),
];

// --- FIGMA TOOLS (custom) ---
const figmaTools = [
  new DynamicStructuredTool({
    name: "get_figma_file_structure",
    description: "Get the structure (pages and frames) of a Figma design file. Requires the file key from the Figma URL.",
    schema: z.object({
      fileKey: z.string().describe("The Figma file key (from the URL: figma.com/file/KEY/Name)."),
    }),
    func: getFigmaFileStructure,
  }),
  new DynamicStructuredTool({
    name: "get_figma_comments",
    description: "Get comments on a Figma file.",
    schema: z.object({
      fileKey: z.string().describe("The Figma file key."),
    }),
    func: getFigmaComments,
  }),
  new DynamicStructuredTool({
    name: "post_figma_comment",
    description: "Post a comment on a Figma file.",
    schema: z.object({
      fileKey: z.string().describe("The Figma file key."),
      message: z.string().describe("The comment message to post."),
      node_id: z.string().optional().describe("Optional node ID to attach the comment to a specific element."),
    }),
    func: postFigmaComment,
  }),
];

// --- GMAIL TOOLS ---
const gmailTools = [
  new DynamicStructuredTool({
    name: "send_gmail",
    description: "Send an email via Gmail. Use this when the user wants to email someone. ALWAYS confirm the recipient email, subject, and body with the user before sending. If the user refers to a person by name, use search_gmail_contacts FIRST to resolve their email address.",
    schema: z.object({
      to: z.string().describe("REQUIRED: Recipient email address."),
      subject: z.string().describe("REQUIRED: Email subject line."),
      body: z.string().describe("REQUIRED: Email body text."),
      cc: z.string().optional().describe("CC email address (comma-separated for multiple)."),
      bcc: z.string().optional().describe("BCC email address (comma-separated for multiple)."),
    }),
    func: sendGmail,
  }),
  new DynamicStructuredTool({
    name: "search_gmail_contacts",
    description: "Search the user's email history to find someone's email address by name. Use this when the user says 'email John' or 'send it to Sarah' — resolve the name to an email address before sending. Returns matching contacts from sent/received emails.",
    schema: z.object({
      query: z.string().describe("REQUIRED: Person's name or partial email address to search for."),
    }),
    func: searchGmailContacts,
  }),
  new DynamicStructuredTool({
    name: "get_recent_emails",
    description: "Get recent emails from the user's Gmail inbox. Use to check inbox, find specific emails, or summarize recent mail.",
    schema: z.object({
      maxResults: z.number().optional().describe("Maximum number of emails to return. Default 10, max 50."),
      query: z.string().optional().describe("Optional Gmail search query to filter emails (e.g., 'from:john', 'subject:meeting', 'is:unread')."),
    }),
    func: getRecentEmails,
  }),
];

// =============================================================================
// TOOL CATEGORY MAP
// =============================================================================

const toolsByCategory = {
  jira_read:    jiraReadTools,
  jira_write:   jiraWriteTools,
  github_read:  githubReadTools,
  github_write: githubWriteTools,
  figma:        figmaTools,
  calendar:     calendarTools,
  slack:        slackCustomTools,
  gmail:        gmailTools,
  image:        imageTools,
  general:      [],
};

// All tools combined (for fallback or multi-category queries)
const allTools = [...imageTools, ...jiraReadTools, ...jiraWriteTools, ...githubReadTools, ...githubWriteTools, ...figmaTools, ...calendarTools, ...slackCustomTools, ...gmailTools];

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
- calendar: Anything about scheduling, meetings, appointments, events, calendar, free time, availability, reminders
- slack: Sending messages to Slack, posting announcements, notifying team, messaging channels, team notifications
- gmail: Sending emails, reading inbox, checking mail, finding someone's email address, emailing a person
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
User: "Open Chrome and go to Figma" -> figma
User: "Hello, how are you?" -> general
User: "Create a ticket for the login bug" -> jira_write
User: "Update ticket FDIT-123 to done" -> jira_write
User: "List all my Jira tickets and mark the first one done" -> jira_read,jira_write
User: "Read the comments on the dashboard design" -> figma
User: "Create a new repo called test-app" -> github_write
User: "What meetings do I have today?" -> calendar
User: "Schedule a call with John next Tuesday at 2pm" -> calendar
User: "Am I free tomorrow afternoon?" -> calendar
User: "Cancel my 3pm meeting" -> calendar
User: "Tell the dev-team I fixed the bug" -> slack
User: "Post to #general that deployment is complete" -> slack
User: "Notify the team about the new release" -> slack
User: "Send an email to John about the meeting" -> gmail
User: "What emails did I get today?" -> gmail
User: "Email Sarah the project update" -> gmail
User: "Check my inbox" -> gmail
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
    calendar: [
        'schedule', 'meeting', 'appointment', 'calendar', 'event', 'free time',
        'availability', 'busy', 'remind', 'reminder', 'book', 'block time',
        'tomorrow', 'yesterday', 'next week', 'this week'
    ],
    slack: [
        'slack', 'tell the team', 'notify team', 'post to', 'announce', 'message channel',
        'send message', 'tell dev', 'tell #', 'post announcement', 'team notification'
    ],
    gmail: [
        'email', 'gmail', 'send email', 'send mail', 'mail to', 'email to',
        'inbox', 'check mail', 'check email', 'recent emails', 'unread emails',
        'send it to', 'email them', 'email him', 'email her', 'email that',
        'mail it', 'compose email', 'write email', 'draft email',
        'send an email', 'email address', 'mail him', 'mail her', 'mail them',
        'send that email', 'forward email', 'reply email', 'my emails',
        'send it via email', 'shoot an email', 'drop an email', 'fire off an email'
    ],
    image: [
        'generate image', 'create image', 'draw', 'make a picture', 'generate a picture',
        'create a logo', 'make an image', 'illustration', 'visualize', 'visualise',
        'generate art', 'create art', 'make art', 'dall-e', 'dalle', 'artwork',
        'render an image', 'design a logo', 'generate a logo', 'picture of',
        'create photo', 'make picture', 'generate photo', 'make a photo',
        'generate a photo', 'create a picture', 'create a drawing', 'sketch',
        'render a', 'paint', 'create graphic', 'make graphic'
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

    // 2. ALWAYS check fallback keywords (even if fast-pass found something)
    // This ensures "open jira tickets" detects jira, not just system
    for (const [service, keywords] of Object.entries(FALLBACK_KEYWORD_MAP)) {
        if (keywords.some(k => lowerMsg.includes(k))) {
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

// Maximum number of recent messages to pass to the LLM/agent.
// Prevents the model from confusing old tool results with the current request.
const MAX_HISTORY_MESSAGES = 30;

/**
 * Trim history to the last N messages to avoid context pollution.
 * Old tool-call confirmations can cause the LLM to believe a new request
 * has already been completed ("hallucination via history").
 */
function trimHistory(messages) {
    if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
    return messages.slice(-MAX_HISTORY_MESSAGES);
}

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
    const history = trimHistory(Array.isArray(chat_history) ? chat_history : []);
    
    // Step 1: Classify intent using the Traffic Cop (now with context)
    const categories = await classifyIntent(userQuery, history);
    
    // Step 2: Get the appropriate tools for the classified categories
    const selectedTools = getToolsForCategories(categories);
    
    console.log(`[Traffic Cop] Selected ${selectedTools.length} tools for categories: ${categories.join(', ')}`);
    
    // Step 3: Handle "general" conversation directly with LLM (no agent needed)
    if (selectedTools.length === 0) {
        console.log("[Traffic Cop] General conversation - using direct LLM call");
        
        // getSystemPrompt() already returns a SystemMessage — don't double-wrap
        const systemPrompt = getSystemPrompt();
        const noToolsGuard = new SystemMessage(
            "IMPORTANT: You have NO tools available in this response. " +
            "You CANNOT perform any actions such as sending emails, creating tickets, " +
            "posting messages, reading files, scheduling events, or querying APIs. " +
            "Do NOT pretend to execute actions or fabricate results. " +
            "If the user asks you to perform an action, tell them clearly and honestly " +
            "that you were unable to route their request to the appropriate tool, " +
            "and ask them to rephrase or be more specific."
        );
        const messages = [
            systemPrompt,
            noToolsGuard,
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
    const fullHistory = await messageHistory.getMessages();
    const history = trimHistory(fullHistory);
    
    // Step 1: Classify intent using the Traffic Cop (with conversation context)
    const categories = await classifyIntent(userQuery, history);

    const lowerQuery = userQuery.toLowerCase();

    // Step 2: Get the appropriate tools for the classified categories
    const selectedTools = getToolsForCategories(categories);
    
    console.log(`[Traffic Cop] Selected ${selectedTools.length} tools for categories: ${categories.join(', ')}`);
    
    // Step 3: Handle "general" conversation directly with LLM (no agent needed)
    if (selectedTools.length === 0) {
        console.log("[Traffic Cop] General conversation - using direct LLM call");
        
        // getSystemPrompt() already returns a SystemMessage — don't double-wrap
        const systemPrompt = getSystemPrompt();
        const noToolsGuard = new SystemMessage(
            "IMPORTANT: You have NO tools available in this response. " +
            "You CANNOT perform any actions such as sending emails, creating tickets, " +
            "posting messages, reading files, scheduling events, or querying APIs. " +
            "Do NOT pretend to execute actions or fabricate results. " +
            "If the user asks you to perform an action, tell them clearly and honestly " +
            "that you were unable to route their request to the appropriate tool, " +
            "and ask them to rephrase or be more specific."
        );
        const messages = [
            systemPrompt,
            noToolsGuard,
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
