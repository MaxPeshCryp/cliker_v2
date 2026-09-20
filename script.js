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
    endgameContent.querySelector("#investmentPlanSummary").textContent = `Шанс успеха: ${plan.successChance}%. Прибыль: +${plan.profitPercent}% (возврат ${100 + plan.profitPercent}%).`
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
        headers: { "Content-Type": "application/json", "X-Leaderboard-Sort": activeLeaderboardSort, ...(options.headers || {}) },
        ...options
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "Ошибка сервера")
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
    formRegister.style.display = "none"
    formLogin.style.display = "none"
    gameLayout.style.display = "grid"
    applyGameState(state)
    showCollectedIncome(state.autoIncome)
    startIncomeCollection()
}

function applyGameState(state) {
    if (state.timedGames && gameState?.timedGames && state.timedGames.serverNow < gameState.timedGames.serverNow) return
    const previousTheme = gameState?.activeTheme
    gameState = state
    if (previousTheme !== state.activeTheme) {
        document.body.classList.remove("theme-gold_theme", "theme-neon_theme", "theme-royal_theme")
        if (state.activeTheme && state.activeTheme !== "classic") document.body.classList.add(`theme-${state.activeTheme}`)
    }
    gameBlock.querySelector("#name").textContent = state.userNik
    gameBlock.querySelector("#clickForce").textContent = formatNumber(state.clickForce).text
    updateCountDisplay()
    updateUpgradeButton()
    renderRobots()
    renderLeaderboard()
    renderEndgame()
    window.renderTimedGames?.(state.timedGames)
    renderAdOffers()
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

    row.append(rank, name, score)
    return row
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
        <span class="ad-label">Бонус за рекламу</span><h3>Турбо на минуту</h3>
        <p>Доход роботов ×2 на 60 секунд. Доступно раз в 10 минут. Продлевает активный турборежим.</p>
        <button type="button" data-ad-placement="boost">Смотреть рекламу · ×2 доход</button></article>` : ""
    return ad + Object.entries(gameState.catalog.boosts).map(([id, item]) => {
        const left = gameState.boosts[id] || 0
        return cardHtml(item.name, `${item.description}<br>Активно еще: ${left} сек.`, `Купить за ${formatNumber(item.cost).text}`, "boost", id, false)
    }).join("")
}

function renderCosmetics() {
    return Object.entries(gameState.catalog.cosmetics).map(([id, item]) => {
        const unlocked = gameState.cosmetics[id]
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

function renderInvestments() {
    const plans = Object.entries(gameState.catalog.investmentPlans).sort((a, b) => b[1].successChance - a[1].successChance)
    return `
        <form id="investmentForm" class="endgame-card">
            <h3>Инвестиции</h3>
            <p>Срок каждого вклада — ${gameState.catalog.investmentDuration} сек. Выше прибыль — ниже шанс успеха.</p>
            <label for="investmentAmount">Сумма</label>
            <div class="investment-amount-row"><input id="investmentAmount" name="amount" type="text" maxlength="120" placeholder="1 Qi или 250M" autocomplete="off" required aria-describedby="investmentAmountHint">
            <button type="button" data-action="invest-all">Всё</button></div>
            <p id="investmentAmountHint">Можно вводить дробь: 1.5 Qi или 1,5 Qi. Обозначения: K, M, B, T, Qa, Qi, Sx, Sp, Oc, No, Dc.</p>
            <label for="investmentPlan">Вид инвестиции</label>
            <select id="investmentPlan" name="plan">${plans.map(([id, plan]) => `<option value="${id}" ${id === "guaranteed" ? "selected" : ""}>${plan.name}: +${plan.profitPercent}%, успех ${plan.successChance}%</option>`).join("")}</select>
            <p id="investmentPlanSummary">Шанс успеха: 100%. Прибыль: +20% (возврат 120%).</p>
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

restoreSession()
