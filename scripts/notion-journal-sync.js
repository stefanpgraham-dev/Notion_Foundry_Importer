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
    const syncedAt = imported?.getFlag(MODULE_ID, "syncedAt");
    status.textContent = imported ? `Synced ${formatSyncTime(syncedAt)}` : "Not imported";
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
      status.textContent = `Synced ${formatSyncTime(currentEntry.getFlag(MODULE_ID, "syncedAt"))}`;
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
        if (show) {
          try {
            await setNotionPageKnown(page.id, true);
            ui.notifications.info("Journal entry is visible to players and the Notion page is tagged Known.");
          } catch (error) {
            ui.notifications.warn(`Journal entry is visible to players, but Notion could not be tagged Known: ${error.message}`);
          }
        } else {
          ui.notifications.info("Journal entry is now hidden from players.");
        }
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
        status.textContent = `Synced ${formatSyncTime(currentEntry.getFlag(MODULE_ID, "syncedAt"))} (with child pages)`;
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

  async showDataSource(database, source, { syncReport = null } = {}) {
    const root = this.element?.[0] ?? this.element;
    const results = root?.querySelector("[data-results]");
    const status = root?.querySelector("[data-status]");
    if (!results || !status) return;
    status.textContent = `Loading ${databaseTitle(database)}…`;
    results.replaceChildren();
    try {
      const pages = await queryDataSource(source.id);
      const folder = await getOrCreateFolder(databaseTitle(database));
      const compareTitle = (a, b) => notionPageTitle(a).localeCompare(notionPageTitle(b), undefined, { numeric: true, sensitivity: "base" });
      pages.sort(compareTitle);

      if (syncReport) {
        const summary = document.createElement("div");
        summary.className = "notion-sync-sync-summary";
        summary.textContent = `Sync complete: ${syncReport.added} added, ${syncReport.refreshed} refreshed, ${syncReport.skipped} unchanged, ${syncReport.failed.length} failed.`;
        results.append(summary);
        if (syncReport.failed.length) {
          const failedList = document.createElement("ul");
          failedList.className = "notion-sync-failed-list";
          for (const page of syncReport.failed) {
            const item = document.createElement("li");
            item.textContent = notionPageTitle(page);
            failedList.append(item);
          }
          results.append(failedList);
        }
      }

      const controls = document.createElement("div");
      controls.className = "notion-sync-database-controls";
      const databaseSearch = document.createElement("input");
      databaseSearch.type = "search";
      databaseSearch.className = "notion-sync-database-search";
      databaseSearch.placeholder = `Search entries in ${databaseTitle(database)}…`;
      databaseSearch.setAttribute("aria-label", `Search entries in ${databaseTitle(database)}`);
      controls.append(databaseSearch);

      const sortLabel = document.createElement("label");
      sortLabel.className = "notion-sync-sort-label";
      sortLabel.textContent = "Sort:";
      const sortSelect = document.createElement("select");
      sortSelect.className = "notion-sync-sort-select";
      sortSelect.setAttribute("aria-label", "Sort database entries");
      const sortOptions = [
        ["title", "Title A–Z"],
        ["last_edited_time", "Last edited (newest)"],
        ["created_time", "Created (newest)"]
      ];
      for (const [name, property] of Object.entries(pages[0]?.properties ?? {}).filter(([, property]) => property.type !== "title").sort(([a], [b]) => a.localeCompare(b))) {
        sortOptions.push([`property:${name}`, `Property: ${name}`]);
      }
      for (const [value, label] of sortOptions) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        sortSelect.append(option);
      }
      sortLabel.append(sortSelect);
      controls.append(sortLabel);
      results.append(controls);

      const actions = document.createElement("div");
      actions.className = "notion-sync-database-actions";
      const selectVisibleLabel = document.createElement("label");
      selectVisibleLabel.className = "notion-sync-select-visible";
      const selectVisible = document.createElement("input");
      selectVisible.type = "checkbox";
      selectVisibleLabel.append(selectVisible, document.createTextNode(" Select visible"));
      actions.append(selectVisibleLabel);

      const pullSelected = document.createElement("button");
      pullSelected.type = "button";
      pullSelected.disabled = true;
      pullSelected.innerHTML = '<i class="fa-solid fa-download"></i> Pull selected (0)';
      actions.append(pullSelected);

      const pullAll = document.createElement("button");
      pullAll.type = "button";
      pullAll.innerHTML = `<i class="fa-solid fa-download"></i> Pull all ${pages.length}`;
      actions.append(pullAll);

      const showSelected = document.createElement("button");
      showSelected.type = "button";
      showSelected.disabled = true;
      showSelected.innerHTML = '<i class="fa-solid fa-eye"></i> Show selected';
      actions.append(showSelected);

      const hideSelected = document.createElement("button");
      hideSelected.type = "button";
      hideSelected.disabled = true;
      hideSelected.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Hide selected';
      actions.append(hideSelected);

      const syncVisibility = document.createElement("button");
      syncVisibility.type = "button";
      syncVisibility.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Sync visibility';
      syncVisibility.title = "Set each imported page’s Notion Known tag to match its Foundry player visibility.";
      actions.append(syncVisibility);
      results.append(actions);

      const rows = pages.map(page => {
        const row = this.resultElement(page, { folder });
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "notion-sync-entry-select";
        checkbox.setAttribute("aria-label", `Select ${notionPageTitle(page)}`);
        row.prepend(checkbox);
        row.dataset.searchText = pageSearchText(page);
        results.append(row);
        return { page, row, checkbox };
      });

      const visibleRows = () => rows.filter(item => !item.row.hidden);
      const selectedVisible = () => visibleRows().filter(item => item.checkbox.checked);
      const updateSelectionControls = () => {
        const visible = visibleRows();
        const selected = selectedVisible();
        pullSelected.disabled = selected.length === 0;
        pullSelected.innerHTML = `<i class="fa-solid fa-download"></i> Pull selected (${selected.length})`;
        showSelected.disabled = selected.length === 0;
        hideSelected.disabled = selected.length === 0;
        selectVisible.checked = visible.length > 0 && visible.every(item => item.checkbox.checked);
        selectVisible.indeterminate = visible.some(item => item.checkbox.checked) && !selectVisible.checked;
      };
      for (const item of rows) item.checkbox.addEventListener("change", updateSelectionControls);

      const sortRows = () => {
        const mode = sortSelect.value;
        rows.sort((a, b) => compareDatabasePages(a.page, b.page, mode));
        for (const item of rows) results.append(item.row);
      };

      const updateFilter = () => {
        const query = normalizeSearchText(databaseSearch.value.trim());
        for (const item of rows) item.row.hidden = Boolean(query) && !item.row.dataset.searchText.includes(query);
        status.textContent = query
          ? `${visibleRows().length} of ${pages.length} database entries match “${databaseSearch.value.trim()}”.`
          : `${pages.length} database entr${pages.length === 1 ? "y" : "ies"} found. Search, sort, select, or pull entries.`;
        updateSelectionControls();
      };

      const synchronize = async targetRows => {
        const report = { added: 0, refreshed: 0, skipped: 0, failed: [] };
        pullSelected.disabled = pullAll.disabled = showSelected.disabled = hideSelected.disabled = true;
        for (const page of targetRows) {
          const imported = findImportedEntry(page.id);
          const lastEdited = page.last_edited_time ?? null;
          if (imported && lastEdited && imported.getFlag(MODULE_ID, "notionLastEditedTime") === lastEdited) {
            report.skipped++;
            continue;
          }
          const entry = await this.pull(page.id, notionPageTitle(page), { folder, confirmRefresh: false, quiet: true, skipRender: true });
          if (!entry) report.failed.push(page);
          else if (imported) report.refreshed++;
          else report.added++;
        }
        await this.showDataSource(database, source, { syncReport: report });
      };

      selectVisible.addEventListener("change", () => {
        for (const item of visibleRows()) item.checkbox.checked = selectVisible.checked;
        updateSelectionControls();
      });
      databaseSearch.addEventListener("input", updateFilter);
      sortSelect.addEventListener("change", sortRows);
      pullSelected.addEventListener("click", async () => {
        const selected = selectedVisible().map(item => item.page);
        if (!selected.length) return;
        const existing = selected.filter(page => findImportedEntry(page.id)).length;
        const confirmed = await Dialog.confirm({
          title: "Pull selected database entries",
          content: `<p>Sync ${selected.length} selected entries from <strong>${escapeHtml(databaseTitle(database))}</strong>?</p><p>${selected.length - existing} new; ${existing} already imported. Existing Foundry folders and permissions are preserved.</p>`
        });
        if (confirmed) await synchronize(selected);
      });
      pullAll.addEventListener("click", async () => {
        const existing = pages.filter(page => findImportedEntry(page.id)).length;
        const confirmed = await Dialog.confirm({
          title: "Pull all database entries",
          content: `<p>Sync all ${pages.length} entries from <strong>${escapeHtml(databaseTitle(database))}</strong>?</p><p>${pages.length - existing} new; ${existing} already imported. Existing Foundry folders and permissions are preserved.</p>`
        });
        if (confirmed) await synchronize(pages);
      });

      const changeSelectedVisibility = async visible => {
        const selected = selectedVisible();
        if (!selected.length) return;
        let changed = 0;
        let skipped = 0;
        for (const item of selected) {
          const entry = findImportedEntry(item.page.id);
          if (!entry) {
            skipped++;
            continue;
          }
          try {
            await entry.update({ ownership: { default: visible ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE } });
            if (visible) {
              try {
                await setNotionPageKnown(item.page.id, true);
              } catch (error) {
                ui.notifications.warn(`“${entry.name}” is visible in Foundry, but Notion could not be tagged Known: ${error.message}`);
              }
            }
            changed++;
          } catch (error) {
            ui.notifications.error(`Could not change visibility for “${entry.name}”: ${error.message}`);
            skipped++;
          }
        }
        ui.notifications.info(`${visible ? "Shown to" : "Hidden from"} players: ${changed} entr${changed === 1 ? "y" : "ies"}${skipped ? `; ${skipped} skipped` : ""}.`);
        await this.showDataSource(database, source);
      };
      showSelected.addEventListener("click", () => changeSelectedVisibility(true));
      hideSelected.addEventListener("click", () => changeSelectedVisibility(false));
      syncVisibility.addEventListener("click", async () => {
        const importedPages = pages.filter(page => findImportedEntry(page.id));
        if (!importedPages.length) {
          ui.notifications.info("There are no imported entries in this database to sync.");
          return;
        }
        const confirmed = await Dialog.confirm({
          title: "Sync Foundry visibility to Notion",
          content: `<p>Sync player visibility for ${importedPages.length} imported entries in <strong>${escapeHtml(databaseTitle(database))}</strong>?</p><p>Visible entries will be tagged Known; hidden entries will have Known removed. Other Notion tags are preserved.</p>`
        });
        if (!confirmed) return;
        syncVisibility.disabled = true;
        let synced = 0;
        let failed = 0;
        for (const page of importedPages) {
          const entry = findImportedEntry(page.id);
          const visible = (entry?.ownership?.default ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
          try {
            await setNotionPageKnown(page.id, visible);
            synced++;
          } catch (error) {
            failed++;
            ui.notifications.warn(`Could not sync “${notionPageTitle(page)}”: ${error.message}`);
          }
        }
        ui.notifications.info(`Visibility sync complete: ${synced} synced${failed ? `, ${failed} failed` : ""}.`);
        await this.showDataSource(database, source);
      });

      if (syncReport?.failed?.length) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.innerHTML = `<i class="fa-solid fa-rotate"></i> Retry ${syncReport.failed.length} failed`;
        retry.addEventListener("click", () => synchronize(syncReport.failed));
        results.insertBefore(retry, controls);
      }
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
        flags: {
          [MODULE_ID]: {
            notionPageId: page.id,
            notionUrl: page.url,
            syncedAt: new Date().toISOString(),
            notionLastEditedTime: page.last_edited_time ?? null
          }
        }
      };
      let entry;
      if (imported) {
        const contentPage = imported.pages.find(journalPage => journalPage.name === "Content");
        if (confirmRefresh) {
          const previousText = previewText(contentPage?.text?.content ?? "");
          const nextText = previewText(html);
          const previousSync = imported.getFlag(MODULE_ID, "syncedAt");
          const lastSynced = previousSync ? new Date(previousSync).toLocaleString() : "Not recorded";
          const truncate = value => value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
          const confirmed = await Dialog.confirm({
            title: "Refresh from Notion",
            content: `<p>Last synced: <strong>${escapeHtml(lastSynced)}</strong>. Review the current and incoming text before refreshing. Folder and permissions will be preserved.</p><div class="notion-sync-refresh-preview"><section><strong>In Foundry: ${escapeHtml(imported.name)}</strong><pre>${escapeHtml(truncate(previousText) || "(Empty)")}</pre></section><section><strong>From Notion: ${escapeHtml(data.name)}</strong><pre>${escapeHtml(truncate(nextText) || "(Empty)")}</pre></section></div>`
          });
          if (!confirmed) return null;
        }
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
          [`flags.${MODULE_ID}.syncedAt`]: data.flags[MODULE_ID].syncedAt,
          [`flags.${MODULE_ID}.notionLastEditedTime`]: data.flags[MODULE_ID].notionLastEditedTime,
          ...(hasKnownTag(page) ? { ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER } } : {})
        });
        entry = imported;
      } else {
        data.folder = folder?.id ?? null;
        data.ownership = {
          default: hasKnownTag(page) ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
          [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
        };
        entry = await JournalEntry.create(data);
      }
      if (includeChildren) await this.importChildPages(page.id, entry, { skipRender });
      if (!quiet) ui.notifications.info(`${imported ? "Refreshed" : "Imported"} “${data.name}” from Notion.`);
      if (!skipRender) this.render(true);
      return entry;
    } catch (error) {
      if (!quiet) ui.notifications.error(`Notion import failed: ${error.message}`);
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

function hasKnownTag(page) {
  const tagsProperty = Object.entries(page?.properties ?? {}).find(([name]) => name.trim().toLocaleLowerCase() === "tags")?.[1];
  return tagsProperty?.type === "multi_select"
    && tagsProperty.multi_select.some(tag => tag.name.trim().toLocaleLowerCase() === "known");
}

async function setNotionPageKnown(pageId, known) {
  const page = await notionRequest(`/pages/${encodeURIComponent(pageId)}`);
  const [propertyName, tagsProperty] = Object.entries(page.properties ?? {})
    .find(([name]) => name.trim().toLocaleLowerCase() === "tags") ?? [];
  if (!tagsProperty) throw new Error('No “Tags” property was found on the Notion page.');
  if (tagsProperty.type !== "multi_select") throw new Error('The Notion “Tags” property must be a multi-select property.');

  const tags = tagsProperty.multi_select ?? [];
  const hasKnown = tags.some(tag => tag.name.trim().toLocaleLowerCase() === "known");
  if (hasKnown === known) return false;
  const nextTags = known
    ? [...tags.map(tag => ({ name: tag.name })), { name: "Known" }]
    : tags.filter(tag => tag.name.trim().toLocaleLowerCase() !== "known").map(tag => ({ name: tag.name }));
  await notionRequest(`/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    body: {
      properties: {
        [propertyName]: {
          multi_select: nextTags
        }
      }
    }
  });
  return true;
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

function compareDatabasePages(a, b, mode) {
  let left;
  let right;
  let descending = false;
  if (mode === "last_edited_time" || mode === "created_time") {
    left = a[mode] ?? "";
    right = b[mode] ?? "";
    descending = true;
  } else if (mode.startsWith("property:")) {
    const name = mode.slice("property:".length);
    left = propertySortValue(a.properties?.[name]);
    right = propertySortValue(b.properties?.[name]);
  } else {
    left = notionPageTitle(a);
    right = notionPageTitle(b);
  }
  if (typeof left === "number" && typeof right === "number") return descending ? right - left : left - right;
  const compared = String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
  return descending ? -compared : compared;
}

function propertySortValue(property) {
  if (!property) return "";
  const value = property[property.type];
  if (property.type === "number") return value ?? Number.NEGATIVE_INFINITY;
  if (property.type === "checkbox") return value ? 1 : 0;
  if (property.type === "date") return value?.start ?? "";
  if (property.type === "select" || property.type === "status") return value?.name ?? "";
  if ((property.type === "formula" || property.type === "rollup") && value?.type) {
    return propertySortValue({ type: value.type, [value.type]: value[value.type] });
  }
  return searchableValue(value);
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

function previewText(html) {
  return new DOMParser().parseFromString(String(html ?? ""), "text/html").body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function formatSyncTime(value) {
  if (!value) return "time unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unknown" : date.toLocaleString();
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
