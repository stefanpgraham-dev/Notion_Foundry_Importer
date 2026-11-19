# Notion Journal Sync for Foundry VTT

A Foundry VTT v14 module for pulling Notion pages into Journal Entries and refreshing imported entries from Notion.

## Initial feature scope

- GM-only Notion browser button in the Journal directory.
- Configure and validate a Notion internal integration token.
- Search pages and data sources available to the integration.
- Search database entries by title and property values; sort by title, timestamps, or a database property.
- Select visible entries and bulk pull or change player visibility.
- Review a text preview before a manual refresh, and see the last sync time on imported entries.
- Batch sync reports added, refreshed, unchanged, and failed entries, with a retry action for failures.
- Import one page, a page branch, or all entries from a database into Foundry Journal folders.
- Sort database entries alphabetically and filter them by title or property values.
- Refresh imported entries from Notion while retaining Foundry folder placement and permissions.
- Track the source page ID and sync timestamp on each imported entry.
- Show or hide an imported entry for players directly from the browser.
- Import Notion pages tagged `Known` with player Observer access; other pages stay private to the GM by default.
- Mark a page `Known` in Notion when the GM uses Show in Foundry.
- Sync Foundry player visibility to the Notion `Known` tag for imported database entries.
- Render common Notion blocks, including visible image captions, and preserve links to unsupported/external content.

## Setup

1. Create a Notion internal integration with read-content and update-content capabilities. The `Tags` property must be a multi-select property for visibility sync.
2. Share the Notion page or database containing the material with that integration.
3. Install and enable this module in a Foundry v14 world.
4. Open the Notion button in the Journal directory and enter the integration token.

The integration token is stored as a client-scoped Foundry setting and is only used from the GM's client. It is not written into world settings or synced to players. Treat it as a secret: it grants the integration access to every page shared with it.

## Sync policy

Notion is the source of truth for imported titles and page content. A page-level manual refresh always fetches the page from Notion and shows a before/after text preview; confirming replaces the imported content and updates its sync time while preserving Foundry folder placement and permissions. Database Pull selected/Pull all skips imported pages whose Notion last-edited time has not changed. The module does not delete journal entries if a Notion page is removed or access is revoked.

Journal content flows from Notion to Foundry. A new import reads the Notion `Known` tag to set initial player visibility; refreshing an existing entry preserves its current Foundry permissions and does not write visibility back to Notion. **Sync visibility** is a separate Foundry-to-Notion operation: it adds or removes `Known` to match Foundry visibility and does not refresh journal content. **Show** adds `Known` immediately; **Hide** changes Foundry visibility, and **Sync visibility** removes `Known` in Notion. Other Notion tags are preserved. If Notion does not allow an update, Foundry visibility remains changed and the module reports the tagging failure.

## Notion block support

Paragraphs, headings, bulleted and numbered lists, quotes, callouts, code, dividers, bookmarks, links, and images are rendered where possible. Nested child pages are imported as entries in nested Foundry folders when importing a branch. Other blocks receive a readable fallback containing their block type and any available text.

## Repository and installation

The source is maintained in the public [Notion_Foundry_Importer GitHub repository](https://github.com/stefanpgraham-dev/Notion_Foundry_Importer).

Install through Foundry Setup → Add-on Modules → Install Module using this manifest URL:

`https://raw.githubusercontent.com/stefanpgraham-dev/Notion_Foundry_Importer/main/module.json`
