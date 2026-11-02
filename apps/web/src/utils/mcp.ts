export const MCP_KEY_PLACEHOLDER = '<your-key>';

export const MCP_AUTH_HEADER = `Authorization: Bearer ${MCP_KEY_PLACEHOLDER}`;

export enum McpSetup {
  PROMPT = 'prompt',
  CLAUDE_CODE = 'claudeCode',
  SERVER = 'server',
}

export const mcpServerUrl = (origin: string): string => `${origin}/mcp`;

/** Keeps the key out of the prompt, since a key pasted into an agent's conversation lands in its transcript. */
export const mcpSetupPrompt = (serverUrl: string): string =>
  [
    "Add Swarmfoundry's MCP server to your MCP client's user-level config, so every session has it.",
    '',
    `- URL: ${serverUrl}`,
    '- Transport: Streamable HTTP',
    `- Header: ${MCP_AUTH_HEADER}`,
    '',
    `Write ${MCP_KEY_PLACEHOLDER} exactly as shown, and never ask me for the key itself. Then tell me which file to ` +
      'open to put my API key in its place, and whether I need to restart or reconnect for the tools to load.',
    '',
    "The server is read-only. Its tools list and search Swarmfoundry's tasks, runs and agent transcripts.",
  ].join('\n');

export const mcpClaudeCodeCommand = (serverUrl: string): string =>
  `claude mcp add --scope user --transport http swarmfoundry ${serverUrl} \\\n` + `  --header "${MCP_AUTH_HEADER}"`;
