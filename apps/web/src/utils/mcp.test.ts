import { describe, expect, it } from 'vitest';

import { mcpClaudeCodeCommand, mcpServerUrl, mcpSetupPrompt } from './mcp';

const SERVER_URL = 'https://swarmfoundry.example.com/mcp';

describe('mcpServerUrl', () => {
  it('serves the server at /mcp on the console origin', () => {
    expect(mcpServerUrl('https://swarmfoundry.example.com')).toBe(SERVER_URL);
  });
});

describe('mcpSetupPrompt', () => {
  it('names the URL, transport and header, with the key left as a placeholder', () => {
    const prompt = mcpSetupPrompt(SERVER_URL);

    expect(prompt).toContain(`- URL: ${SERVER_URL}`);
    expect(prompt).toContain('- Transport: Streamable HTTP');
    expect(prompt).toContain('- Header: Authorization: Bearer <your-key>');
    expect(prompt).toContain('never ask me for the key itself');
  });
});

describe('mcpClaudeCodeCommand', () => {
  it('adds the server to the user config, for every project', () => {
    expect(mcpClaudeCodeCommand(SERVER_URL)).toBe(
      `claude mcp add --scope user --transport http swarmfoundry ${SERVER_URL} \\\n` +
        '  --header "Authorization: Bearer <your-key>"'
    );
  });
});
