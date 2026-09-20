/* Flipkart Scraper — dashboard client.
 * Vanilla JS on purpose: no build step, no framework, no CDN.
 * Live updates arrive over SSE; commands go out as plain POSTs.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  const state = {
    stats: null,
    sort: { by: "scrapedAt", dir: "desc" },
    offset: 0,
    limit: 50,
    rows: [],
    total: 0,
    expanded: new Set(),
    seenKeys: new Set(),
    freshKeys: new Set(),
    failures: [],
    selectedFailures: new Set(),
    logs: [],
    view: "products",
  };

  const keyOf = (row) => row.pid || row.url;

  /** Conversion-funnel steps that have an above/below/equal filter. */
  const FUNNEL_STEPS = ["impressionToClick", "clickToCart", "cartToSale"];

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  function toast(message, isError) {
    const node = $("toast");
    node.textContent = message;
    node.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.className = "toast";
    }, 3800);
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* some routes return files, not JSON */
    }
    if (!res.ok) {
      throw new Error((body && (body.error || body.message)) || `${res.status} ${res.statusText}`);
    }
    return body;
  }

  function duration(ms) {
    if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return "—";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  const dash = (value) => (value === null || value === undefined || value === "" ? "—" : value);
  const num = (value) => (typeof value === "number" ? value.toLocaleString("en-IN") : "—");

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // ------------------------------------------------------------------
  // stats
  // ------------------------------------------------------------------
  function renderStats(stats) {
    state.stats = stats;

    $("status-pill").dataset.status = stats.status;
    $("status-text").textContent = stats.status;
    $("job-sub").textContent = stats.keyword
      ? `"${stats.keyword}" · pages ${stats.startPage + 1}–${stats.endPage}`
      : "No job yet";

    $("s-total").innerHTML = stats.totalIsEstimate
      ? `${num(stats.totalProducts)} <small>est.</small>`
      : num(stats.totalProducts);
    $("s-completed").textContent = num(stats.completedProducts);
    $("s-remaining").textContent = num(stats.remainingProducts);
    $("s-success").textContent = num(stats.successCount);
    $("s-failed").textContent = num(stats.failedCount);
    $("s-page").textContent = dash(stats.currentPage);
    $("s-product").textContent = dash(stats.currentProduct);
    $("s-elapsed").textContent = duration(stats.runningTimeMs);
    $("s-eta").textContent = duration(stats.estimatedRemainingMs);
    $("s-rate").textContent = stats.productsPerMinute ? stats.productsPerMinute.toFixed(1) : "0";

    $("p-percent").textContent = `${stats.progressPercent}%`;
    $("p-bar").style.width = `${Math.min(100, stats.progressPercent)}%`;
    $("p-label").textContent =
      stats.currentPage != null
        ? `Page ${stats.currentPage}${stats.currentProduct ? ` · product ${stats.currentProduct}` : ""}${
            stats.currentProductLabel ? ` · ${stats.currentProductLabel}` : ""
          }`
        : "Progress";

    const busy = stats.status === "running" || stats.status === "starting";
    $("btn-start").disabled = busy || stats.status === "paused";
    $("btn-pause").disabled = !busy;
    $("btn-resume").disabled = busy || stats.status === "stopping";
    $("btn-stop").disabled = !busy && stats.status !== "paused";
    $("btn-retry").disabled = busy;
    $("btn-retry-all").disabled = busy;
    $("btn-retry-selected").disabled = busy;
  }

  // ------------------------------------------------------------------
  // products
  // ------------------------------------------------------------------
  function collectFilters() {
    const value = (id) => $(id).value.trim();
    const multi = (id) => Array.from($(id).selectedOptions).map((o) => o.value);

    const params = new URLSearchParams();
    const put = (key, raw) => {
      if (raw !== "" && raw !== undefined && raw !== null) params.set(key, raw);
    };

    put("search", value("f-search"));
    put("fsn", value("f-fsn"));
    put("fsnMode", $("f-fsn-mode").value);
    for (const key of [
      "priceMin", "priceMax",
      "ratingMin", "ratingMax",
      "reviewCountMin", "reviewCountMax",
      "returnRateMin", "returnRateMax",
    ]) {
      put(key, value(`f-${key}`));
    }
    // Funnel steps only travel as a pair — an operator with no number (or the
    // other way round) means "no filter on this step".
    for (const step of FUNNEL_STEPS) {
      const op = $(`f-${step}Op`).value;
      const threshold = value(`f-${step}Value`);
      if (op && threshold !== "") {
        params.set(`${step}Op`, op);
        params.set(`${step}Value`, threshold);
      }
    }

    for (const key of ["quality", "returnPolicy", "returnRateColor", "isStartSellingEnable", "success", "page"]) {
      const list = multi(`f-${key}`);
      if (list.length) params.set(key, list.join(","));
    }

    params.set("sortBy", state.sort.by);
    params.set("sortDir", state.sort.dir);
    params.set("offset", String(state.offset));
    params.set("limit", String(state.limit));
    return params;
  }

  async function loadProducts() {
    const data = await api(`/api/products?${collectFilters().toString()}`);
    state.rows = data.rows;
    state.total = data.total;
    $("c-products").textContent = data.unfiltered;
    $("products-summary").textContent =
      data.total === data.unfiltered
        ? `${data.total} rows`
        : `${data.total} of ${data.unfiltered} rows`;
    renderProducts();
    renderPager();
  }

  const reloadProducts = debounce(() => {
    loadProducts().catch((err) => toast(err.message, true));
  }, 220);

  function statusBadge(row) {
    return row.success
      ? el("span", "badge ok", "OK")
      : el("span", "badge bad", "Failed");
  }

  function startSellingCell(row) {
    if (row.isStartSellingEnable === true) return el("span", "badge ok", "Enabled");
    if (row.isStartSellingEnable === false) return el("span", "badge warn", "Disabled");
    return el("span", "badge neutral", "None");
  }


  /**
   * The product's main image, as scraped from the product page.
   *
   * `mainImage` is a CDN URL the browser loads directly (lazily, so a long grid
   * does not fire hundreds of requests at once); a product whose image could not
   * be read, or an image the CDN refuses, falls back to a dash.
   */
  function productImageCell(row) {
    const td = el("td");
    if (!row.mainImage) {
      td.textContent = "—";
      return td;
    }

    const a = el("a");
    a.href = row.mainImage;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.title = row.title || "Open full image";

    const img = el("img", "p-thumb");
    img.src = row.mainImage;
    img.alt = row.title || "Product image";
    img.loading = "lazy";
    // A broken/blocked image would otherwise render as a torn-icon box.
    img.addEventListener("error", () => {
      td.textContent = "—";
    });

    a.appendChild(img);
    td.appendChild(a);
    return td;
  }

  function renderProducts() {
    const body = $("products-body");
    body.textContent = "";

    if (state.rows.length === 0) {
      const tr = el("tr");
      const td = el("td");
      td.colSpan = 15;
      td.appendChild(el("div", "empty-state", "No products yet. Start a job, or relax the filters."));
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    for (const row of state.rows) {
      const key = keyOf(row);
      const tr = el("tr");
      if (state.freshKeys.has(key)) tr.classList.add("new-row");

      const toggle = el("td");
      const caret = el("button", "tiny", state.expanded.has(key) ? "▾" : "▸");
      caret.title = "Show details";
      caret.addEventListener("click", () => {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderProducts();
      });
      toggle.appendChild(caret);
      tr.appendChild(toggle);

      tr.appendChild(el("td", "num", String(row.page)));
      tr.appendChild(el("td", "num", String(row.productIndex)));

      const statusTd = el("td");
      statusTd.appendChild(statusBadge(row));
      tr.appendChild(statusTd);

      tr.appendChild(productImageCell(row));

      tr.appendChild(el("td", "mono", dash(row.fsn)));
      tr.appendChild(el("td", "num", row.price === null ? "—" : `₹${num(row.price)}`));
      tr.appendChild(el("td", "num", row.rating === null ? "—" : row.rating.toFixed(1)));
      tr.appendChild(el("td", "num", num(row.reviewCount)));
      tr.appendChild(el("td", null, dash(row.returnPolicy)));
      tr.appendChild(el("td", null, dash(row.quality)));

      const rateTd = el("td");
      if (row.returnRate) {
        if (row.returnRateColor) {
          const swatch = el("span", "swatch");
          swatch.style.background = row.returnRateColor;
          swatch.title = row.returnRateColor;
          rateTd.appendChild(swatch);
        }
        rateTd.appendChild(document.createTextNode(row.returnRate));
      } else {
        rateTd.textContent = "—";
      }
      tr.appendChild(rateTd);

      const ssTd = el("td");
      ssTd.appendChild(startSellingCell(row));
      tr.appendChild(ssTd);

      const linksTd = el("td");
      const link = (href, label) => {
        if (!href) return;
        const a = el("a", null, label);
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        linksTd.appendChild(a);
        linksTd.appendChild(document.createTextNode(" "));
      };
      link(row.url, "Product");
      link(row.latchOnUrl, "Latch");
      link(row.startSellingUrl, "Sell");
      if (!linksTd.childNodes.length) linksTd.textContent = "—";
      tr.appendChild(linksTd);

      const detailsTd = el("td");
      const detailsBtn = el("button", "tiny", state.expanded.has(key) ? "Hide" : "Details");
      detailsBtn.addEventListener("click", () => {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderProducts();
      });
      detailsTd.appendChild(detailsBtn);
      tr.appendChild(detailsTd);

      body.appendChild(tr);

      if (state.expanded.has(key)) body.appendChild(detailRow(row));
    }

    state.freshKeys.clear();
  }

  /** The expandable panel — structured UI for the three complex fields. */
  function detailRow(row) {
    const tr = el("tr", "detail");
    const td = el("td");
    td.colSpan = 15;
    const inner = el("div", "detail-inner");

    // ---- Conversion Funnel ----
    const funnelCard = el("div", "detail-card");
    funnelCard.appendChild(el("h4", null, "Conversion Funnel"));
    if (row.conversionFunnel) {
      const wrap = el("div", "funnel");
      const steps = [
        ["Impression to Click", row.conversionFunnel.impressionToClick],
        ["Click to Cart", row.conversionFunnel.clickToCart],
        ["Cart to Sale", row.conversionFunnel.cartToSale],
      ];
      for (const [label, value] of steps) {
        const step = el("div", "funnel-step");
        const head = el("div", "label");
        head.appendChild(el("span", null, label));
        head.appendChild(el("b", null, `${value}%`));
        step.appendChild(head);
        const meter = el("div", "meter");
        const fill = el("i");
        fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
        meter.appendChild(fill);
        step.appendChild(meter);
        wrap.appendChild(step);
      }
      funnelCard.appendChild(wrap);
    } else {
      funnelCard.appendChild(el("div", "empty-note", "No conversion funnel data."));
    }
    inner.appendChild(funnelCard);

    // ---- Sales Rank ----
    const rankCard = el("div", "detail-card");
    rankCard.appendChild(el("h4", null, "Sales Rank"));
    if (row.salesRank && row.salesRank.length) {
      const table = el("table", "mini");
      const thead = el("thead");
      const hr = el("tr");
      hr.appendChild(el("th", null, "Category"));
      hr.appendChild(el("th", null, "Rank"));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const entry of row.salesRank) {
        const r = el("tr");
        r.appendChild(el("td", null, entry.category));
        r.appendChild(el("td", "num", `#${entry.rank}`));
        tbody.appendChild(r);
      }
      table.appendChild(tbody);
      rankCard.appendChild(table);
    } else {
      rankCard.appendChild(el("div", "empty-note", "No sales rank data."));
    }
    inner.appendChild(rankCard);

    // ---- Top Return Reasons ----
    const reasonCard = el("div", "detail-card");
    reasonCard.appendChild(el("h4", null, "Top Return Reasons"));
    if (row.topReturnReasons && row.topReturnReasons.length) {
      const wrap = el("div", "funnel");
      for (const reason of row.topReturnReasons) {
        const step = el("div", "funnel-step");
        const head = el("div", "label");
        head.appendChild(el("span", null, reason.reason));
        head.appendChild(el("b", null, `${reason.percentage}%`));
        step.appendChild(head);
        const meter = el("div", "meter warm");
        const fill = el("i");
        fill.style.width = `${Math.max(0, Math.min(100, reason.percentage))}%`;
        meter.appendChild(fill);
        step.appendChild(meter);
        wrap.appendChild(step);
      }
      reasonCard.appendChild(wrap);
    } else {
      reasonCard.appendChild(el("div", "empty-note", "No return reasons recorded."));
    }
    inner.appendChild(reasonCard);

    // ---- error, when the row failed ----
    if (!row.success && row.error) {
      const errCard = el("div", "detail-card");
      errCard.appendChild(el("h4", null, "Failure Reason"));
      errCard.appendChild(el("div", null, row.error));
      inner.appendChild(errCard);
    }

    td.appendChild(inner);
    tr.appendChild(td);
    return tr;
  }

  function renderPager() {
    const from = state.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.limit, state.total);
    $("pager-label").textContent = `${from}–${to} of ${state.total}`;
    $("btn-prev").disabled = state.offset <= 0;
    $("btn-next").disabled = state.offset + state.limit >= state.total;
  }

  async function loadFilterOptions() {
    const options = await api("/api/products/filter-options");
    const fill = (id, values, labeller) => {
      const select = $(id);
      const chosen = new Set(Array.from(select.selectedOptions).map((o) => o.value));
      select.textContent = "";
      for (const value of values) {
        const option = el("option", null, labeller ? labeller(value) : String(value));
        option.value = String(value);
        if (chosen.has(String(value))) option.selected = true;
        select.appendChild(option);
      }
    };
    fill("f-quality", options.quality);
    fill("f-returnPolicy", options.returnPolicy);
    fill("f-returnRateColor", options.returnRateColor);
    fill("f-page", options.pages, (p) => `Page ${p}`);
  }

  // ------------------------------------------------------------------
  // failures
  // ------------------------------------------------------------------
  async function loadFailures() {
    const params = new URLSearchParams();
    const search = $("ff-search").value.trim();
    if (search) params.set("search", search);
    params.set("status", $("ff-status").value);
    params.set("errorType", $("ff-type").value);

    const data = await api(`/api/failures?${params.toString()}`);
    state.failures = data.rows;
    $("c-failures").textContent = data.rows.filter((f) => f.status !== "resolved").length;

    // Keep the error-type filter in sync with what actually exists.
    const typeSelect = $("ff-type");
    const current = typeSelect.value;
    typeSelect.textContent = "";
    const allOption = el("option", null, "All error types");
    allOption.value = "all";
    typeSelect.appendChild(allOption);
    for (const type of data.errorTypes) {
      const option = el("option", null, type);
      option.value = type;
      typeSelect.appendChild(option);
    }
    typeSelect.value = data.errorTypes.includes(current) ? current : "all";

    renderFailures();
  }

  const reloadFailures = debounce(() => {
    loadFailures().catch((err) => toast(err.message, true));
  }, 220);

  function renderFailures() {
    const body = $("failures-body");
    body.textContent = "";

    if (state.failures.length === 0) {
      const tr = el("tr");
      const td = el("td");
      td.colSpan = 11;
      td.appendChild(el("div", "empty-state", "No failures recorded. "));
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    for (const failure of state.failures) {
      const tr = el("tr");

      const pickTd = el("td");
      const pick = el("input");
      pick.type = "checkbox";
      pick.checked = state.selectedFailures.has(failure.id);
      pick.addEventListener("change", () => {
        if (pick.checked) state.selectedFailures.add(failure.id);
        else state.selectedFailures.delete(failure.id);
      });
      pickTd.appendChild(pick);
      tr.appendChild(pickTd);

      const expandTd = el("td");
      const caret = el("button", "tiny", state.expanded.has(failure.id) ? "▾" : "▸");
      caret.addEventListener("click", () => {
        if (state.expanded.has(failure.id)) state.expanded.delete(failure.id);
        else state.expanded.add(failure.id);
        renderFailures();
      });
      expandTd.appendChild(caret);
      tr.appendChild(expandTd);

      tr.appendChild(el("td", "num", String(failure.page)));
      tr.appendChild(el("td", "num", String(failure.productIndex)));
      tr.appendChild(el("td", "mono", dash(failure.fsn || failure.pid)));

      const typeTd = el("td");
      typeTd.appendChild(el("span", "badge bad", failure.errorType));
      tr.appendChild(typeTd);

      tr.appendChild(el("td", null, failure.stage));
      tr.appendChild(el("td", "mono", new Date(failure.failedAt).toLocaleString()));
      tr.appendChild(el("td", "num", String(failure.retryCount)));

      const statusTd = el("td");
      const cls =
        failure.status === "resolved" ? "badge ok" : failure.status === "retrying" ? "badge warn" : "badge bad";
      statusTd.appendChild(el("span", cls, failure.status));
      tr.appendChild(statusTd);

      const actionTd = el("td");
      const retryBtn = el("button", "tiny", "Retry");
      retryBtn.addEventListener("click", () => retryFailures([failure.id]));
      actionTd.appendChild(retryBtn);
      tr.appendChild(actionTd);

      body.appendChild(tr);

      if (state.expanded.has(failure.id)) {
        const detail = el("tr", "detail");
        const td = el("td");
        td.colSpan = 11;
        const inner = el("div", "detail-inner");

        const info = el("div", "detail-card");
        info.appendChild(el("h4", null, "Failure Detail"));
        const dl = el("table", "mini");
        const rows = [
          ["FSN", failure.fsn || "—"],
          ["PID", failure.pid || "—"],
          ["Page / Product", `${failure.page} / ${failure.productIndex}`],
          ["Failure time", new Date(failure.failedAt).toLocaleString()],
          ["Failure stage", failure.stage],
          ["Error type", failure.errorType],
          ["Retry count", String(failure.retryCount)],
          ["Status", failure.status],
        ];
        for (const [k, v] of rows) {
          const r = el("tr");
          r.appendChild(el("th", null, k));
          r.appendChild(el("td", null, v));
          dl.appendChild(r);
        }
        info.appendChild(dl);
        const urlLine = el("div", null, "");
        const a = el("a", null, failure.url);
        a.href = failure.url;
        a.target = "_blank";
        a.rel = "noreferrer";
        urlLine.appendChild(a);
        info.appendChild(urlLine);
        inner.appendChild(info);

        const msg = el("div", "detail-card");
        msg.appendChild(el("h4", null, "Error Message"));
        msg.appendChild(el("div", null, failure.message));
        if (failure.stack) {
          const stack = el("pre", "stack", failure.stack);
          msg.appendChild(stack);
        }
        inner.appendChild(msg);

        const shot = el("div", "detail-card shot-link");
        shot.appendChild(el("h4", null, "Failure Screenshot"));
        if (failure.screenshot) {
          const href = `/api/${failure.screenshot.replace(/^screenshots\//, "screenshots/")}`;
          const link = el("a", null, "Open full size");
          link.href = href;
          link.target = "_blank";
          link.rel = "noreferrer";
          shot.appendChild(link);
          const img = el("img");
          img.src = href;
          img.alt = "Failure screenshot";
          img.loading = "lazy";
          shot.appendChild(img);
        } else {
          shot.appendChild(el("div", "empty-note", "No screenshot could be captured (page was already closed)."));
        }
        inner.appendChild(shot);

        td.appendChild(inner);
        detail.appendChild(td);
        body.appendChild(detail);
      }
    }
  }

  async function retryFailures(ids) {
    try {
      const body = ids && ids.length ? JSON.stringify({ ids }) : JSON.stringify({});
      toast(ids && ids.length ? `Retrying ${ids.length} product(s)…` : "Retrying all failed products…");
      const result = await api("/api/failures/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      toast(`Retry finished — ${result.recovered}/${result.attempted} recovered.`);
      state.selectedFailures.clear();
      await Promise.all([loadFailures(), loadProducts()]);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ------------------------------------------------------------------
  // logs
  // ------------------------------------------------------------------
  const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

  function appendLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > 1000) state.logs.shift();
    if (state.view === "logs") renderLogs();
  }

  function renderLogs() {
    const box = $("log-box");
    const threshold = $("log-level").value;
    const min = threshold === "all" ? -1 : LEVEL_ORDER[threshold];
    const shouldFollow = $("log-follow").checked;

    box.textContent = "";
    for (const entry of state.logs) {
      if (LEVEL_ORDER[entry.level] < min) continue;
      const line = el("div", `log-line ${entry.level}`);
      line.appendChild(el("span", "ts", new Date(entry.ts).toLocaleTimeString()));
      line.appendChild(el("span", "ev", entry.event));
      line.appendChild(el("span", "msg", entry.message));
      box.appendChild(line);
    }
    if (shouldFollow) box.scrollTop = box.scrollHeight;
  }

  // ------------------------------------------------------------------
  // exports
  // ------------------------------------------------------------------
  async function loadExports() {
    const data = await api("/api/exports");
    const body = $("exports-body");
    body.textContent = "";
    if (!data.files.length) {
      const tr = el("tr");
      const td = el("td");
      td.colSpan = 4;
      td.appendChild(el("div", "empty-state", "No Excel files yet — one is written each time a page completes."));
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const file of data.files) {
      const tr = el("tr");
      tr.appendChild(el("td", "mono", file.name));
      tr.appendChild(el("td", "num", `${Math.round(file.size / 1024)} KB`));
      tr.appendChild(el("td", null, new Date(file.modified).toLocaleString()));
      const td = el("td");
      const a = el("a", null, "Download");
      a.href = `/api/exports/download/${encodeURIComponent(file.name)}`;
      td.appendChild(a);
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  // ------------------------------------------------------------------
  // SSE
  // ------------------------------------------------------------------
  function connect() {
    const source = new EventSource("/api/stream");

    source.addEventListener("open", () => {
      $("conn-state").textContent = "live";
    });
    source.addEventListener("error", () => {
      // EventSource retries on its own; just reflect the state.
      $("conn-state").textContent = "reconnecting…";
    });

    source.addEventListener("stats", (event) => renderStats(JSON.parse(event.data)));

    source.addEventListener("product", (event) => {
      const product = JSON.parse(event.data);
      const key = keyOf(product);
      if (!state.seenKeys.has(key)) {
        state.seenKeys.add(key);
        state.freshKeys.add(key);
      }
      // Refetch so server-side filters/sorting stay authoritative; debounced so
      // a burst of products costs one request.
      if ($("auto-follow").checked) reloadProducts();
      loadFilterOptions().catch(() => {});
    });

    source.addEventListener("failure", () => reloadFailures());

    source.addEventListener("export", (event) => {
      const info = JSON.parse(event.data);
      if (!info.skipped) {
        toast(info.page ? `page-${info.page}.xlsx generated (${info.rows} rows)` : `Master export ready (${info.rows} rows)`);
      }
      if (state.view === "exports") loadExports().catch(() => {});
    });

    source.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));

    source.addEventListener("status", (event) => {
      const { status } = JSON.parse(event.data);
      if (status === "completed" || status === "stopped" || status === "failed") {
        loadProducts().catch(() => {});
        loadFailures().catch(() => {});
        loadExports().catch(() => {});
      }
    });
  }

  // ------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------
  function wire() {
    // tabs
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => {
        for (const other of document.querySelectorAll(".tab")) other.classList.remove("active");
        for (const view of document.querySelectorAll(".view")) view.classList.remove("active");
        tab.classList.add("active");
        state.view = tab.dataset.view;
        $(`view-${state.view}`).classList.add("active");
        if (state.view === "logs") renderLogs();
        if (state.view === "exports") loadExports().catch((err) => toast(err.message, true));
        if (state.view === "failures") loadFailures().catch((err) => toast(err.message, true));
      });
    }

    // job controls
    $("btn-start").addEventListener("click", async () => {
      try {
        await api("/api/job/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: $("keyword").value,
            startPage: Number($("startPage").value),
            endPage: Number($("endPage").value),
            fresh: $("fresh").value === "true",
          }),
        });
        toast("Job started.");
      } catch (err) {
        toast(err.message, true);
      }
    });

    const command = (id, path, label) => {
      $(id).addEventListener("click", async () => {
        try {
          await api(path, { method: "POST" });
          toast(label);
        } catch (err) {
          toast(err.message, true);
        }
      });
    };
    command("btn-pause", "/api/job/pause", "Pausing after the current product…");
    command("btn-resume", "/api/job/resume", "Resumed.");
    command("btn-stop", "/api/job/stop", "Stopping…");

    $("btn-retry").addEventListener("click", () => retryFailures());
    $("btn-retry-all").addEventListener("click", () => retryFailures());
    $("btn-retry-selected").addEventListener("click", () => {
      const ids = Array.from(state.selectedFailures);
      if (!ids.length) {
        toast("Select at least one failed product first.", true);
        return;
      }
      retryFailures(ids);
    });

    $("ff-all").addEventListener("change", (event) => {
      state.selectedFailures.clear();
      if (event.target.checked) {
        for (const failure of state.failures) state.selectedFailures.add(failure.id);
      }
      renderFailures();
    });

    // exports
    $("btn-export-page").addEventListener("click", async () => {
      const current = state.stats && state.stats.currentPage;
      const pageNo = current ?? Number.parseInt(prompt("Export which page number?") ?? "", 10);
      if (!Number.isFinite(pageNo) || pageNo < 1) {
        toast("No current page to export.", true);
        return;
      }
      try {
        const result = await api(`/api/exports/page/${pageNo}`, { method: "POST" });
        toast(`${result.file} generated (${result.rows} rows).`);
        if (state.view === "exports") loadExports().catch(() => {});
      } catch (err) {
        toast(err.message, true);
      }
    });

    const exportAll = async () => {
      try {
        toast("Building the master workbook…");
        const result = await api("/api/exports/all", { method: "POST" });
        toast(`${result.file} generated (${result.rows} rows).`);
        if (state.view === "exports") loadExports().catch(() => {});
      } catch (err) {
        toast(err.message, true);
      }
    };
    $("btn-export-all").addEventListener("click", exportAll);
    $("btn-export-all-2").addEventListener("click", exportAll);
    $("btn-refresh-exports").addEventListener("click", () => loadExports().catch((err) => toast(err.message, true)));

    const downloadLogs = () => {
      window.location.href = "/api/logs/download";
    };
    $("btn-logs").addEventListener("click", downloadLogs);
    $("btn-logs-2").addEventListener("click", downloadLogs);
    $("log-level").addEventListener("change", renderLogs);

    // filters
    $("btn-apply").addEventListener("click", () => {
      state.offset = 0;
      reloadProducts();
    });
    $("btn-clear").addEventListener("click", () => {
      for (const input of document.querySelectorAll(".filter-body input")) input.value = "";
      for (const select of document.querySelectorAll(".filter-body select[multiple]")) {
        for (const option of select.options) option.selected = false;
      }
      // Single-value selects aren't covered by either loop above; only the
      // funnel operators reset here, so the FSN mode keeps its choice.
      for (const select of document.querySelectorAll(".filter-body select[data-funnel-op]")) {
        select.value = "";
      }
      state.offset = 0;
      reloadProducts();
    });
    $("f-search").addEventListener("input", () => {
      state.offset = 0;
      reloadProducts();
    });
    $("f-fsn").addEventListener("input", () => {
      state.offset = 0;
      reloadProducts();
    });
    // Switching a funnel operator is a deliberate one-click action, so it
    // re-queries straight away; the threshold box still goes through Apply.
    for (const step of FUNNEL_STEPS) {
      $(`f-${step}Op`).addEventListener("change", () => {
        state.offset = 0;
        reloadProducts();
      });
    }

    // sorting
    for (const th of document.querySelectorAll("th.sortable")) {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (state.sort.by === field) {
          state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort.by = field;
          state.sort.dir = "asc";
        }
        for (const other of document.querySelectorAll("th.sortable")) {
          other.textContent = other.textContent.replace(/\s*[▲▼]$/, "");
        }
        th.textContent = `${th.textContent} ${state.sort.dir === "asc" ? "▲" : "▼"}`;
        state.offset = 0;
        reloadProducts();
      });
    }

    // paging
    $("page-size").addEventListener("change", () => {
      state.limit = Number($("page-size").value);
      state.offset = 0;
      reloadProducts();
    });
    $("btn-prev").addEventListener("click", () => {
      state.offset = Math.max(0, state.offset - state.limit);
      reloadProducts();
    });
    $("btn-next").addEventListener("click", () => {
      state.offset += state.limit;
      reloadProducts();
    });

    // failure filters
    for (const id of ["ff-search", "ff-status", "ff-type"]) {
      $(id).addEventListener("input", reloadFailures);
      $(id).addEventListener("change", reloadFailures);
    }
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  async function boot() {
    wire();
    connect();

    try {
      const snapshot = await api("/api/job/stats");
      renderStats(snapshot.stats);
      if (snapshot.checkpoint.keyword) {
        $("keyword").value = snapshot.checkpoint.keyword;
        $("startPage").value = snapshot.checkpoint.startPage;
        $("endPage").value = snapshot.checkpoint.endPage;
      }
      if (snapshot.canResume) {
        toast("An unfinished job was found — press Resume to continue where it stopped.");
      }
    } catch (err) {
      toast(err.message, true);
    }

    try {
      const logs = await api("/api/logs?limit=300");
      state.logs = logs.entries;
    } catch {
      /* logs are optional at boot */
    }

    await Promise.all([
      loadFilterOptions().catch(() => {}),
      loadProducts().catch((err) => toast(err.message, true)),
      loadFailures().catch(() => {}),
      loadExports().catch(() => {}),
    ]);

    for (const row of state.rows) state.seenKeys.add(keyOf(row));
    state.freshKeys.clear();
  }

  boot();
})();
