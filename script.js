const changeLogin = document.querySelector("#changeLogin")
const formRegister = document.querySelector("#form-register")
const formLogin = document.querySelector("#form-login")
const changeRegister = document.querySelector("#change-register")
const gameBlock = document.querySelector("#game")
const gameLayout = document.querySelector("#gameLayout")
const buttonClickMe = document.querySelector("#clickMe")
const buttonClickForceUpgrade = document.querySelector("#clickForceUpgrade")
const robotsIncome = document.querySelector("#robotsIncome")
const robotsList = document.querySelector("#robotsList")
const prestigePanel = document.querySelector("#prestigePanel")
const endgameContent = document.querySelector("#endgameContent")
const endgameTabs = document.querySelector(".endgame-tabs")
const leaderboardTabs = document.querySelector("#leaderboardTabs")
const NUMBER_SUFFIXES = [
    { value: 1, suffix: "", className: "count-rank-base" },
    { value: 1e3, suffix: "K", className: "count-rank-k" },
    { value: 1e6, suffix: "M", className: "count-rank-m" },
    { value: 1e9, suffix: "B", className: "count-rank-b" },
    { value: 1e12, suffix: "T", className: "count-rank-t" },
    { value: 1e15, suffix: "Qa", className: "count-rank-qa" },
    { value: 1e18, suffix: "Qi", className: "count-rank-qi" },
    { value: 1e21, suffix: "Sx", className: "count-rank-sx" },
    { value: 1e24, suffix: "Sp", className: "count-rank-sp" },
    { value: 1e27, suffix: "Oc", className: "count-rank-oc" },
    { value: 1e30, suffix: "No", className: "count-rank-no" },
    { value: 1e33, suffix: "Dc", className: "count-rank-dc" }
]

let gameState = null
let incomeTimer = null
let actionQueue = Promise.resolve()
let activeEndgameTab = "research"
let activeLeaderboardSort = "total_earned"
let lastRankingIncomeTotal = null
const rankingIncomeAnimations = new Map()
let levelNoticeTimer = null

if (new URLSearchParams(window.location.search).get("login") === "1") {
    formRegister.style.display = "none"
    formLogin.style.display = "block"
    history.replaceState(null, "", window.location.pathname)
}

document.querySelector("#logoutButton").addEventListener("click", async event => {
    const button = event.currentTarget
    button.disabled = true
    button.textContent = "Выходим…"
    gameLayout.inert = true
    clearInterval(incomeTimer)
    incomeTimer = null
    try {
        // Finish already queued purchases before clearing the server session.
        await actionQueue
        await apiRequest("/api/logout", {method: "POST"})
        // A fresh document clears all account data, drafts and mini-game timers.
        window.location.replace("/?login=1")
    } catch (error) {
        gameLayout.inert = false
        button.disabled = false
        button.textContent = "Выйти из аккаунта"
        startIncomeCollection()
        alert(`Не удалось выйти: ${error.message}. Попробуйте ещё раз.`)
    }
})

changeLogin.onclick = function () {
    formRegister.style.display = "none"
    formLogin.style.display = "block"
}

changeRegister.onclick = function () {
    formRegister.style.display = "block"
    formLogin.style.display = "none"
}

formRegister.addEventListener("submit", async (event) => {
    event.preventDefault()
    try {
        const response = await apiRequest("/api/register", {
            method: "POST",
            body: JSON.stringify({
                nickname: formRegister.querySelector("#nik-register").value.trim(),
                email: formRegister.querySelector("#email-register").value.trim(),
                password: formRegister.querySelector("#password-register").value
            })
        })
        alert(response.message)
        formRegister.reset()
        formRegister.style.display = "none"
        formLogin.style.display = "block"
    } catch (error) {
        alert(error.message)
    }
})

formLogin.addEventListener("submit", async (event) => {
    event.preventDefault()
    try {
        const state = await apiRequest("/api/login", {
            method: "POST",
            body: JSON.stringify({
                email: formLogin.querySelector("#email-login").value.trim(),
                password: formLogin.querySelector("#password-login").value
            })
        })
        alert(`Добро пожаловать ${state.userNik}. у вас кликов- ${formatNumber(state.userCount).text}`)
        formLogin.reset()
        openGame(state)
    } catch (error) {
        alert(error.message)
    }
})

buttonClickMe.addEventListener("click", () => {
    enqueueGameAction("/api/click")
})

buttonClickForceUpgrade.addEventListener("click", () => {
    enqueueGameAction("/api/click-upgrade")
})

robotsList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-robot-id]")
    if (!button || button.disabled) return
    enqueueGameAction(`/api/robots/${button.dataset.robotId}/upgrade`)
})

endgameTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-endgame-tab]")
    if (!button) return
    activeEndgameTab = button.dataset.endgameTab
    renderEndgame()
    renderAdOffers()
})

leaderboardTabs.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-leaderboard-sort]")
    if (!button || button.dataset.leaderboardSort === activeLeaderboardSort) return
    const previousSort = activeLeaderboardSort
    activeLeaderboardSort = button.dataset.leaderboardSort
    try {
        const leaderboard = await apiRequest("/api/leaderboard")
        gameState.leaderboard = leaderboard
        renderLeaderboard()
    } catch (error) {
        activeLeaderboardSort = previousSort
        alert(error.message)
    }
})

endgameContent.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]")
    if (!button || button.disabled) return
    const action = button.dataset.action
    const id = button.dataset.id
    if (action === "research") enqueueGameAction(`/api/research/${id}/upgrade`)
    if (action === "boost") enqueueGameAction(`/api/boosts/${id}/buy`)
    if (action === "cosmetic") enqueueGameAction(`/api/cosmetics/${id}/buy`)
    if (action === "collection") enqueueGameAction(`/api/collections/${id}/buy`)
    if (action === "collect-investments") enqueueGameAction("/api/investments/collect")
    if (action === "invest-all") {
        endgameContent.querySelector('[name="amount"]').value = gameState.userCountExact || String(gameState.userCount)
    }
})

endgameContent.addEventListener("submit", (event) => {
    if (!event.target.matches("#investmentForm")) return
    event.preventDefault()
    const formData = new FormData(event.target)
    enqueueGameAction("/api/investments/create", {
        amount: String(formData.get("amount") || "").trim(),
        plan: formData.get("plan")
    })
})

endgameContent.addEventListener("change", (event) => {
    if (!event.target.matches("#investmentPlan")) return
    const plan = gameState.catalog.investmentPlans[event.target.value]
    endgameContent.querySelector("#investmentPlanSummary").textContent = investmentPlanSummary(plan)
})

prestigePanel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]")
    if (!button || button.disabled) return
    if (button.dataset.action === "prestige") {
        if (confirm("Престиж сбросит баланс, обычных роботов, бусты и инвестиции за постоянный бонус. Продолжить?")) {
            enqueueGameAction("/api/prestige")
        }
    }
    if (button.dataset.action === "fusion") enqueueGameAction("/api/fusion")
})

function enqueueGameAction(url, body = null) {
    actionQueue = actionQueue
        .then(async () => {
            const options = { method: "POST" }
            if (body) options.body = JSON.stringify(body)
            const state = await apiRequest(url, options)
            applyGameState(state)
            showCollectedIncome(state.autoIncome)
            if (state.investmentResult) {
                const result = state.investmentResult
                alert(result.won + result.lost === 0 ? "Готовых инвестиций пока нет."
                    : `Успешных вкладов: ${result.won}. Неудачных: ${result.lost}. Возвращено: ${formatNumber(result.payout).text}. Потеряно: ${formatNumber(result.lostAmount).text}.`)
            } else if (Number(state.investmentPayout) > 0) alert(`Инвестиции вернули ${formatNumber(state.investmentPayout).text}`)
        })
        .catch((error) => alert(error.message))
}

async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), "X-Leaderboard-Sort": activeLeaderboardSort, ...(options.headers || {}) }
    })
    const data = await response.json().catch(() => ({error: response.status === 413 ? "Выберите картинку размером до 5 МБ" : "Сервер временно недоступен"}))
    if (!response.ok) {
        if (gameState && (response.status === 401 || data.error === "Аккаунт заблокирован администратором")) {
            clearInterval(incomeTimer)
            incomeTimer = null
            gameState = null
            gameLayout.style.display = "none"
            formLogin.style.display = "block"
            document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close())
            window.dispatchEvent(new Event("clicker:logout"))
            alert(data.error || "Требуется вход")
        }
        throw new Error(data.error || "Ошибка сервера")
    }
    return data
}

async function restoreSession() {
    try {
        openGame(await apiRequest("/api/state"))
    } catch (error) {
        if (error.message !== "Требуется вход") console.error(error)
    }
}

function openGame(state) {
    lastRankingIncomeTotal = null
    formRegister.style.display = "none"
    formLogin.style.display = "none"
    gameLayout.style.display = "grid"
    applyGameState(state)
    showCollectedIncome(state.autoIncome)
    startIncomeCollection()
    window.dispatchEvent(new Event("clicker:login"))
}

function applyGameState(state) {
    if (state.timedGames && gameState?.timedGames && state.timedGames.serverNow < gameState.timedGames.serverNow) return
    const previousTheme = gameState?.activeTheme
    const previousLevel = gameState?.progression?.level
    gameState = state
    if (previousTheme !== state.activeTheme) {
        Array.from(document.body.classList).filter(name => name.startsWith("theme-")).forEach(name => document.body.classList.remove(name))
        if (state.activeTheme && state.activeTheme !== "classic") document.body.classList.add(`theme-${state.activeTheme}`)
    }
    renderPlayerName(gameBlock.querySelector("#name"), state.userNik, state.isVerified, state.badges)
    renderPlayerName(document.querySelector("#welcomeName"), state.userNik, state.isVerified, state.badges)
    renderProgression(state.progression, previousLevel)
    updateHtml(document.querySelector("#editAvatar"), avatarSvg(state.avatar))
    if (document.querySelector("#appearanceDialog").open) renderThemeChoices()
    gameBlock.querySelector("#clickForce").textContent = formatNumber(state.clickForce).text
    updateCountDisplay()
    updateUpgradeButton()
    renderRobots()
    renderLeaderboard()
    renderEndgame()
    window.renderTimedGames?.(state.timedGames)
    renderAdOffers()
    showRankingIncome(state.timedGames?.rewardEarnedExact)
}

function renderLeaderboard() {
    const leaderboard = gameState.leaderboard
    if (!leaderboard) return
    const top = document.querySelector("#leaderboardTop")
    const around = document.querySelector("#leaderboardAround")
    const position = document.querySelector("#leaderboardPosition")
    if (leaderboard.sortBy !== activeLeaderboardSort) return
    document.querySelector(".leaderboard-caption").textContent = `По критерию: ${leaderboard.label}`
    leaderboardTabs.querySelectorAll("button").forEach((button) => {
        const isActive = button.dataset.leaderboardSort === activeLeaderboardSort
        button.classList.toggle("is-active", isActive)
        button.setAttribute("aria-pressed", String(isActive))
    })
    updateChildren(top, leaderboard.top.map(createLeaderboardRow))
    updateChildren(around, leaderboard.around.map(createLeaderboardRow))
    position.textContent = `Ваше место: #${leaderboard.currentRank} из ${leaderboard.totalPlayers}`
}

function createLeaderboardRow(player) {
    const row = document.createElement("div")
    row.className = `leaderboard-row${player.isCurrentUser ? " is-current" : ""}`

    const rank = document.createElement("span")
    rank.className = `leaderboard-rank rank-${Math.min(player.rank, 3)}`
    rank.textContent = player.rank

    const name = document.createElement("span")
    name.className = "leaderboard-name"
    name.textContent = player.isCurrentUser ? `${player.nickname} (вы)` : player.nickname

    const score = document.createElement("span")
    score.className = "leaderboard-score"
    score.textContent = formatNumber(player.score).text

    const identity = document.createElement("span")
    identity.className = "leaderboard-identity"
    const avatar = document.createElement("span")
    avatar.className = "leaderboard-avatar"
    avatar.innerHTML = avatarSvg(player.avatar)
    const playerInfo = document.createElement("span")
    playerInfo.className = "leaderboard-player"
    const nameLine = document.createElement("span")
    nameLine.className = "leaderboard-name-line"
    nameLine.append(name)
    if (player.isVerified) nameLine.append(createVerifiedBadge())
    playerInfo.append(nameLine)
    if (player.badges?.some(badge => badge.id !== "verified")) playerInfo.append(createPlayerBadges(player.badges))
    if (player.progression) playerInfo.append(createLevelBadge(player.progression, true))
    identity.append(avatar, playerInfo)
    row.append(rank, identity, score)
    return row
}

function createVerifiedBadge() {
    const badge = document.createElement("span")
    badge.className = "verified-badge"
    badge.setAttribute("role", "img")
    badge.setAttribute("aria-label", "Верифицированный игрок")
    badge.title = "Верифицированный игрок"
    badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 1 3 2 3.6.4 1.2 3.4L22 9l-.5 3 .5 3-2.2 2.2-1.2 3.4-3.6.4-3 2-3-2-3.6-.4-1.2-3.4L2 15l.5-3L2 9l2.2-2.2 1.2-3.4L9 3Z"/><path d="m7.5 12 3 3 6-6" fill="none" stroke="#10233d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    return badge
}

function createPlayerBadges(badges = []) {
    const group = document.createElement("span")
    group.className = "player-badges"
    badges.filter(badge => badge.id !== "verified").forEach(badge => {
        const icon = document.createElement("span")
        icon.className = "player-badge"
        icon.style.setProperty("--badge-color", badge.color)
        icon.setAttribute("role", "img")
        icon.setAttribute("aria-label", badge.name)
        icon.title = badge.name
        icon.textContent = badge.symbol
        group.append(icon)
    })
    return group
}

function renderPlayerName(element, nickname, isVerified, badges = []) {
    const children = [document.createTextNode(nickname)]
    if (isVerified) children.push(createVerifiedBadge())
    if (badges.some(badge => badge.id !== "verified")) children.push(createPlayerBadges(badges))
    updateChildren(element, children)
}

function createLevelBadge(progress, compact = false) {
    const badge = document.createElement("span")
    badge.className = `level-badge${compact ? " is-compact" : ""}`
    badge.style.setProperty("--badge-color", progress.badge?.color || "#a5b0c6")
    const icon = document.createElement("span")
    icon.className = "level-badge-icon"
    icon.setAttribute("aria-hidden", "true")
    icon.textContent = progress.badge?.symbol || "◇"
    const label = document.createElement("span")
    label.textContent = `${compact ? `Ур. ${progress.level}` : `Уровень ${progress.level}`} · ${progress.badge?.name || "Новичок"}`
    badge.title = progress.badge ? `${progress.badge.name} — награда за ${progress.badge.level}-й уровень. Уровень игрока: ${progress.level}` : `Уровень игрока: ${progress.level}. Первый бейдж на 10-м уровне`
    badge.append(icon, label)
    return badge
}

function renderProgression(progress, previousLevel) {
    const panel = document.querySelector("#playerProgression")
    panel.hidden = !progress
    if (!progress) return
    document.querySelector("#accountLevel").textContent = progress.level
    document.querySelector("#levelEmblem").style.setProperty("--badge-color", progress.badge?.color || "var(--gold-light)")
    updateChildren(document.querySelector("#equippedLevelBadge"), [createLevelBadge(progress)])
    document.querySelector("#levelProgressText").textContent = `Ещё ${formatNumber(progress.remainingExact).text} монет до ${progress.level + 1}-го уровня`
    const bar = document.querySelector("#levelProgress")
    bar.value = progress.progressPercent
    bar.setAttribute("aria-valuetext", `${progress.progressPercent}% — ${progress.earnedInLevelExact} из ${progress.levelCostExact} монет`)
    document.querySelector("#levelEarned").textContent = `Всего заработано: ${formatNumber(progress.totalEarnedExact).text}`
    document.querySelector("#levelEarned").title = `${progress.totalEarnedExact} монет`
    document.querySelector("#nextLevelLabel").textContent = `${formatNumber(progress.earnedInLevelExact).text} / ${formatNumber(progress.levelCostExact).text}`
    document.querySelector("#badgeCount").textContent = `${progress.unlockedBadges.length} / ${progress.rewards.length}`
    document.querySelector("#nextBadgeHint").textContent = progress.nextBadge ? `Далее: ${progress.nextBadge.name} · ур. ${progress.nextBadge.level}` : "Все бейджи получены · уровни продолжаются"
    const cards = progress.rewards.map(reward => {
        const unlocked = progress.level >= reward.level
        const next = progress.nextBadge?.id === reward.id
        const card = document.createElement("article")
        card.className = `level-reward${unlocked ? " is-earned" : ""}${next ? " is-next" : ""}`
        card.style.setProperty("--badge-color", reward.color)
        const icon = document.createElement("span")
        icon.className = "reward-medallion"
        icon.setAttribute("aria-hidden", "true")
        icon.textContent = reward.symbol
        const name = document.createElement("h3")
        name.textContent = reward.name
        const level = document.createElement("p")
        level.textContent = `Уровень ${reward.level}`
        const cost = document.createElement("p")
        cost.textContent = `${formatNumber(reward.requiredEarnedExact).text} заработано`
        cost.title = `${reward.requiredEarnedExact} монет за всё время`
        const status = document.createElement("span")
        status.className = "reward-status"
        status.textContent = unlocked ? "✓ Получен" : next ? "Следующая награда" : "Не открыт"
        card.append(icon, name, level, cost, status)
        return card
    })
    updateChildren(document.querySelector("#levelRewardTrack"), cards)
    if (previousLevel != null && progress.level > previousLevel) {
        const notice = document.querySelector("#levelUpNotice")
        const newlyEarned = progress.unlockedBadges.filter(badge => badge.level > previousLevel)
        notice.textContent = `Новый уровень: ${progress.level}!${newlyEarned.length ? ` Получены бейджи: ${newlyEarned.map(badge => badge.name).join(", ")}.` : " Так держать!"}`
        notice.hidden = false
        clearTimeout(levelNoticeTimer)
        levelNoticeTimer = setTimeout(() => { notice.hidden = true }, 7000)
    }
}

function updateCountDisplay() {
    const userCountElement = gameBlock.querySelector("#userCount")
    const formattedCount = formatNumber(gameState.userCount)
    userCountElement.textContent = formattedCount.text
    userCountElement.className = formattedCount.className
}

function updateUpgradeButton() {
    buttonClickForceUpgrade.textContent = `увеличить силу клика до ${formatNumber(gameState.baseClickForce + 1).text} за ${formatNumber(gameState.forceUpgradeCost).text} кликов`
}

function renderRobots() {
    robotsIncome.textContent = `Автодоход: ${formatNumber(gameState.robotsIncome).text}/сек | за места: +${formatNumber(gameState.timedRewardIncome || 0).text}/сек | обслуживание: ${formatNumber(gameState.maintenanceCost).text}/сек | максимум уровня: ${gameState.robotMaxLevel}`
    if (gameState.adminIncomeBoost?.remaining > 0) robotsIncome.textContent += ` | Бонус администратора: ×${gameState.adminIncomeBoost.multiplier}, ещё ${gameState.adminIncomeBoost.remaining} сек.`
    const cards = []
    Object.entries(gameState.catalog.robots).forEach(([robotId, robot]) => {
        const level = gameState.robots[robotId]?.level || 0
        const locked = gameState.prestigePoints < robot.requiresPrestige
        const maxLevel = Math.min(gameState.robotMaxLevel, robot.powers.length)
        const currentPower = level > 0 ? robot.powers[level - 1] : 0
        const nextPower = robot.powers[level] || robot.powers[robot.powers.length - 1]
        const nextCost = level === 0 ? robot.buyCost : robot.upgradeCosts[level - 1] || 0
        const card = document.createElement("article")
        card.className = `robot-card robot-card-level-${level} ${locked ? "is-locked" : ""}`
        const buttonText = locked ? `Нужен престиж ${robot.requiresPrestige}` : level >= maxLevel ? "Максимум" : level === 0 ? `Купить за ${formatNumber(nextCost).text}` : `Улучшить за ${formatNumber(nextCost).text}`
        card.innerHTML = `
            <div class="robot-visual robot-level-${Math.min(level, 5)}" aria-hidden="true">
                <div class="robot-antenna"></div><div class="robot-head"><span class="robot-eye"></span><span class="robot-eye"></span></div>
                <div class="robot-body"><span></span><span></span><span></span><span></span><span></span></div>
            </div>
            <div class="robot-info">
                <h3>${robot.name}</h3>
                <p>${robot.className}</p>
                <p>Уровень: ${level}/${maxLevel}</p>
                <p>Сила: ${formatNumber(currentPower).text}/сек</p>
                <p>${level < maxLevel && !locked ? `Следующая сила: ${formatNumber(nextPower).text}/сек` : locked ? "Откроется через престиж" : "Все улучшения куплены"}</p>
            </div>
            <button type="button" data-robot-id="${robotId}" ${locked || level >= maxLevel ? "disabled" : ""}>${buttonText}</button>`
        cards.push(card)
    })
    updateChildren(robotsList, cards)
}

// Reconcile the fixed-order UI in place so polling preserves focus and animations.
function updateChildren(parent, nextChildren) {
    const previousChildren = Array.from(parent.childNodes)
    nextChildren.forEach((next, index) => {
        const previous = previousChildren[index]
        if (!previous) {
            parent.append(next)
        } else if (previous.nodeType !== next.nodeType || previous.nodeName !== next.nodeName) {
            previous.replaceWith(next)
        } else if (next.nodeType === Node.ELEMENT_NODE) {
            for (const attribute of Array.from(previous.attributes)) {
                if (!next.hasAttribute(attribute.name)) previous.removeAttribute(attribute.name)
            }
            for (const attribute of Array.from(next.attributes)) {
                if (previous.getAttribute(attribute.name) !== attribute.value) {
                    previous.setAttribute(attribute.name, attribute.value)
                }
            }
            updateChildren(previous, Array.from(next.childNodes))
        } else if (previous.nodeValue !== next.nodeValue) {
            previous.nodeValue = next.nodeValue
        }
    })
    previousChildren.slice(nextChildren.length).forEach((child) => child.remove())
}

function updateHtml(parent, html) {
    const template = document.createElement("template")
    template.innerHTML = html
    updateChildren(parent, Array.from(template.content.childNodes))
}

function renderEndgame() {
    if (!gameState) return
    renderPrestigePanel()
    endgameTabs.querySelectorAll("button").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.endgameTab === activeEndgameTab)
    })
    // Keep the live form (values and focus) intact during income updates.
    if (activeEndgameTab === "investments" && endgameContent.querySelector("#investmentForm")) {
        updateHtml(endgameContent.querySelector("#investmentList"), renderInvestmentList())
        return
    }
    const renderers = {
        research: renderResearch,
        boosts: renderBoosts,
        cosmetics: renderCosmetics,
        collections: renderCollections,
        investments: renderInvestments,
        achievements: renderAchievements
    }
    if (endgameContent.dataset.tab !== activeEndgameTab) {
        endgameContent.innerHTML = renderers[activeEndgameTab]()
        endgameContent.dataset.tab = activeEndgameTab
    } else {
        updateHtml(endgameContent, renderers[activeEndgameTab]())
    }
}

function renderPrestigePanel() {
    const canPrestige = gameState.userCount >= gameState.catalog.prestigeMinBalance
    updateHtml(prestigePanel, `
        <div>
            <h3>Престиж: ${gameState.prestigePoints}</h3>
            <p>Постоянный множитель: x${gameState.prestigeMultiplier.toFixed(2)}</p>
            <p>Минимум для сброса: ${formatNumber(gameState.catalog.prestigeMinBalance).text}</p>
        </div>
        <button type="button" data-action="prestige" ${canPrestige ? "" : "disabled"}>Сделать престиж</button>
        <button type="button" data-action="fusion">Слияние роботов</button>`)
}

function renderResearch() {
    return Object.entries(gameState.catalog.research).map(([id, item]) => {
        const level = gameState.research[id] || 0
        const cost = Math.floor(item.baseCost * Math.pow(1.8, level))
        return cardHtml(item.name, `Уровень ${level}/${item.maxLevel}<br>${item.description}`, `Купить за ${formatNumber(cost).text}`, "research", id, level >= item.maxLevel)
    }).join("")
}

function renderBoosts() {
    const ad = gameState.adOffers ? `<article class="ad-offer" data-ad-card="boost">
        <a class="ad-image-link" href="https://it.iteacher-alex.org/" target="_blank" rel="noopener noreferrer" aria-label="ITeacher — занятия для детей (новая вкладка)"><img class="ad-illustration" src="/assets/iteacher-young-creators.png" width="1536" height="1024" loading="lazy" alt="Подростки создают на ноутбуке игровой мир с летающими островами и роботом"></a>
        <span class="ad-label">Реклама · ITeacher</span><h3>Турбо на минуту</h3>
        <p>Доход роботов ×2 на 60 секунд. Доступно раз в 10 минут. Продлевает активный турборежим.</p>
        <p class="ad-sponsor">Развивайте навыки с ITeacher: индивидуальные уроки по 45 минут с упором на практику.</p>
        <a class="ad-site-link" href="https://it.iteacher-alex.org/" target="_blank" rel="noopener noreferrer">Узнать о занятиях ↗<span class="ad-link-hint"> (новая вкладка)</span></a>
        <button type="button" data-ad-placement="boost">Смотреть рекламу · ×2 доход</button></article>` : ""
    return ad + Object.entries(gameState.catalog.boosts).map(([id, item]) => {
        const left = gameState.boosts[id] || 0
        return cardHtml(item.name, `${item.description}<br>Активно еще: ${left} сек.`, `Купить за ${formatNumber(item.cost).text}`, "boost", id, false)
    }).join("")
}

function renderCosmetics() {
    return Object.entries(gameState.catalog.cosmetics).map(([id, item]) => {
        const unlocked = gameState.cosmetics[id] || item.cost === 0
        const active = gameState.activeTheme === id
        return cardHtml(item.name, `${item.description}<br>${active ? "Активно" : unlocked ? "Куплено" : "Не куплено"}`, unlocked ? "Включить" : `Купить за ${formatNumber(item.cost).text}`, "cosmetic", id, active)
    }).join("")
}

function renderCollections() {
    return Object.entries(gameState.catalog.collections).map(([id, item]) => {
        const unlocked = gameState.collections[id]
        return cardHtml(item.name, `${item.description}<br>Бонус: +${Math.round(item.bonus * 1000) / 10}%`, unlocked ? "Куплено" : `Купить за ${formatNumber(item.cost).text}`, "collection", id, unlocked)
    }).join("")
}

function renderInvestmentList() {
    return gameState.investments.map((investment) => {
        const left = Math.max(0, investment.ready_at - Math.floor(Date.now() / 1000))
        const chance = investment.success_chance ?? (investment.risky ? 50 : 100)
        return `<p>${investment.plan_name || "Инвестиция"}: Вклад ${formatNumber(investment.amount).text} -> ${formatNumber(investment.payout_amount).text} при успехе (${chance}%), ${left > 0 ? `готов через ${left} сек.` : "можно забрать"}</p>`
    }).join("") || "<p>Активных инвестиций нет.</p>"
}

function investmentPlanSummary(plan) {
    return `Шанс успеха: ${plan.successChance}%. Прибыль: +${plan.profitPercent}% (возврат ${100 + plan.profitPercent}%). Срок: ${plan.duration ?? gameState.catalog.investmentDuration} сек.`
}

function renderInvestments() {
    const plans = Object.entries(gameState.catalog.investmentPlans).sort((a, b) => b[1].successChance - a[1].successChance)
    return `
        <form id="investmentForm" class="endgame-card">
            <h3>Инвестиции</h3>
            <p>Чем рискованнее вклад, тем быстрее он завершится. Выше прибыль — ниже шанс успеха.</p>
            <label for="investmentAmount">Сумма</label>
            <div class="investment-amount-row"><input id="investmentAmount" name="amount" type="text" maxlength="120" placeholder="1 Qi или 250M" autocomplete="off" required aria-describedby="investmentAmountHint">
            <button type="button" data-action="invest-all">Всё</button></div>
            <p id="investmentAmountHint">Можно вводить дробь: 1.5 Qi или 1,5 Qi. Обозначения: K, M, B, T, Qa, Qi, Sx, Sp, Oc, No, Dc.</p>
            <label for="investmentPlan">Вид инвестиции</label>
            <select id="investmentPlan" name="plan">${plans.map(([id, plan]) => `<option value="${id}" ${id === "guaranteed" ? "selected" : ""}>${plan.name}: +${plan.profitPercent}%, успех ${plan.successChance}%, ${plan.duration ?? gameState.catalog.investmentDuration} сек.</option>`).join("")}</select>
            <p id="investmentPlanSummary">${investmentPlanSummary(gameState.catalog.investmentPlans.guaranteed)}</p>
            <p>При успехе возвращается вклад и указанная прибыль. При неудаче вклад теряется полностью. Прибыль округляется вниз до целой монеты.</p>
            <button type="submit">Вложить</button>
        </form>
        <div class="endgame-card"><div id="investmentList">${renderInvestmentList()}</div><button type="button" data-action="collect-investments">Забрать готовые</button></div>`
}

function renderAchievements() {
    return Object.entries(gameState.catalog.achievements).map(([id, item]) => {
        const unlocked = gameState.achievements[id]
        return `<article class="endgame-card ${unlocked ? "is-unlocked" : ""}"><h3>${item.name}</h3><p>${item.description}</p><p>Бонус: +${Math.round(item.bonus * 100)}%</p><button disabled>${unlocked ? "Получено" : "Не открыто"}</button></article>`
    }).join("")
}

function cardHtml(title, body, buttonText, action, id, disabled) {
    return `<article class="endgame-card"><h3>${title}</h3><p>${body}</p><button type="button" data-action="${action}" data-id="${id}" ${disabled ? "disabled" : ""}>${buttonText}</button></article>`
}

function startIncomeCollection() {
    if (incomeTimer) clearInterval(incomeTimer)
    incomeTimer = setInterval(async () => {
        try {
            const state = await apiRequest("/api/collect-income", { method: "POST" })
            applyGameState(state)
            showCollectedIncome(state.autoIncome)
        } catch (error) {
            console.error(error)
        }
    }, 1000)
}

function showRankingIncome(totalExact) {
    if (totalExact == null) return
    const total = BigInt(totalExact)
    const income = lastRankingIncomeTotal === null ? 0n : total - lastRankingIncomeTotal
    // A cumulative server counter captures income settled by other requests too.
    // Repeated or out-of-order replies never replay the same reward animation.
    if (lastRankingIncomeTotal === null || total > lastRankingIncomeTotal) lastRankingIncomeTotal = total
    if (income <= 0n || document.visibilityState !== "visible") return
    const inMiniGame = document.querySelector("#timedDialog").open
    const target = document.querySelector(inMiniGame ? "#timedRankingIncomePop" : "#rankingIncomePop")
    if (!target) return
    const label = `🏆 +${formatNumber(income.toString()).text} · за рейтинг${inMiniGame ? " → основной баланс" : ""}`
    if (target.firstChild) target.firstChild.nodeValue = label
    else target.textContent = label
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    rankingIncomeAnimations.get(target)?.cancel()
    rankingIncomeAnimations.set(target, target.animate([
        { opacity: 0, transform: reducedMotion ? "none" : "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)", offset: 0.15 },
        { opacity: 1, transform: "translateY(0)", offset: 0.75 },
        { opacity: 0, transform: reducedMotion ? "none" : "translateY(-8px)" }
    ], { duration: 950, easing: "ease-out" }))
}

function showCollectedIncome(income) {
    if (!income) return
    const countBox = gameBlock.querySelector("#countBox")
    const rect = countBox.getBoundingClientRect()
    const autoIncomeElement = document.createElement("div")
    autoIncomeElement.className = "auto-income-pop"
    autoIncomeElement.textContent = `+${formatNumber(income).text}`
    autoIncomeElement.style.left = `${rect.left + rect.width / 2}px`
    autoIncomeElement.style.top = `${rect.top + rect.height / 2}px`
    document.body.append(autoIncomeElement)
    setTimeout(() => autoIncomeElement.remove(), 900)
}

function formatNumber(value) {
    const number = Number(value) || 0
    const absNumber = Math.abs(number)
    let rank = NUMBER_SUFFIXES[0]
    for (let index = NUMBER_SUFFIXES.length - 1; index >= 0; index--) {
        if (absNumber >= NUMBER_SUFFIXES[index].value) {
            rank = NUMBER_SUFFIXES[index]
            break
        }
    }
    if (!rank.suffix) return { text: Math.floor(number).toString(), className: rank.className }
    const rankIndex = NUMBER_SUFFIXES.indexOf(rank)
    const shortValue = number / rank.value
    const digits = Math.abs(shortValue) >= 100 ? 0 : Math.abs(shortValue) >= 10 ? 1 : 2
    const roundedValue = Number(shortValue.toFixed(digits))
    if (Math.abs(roundedValue) >= 1000 && rankIndex < NUMBER_SUFFIXES.length - 1) {
        const nextRank = NUMBER_SUFFIXES[rankIndex + 1]
        const nextShortValue = number / nextRank.value
        const nextDigits = Math.abs(nextShortValue) >= 100 ? 0 : Math.abs(nextShortValue) >= 10 ? 1 : 2
        return { text: `${trimZeros(nextShortValue.toFixed(nextDigits))}${nextRank.suffix}`, className: nextRank.className }
    }
    return { text: `${trimZeros(shortValue.toFixed(digits))}${rank.suffix}`, className: rank.className }
}

function trimZeros(value) {
    return value.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")
}

function createFlyingRuble() {
    const countBox = document.getElementById("countBox")
    if (!buttonClickMe || !countBox) return
    const buttonRect = buttonClickMe.getBoundingClientRect()
    const counterRect = countBox.getBoundingClientRect()
    const rubleIcon = document.createElement("div")
    const startX = buttonRect.left + Math.random() * buttonRect.width
    const startY = buttonRect.top + Math.random() * buttonRect.height
    rubleIcon.className = "ruble-fly"
    rubleIcon.style.left = `${startX}px`
    rubleIcon.style.top = `${startY}px`
    document.body.appendChild(rubleIcon)
    rubleIcon.getBoundingClientRect()
    requestAnimationFrame(() => {
        rubleIcon.style.transform = `translate(${counterRect.left + counterRect.width / 2 - startX}px, ${counterRect.top + counterRect.height / 2 - startY}px)`
    })
    setTimeout(() => rubleIcon.remove(), 800)
}

buttonClickMe.addEventListener("click", () => {
    const iconsCount = Math.floor(Math.random() * 3) + 1
    for (let index = 0; index < iconsCount; index++) createFlyingRuble()
})

const adDialog = document.querySelector("#adDialog")
const adStatus = document.querySelector("#adStatus")
const adClaim = document.querySelector("#adClaim")
const adClose = document.querySelector("#adClose")
let adSession = null
let adTimer = null
let adRequestVersion = 0
let adClaiming = false
let adOpener = null

function renderAdOffers() {
    document.querySelectorAll("[data-ad-card]").forEach(card => {
        const placement = card.dataset.adCard
        const offer = gameState?.adOffers?.[placement]
        card.hidden = !offer
        if (!offer) return
        const button = card.querySelector("[data-ad-placement]")
        button.disabled = !offer.available || Boolean(gameState.timedGames?.active)
        const remaining = offer.remaining || 0
        const label = gameState.timedGames?.active ? "После завершения мини-игры"
            : offer.claimed ? "Бонус уже получен"
            : remaining > 0 ? `Доступно через ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
            : !offer.available ? "Нужен результат больше нуля"
            : placement === "boost" ? "Смотреть рекламу · ×2 доход"
            : `Смотреть рекламу · +${formatNumber(offer.amount).text}`
        if (button.firstChild) button.firstChild.nodeValue = label
        else button.textContent = label
    })
}

document.addEventListener("click", async event => {
    const button = event.target.closest("[data-ad-placement]")
    if (!button || button.disabled || adDialog.open) return
    const placement = button.dataset.adPlacement
    const offer = gameState?.adOffers?.[placement]
    if (!offer?.available) return
    const version = ++adRequestVersion
    adOpener = button
    adSession = null
    adClaim.hidden = false
    adClaim.disabled = true
    adClaim.textContent = "Забрать бонус"
    adStatus.textContent = "Подготавливаем просмотр…"
    document.querySelector("#adDialogReward").textContent = placement === "boost"
        ? "Награда: ×2 доход роботов на 60 секунд."
        : `Награда: +${formatNumber(offer.amount).text} монет на основной баланс.`
    adDialog.showModal()
    document.body.classList.add("ad-modal-open")
    try {
        const response = await apiRequest("/api/ads/start", {
            method: "POST", body: JSON.stringify({ placement, runId: offer.runId })
        })
        if (version !== adRequestVersion || !adDialog.open) return
        adSession = { ...response, placement, deadline: performance.now() + response.waitSeconds * 1000 }
        document.querySelector("#adDialogReward").textContent = placement === "boost"
            ? "Награда: ×2 доход роботов на 60 секунд."
            : `Награда: +${formatNumber(response.amount).text} монет на основной баланс.`
        const tick = () => {
            const left = Math.max(0, Math.ceil((adSession.deadline - performance.now()) / 1000))
            adStatus.textContent = left ? `Бонус будет доступен через ${left} сек.` : "Просмотр завершён. Можно забрать бонус!"
            adClaim.disabled = left > 0
            if (!left) { clearInterval(adTimer); adTimer = null }
        }
        adTimer = setInterval(tick, 200)
        tick()
    } catch (error) {
        if (version === adRequestVersion) adStatus.textContent = error.message
    }
})

adClaim.addEventListener("click", async () => {
    if (!adSession || adClaim.disabled || adClaiming) return
    adClaiming = true
    adClaim.disabled = true
    adClose.disabled = true
    adStatus.textContent = "Начисляем бонус…"
    try {
        const state = await apiRequest("/api/ads/claim", {
            method: "POST", body: JSON.stringify({ token: adSession.token })
        })
        applyGameState(state)
        adStatus.textContent = adSession.placement === "boost" ? "Готово! Турборежим продлён на 60 секунд."
            : `Готово! На основной баланс добавлено ${formatNumber(adSession.amount).text} монет.`
        adClaim.hidden = true
    } catch (error) {
        adStatus.textContent = `${error.message}. Можно повторить получение или закрыть окно.`
        adClaim.disabled = false
    } finally {
        adClaiming = false
        adClose.disabled = false
    }
})

adClose.addEventListener("click", () => { if (!adClaiming) adDialog.close() })
adDialog.addEventListener("cancel", event => { if (adClaiming) event.preventDefault() })
adDialog.addEventListener("close", () => {
    ++adRequestVersion
    clearInterval(adTimer)
    adTimer = null
    adSession = null
    document.body.classList.remove("ad-modal-open")
    if (adOpener?.isConnected && !adOpener.disabled) adOpener.focus({ preventScroll: true })
})

// Avatar SVG is composed exclusively from allowlisted parts, never user markup.
const AVATAR_PARTS = {
    character: { robot: "Робот", cat: "Кот", bear: "Медведь", alien: "Пришелец" },
    background: { "#24365c": "Синий", "#123f43": "Морской", "#58304b": "Ягодный", "#49376b": "Фиолетовый", "#663c2b": "Терракотовый", "#253b32": "Лесной" },
    color: { "#9bbcff": "Голубой", "#79dfca": "Мятный", "#ffadc8": "Розовый", "#c8afff": "Сиреневый", "#ffd080": "Золотистый", "#e5eaf5": "Жемчужный" },
    eyes: { happy: "Улыбка", round: "Удивление", wink: "Подмигивание", cool: "Очки" },
    accessory: { none: "Без аксессуара", crown: "Корона", star: "Звезда", headphones: "Наушники" }
}
const PART_LABELS = { character: "Персонаж", background: "Фон", color: "Цвет персонажа", eyes: "Выражение лица", accessory: "Аксессуар" }
const THEME_PREVIEWS = {
    classic: ["Классика", "#101522", "#ffce73"],
    ocean_theme: ["Океан", "#0a2032", "#69dbef"],
    sakura_theme: ["Сакура", "#2a182b", "#ffb1d1"],
    forest_theme: ["Лес", "#102b24", "#8ae4b4"],
    sunset_theme: ["Закат", "#301d24", "#ffb68d"],
    cosmos_theme: ["Космос", "#1d1939", "#c1aeff"],
    gold_theme: ["Золотая", "#292214", "#ffe09b"],
    neon_theme: ["Неоновая", "#101f2b", "#78ffde"],
    royal_theme: ["Королевская", "#291b38", "#e2b2ff"]
}
let avatarDraft = null
let avatarUpload = null
let avatarPreviewUrl = null
let avatarLoadVersion = 0
let avatarLoading = false
let appearanceBusy = false
const appearanceDialog = document.querySelector("#appearanceDialog")
const appearanceStatus = document.querySelector("#appearanceStatus")

function normalizeAvatar(value) {
    if (/^\/api\/avatar-images\/[a-f0-9]{32}$/.test(value?.imageUrl)) return {imageUrl: value.imageUrl}
    return Object.fromEntries(Object.entries(AVATAR_PARTS).map(([part, choices]) =>
        [part, Object.hasOwn(choices, value?.[part]) ? value[part] : Object.keys(choices)[0]]))
}

function avatarSvg(value) {
    const a = normalizeAvatar(value)
    if (a.imageUrl) return `<img class="custom-avatar-image" src="${a.imageUrl}" alt="Аватарка игрока" width="256" height="256">`
    const ears = {
        robot: '<path d="M60 33V21" stroke="currentColor" stroke-width="5"/><circle cx="60" cy="18" r="6" fill="currentColor"/>',
        cat: '<path d="M30 52L25 22L49 37M71 37L95 22L90 52" fill="currentColor" stroke="#182238" stroke-width="3" stroke-linejoin="round"/>',
        bear: '<circle cx="33" cy="39" r="14" fill="currentColor"/><circle cx="87" cy="39" r="14" fill="currentColor"/>',
        alien: '<path d="M41 37L31 21M79 37L89 21" stroke="currentColor" stroke-width="4"/><circle cx="30" cy="19" r="5" fill="currentColor"/><circle cx="90" cy="19" r="5" fill="currentColor"/>'
    }[a.character]
    const eyes = {
        happy: '<path d="M37 61q6-10 12 0M71 61q6-10 12 0" fill="none" stroke="#182238" stroke-width="4" stroke-linecap="round"/>',
        round: '<ellipse cx="44" cy="58" rx="5" ry="7" fill="#182238"/><ellipse cx="76" cy="58" rx="5" ry="7" fill="#182238"/>',
        wink: '<circle cx="44" cy="58" r="5" fill="#182238"/><path d="M71 58h12" stroke="#182238" stroke-width="4" stroke-linecap="round"/>',
        cool: '<path d="M32 52h24v10q-12 14-24 0ZM64 52h24v10q-12 14-24 0Z" fill="#182238"/><path d="M55 55h10" stroke="#182238" stroke-width="4"/>'
    }[a.eyes]
    const accessory = {
        none: '',
        crown: '<path d="M40 36L36 17L50 24L60 11L70 24L84 17L80 36Z" fill="#ffcf70" stroke="#976729" stroke-width="2"/>',
        star: '<path d="M91 73l4 8 9 1-7 6 2 9-8-4-8 4 2-9-7-6 9-1Z" fill="#ffcf70"/>',
        headphones: '<path d="M25 64V53a35 35 0 0170 0v11" fill="none" stroke="#eff4ff" stroke-width="7"/><rect x="20" y="54" width="12" height="25" rx="5" fill="#182238"/><rect x="88" y="54" width="12" height="25" rx="5" fill="#182238"/>'
    }[a.accessory]
    return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="color:${a.color}"><rect width="120" height="120" rx="30" fill="${a.background}"/><circle cx="100" cy="17" r="32" fill="white" opacity=".06"/><path d="M23 120v-11c0-28 74-28 74 0v11" fill="currentColor" opacity=".65"/>${ears}<rect x="28" y="33" width="64" height="57" rx="${a.character === 'robot' ? 17 : 28}" fill="currentColor"/><ellipse cx="38" cy="70" rx="7" ry="4" fill="#e98193" opacity=".5"/><ellipse cx="82" cy="70" rx="7" ry="4" fill="#e98193" opacity=".5"/>${eyes}<path d="M51 74q9 9 18 0" fill="none" stroke="#182238" stroke-width="3" stroke-linecap="round"/>${accessory}</svg>`
}

function showAppearance(tab) {
    clearAvatarUpload()
    avatarDraft = normalizeAvatar(gameState.avatar)
    appearanceStatus.textContent = ""
    setAppearanceTab(tab)
    renderAvatarEditor()
    renderThemeChoices()
    appearanceDialog.showModal()
}

function setAppearanceTab(tab) {
    document.querySelector("#themeEditor").hidden = tab !== "themes"
    document.querySelector("#avatarEditor").hidden = tab !== "avatar"
    appearanceDialog.querySelectorAll("[data-appearance-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.appearanceTab === tab)))
}

function renderThemeChoices() {
    document.querySelector("#themeBalance").textContent = `На балансе: ${formatNumber(gameState.userCount).text} монет`
    const cards = Object.entries(THEME_PREVIEWS).map(([id, [name, background, accent]]) => {
        const item = gameState.catalog.cosmetics[id]
        const available = id === "classic" || gameState.cosmetics[id]
        const canBuy = item && gameState.userCount >= item.cost
        const active = gameState.activeTheme === id
        const label = active ? "✓ Выбрана" : id === "classic" ? "Бесплатно" : available ? "Включить · куплена" : `${canBuy ? "Купить за" : "Не хватает · цена"} ${formatNumber(item?.cost || 0).text}`
        return `<button type="button" class="theme-choice" data-theme="${id}" aria-pressed="${active}" ${(!available && !canBuy) || appearanceBusy || avatarLoading ? "disabled" : ""}><span class="theme-sample" style="--sample-bg:${background};--sample-accent:${accent}"><i></i><i></i><i></i><b>✦</b></span><strong>${name}</strong><small>${label}</small></button>`
    })
    updateHtml(document.querySelector("#themeChoices"), cards.join(""))
}

function renderAvatarEditor() {
    const preview = document.querySelector("#avatarPreview")
    if (avatarPreviewUrl) {
        const img = document.createElement("img")
        img.src = avatarPreviewUrl
        img.alt = "Предпросмотр своей аватарки"
        img.className = "custom-avatar-image"
        updateChildren(preview, [img])
    } else updateHtml(preview, avatarSvg(avatarDraft))
    const imageMode = !!(avatarUpload || avatarDraft?.imageUrl)
    document.querySelector("#avatarChoices").hidden = imageMode
    document.querySelector("#buildAvatar").hidden = !imageMode
    for (const id of ["saveAvatar", "randomAvatar", "resetAvatar", "uploadAvatar", "buildAvatar", "avatarFile"]) document.getElementById(id).disabled = appearanceBusy || avatarLoading
    const fields = Object.entries(AVATAR_PARTS).map(([part, values]) => `<fieldset><legend>${PART_LABELS[part]}</legend><div class="avatar-options">${Object.entries(values).map(([value, label]) => `<button type="button" data-avatar-part="${part}" data-value="${value}" aria-pressed="${avatarDraft[part] === value}" ${appearanceBusy ? "disabled" : ""}>${value.startsWith("#") ? `<i class="color-dot" style="background:${value}"></i>` : ""}${label}</button>`).join("")}</div></fieldset>`)
    updateHtml(document.querySelector("#avatarChoices"), fields.join(""))
}

document.querySelector("#openAppearance").addEventListener("click", () => showAppearance("themes"))
document.querySelector("#editAvatar").addEventListener("click", () => showAppearance("avatar"))
document.querySelector("#closeAppearance").addEventListener("click", () => appearanceDialog.close())
appearanceDialog.addEventListener("click", event => {
    if (event.target === appearanceDialog) {
        const rect = appearanceDialog.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) appearanceDialog.close()
    }
    const tab = event.target.closest("[data-appearance-tab]")
    if (tab) setAppearanceTab(tab.dataset.appearanceTab)
})
document.querySelector("#avatarChoices").addEventListener("click", event => {
    const button = event.target.closest("[data-avatar-part]")
    if (!button || appearanceBusy || avatarLoading) return
    avatarDraft[button.dataset.avatarPart] = button.dataset.value
    appearanceStatus.textContent = "Есть несохранённые изменения"
    renderAvatarEditor()
})
document.querySelector("#randomAvatar").addEventListener("click", () => {
    clearAvatarUpload()
    avatarDraft = Object.fromEntries(Object.entries(AVATAR_PARTS).map(([part, choices]) => {
        const values = Object.keys(choices)
        return [part, values[Math.floor(Math.random() * values.length)]]
    }))
    appearanceStatus.textContent = "Есть несохранённые изменения"
    renderAvatarEditor()
})
document.querySelector("#resetAvatar").addEventListener("click", () => {
    clearAvatarUpload()
    avatarDraft = normalizeAvatar(gameState.avatar)
    appearanceStatus.textContent = "Изменения отменены"
    renderAvatarEditor()
})

function saveAppearance(url, payload, message) {
    if (appearanceBusy || avatarLoading) return
    appearanceBusy = true
    appearanceStatus.textContent = "Сохраняем…"
    for (const id of ["saveAvatar", "randomAvatar", "resetAvatar"]) document.getElementById(id).disabled = true
    renderAvatarEditor()
    renderThemeChoices()
    // Share the action queue with purchases/clicks to preserve state response order.
    actionQueue = actionQueue.then(async () => {
        const state = await apiRequest(url, { method: "POST", body: payload instanceof FormData ? payload : JSON.stringify(payload) })
        applyGameState(state)
        if (url.startsWith("/api/profile/avatar")) {
            clearAvatarUpload()
            avatarDraft = normalizeAvatar(state.avatar)
        }
        appearanceStatus.textContent = message
    }).catch(error => { appearanceStatus.textContent = error.message }).finally(() => {
        appearanceBusy = false
        for (const id of ["saveAvatar", "randomAvatar", "resetAvatar"]) document.getElementById(id).disabled = false
        renderAvatarEditor()
        renderThemeChoices()
    })
}
document.querySelector("#saveAvatar").addEventListener("click", () => {
    if (avatarUpload) {
        const form = new FormData()
        form.append("image", avatarUpload)
        saveAppearance("/api/profile/avatar-image", form, "Картинка сохранена и видна в рейтингах")
    } else if (avatarDraft.imageUrl) appearanceStatus.textContent = "Эта картинка уже сохранена"
    else saveAppearance("/api/profile/avatar", {...avatarDraft}, "Аватарка сохранена и видна в рейтингах")
})
document.querySelector("#themeChoices").addEventListener("click", event => {
    const button = event.target.closest("[data-theme]")
    if (!button || button.disabled) return
    const theme = button.dataset.theme
    if (theme === "classic" || gameState.cosmetics[theme]) saveAppearance("/api/profile/theme", {theme}, "Тема включена")
    else saveAppearance(`/api/cosmetics/${theme}/buy`, {}, "Тема куплена и включена")
})

function clearAvatarUpload() {
    ++avatarLoadVersion
    avatarLoading = false
    avatarUpload = null
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
    avatarPreviewUrl = null
    document.querySelector("#avatarFile").value = ""
}

document.querySelector("#uploadAvatar").addEventListener("click", () => document.querySelector("#avatarFile").click())
document.querySelector("#buildAvatar").addEventListener("click", () => {
    clearAvatarUpload()
    avatarDraft = normalizeAvatar(null)
    appearanceStatus.textContent = "Собери персонажа и сохрани, чтобы заменить картинку"
    renderAvatarEditor()
})
document.querySelector("#avatarFile").addEventListener("change", async event => {
    const file = event.target.files[0]
    if (!file) return
    event.target.value = ""
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
        appearanceStatus.textContent = "Выберите JPG, PNG или WebP размером до 5 МБ"
        return
    }
    const version = ++avatarLoadVersion
    let url = URL.createObjectURL(file)
    avatarLoading = true
    appearanceStatus.textContent = "Открываем картинку…"
    renderAvatarEditor()
    renderThemeChoices()
    try {
        const img = new Image()
        img.src = url
        await img.decode()
        if (version !== avatarLoadVersion) return
        if (img.naturalWidth * img.naturalHeight > 20_000_000) throw new Error("Картинка слишком большая: максимум 20 мегапикселей")
        if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
        avatarPreviewUrl = url
        url = null
        avatarUpload = file
        appearanceStatus.textContent = "Предпросмотр готов. Нажми «Сохранить аватарку»"
    } catch (error) {
        if (version === avatarLoadVersion) appearanceStatus.textContent = error.name === "EncodingError" ? "Не удалось прочитать картинку. Выберите другой файл" : error.message
    } finally {
        if (url) URL.revokeObjectURL(url)
        if (version === avatarLoadVersion) {
            avatarLoading = false
            renderAvatarEditor()
            renderThemeChoices()
        }
    }
})
appearanceDialog.addEventListener("close", clearAvatarUpload)

restoreSession()
