# @atlassian-ai-toolkit/mcp

MCP server for Atlassian Cloud, built with [FastMCP](https://github.com/punkpeye/fastmcp).

## Tools

| Tool | Description |
|------|-------------|
| `jira_get_issue` | Get a Jira issue by key or ID |
| `jira_search_issues` | Search issues with JQL (auto-paginated), optional `limit` and `fields` |
| `jira_delete_issue` | Preview or delete a Jira issue with `force` + `confirm` |
| `jira_get_sprint` | Get a Jira sprint by ID |
| `jira_list_sprints` | List sprints for a board, optionally filtered by state |
| `jira_list_sprint_issues` | List all issues in a sprint (auto-paginated) |
| `jira_create_sprint` | Create a future sprint on a board |
| `jira_edit_sprint` | Edit sprint metadata or state |
| `jira_close_sprint` | Preview or close a sprint with `force` + `confirm`; can move issues first |
| `jira_rollover_sprint_issues` | Preview or move sprint issues to another sprint or the backlog with `force` + `confirm` |
| `jira_add_attachment` | Upload file attachments to a Jira issue |
| `confluence_get_page` | Get a Confluence page by ID |
| `confluence_upload_attachment` | Upload one local file as an attachment to a Confluence page |
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
