"use strict";

/* Admin: money tracking and blog writing.
   No framework and no build step - the file you edit is the file that runs. */

const state = {
    me: null,
    money: null,
    posts: [],
    payer: "y",
    type: "f",
    month: "",
    search: "",
    editingSlug: null,
    previewing: false,
};

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
    let payload = {};
    try {
        payload = await response.json();
    } catch {
        payload = { error: `server returned ${response.status}` };
    }
    if (!response.ok) {
        const error = new Error(payload.error ?? `request failed (${response.status})`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

const kr = (value) =>
    `${Number(value || 0).toLocaleString("nb-NO", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })} kr`;

function monthName(month) {
    const [year, index] = month.split("-");
    return new Date(Number(year), Number(index) - 1, 1)
        .toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function say(node, message, kind = "") {
    node.textContent = message;
    node.className = `message ${kind}`.trim();
}

function banner(message) {
    const node = el("banner");
    node.hidden = !message;
    node.textContent = message ?? "";
}

/* ---------------------------------------------------------------- money -- */

function buildToggle(node, options, selected, onPick) {
    node.textContent = "";
    for (const [value, label] of Object.entries(options)) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "radio");
        button.dataset.value = value;
        button.textContent = label;
        button.setAttribute("aria-checked", String(value === selected));
        button.addEventListener("click", () => onPick(value));
        node.append(button);
    }
}

function renderToggles() {
    const { people, types } = state.money;
    buildToggle(el("payerToggle"), people, state.payer, (value) => {
        state.payer = value;
        renderToggles();
    });
    buildToggle(el("typeToggle"), types, state.type, (value) => {
        state.type = value;
        renderToggles();
    });
    const payer = people[state.payer];
    const other = people[state.payer === "y" ? "v" : "y"];
    el("typeHint").textContent =
        state.type === "f"
            ? `Split 50/50: ${other} will owe ${payer} half of it.`
            : state.type === state.payer
              ? `${payer} paid for ${payer}: the balance does not move.`
              : `${payer} paid for ${other}: ${other} will owe the whole amount.`;
}

function renderCategories() {
    const chips = el("categoryChips");
    chips.textContent = "";
    for (const category of state.money.categories.slice(0, 10)) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = category;
        chip.setAttribute("aria-pressed", "false");
        chip.addEventListener("click", () => {
            el("category").value = category;
            syncChips();
        });
        chips.append(chip);
    }
    const list = el("categoryList");
    list.textContent = "";
    for (const category of state.money.categories) {
        const option = document.createElement("option");
        option.value = category;
        list.append(option);
    }
}

function syncChips() {
    const current = el("category").value.trim().toLowerCase();
    for (const chip of document.querySelectorAll("#categoryChips button")) {
        chip.setAttribute("aria-pressed", String(chip.textContent === current));
    }
}

function renderBalance() {
    const { settlement } = state.money;
    el("balanceSentence").textContent = settlement.balance.settled
        ? "All square"
        : `${settlement.balance.debtorName} owes ${settlement.balance.creditorName} ` +
          `${kr(settlement.balance.amount)}`;

    const people = el("people");
    people.textContent = "";
    for (const [key, person] of Object.entries(settlement.people)) {
        const card = document.createElement("div");
        card.className = "person";
        card.dataset.person = key;
        const name = document.createElement("b");
        name.textContent = person.name;
        const paid = document.createElement("span");
        paid.append("paid ", varNode(kr(person.paid)));
        const borne = document.createElement("span");
        borne.append("own share ", varNode(kr(person.borne)));
        card.append(name, paid, borne);
        people.append(card);
    }
}

function varNode(value) {
    const node = document.createElement("var");
    node.textContent = value;
    return node;
}

function renderDuplicates() {
    const box = el("duplicates");
    const duplicates = state.money.duplicates ?? [];
    box.textContent = "";
    box.hidden = duplicates.length === 0;
    if (!duplicates.length) return;
    box.append(document.createTextNode("Recorded more than once:"));
    const list = document.createElement("ul");
    for (const group of duplicates) {
        const item = document.createElement("li");
        item.textContent =
            `${group.date} ${group.category} ${kr(group.amount)} "${group.description}" ` +
            `(${group.count} times)`;
        list.append(item);
    }
    box.append(list);
}

function renderBars() {
    const bars = el("categoryBars");
    bars.textContent = "";
    const top = state.money.settlement.byCategory.slice(0, 8);
    const max = top.reduce((peak, row) => Math.max(peak, Number(row.total)), 0);
    for (const row of top) {
        const line = document.createElement("div");
        line.className = "bar";
        const label = document.createElement("span");
        label.textContent = row.category;
        const track = document.createElement("div");
        track.className = "bar-track";
        const fill = document.createElement("div");
        fill.className = "bar-fill";
        fill.style.width = max ? `${(Number(row.total) / max) * 100}%` : "0%";
        track.append(fill);
        const value = document.createElement("span");
        value.textContent = kr(row.total);
        line.append(label, track, value);
        bars.append(line);
    }
}

function renderMonths() {
    const select = el("monthFilter");
    const months = state.money.settlement.byMonth.map((row) => row.month).reverse();
    const previous = state.month;
    select.textContent = "";
    for (const [value, label] of [["", "All months"], ...months.map((m) => [m, monthName(m)])]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.append(option);
    }
    select.value = months.includes(previous) ? previous : "";
    state.month = select.value;
}

function renderExpenses() {
    const list = el("expenseList");
    list.textContent = "";
    const needle = state.search.trim().toLowerCase();
    const visible = state.money.expenses.filter((expense) => {
        if (state.month && !expense.isoDate.startsWith(state.month)) return false;
        if (!needle) return true;
        return `${expense.description} ${expense.category}`.toLowerCase().includes(needle);
    });
    el("noRows").hidden = visible.length > 0;

    for (const expense of visible) {
        const item = document.createElement("li");
        item.className = "row";
        item.dataset.payer = expense.payer;

        const main = document.createElement("div");
        main.className = "row-main";
        const title = document.createElement("div");
        title.className = "row-title";
        title.textContent = expense.description || expense.category;
        const meta = document.createElement("div");
        meta.className = "row-meta";
        meta.textContent = `${expense.isoDate} - ${expense.category} - ` +
            `${state.money.people[expense.payer]} paid - ${state.money.types[expense.type]}`;
        main.append(title, meta);

        const amount = document.createElement("span");
        amount.className = "row-amount";
        amount.textContent = kr(expense.amount);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteExpense(expense));

        item.append(main, amount, remove);
        list.append(item);
    }
}

function renderMoney() {
    renderBalance();
    renderDuplicates();
    renderBars();
    renderMonths();
    renderExpenses();
}

async function loadMoney() {
    state.money = await api("/api/expenses");
    renderToggles();
    renderCategories();
    renderMoney();
}

async function submitExpense(event) {
    event.preventDefault();
    const button = el("addExpense");
    const body = () => ({
        amount: el("amount").value,
        payer: state.payer,
        type: state.type,
        category: el("category").value,
        date: el("date").value,
        description: el("description").value,
    });
    button.disabled = true;
    try {
        await send(body());
    } catch (error) {
        if (error.status === 409 && error.payload?.duplicateOf?.length) {
            const existing = error.payload.duplicateOf[0];
            const ok = window.confirm(
                `The same row is already there (${existing.isoDate}, ${existing.category}, ` +
                `${kr(existing.amount)}, ${state.money.people[existing.payer]} paid).\n\nAdd it anyway?`
            );
            if (ok) {
                try {
                    await send({ ...body(), allowDuplicate: true });
                } catch (retry) {
                    say(el("expenseMessage"), retry.message, "error");
                }
            } else {
                say(el("expenseMessage"), "Not added - it was already recorded.");
            }
        } else {
            say(el("expenseMessage"), error.message, "error");
        }
    } finally {
        button.disabled = false;
    }
}

async function send(payload) {
    const result = await api("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
    state.money = result;
    renderCategories();
    renderMoney();
    say(el("expenseMessage"), `Added ${kr(result.entry.amount)}`, "ok");
    el("amount").value = "";
    el("description").value = "";
    el("amount").focus();
}

async function deleteExpense(expense) {
    const label = expense.description || expense.category;
    if (!window.confirm(`Delete ${kr(expense.amount)} (${label})?`)) return;
    try {
        state.money = await api(`/api/expenses/${encodeURIComponent(expense.id)}`, { method: "DELETE" });
        renderMoney();
        say(el("expenseMessage"), "Row deleted", "ok");
    } catch (error) {
        say(el("expenseMessage"), error.message, "error");
    }
}

/* ----------------------------------------------------------------- blog -- */

async function loadPosts() {
    const result = await api("/api/posts?drafts=1");
    state.posts = result.posts ?? [];
    renderPostList();
}

function renderPostList() {
    const list = el("postList");
    list.textContent = "";
    for (const post of state.posts) {
        const item = document.createElement("li");
        item.className = "row";
        item.dataset.status = post.status;

        const main = document.createElement("div");
        main.className = "row-main";
        const title = document.createElement("div");
        title.className = "row-title";
        title.textContent = post.title;
        const meta = document.createElement("div");
        meta.className = "row-meta";
        meta.textContent = `${post.date} - ${post.status}${post.legacyPath ? " - static file" : ""}`;
        main.append(title, meta);

        const view = document.createElement("a");
        view.className = "edit";
        view.textContent = "View";
        view.href = post.legacyPath ? `../${post.legacyPath}` : `../post.html?slug=${encodeURIComponent(post.slug)}`;

        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => openPost(post.slug));

        item.append(main, view, edit);
        list.append(item);
    }
}

async function openPost(slug) {
    try {
        const { post } = await api(`/api/posts/${encodeURIComponent(slug)}`);
        state.editingSlug = post.slug;
        el("postTitle").value = post.title;
        el("postDate").value = post.date;
        el("postSlug").value = post.slug;
        el("postStatus").value = post.status;
        el("postBody").value = post.markdown;
        el("deletePost").hidden = false;
        say(el("postMessage"), `Editing "${post.title}"`);
        showPreview(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
        say(el("postMessage"), error.message, "error");
    }
}

function newPost() {
    state.editingSlug = null;
    el("postTitle").value = "";
    el("postSlug").value = "";
    el("postBody").value = "";
    el("postStatus").value = "draft";
    el("postDate").value = new Date().toISOString().slice(0, 10);
    el("deletePost").hidden = true;
    showPreview(false);
    say(el("postMessage"), "New post");
    el("postTitle").focus();
}

async function savePost() {
    const button = el("savePost");
    button.disabled = true;
    try {
        const payload = {
            title: el("postTitle").value,
            date: el("postDate").value,
            markdown: el("postBody").value,
            status: el("postStatus").value,
        };
        const slug = el("postSlug").value.trim() || state.editingSlug;
        if (slug) payload.slug = slug;
        const { post } = await api("/api/posts", { method: "POST", body: JSON.stringify(payload) });
        state.editingSlug = post.slug;
        el("postSlug").value = post.slug;
        el("deletePost").hidden = false;
        say(el("postMessage"), `Saved as ${post.status}: /post.html?slug=${post.slug}`, "ok");
        await loadPosts();
        if (state.previewing) showPreview(true);
    } catch (error) {
        say(el("postMessage"), error.message, "error");
    } finally {
        button.disabled = false;
    }
}

async function removePost() {
    if (!state.editingSlug) return;
    if (!window.confirm(`Delete the post "${el("postTitle").value}"?`)) return;
    try {
        await api(`/api/posts/${encodeURIComponent(state.editingSlug)}`, { method: "DELETE" });
        say(el("postMessage"), "Post deleted", "ok");
        newPost();
        await loadPosts();
    } catch (error) {
        say(el("postMessage"), error.message, "error");
    }
}

/** The preview asks the server to render, so what you see is what gets stored. */
async function showPreview(on) {
    state.previewing = on;
    const preview = el("postPreview");
    preview.hidden = !on;
    if (!on) return;
    if (!state.editingSlug) {
        preview.textContent = "Save the post once, then the preview shows exactly what will be published.";
        return;
    }
    try {
        const { post } = await api(`/api/posts/${encodeURIComponent(state.editingSlug)}`);
        preview.innerHTML = post.html;
    } catch (error) {
        preview.textContent = error.message;
    }
}

/* ------------------------------------------------------------------ boot -- */

function showTab(name) {
    el("moneyPanel").hidden = name !== "money";
    el("blogPanel").hidden = name !== "blog";
    location.hash = name;
}

async function start() {
    try {
        state.me = await api("/api/me");
    } catch {
        state.me = { signedIn: false };
    }
    if (!state.me.signedIn) {
        el("whoami").textContent = "not signed in";
        banner("You are not signed in. Go to /login and come back.");
        return;
    }
    el("whoami").textContent =
        `${state.me.userDetails} (${state.me.roles.filter((role) => role !== "anonymous" && role !== "authenticated").join(", ") || "no roles"})`;

    el("date").value = new Date().toISOString().slice(0, 10);
    el("postDate").value = new Date().toISOString().slice(0, 10);

    el("expenseForm").addEventListener("submit", submitExpense);
    el("category").addEventListener("input", syncChips);
    el("monthFilter").addEventListener("change", (event) => {
        state.month = event.target.value;
        renderExpenses();
    });
    el("searchInput").addEventListener("input", (event) => {
        state.search = event.target.value;
        renderExpenses();
    });
    el("tabMoneyLink").addEventListener("click", (event) => {
        event.preventDefault();
        showTab("money");
    });
    el("tabBlogLink").addEventListener("click", (event) => {
        event.preventDefault();
        showTab("blog");
    });
    el("savePost").addEventListener("click", savePost);
    el("newPost").addEventListener("click", newPost);
    el("deletePost").addEventListener("click", removePost);
    el("togglePreview").addEventListener("click", () => showPreview(!state.previewing));
    el("postTitle").addEventListener("blur", () => {
        if (!el("postSlug").value && !state.editingSlug && el("postTitle").value) {
            el("postSlug").value = "";  // the server derives it; leave blank to accept that
        }
    });

    if (state.me.canWriteMoney) {
        try {
            await loadMoney();
        } catch (error) {
            banner(`Could not load the money data: ${error.message}`);
        }
    } else {
        el("moneyPanel").hidden = true;
    }

    if (state.me.canWriteBlog) {
        try {
            await loadPosts();
        } catch (error) {
            banner(`Could not load posts: ${error.message}`);
        }
    } else {
        el("blogPanel").hidden = true;
        el("tabBlogLink").hidden = true;
    }

    showTab(location.hash === "#blog" && state.me.canWriteBlog ? "blog" : "money");
}

start();
