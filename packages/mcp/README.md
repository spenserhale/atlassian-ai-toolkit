# @atlassian-ai-toolkit/mcp

MCP server for Atlassian Cloud, built with [FastMCP](https://github.com/punkpeye/fastmcp).

## Tools

| Tool | Description |
|------|-------------|
| `jira_get_issue` | Get a Jira issue by key or ID |
| `jira_delete_issue` | Preview or delete a Jira issue with `force` + `confirm` |
| `confluence_get_page` | Get a Confluence page by ID |
| `confluence_delete_page` | Preview, trash, or purge a Confluence page with `force` + `confirm` |

## Setup with Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "atlassian-ai-toolkit": {
      "command": "bun",
      "args": ["run", "/Users/spenser/Code/Toolkits/atlassian-ai-toolkit/packages/mcp/src/index.ts"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@example.com",
        "ATLASSIAN_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

## Development

```bash
# Run in stdio mode
bun run dev

# Inspect with FastMCP inspector
bun run inspect
```
