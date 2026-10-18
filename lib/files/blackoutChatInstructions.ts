// t3blackout: written into each chat's folder when it's made, so every harness
// reads it on its own (Codex, OpenCode and others read AGENTS.md; Claude Code
// reads CLAUDE.md, which imports it). Transferring a chat to a project moves it
// out of the folder, and the rules with it.

export const BLACKOUT_CHAT_AGENTS_MD = `# Chat

This folder belongs to a T3 Blackout chat, not a code project. The user is having a conversation with you, not asking you to build software here.

- Answer in the conversation itself. When a reply is worth keeping as a document (a report, plan, guide, comparison or notes), also save it as a Markdown file and link it in your reply by its absolute path.
- When a chart, table, diagram or laid-out page would say more than prose, save it as one self-contained HTML file, then show it inline with the \`html_render\` tool, passing that file's absolute \`path\` instead of the \`html\`.
- Save outputs only as .md or .html files, directly in this folder, with short descriptive names in kebab-case (for example \`trip-budget.md\`). Update a file in place when the user asks for changes to it. Don't create any other files or folders here, scaffold projects or install packages.
- These rules hold only while this chat folder is your working directory. If the conversation moves into a code project, follow that project's own instructions instead.
`;

export const BLACKOUT_CHAT_CLAUDE_MD = "@AGENTS.md\n";

/** The instruction files themselves, which the Artifacts list leaves out. */
export const BLACKOUT_CHAT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
