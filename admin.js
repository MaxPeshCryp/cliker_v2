const $ = selector => document.querySelector(selector)
let csrfToken = ""
let badgeCatalog = []
let selectedPlayer = null
let currentPage = 1
let searchQuery = ""
let busy = false
let listRequest = 0
let selectionRequest = 0

function status(message = "", error = false) {
    $("#adminStatus").textContent = message
    $("#adminStatus").classList.toggle("is-error", error)
}

function showLogin() {
    selectedPlayer = null
    selectionRequest++
    listRequest++
    $("#playersList").replaceChildren()
    $("#selectedName").textContent = ""
    $("#selectedEmail").textContent = ""
    $("#selectedBalance").textContent = ""
    $("#selectedBadges").replaceChildren()
    $("#badgeChoices").replaceChildren()
    if ($("#resetDialog").open) $("#resetDialog").close()
    $("#adminPanel").hidden = true
    $("#adminLogout").hidden = true
    $("#loginPanel").hidden = false
    $("#playerPanel").hidden = true
    $("#emptySelection").hidden = false
}

async function api(url, body) {
    const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: {"Content-Type": "application/json", "X-CSRF-Token": csrfToken},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
    })
    const data = await response.json().catch(() => ({error: "Сервер временно недоступен"}))
    if (!response.ok) {
        if (response.status === 401 && !url.endsWith("/login")) showLogin()
        throw new Error(data.error || "Ошибка сервера")
    }
    return data
}

async function run(task) {
    if (busy) return
    busy = true
    const panels = [$("#loginPanel"), $("#adminPanel"), $("#resetDialog")]
    panels.forEach(panel => { panel.inert = true })
    $("#adminLogout").disabled = true
    try { await task() } catch (error) { status(error.message, true) }
    finally {
        panels.forEach(panel => { panel.inert = false })
        $("#adminLogout").disabled = false
        busy = false
    }
}

async function openPanel(data) {
    csrfToken = data.csrfToken
    badgeCatalog = data.badges
    $("#loginPanel").hidden = true
    $("#adminPanel").hidden = false
    $("#adminLogout").hidden = false
    history.replaceState(null, "", "/admin")
    await loadPlayers()
}

async function loadPlayers() {
    const version = ++listRequest
    const data = await api(`/api/admin/users?q=${encodeURIComponent(searchQuery)}&page=${currentPage}`)
    if (version !== listRequest) return
    $("#totalPlayers").textContent = `Игроков: ${data.total}`
    $("#pageLabel").textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`
    $("#previousPage").disabled = currentPage === 1
    $("#nextPage").disabled = currentPage * data.pageSize >= data.total
    const buttons = data.users.map(player => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `player-item${selectedPlayer?.id === player.id ? " is-selected" : ""}`
        button.dataset.userId = String(player.id)
        button.setAttribute("aria-pressed", String(selectedPlayer?.id === player.id))
        const name = document.createElement("strong")
        name.textContent = `${player.nickname}${player.isVerified ? " ✓" : ""}`
        const email = document.createElement("small")
        email.textContent = `#${player.id} · ${player.email}`
        const balance = document.createElement("small")
        balance.textContent = `${player.isBanned ? "Заблокирован · " : ""}${player.balance} кликов`
        button.append(name, email, balance)
        button.addEventListener("click", () => run(async () => {
            const version = ++selectionRequest
            const data = await api(`/api/admin/users/${player.id}`)
            if (version !== selectionRequest) return
            $("#clickAmount").value = ""
            renderPlayer(data.user)
            await loadPlayers()
            status()
        }))
        return button
    })
    if (!buttons.length) {
        const empty = document.createElement("p")
        empty.className = "muted"
        empty.textContent = "Игроки не найдены."
        buttons.push(empty)
    }
    $("#playersList").replaceChildren(...buttons)
}

function renderPlayer(player) {
    selectedPlayer = player
    $("#emptySelection").hidden = true
    $("#playerPanel").hidden = false
    $("#selectedId").textContent = `АККАУНТ #${player.id}`
    $("#selectedName").textContent = player.nickname
    $("#selectedEmail").textContent = player.email
    $("#selectedBalance").textContent = `${player.balance} кликов`
    $("#selectedStatus").textContent = player.isBanned ? "Заблокирован" : "Активен"
    $("#selectedStatus").classList.toggle("is-banned", player.isBanned)
    $("#toggleBan").textContent = player.isBanned ? "Разбанить игрока" : "Забанить игрока"
    const boost = player.incomeBoost
    $("#incomeBoostStatus").textContent = boost.remaining > 0
        ? `×${boost.multiplier} до ${new Date(boost.until * 1000).toLocaleString("ru-RU")}` : "Сейчас обычный доход"
    $("#selectedBadges").replaceChildren(...player.badges.map(badge => {
        const span = document.createElement("span")
        span.className = "badge-tag"
        span.textContent = `${badge.symbol} ${badge.name}`
        return span
    }))
    renderBadgeChoices()
}

function renderBadgeChoices() {
    const owned = new Set(selectedPlayer.badges.map(badge => badge.id))
    const legend = document.createElement("legend")
    legend.className = "sr-only"
    legend.textContent = "Выбор бейджей для выдачи или отзыва"
    $("#badgeChoices").replaceChildren(legend, ...badgeCatalog.map(badge => {
        const label = document.createElement("label")
        label.className = `badge-choice${owned.has(badge.id) ? " is-owned" : ""}`
        const input = document.createElement("input")
        input.type = "checkbox"
        input.value = badge.id
        const symbol = document.createElement("span")
        symbol.className = "badge-symbol"
        symbol.textContent = badge.symbol
        symbol.setAttribute("aria-hidden", "true")
        const name = document.createElement("span")
        name.textContent = badge.name
        if (owned.has(badge.id)) {
            const note = document.createElement("small")
            note.textContent = "Уже выдан"
            name.append(note)
        }
        label.append(input, symbol, name)
        return label
    }))
}

async function perform(action, extra = {}) {
    if (!selectedPlayer) return
    const data = await api(`/api/admin/users/${selectedPlayer.id}/actions`, {action, ...extra})
    renderPlayer(data.user)
    status(data.message)
    await loadPlayers()
}

$("#adminLoginForm").addEventListener("submit", event => {
    event.preventDefault()
    run(async () => {
        const data = await api("/api/admin/login", {login: $("#adminLogin").value.trim(), password: $("#adminPassword").value})
        $("#adminLoginForm").reset()
        currentPage = 1
        searchQuery = ""
        $("#playerSearch").value = ""
        await openPanel(data)
        status("Вход выполнен. Выберите игрока.")
    })
})
$("#adminLogout").addEventListener("click", () => run(async () => {
    await api("/api/admin/logout", {})
    showLogin()
    history.replaceState(null, "", "/admin/login")
    const data = await api("/api/admin/session")
    csrfToken = data.csrfToken
    status("Вы вышли из админ-панели.")
}))
$("#searchForm").addEventListener("submit", event => {
    event.preventDefault()
    run(async () => { searchQuery = $("#playerSearch").value.trim(); currentPage = 1; await loadPlayers() })
})
$("#refreshPlayers").addEventListener("click", () => run(async () => {
    if (selectedPlayer) renderPlayer((await api(`/api/admin/users/${selectedPlayer.id}`)).user)
    await loadPlayers()
    status("Данные обновлены.")
}))
$("#previousPage").addEventListener("click", () => run(async () => { currentPage--; await loadPlayers() }))
$("#nextPage").addEventListener("click", () => run(async () => { currentPage++; await loadPlayers() }))
$("#balanceForm").addEventListener("submit", event => {
    event.preventDefault()
    const action = event.submitter?.value || "add_clicks"
    const amount = $("#clickAmount").value.trim()
    run(async () => { await perform(action, {amount}); $("#clickAmount").value = "" })
})
$("#incomeForm").addEventListener("submit", event => {
    event.preventDefault()
    const multiplier = Number($("#incomeMultiplier").value)
    const duration = Number($("#incomeDuration").value) * Number($("#incomeUnit").value)
    run(() => perform("income_boost", {multiplier, duration}))
})
$("#stopIncomeBoost").addEventListener("click", () => run(() => perform("stop_income_boost")))
$("#grantVerification").addEventListener("click", () => run(() => perform("grant_badges", {badges: ["verified"]})))
$("#revokeVerification").addEventListener("click", () => run(() => perform("revoke_badges", {badges: ["verified"]})))
for (const [selector, action] of [["#grantBadges", "grant_badges"], ["#revokeBadges", "revoke_badges"]]) {
    $(selector).addEventListener("click", () => {
        const badges = [...document.querySelectorAll("#badgeChoices input:checked")].map(input => input.value)
        if (!badges.length) return status("Выберите хотя бы один бейдж.", true)
        run(() => perform(action, {badges}))
    })
}
$("#toggleBan").addEventListener("click", () => run(() => perform(selectedPlayer.isBanned ? "unban" : "ban")))
$("#resetAccount").addEventListener("click", () => {
    $("#resetDescription").textContent = `Игрок «${selectedPlayer.nickname}» (#${selectedPlayer.id}) потеряет весь игровой прогресс. Действие необратимо.`
    $("#resetForm").reset()
    $("#resetDialog").showModal()
})
$("#cancelReset").addEventListener("click", () => $("#resetDialog").close())
$("#resetForm").addEventListener("submit", event => {
    event.preventDefault()
    const confirmation = $("#resetConfirmation").value.trim()
    if (confirmation !== String(selectedPlayer.id)) {
        $("#resetConfirmation").setCustomValidity("ID не совпадает с выбранным игроком")
        $("#resetConfirmation").reportValidity()
        return
    }
    run(async () => { await perform("reset", {confirmUserId: selectedPlayer.id}); $("#resetDialog").close() })
})
$("#resetConfirmation").addEventListener("input", event => event.target.setCustomValidity(""))

run(async () => {
    const data = await api("/api/admin/session")
    csrfToken = data.csrfToken
    if (data.authenticated) { await openPanel(data); status() }
    else {
        showLogin()
        status(data.configured ? "" : "Доступ ещё не настроен. Администратор сервера должен задать данные входа в .env.", !data.configured)
    }
})
