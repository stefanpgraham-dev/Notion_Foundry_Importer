const MODULE_ID = "notion-foundry-sync";
const NOTION_VERSION = "2026-03-11";
const API_BASE = "https://api.notion.com/v1";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "integrationToken", {
    name: "Notion integration token",
    hint: "Stored only in this GM client's settings. Keep it private.",
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
});

Hooks.once("ready", () => {
  document.addEventListener("click", async event => {
    const anchor = event.target.closest("a[data-notion-page-id]");
    if (!anchor || !game.user?.isGM) return;
    event.preventDefault();
    const pageId = anchor.dataset.notionPageId;
    let entry = findImportedEntry(pageId);
    if (!entry) {
      try {
        const page = await notionRequest(`/pages/${encodeURIComponent(pageId)}`);
        entry = await new NotionSyncBrowser().pull(page.id, notionPageTitle(page), { skipRender: true });
      } catch (error) {
        ui.notifications.error(`Could not import the linked Notion page: ${error.message}`);
      }
    }
    entry?.sheet?.render(true);
  });
});

Hooks.on("renderJournalDirectory", (_app, html) => {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".notion-sync-directory-button")) return;
  const controls = root.querySelector(".header-actions");
  if (!controls) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "notion-sync-directory-button";
  button.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Notion';
  button.title = "Browse and sync Notion pages";
  button.addEventListener("click", () => new NotionSyncBrowser().render(true));
  controls.append(button);
});

class NotionSyncBrowser extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "notion-sync-browser",
      title: "Notion Journal Sync",
      template: `modules/${MODULE_ID}/templates/browser.html`,
      width: 620,
      height: 650,
      resizable: true,
      classes: ["notion-sync-browser"]
    });
  }

  async getData() {
    return {
      configured: Boolean(game.settings.get(MODULE_ID, "integrationToken")),
      results: [],
      status: "Connect a Notion integration, then search pages it can access."
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = html instanceof HTMLElement ? html : html?.[0];
    root?.querySelector("[data-action='configure']")?.addEventListener("click", () => this.configure());
    root?.querySelector("[data-action='search']")?.addEventListener("click", () => this.search());
    root?.querySelector("[data-action='search-databases']")?.addEventListener("click", () => this.searchDataSources());
    root?.querySelector("[data-action='import-id']")?.addEventListener("click", () => this.importById());
    root?.querySelector("[data-search]")?.addEventListener("keydown", event => {
      if (event.key === "Enter") this.search();
    });
    root?.querySelectorAll("[data-action='pull']").forEach(button => {
      button.addEventListener("click", () => this.pull(button.dataset.pageId, button.dataset.title));
    });
    root?.querySelectorAll("[data-action='refresh']").forEach(button => {
      button.addEventListener("click", () => this.refresh(button.dataset.entryId));
    });
  }

  async configure() {
    const current = game.settings.get(MODULE_ID, "integrationToken");
    const content = `<div class="notion-sync-config">
      <p>Create a Notion internal integration with read-content capability, then share the pages you want it to read with that integration.</p>
      <label>Integration token <input type="password" name="token" autocomplete="off" value="${escapeAttribute(current)}"></label>
      <p class="hint">The token is stored only in this GM client's Foundry settings. Treat it like a password.</p>
    </div>`;
    new Dialog({
      title: "Connect Notion",
      content,
      buttons: {
        connect: {
          label: "Connect and validate",
          callback: async html => {
            const token = html.find("input[name='token']").val()?.trim();
            if (!token) return ui.notifications.warn("Enter a Notion integration token.");
            try {
              await notionRequest("/users/me", { token });
              await game.settings.set(MODULE_ID, "integrationToken", token);
              ui.notifications.info("Notion connection validated.");
              this.render(true);
            } catch (error) {
              ui.notifications.error(`Could not connect to Notion: ${error.message}`);
            }
          }
        },
        cancel: { label: "Cancel" }
      },
      default: "connect"
    }).render(true);
  }

  async search() {
    const root = this.element?.[0] ?? this.element;
    const query = root?.querySelector("[data-search]")?.value?.trim() ?? "";
    const results = root?.querySelector("[data-results]");
    const status = root?.querySelector("[data-status]");
    if (!results || !status) return;
    status.textContent = "Searching Notion…";
    results.replaceChildren();
    try {
      const response = await notionRequest("/search", {
        method: "POST",
        body: { query, filter: { property: "object", value: "page" }, page_size: 100 }
      });
      const pages = response.results ?? [];
      status.textContent = pages.length ? `${pages.length} page(s) found.` : "No pages found. Check that the integration has access to the page.";
      for (const page of pages) results.append(this.resultElement(page));
    } catch (error) {
      status.textContent = `Search failed: ${error.message}`;
    }
  }

  async searchDataSources() {
    const root = this.element?.[0] ?? this.element;
    const query = root?.querySelector("[data-search]")?.value?.trim() ?? "";
    const results = root?.querySelector("[data-results]");
    const status = root?.querySelector("[data-status]");
    if (!results || !status) return;
    status.textContent = "Searching Notion databases…";
    results.replaceChildren();
    try {
      const response = await notionRequest("/search", {
        method: "POST",
        body: { query, filter: { property: "object", value: "data_source" }, page_size: 100 }
      });
      const sources = response.results ?? [];
      status.textContent = sources.length ? `${sources.length} data source(s) found.` : "No data sources found. Check that the integration has access to the parent database.";
      for (const source of sources) {
        const row = document.createElement("div");
        row.className = "notion-sync-result";
        const label = document.createElement("span");
        label.className = "notion-sync-result-name";
        label.textContent = richTextTitle(source.title) || source.name || "Notion data source";
        row.append(label);
        const browse = document.createElement("button");
        browse.type = "button";
        browse.innerHTML = '<i class="fa-solid fa-folder-open"></i> Browse';
        browse.addEventListener("click", () => this.showDataSource({ title: source.title ?? [{ plain_text: label.textContent }] }, source));
        row.append(browse);
        results.append(row);
      }
    } catch (error) {
      status.textContent = `Database search failed: ${error.message}`;
    }
  }

  resultElement(page, { folder = null } = {}) {
    const title = notionPageTitle(page);
    const imported = findImportedEntry(page.id);
    const row = document.createElement("div");
    row.className = "notion-sync-result";
    const label = document.createElement("span");
    label.className = "notion-sync-result-name";
    label.textContent = title;
    row.append(label);
    const status = document.createElement("span");
    status.className = "notion-sync-status";
    status.textContent = imported ? "Imported" : "Not imported";
    row.append(status);
    const action = document.createElement("button");
    let currentEntry = imported;
    action.type = "button";
    action.dataset.pageId = page.id;
    action.dataset.title = title;
    action.dataset.action = imported ? "refresh" : "pull";
    if (imported) action.dataset.entryId = imported.id;
    action.innerHTML = imported ? '<i class="fa-solid fa-rotate"></i> Refresh' : '<i class="fa-solid fa-download"></i> Pull';
    action.addEventListener("click", async () => {
      currentEntry = currentEntry
        ? await this.refresh(currentEntry.id, { skipRender: true })
        : await this.pull(page.id, title, { folder, skipRender: true });
      if (!currentEntry) return;
      status.textContent = "Imported";
      action.dataset.action = "refresh";
      action.dataset.entryId = currentEntry.id;
      action.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
      visibility.disabled = false;
      updateVisibilityButton();
    });
    row.append(action);
    const visibility = document.createElement("button");
    visibility.type = "button";
    visibility.className = "notion-sync-visibility-button";
    row.append(visibility);
    const updateVisibilityButton = () => {
      const visible = (currentEntry?.ownership?.default ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
      visibility.title = visible ? "Hide this entry from players" : "Show this entry to players";
      visibility.setAttribute("aria-label", visibility.title);
      visibility.innerHTML = visible ? '<i class="fa-solid fa-eye-slash"></i> Hide' : '<i class="fa-solid fa-eye"></i> Show';
    };
    updateVisibilityButton();
    visibility.addEventListener("click", async () => {
      currentEntry = currentEntry ?? findImportedEntry(page.id);
      if (!currentEntry) {
        ui.notifications.warn("Pull this Notion page into Foundry before changing player visibility.");
        return;
      }
      const show = (currentEntry.ownership?.default ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
      try {
        await currentEntry.update({ ownership: { default: show ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE } });
        currentEntry = game.journal.get(currentEntry.id);
        updateVisibilityButton();
        ui.notifications.info(show ? "Journal entry is now visible to players." : "Journal entry is now hidden from players.");
      } catch (error) {
        ui.notifications.error(`Could not change journal visibility: ${error.message}`);
      }
    });
    if (!imported) {
      const branch = document.createElement("button");
      branch.type = "button";
      branch.title = "Import this page and child pages";
      branch.innerHTML = '<i class="fa-solid fa-folder-tree"></i> Branch';
      branch.addEventListener("click", async () => {
        currentEntry = await this.pull(page.id, title, { includeChildren: true, folder, skipRender: true });
        if (!currentEntry) return;
        status.textContent = "Imported with child pages";
        action.dataset.action = "refresh";
        action.dataset.entryId = currentEntry.id;
        action.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
        visibility.disabled = false;
        updateVisibilityButton();
      });
      row.append(branch);
    }
    return row;
  }

  async importById() {
    const root = this.element?.[0] ?? this.element;
    const input = root?.querySelector("[data-page-id]");
    const pageId = input?.value?.trim();
    if (!pageId) return ui.notifications.warn("Enter a Notion page ID or URL.");
    const normalized = pageId.match(/[0-9a-f]{32}/i)?.[0] ?? pageId;
    try {
      const page = await notionRequest(`/pages/${encodeURIComponent(normalized)}`);
      await this.pull(page.id, notionPageTitle(page));
      return;
    } catch (error) {
      try {
        const database = await notionRequest(`/databases/${encodeURIComponent(normalized)}`);
        const sources = database.data_sources ?? [];
        if (!sources.length) throw new Error("This database has no readable data source.");
        await this.showDataSource(database, sources[0]);
      } catch (databaseError) {
        ui.notifications.error(`Could not open that Notion page or database: ${databaseError.message}`);
      }
    }
  }

  async showDataSource(database, source) {
    const root = this.element?.[0] ?? this.element;
    const results = root?.querySelector("[data-results]");
    const status = root?.querySelector("[data-status]");
    if (!results || !status) return;
    status.textContent = `Loading ${databaseTitle(database)}…`;
    results.replaceChildren();
    try {
      const pages = (await queryDataSource(source.id)).sort((a, b) =>
        notionPageTitle(a).localeCompare(notionPageTitle(b), undefined, { numeric: true, sensitivity: "base" })
      );
      const folder = await getOrCreateFolder(databaseTitle(database));
      const databaseSearch = document.createElement("input");
      databaseSearch.type = "search";
      databaseSearch.className = "notion-sync-database-search";
      databaseSearch.placeholder = `Search entries in ${databaseTitle(database)}…`;
      databaseSearch.setAttribute("aria-label", `Search entries in ${databaseTitle(database)}`);
      results.append(databaseSearch);

      const pullAll = document.createElement("button");
      pullAll.type = "button";
      pullAll.innerHTML = `<i class="fa-solid fa-download"></i> Pull all ${pages.length} entries into “${escapeHtml(folder.name)}”`;
      pullAll.addEventListener("click", async () => {
        const importedCount = pages.filter(page => findImportedEntry(page.id)).length;
        const confirmed = await Dialog.confirm({
          title: importedCount ? "Import and refresh database" : "Import database",
          content: `<p>Import ${pages.length - importedCount} new entr${pages.length - importedCount === 1 ? "y" : "ies"}${importedCount ? ` and refresh ${importedCount} existing entr${importedCount === 1 ? "y" : "ies"}` : ""} into <strong>${escapeHtml(folder.name)}</strong>?</p><p>Existing Foundry folders and permissions will be preserved.</p>`
        });
        if (!confirmed) return;
        for (const page of pages) await this.pull(page.id, notionPageTitle(page), { folder, confirmRefresh: false, quiet: true, skipRender: true });
        ui.notifications.info(`Synchronized ${pages.length} entries from “${folder.name}”.`);
        await this.showDataSource(database, source);
      });
      results.append(pullAll);
      const rows = pages.map(page => {
        const row = this.resultElement(page, { folder });
        row.dataset.searchText = pageSearchText(page);
        results.append(row);
        return row;
      });
      const updateFilter = () => {
        const query = normalizeSearchText(databaseSearch.value.trim());
        let visibleCount = 0;
        for (const row of rows) {
          row.hidden = Boolean(query) && !row.dataset.searchText.includes(query);
          if (!row.hidden) visibleCount++;
        }
        status.textContent = query
          ? `${visibleCount} of ${pages.length} database entries match “${databaseSearch.value.trim()}”.`
          : `${pages.length} database entr${pages.length === 1 ? "y" : "ies"} found, sorted alphabetically. Pull individual entries or import the full database.`;
      };
      databaseSearch.addEventListener("input", updateFilter);
      updateFilter();
    } catch (error) {
      status.textContent = `Could not load database entries: ${error.message}`;
    }
  }

  async pull(pageId, title, { includeChildren = false, folder = null, confirmRefresh = true, quiet = false, skipRender = false } = {}) {
    try {
      const page = await notionRequest(`/pages/${encodeURIComponent(pageId)}`);
      const html = await pageToHtml(page.id);
      const imported = findImportedEntry(page.id);
      const data = {
        name: notionPageTitle(page) || title || "Untitled Notion page",
        pages: [{
          name: "Content",
          type: "text",
          text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML }
        }],
        flags: { [MODULE_ID]: { notionPageId: page.id, notionUrl: page.url, syncedAt: new Date().toISOString() } }
      };
      let entry;
      if (imported) {
        if (confirmRefresh) {
          const confirmed = await Dialog.confirm({
            title: "Refresh from Notion",
            content: `<p>Replace the imported title and body for <strong>${escapeHtml(imported.name)}</strong> with the current Notion content?</p><p>Foundry folder and permissions will be preserved.</p>`
          });
          if (!confirmed) return null;
        }
        const contentPage = imported.pages.find(journalPage => journalPage.name === "Content");
        if (contentPage) {
          await contentPage.update({
            "text.content": html,
            "text.format": CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
          });
        } else {
          await imported.createEmbeddedDocuments("JournalEntryPage", [{
            name: "Content",
            type: "text",
            text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML }
          }]);
        }
        await imported.update({
          name: data.name,
          [`flags.${MODULE_ID}.notionUrl`]: page.url,
          [`flags.${MODULE_ID}.syncedAt`]: data.flags[MODULE_ID].syncedAt
        });
        entry = imported;
      } else {
        data.folder = folder?.id ?? null;
        data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
        entry = await JournalEntry.create(data);
      }
      if (includeChildren) await this.importChildPages(page.id, entry, { skipRender });
      if (!quiet) ui.notifications.info(`${imported ? "Refreshed" : "Imported"} “${data.name}” from Notion.`);
      if (!skipRender) this.render(true);
      return entry;
    } catch (error) {
      ui.notifications.error(`Notion import failed: ${error.message}`);
      return null;
    }
  }

  async importChildPages(parentPageId, parentEntry, { skipRender = false } = {}) {
    const children = await getAllBlockChildren(parentPageId);
    const childPages = children.filter(block => block.type === "child_page");
    if (!childPages.length) return;
    const folder = await getOrCreateFolder(parentEntry.name, parentEntry.folder);
    for (const block of childPages) {
      const child = await notionRequest(`/pages/${encodeURIComponent(block.id)}`);
      await this.pull(child.id, notionPageTitle(child) || block.child_page?.title, { includeChildren: true, folder, confirmRefresh: false, quiet: true, skipRender });
    }
  }

  async refresh(entryId, { skipRender = false } = {}) {
    const entry = game.journal.get(entryId);
    const pageId = entry?.getFlag(MODULE_ID, "notionPageId");
    if (!entry || !pageId) return ui.notifications.warn("This entry is not linked to a Notion page.");
    return this.pull(pageId, entry.name, { skipRender });
  }
}

async function notionRequest(path, { token = game.settings.get(MODULE_ID, "integrationToken"), method = "GET", body } = {}) {
  if (!token) throw new Error("Connect a Notion integration first.");
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (![429, 503, 529].includes(response.status) || attempt === 3) {
      throw new Error(data.message ?? `${response.status} ${response.statusText}`);
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delay = retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error("Notion request failed after retries.");
}

async function getAllBlockChildren(blockId) {
  const blocks = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await notionRequest(`/blocks/${encodeURIComponent(blockId)}/children?${query}`);
    blocks.push(...(page.results ?? []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function queryDataSource(dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const response = await notionRequest(`/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
      method: "POST",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }
    });
    pages.push(...(response.results ?? []).filter(result => result.object === "page"));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return pages;
}

async function pageToHtml(pageId, depth = 0) {
  if (depth > 8) return "<p><em>[Nested content limit reached]</em></p>";
  const page = await notionRequest(`/pages/${encodeURIComponent(pageId)}`);
  const blocks = await getAllBlockChildren(pageId);
  const out = [];
  const properties = await renderPageProperties(page);
  if (properties) out.push(properties);
  out.push(await blocksToHtml(blocks, pageId, depth));
  return out.join("\n") || "<p><em>This Notion page has no readable body content.</em></p>";
}

async function blocksToHtml(blocks, pageId, depth = 0) {
  if (depth > 8) return "<p><em>[Nested content limit reached]</em></p>";
  const out = [];
  for (const block of blocks) {
    const rendered = block.type === "image"
      ? await renderImageBlock(block, pageId)
      : block.type === "table"
        ? await renderTableBlock(block)
        : renderBlock(block);
    if (rendered) out.push(rendered);
    if (block.has_children && block.type !== "child_page" && block.type !== "table") {
      const children = await blocksToHtml(await getAllBlockChildren(block.id), pageId, depth + 1);
      out.push(`<div class="notion-nested-block">${children}</div>`);
    }
  }
  return out.join("\n");
}

async function renderTableBlock(block) {
  const rows = await getAllBlockChildren(block.id);
  if (!rows.length) return "<p><em>[Empty table]</em></p>";
  const hasHeader = Boolean(block.table?.has_column_header);
  const markup = rows.map((row, index) => {
    const cells = (row.table_row?.cells ?? []).map(cell => `<${hasHeader && index === 0 ? "th" : "td"}>${renderRichText(cell)}</${hasHeader && index === 0 ? "th" : "td"}>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><tbody>${markup}</tbody></table>`;
}

function renderBlock(block) {
  const value = block[block.type] ?? {};
  const rich = renderRichText(value.rich_text ?? value.title ?? []);
  switch (block.type) {
    case "paragraph": return `<p>${rich}</p>`;
    case "heading_1": return `<h1>${rich}</h1>`;
    case "heading_2": return `<h2>${rich}</h2>`;
    case "heading_3": return `<h3>${rich}</h3>`;
    case "bulleted_list_item": return `<ul><li>${rich}</li></ul>`;
    case "numbered_list_item": return `<ol><li>${rich}</li></ol>`;
    case "table_row": return `<p>${(value.cells ?? []).map(cell => renderRichText(cell)).join(" | ")}</p>`;
    case "quote": return `<blockquote>${rich}</blockquote>`;
    case "callout": return `<blockquote><strong>${escapeHtml(value.icon?.emoji ?? "Note")}</strong> ${rich}</blockquote>`;
    case "code": return `<pre><code>${escapeHtml((value.rich_text ?? []).map(item => item.plain_text).join(""))}</code></pre>`;
    case "divider": return "<hr>";
    case "bookmark": return `<p><a href="${escapeAttribute(value.url ?? "#")}">${escapeHtml(value.url ?? "Bookmark")}</a></p>`;
    case "embed":
    case "file":
    case "pdf": return `<p><a href="${escapeAttribute(value.url ?? value.external?.url ?? value.file?.url ?? "#")}">Open ${escapeHtml(block.type)}</a></p>`;
    case "image": {
      const url = value.external?.url ?? value.file?.url;
      return url ? `<p><img src="${escapeAttribute(url)}" alt="${escapeAttribute(value.caption?.map(x => x.plain_text).join("") ?? "Notion image")}" style="max-width:100%"></p>` : "<p>[Image unavailable]</p>";
    }
    case "child_page": return `<p><strong>Subpage:</strong> ${escapeHtml(value.title ?? "Untitled")}</p>`;
    default: return rich ? `<p><em>${escapeHtml(block.type)}:</em> ${rich}</p>` : `<p><em>[${escapeHtml(block.type)} block]</em></p>`;
  }
}

async function renderPageProperties(page) {
  const rows = await Promise.all(Object.entries(page.properties ?? {})
    .filter(([, property]) => property.type !== "title")
    .map(async ([name, property]) => {
      const value = await formatProperty(property);
      return value ? `<tr><th>${escapeHtml(name)}</th><td>${value}</td></tr>` : "";
    }));
  const renderedRows = rows.filter(Boolean);
  return renderedRows.length ? `<table class="notion-page-properties"><tbody>${renderedRows.join("")}</tbody></table><hr>` : "";
}

async function formatProperty(property) {
  const value = property[property.type];
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) {
    if (property.type === "rich_text" || property.type === "title") return renderRichText(value);
    if (property.type === "multi_select") return escapeHtml(value.map(item => item.name).join(", "));
    if (property.type === "relation") {
      const labels = await Promise.all(value.map(async item => {
        try {
          const relatedPage = await notionRequest(`/pages/${encodeURIComponent(item.id)}`);
          const label = escapeHtml(notionPageTitle(relatedPage));
          const imported = findImportedEntry(item.id);
          return imported
            ? `<a class="content-link" data-link data-uuid="${escapeAttribute(imported.uuid)}">${label}</a>`
            : `<a href="${escapeAttribute(relatedPage.url ?? "#")}" data-notion-page-id="${escapeAttribute(item.id)}">${label}</a>`;
        } catch (_error) {
          return escapeHtml(item.id);
        }
      }));
      return labels.join(", ");
    }
    if (property.type === "people") return escapeHtml(value.map(item => item.name ?? item.person?.email ?? item.id).join(", "));
    if (property.type === "files") return value.map(item => {
      const link = item.file?.url ?? item.external?.url;
      const label = item.name ?? "File";
      return link ? `<a href="${escapeAttribute(link)}">${escapeHtml(label)}</a>` : escapeHtml(label);
    }).join(", ");
  }
  if (property.type === "select" || property.type === "status") return escapeHtml(value.name ?? "");
  if (property.type === "checkbox") return value ? "Yes" : "No";
  if (property.type === "date") return escapeHtml([value.start, value.end].filter(Boolean).join(" – "));
  if (property.type === "url" || property.type === "email") {
    const href = property.type === "email" ? `mailto:${value}` : value;
    return `<a href="${escapeAttribute(href)}">${escapeHtml(value)}</a>`;
  }
  if (property.type === "formula") return value.type ? await formatProperty({ type: value.type, [value.type]: value[value.type] }) : "";
  if (property.type === "rollup") return value.type ? await formatProperty({ type: value.type, [value.type]: value[value.type] }) : "";
  if (typeof value === "object") return escapeHtml(value.name ?? value.plain_text ?? JSON.stringify(value));
  return escapeHtml(value);
}

async function renderImageBlock(block, pageId) {
  const image = block.image ?? {};
  const source = image.external?.url ?? image.file?.url;
  const alt = image.caption?.map(item => item.plain_text).join("") || "Notion image";
  if (!source) return `<p><em>[${escapeHtml(alt)} unavailable]</em></p>`;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const blob = await response.blob();
    const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg")?.split(";")[0] || source.match(/\.(png|jpe?g|gif|webp|svg)(?:\?|$)/i)?.[1] || "png";
    const file = new File([blob], `${block.id}.${extension}`, { type: blob.type || `image/${extension}` });
    const target = `notion-journal-sync/${pageId.replace(/-/g, "")}`;
    await ensureDataDirectory(target);
    const uploaded = await foundry.applications.apps.FilePicker.upload("data", target, file, {}, { notify: false });
    const path = uploaded.path ?? uploaded.url ?? uploaded;
    return `<p><img src="${escapeAttribute(path)}" alt="${escapeAttribute(alt)}" style="max-width:100%"></p>`;
  } catch (_error) {
    return `<p><a href="${escapeAttribute(source)}">${escapeHtml(alt)} (open from Notion)</a></p>`;
  }
}

async function ensureDataDirectory(path) {
  const filePicker = foundry.applications.apps.FilePicker;
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await filePicker.browse("data", current);
    } catch (_error) {
      try {
        await filePicker.createDirectory("data", current);
      } catch (_createError) {
        // Another import may have created it between browse and create.
        await filePicker.browse("data", current);
      }
    }
  }
}

function renderRichText(items) {
  return (items ?? []).map(item => {
    const text = escapeHtml(item.plain_text ?? item.text?.content ?? "");
    const annotations = item.annotations ?? {};
    let html = text;
    if (annotations.code) html = `<code>${html}</code>`;
    if (annotations.bold) html = `<strong>${html}</strong>`;
    if (annotations.italic) html = `<em>${html}</em>`;
    if (annotations.strikethrough) html = `<s>${html}</s>`;
    if (annotations.underline) html = `<u>${html}</u>`;
    if (item.href) {
      const pageId = extractNotionId(item.href);
      const linked = pageId ? findImportedEntry(pageId) : null;
      html = linked
        ? `<a class="content-link" data-link data-uuid="${escapeAttribute(linked.uuid)}">${html}</a>`
        : pageId
          ? `<a href="${escapeAttribute(item.href)}" data-notion-page-id="${escapeAttribute(pageId)}">${html}</a>`
          : `<a href="${escapeAttribute(item.href)}">${html}</a>`;
    }
    return html;
  }).join("");
}

function notionPageTitle(page) {
  const titleProperty = Object.values(page.properties ?? {}).find(property => property.type === "title");
  const title = titleProperty?.title?.map(item => item.plain_text).join("") ?? page.title?.map(item => item.plain_text).join("");
  return title || "Untitled Notion page";
}

function databaseTitle(database) {
  return richTextTitle(database.title) || database.name || "Notion database";
}

function pageSearchText(page) {
  const values = [notionPageTitle(page)];
  for (const [name, property] of Object.entries(page.properties ?? {})) {
    values.push(name, searchableValue(property[property.type]));
  }
  return normalizeSearchText(values.join(" "));
}

function searchableValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(searchableValue).join(" ");
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !["id", "type", "icon", "created_by", "last_edited_by"].includes(key))
      .map(([, nested]) => searchableValue(nested))
      .join(" ");
  }
  return String(value);
}

function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function richTextTitle(value) {
  if (Array.isArray(value)) return value.map(item => item.plain_text ?? item.text?.content ?? "").join("");
  return typeof value === "string" ? value : "";
}

function findImportedEntry(pageId) {
  const normalized = normalizeNotionId(pageId);
  return game.journal.find(entry => normalizeNotionId(entry.getFlag(MODULE_ID, "notionPageId")) === normalized);
}

function extractNotionId(value) {
  const match = String(value ?? "").match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return match ?? null;
}

function normalizeNotionId(value) {
  return String(value ?? "").replace(/-/g, "").toLowerCase();
}

async function getOrCreateFolder(name, parent = null) {
  let folder = game.folders.find(item => item.type === "JournalEntry" && item.name === name && (item.folder?.id ?? null) === (parent?.id ?? null));
  if (!folder) folder = await Folder.create({ name, type: "JournalEntry", folder: parent?.id ?? null, sorting: "a", ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE } });
  return folder;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
