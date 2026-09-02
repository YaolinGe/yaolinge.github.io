"use strict";

/* Money portal front end. No framework, no build step: the file you edit is
   the file the browser runs. */

const state = {
    config: null,
    entries: [],
    summary: null,
    problems: [],
    month: "",
    search: "",
    token: localStorage.getItem("money-token") || ""
};

const el = (id) => document.getElementById(id);

function headers() {
    const base = { "Content-Type": "application/json" };
    if (state.token) base["X-Money-Token"] = state.token;
    return base;
}

async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: headers() });
    let payload = {};
    try {
        payload = await response.json();
    } catch (error) {
        payload = { error: `server returned ${response.status}` };
    }
    if (response.status === 401) {
        const token = window.prompt("This portal needs its access token:");
        if (token) {
            state.token = token.trim();
            localStorage.setItem("money-token", state.token);
            return api(path, options);
        }
        throw new Error("token required");
    }
    if (!response.ok) throw new Error(payload.error || `request failed (${response.status})`);
    return payload;
}

function money(value) {
    const amount = Number(value || 0);
    const currency = state.config ? state.config.currency : "";
    return `${amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} ${currency}`.trim();
}

function monthLabel(month) {
    const [year, index] = month.split("-");
    const date = new Date(Number(year), Number(index) - 1, 1);
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function setMessage(text, kind = "") {
    const node = el("formMessage");
    node.textContent = text;
    node.className = `form-message ${kind}`.trim();
}

/* -- rendering -------------------------------------------------------- */

function renderCategoryInputs() {
    const chips = el("categoryChips");
    chips.textContent = "";
    state.config.categories.slice(0, 8).forEach((category) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = category;
        chip.setAttribute("aria-pressed", "false");
        chip.addEventListener("click", () => {
            el("category").value = category;
            syncChips();
        });
        chips.append(chip);
    });

    const list = el("categoryList");
    list.textContent = "";
    state.config.categories.forEach((category) => {
        const option = document.createElement("option");
        option.value = category;
        list.append(option);
    });

    const methods = el("method");
    methods.textContent = "";
    ["", ...state.config.methods].forEach((method) => {
        const option = document.createElement("option");
        option.value = method;
        option.textContent = method || "—";
        methods.append(option);
    });
}

function syncChips() {
    const current = el("category").value.trim().toLowerCase();
    document.querySelectorAll("#categoryChips .chip").forEach((chip) => {
        chip.setAttribute("aria-pressed", chip.textContent === current ? "true" : "false");
    });
}

function renderSummary() {
    const summary = state.summary;
    if (!summary) return;
    el("monthTotal").textContent = money(summary.month_total);
    el("todayTotal").textContent = money(summary.today);
    el("dailyAverage").textContent = money(summary.month_daily_average);
    el("allTimeTotal").textContent = money(summary.total);
    el("entryCount").textContent = summary.count;

    const bars = el("categoryBars");
    bars.textContent = "";
    const top = summary.by_category.slice(0, 8);
    const max = top.reduce((peak, row) => Math.max(peak, Number(row.total)), 0);
    top.forEach((row) => {
        const line = document.createElement("div");
        line.className = "bar-row";

        const label = document.createElement("span");
        label.textContent = row.category;

        const track = document.createElement("div");
        track.className = "bar-track";
        const fill = document.createElement("div");
        fill.className = "bar-fill";
        fill.style.width = max ? `${(Number(row.total) / max) * 100}%` : "0%";
        track.append(fill);

        const value = document.createElement("span");
        value.textContent = money(row.total);

        line.append(label, track, value);
        bars.append(line);
    });
}

function renderMonths() {
    const select = el("monthFilter");
    const months = state.summary ? state.summary.by_month.map((row) => row.month) : [];
    const current = state.summary ? state.summary.month : "";
    if (!months.includes(current)) months.push(current);
    const previous = state.month || current;
    select.textContent = "";
    [...months].reverse().forEach((month) => {
        const option = document.createElement("option");
        option.value = month;
        option.textContent = monthLabel(month);
        select.append(option);
    });
    select.value = months.includes(previous) ? previous : current;
    state.month = select.value;
}

function renderEntries() {
    const list = el("entryList");
    list.textContent = "";
    const needle = state.search.trim().toLowerCase();
    const visible = state.entries.filter((entry) => {
        if (state.month && !entry.date.startsWith(state.month)) return false;
        if (!needle) return true;
        return [entry.description, entry.category, entry.tags]
            .join(" ")
            .toLowerCase()
            .includes(needle);
    });

    el("emptyState").hidden = visible.length > 0;

    visible.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "entry";

        const main = document.createElement("div");
        main.className = "entry-main";
        const title = document.createElement("span");
        title.className = "entry-title";
        title.textContent = entry.description || entry.category;
        const meta = document.createElement("span");
        meta.className = "entry-meta";
        meta.textContent = [entry.date, entry.category, entry.method].filter(Boolean).join(" · ");
        main.append(title, meta);

        const amount = document.createElement("span");
        amount.className = "entry-amount";
        amount.textContent = `${Number(entry.amount).toFixed(2)} ${entry.currency}`;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteEntry(entry));

        item.append(main, amount, remove);
        list.append(item);
    });
}

function renderProblems() {
    const banner = el("problemBanner");
    if (!state.problems.length) {
        banner.hidden = true;
        return;
    }
    const lines = state.problems.map((problem) => `line ${problem.line} (${problem.field}: ${problem.error})`);
    banner.hidden = false;
    banner.textContent = `${state.problems.length} row(s) in the CSV could not be read and are not counted: ${lines
        .slice(0, 5)
        .join(", ")}`;
}

function renderAll() {
    renderSummary();
    renderMonths();
    renderEntries();
    renderProblems();
}

/* -- actions ---------------------------------------------------------- */

function applyState(payload) {
    state.entries = payload.entries || [];
    state.summary = payload.summary || state.summary;
    state.problems = payload.problems || [];
    renderAll();
}

async function refresh() {
    applyState(await api("/api/entries?limit=1000"));
}

async function submitEntry(event) {
    event.preventDefault();
    const button = el("submitBtn");
    button.disabled = true;
    const body = {
        id: crypto.randomUUID().replace(/-/g, ""),
        amount: el("amount").value,
        currency: el("currency").value,
        date: el("date").value,
        category: el("category").value,
        description: el("description").value,
        method: el("method").value,
        source: "portal"
    };
    try {
        const payload = await api("/api/entries", { method: "POST", body: JSON.stringify(body) });
        applyState(payload);
        const git = payload.git || {};
        const suffix = git.status === "committed" ? " · committed" : git.status === "failed" ? " · git failed" : "";
        setMessage(`Saved ${money(payload.entry.amount)}${suffix}`, "ok");
        el("amount").value = "";
        el("description").value = "";
        el("amount").focus();
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        button.disabled = false;
    }
}

async function deleteEntry(entry) {
    const label = entry.description || entry.category;
    if (!window.confirm(`Delete ${Number(entry.amount).toFixed(2)} ${entry.currency} (${label})?`)) return;
    try {
        applyState(await api(`/api/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" }));
        setMessage("Entry deleted", "ok");
    } catch (error) {
        setMessage(error.message, "error");
    }
}

/* -- boot ------------------------------------------------------------- */

async function start() {
    try {
        state.config = await api("/api/config");
    } catch (error) {
        // Most likely cause: this file was opened without the server behind it
        // (for example the copy published with the static site).
        setMessage(
            `${error.message}. This page needs the local portal running: ` +
            "cd tools/money-portal && python3 server.py",
            "error"
        );
        return;
    }
    const ledgerPath = el("ledgerPath");
    ledgerPath.textContent = state.config.ledger.split("/").pop();
    ledgerPath.title = state.config.ledger;
    el("currency").value = state.config.currency;
    el("date").value = state.config.today;
    el("gitStatus").textContent = `git sync: ${state.config.git_sync ? "on" : "off"}`;
    el("forgetToken").hidden = !state.token;
    renderCategoryInputs();

    el("entryForm").addEventListener("submit", submitEntry);
    el("category").addEventListener("input", syncChips);
    el("monthFilter").addEventListener("change", (event) => {
        state.month = event.target.value;
        renderEntries();
    });
    el("searchInput").addEventListener("input", (event) => {
        state.search = event.target.value;
        renderEntries();
    });
    el("scanBtn").addEventListener("click", () => {
        setMessage("Receipt scanning is not built yet - it will post to the same API.", "");
    });
    el("forgetToken").addEventListener("click", () => {
        localStorage.removeItem("money-token");
        state.token = "";
        el("forgetToken").hidden = true;
        setMessage("Token forgotten. Reload to enter a new one.", "");
    });

    await refresh();
}

start();
