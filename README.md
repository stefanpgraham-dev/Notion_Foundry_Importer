# Notion Journal Sync for Foundry VTT

A Foundry VTT v14 module for pulling Notion pages into Journal Entries and refreshing imported entries from Notion.

## Initial feature scope

- GM-only Notion browser button in the Journal directory.
- Configure and validate a Notion internal integration token.
- Search pages and data sources available to the integration.
- Import one page, a page branch, or all entries from a database into Foundry Journal folders.
- Sort database entries alphabetically and filter them by title or property values.
- Refresh imported entries from Notion while retaining Foundry folder placement and permissions.
- Track the source page ID and sync timestamp on each imported entry.
- Show or hide an imported entry for players directly from the browser.
- Keep imported entries private to the GM until the GM changes Foundry permissions.
- Render common Notion blocks and preserve links to unsupported/external content.

## Setup

1. Create a Notion internal integration with read-content capability.
2. Share the Notion page or database containing the material with that integration.
3. Install and enable this module in a Foundry v14 world.
4. Open the Notion button in the Journal directory and enter the integration token.

The integration token is stored as a client-scoped Foundry setting and is only used from the GM's client. It is not written into world settings or synced to players. Treat it as a secret: it grants the integration access to every page shared with it.

## Sync policy

Notion is the source of truth for imported titles and page content. Refresh updates those fields and the imported source page, while leaving Foundry folder placement and permission configuration alone. The module does not delete journal entries if a Notion page is removed or access is revoked.

This is a one-way importer. Foundry edits are not sent back to Notion.

## Notion block support

Paragraphs, headings, bulleted and numbered lists, quotes, callouts, code, dividers, bookmarks, links, and images are rendered where possible. Nested child pages are imported as entries in nested Foundry folders when importing a branch. Other blocks receive a readable fallback containing their block type and any available text.

## Repository and installation

The source is maintained in the public [Notion_Foundry_Importer GitHub repository](https://github.com/stefanpgraham-dev/Notion_Foundry_Importer).

Install through Foundry Setup → Add-on Modules → Install Module using this manifest URL:

`https://raw.githubusercontent.com/stefanpgraham-dev/Notion_Foundry_Importer/main/module.json`
