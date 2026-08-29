const changeLogin = document.querySelector("#changeLogin")
const formRegister = document.querySelector("#form-register")
const formLogin = document.querySelector("#form-login")
const changeRegister = document.querySelector("#change-register")
const gameBlock = document.querySelector("#game")
const buttonClickMe = document.querySelector("#clickMe")
const buttonClickForceUpgrade = document.querySelector("#clickForceUpgrade")
const robotsIncome = document.querySelector("#robotsIncome")
const robotsList = document.querySelector("#robotsList")
const prestigePanel = document.querySelector("#prestigePanel")
const endgameContent = document.querySelector("#endgameContent")
const endgameTabs = document.querySelector(".endgame-tabs")
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
})

endgameContent.addEventListener("submit", (event) => {
    if (!event.target.matches("#investmentForm")) return
    event.preventDefault()
    const formData = new FormData(event.target)
    const amount = Number(formData.get("amount")) || 0
    enqueueGameAction("/api/investments/create", {
        amount,
        risky: formData.get("risky") === "on"
    })
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
            if (state.investmentPayout) alert(`Инвестиции вернули ${formatNumber(state.investmentPayout).text}`)
        })
        .catch((error) => alert(error.message))
}

async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
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
    gameBlock.style.display = "block"
    applyGameState(state)
    showCollectedIncome(state.autoIncome)
    startIncomeCollection()
}

function applyGameState(state) {
    gameState = state
    document.body.classList.remove("theme-gold_theme", "theme-neon_theme", "theme-royal_theme")
    if (state.activeTheme && state.activeTheme !== "classic") document.body.classList.add(`theme-${state.activeTheme}`)
    gameBlock.querySelector("#name").textContent = state.userNik
    gameBlock.querySelector("#clickForce").textContent = formatNumber(state.clickForce).text
    updateCountDisplay()
    updateUpgradeButton()
    renderRobots()
    renderEndgame()
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
    robotsIncome.textContent = `Автодоход: ${formatNumber(gameState.robotsIncome).text}/сек | обслуживание: ${formatNumber(gameState.maintenanceCost).text}/сек | максимум уровня: ${gameState.robotMaxLevel}`
    robotsList.innerHTML = ""
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
        robotsList.append(card)
    })
}

function renderEndgame() {
    if (!gameState) return
    renderPrestigePanel()
    endgameTabs.querySelectorAll("button").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.endgameTab === activeEndgameTab)
    })
    const renderers = {
        research: renderResearch,
        boosts: renderBoosts,
        cosmetics: renderCosmetics,
        collections: renderCollections,
        investments: renderInvestments,
        achievements: renderAchievements
    }
    endgameContent.innerHTML = renderers[activeEndgameTab]()
}

function renderPrestigePanel() {
    const canPrestige = gameState.userCount >= gameState.catalog.prestigeMinBalance
    prestigePanel.innerHTML = `
        <div>
            <h3>Престиж: ${gameState.prestigePoints}</h3>
            <p>Постоянный множитель: x${gameState.prestigeMultiplier.toFixed(2)}</p>
            <p>Минимум для сброса: ${formatNumber(gameState.catalog.prestigeMinBalance).text}</p>
        </div>
        <button type="button" data-action="prestige" ${canPrestige ? "" : "disabled"}>Сделать престиж</button>
        <button type="button" data-action="fusion">Слияние роботов</button>`
}

function renderResearch() {
    return Object.entries(gameState.catalog.research).map(([id, item]) => {
        const level = gameState.research[id] || 0
        const cost = Math.floor(item.baseCost * Math.pow(1.8, level))
        return cardHtml(item.name, `Уровень ${level}/${item.maxLevel}<br>${item.description}`, `Купить за ${formatNumber(cost).text}`, "research", id, level >= item.maxLevel)
    }).join("")
}

function renderBoosts() {
    return Object.entries(gameState.catalog.boosts).map(([id, item]) => {
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

function renderInvestments() {
    const list = gameState.investments.map((investment) => {
        const left = Math.max(0, investment.ready_at - Math.floor(Date.now() / 1000))
        return `<p>Вклад ${formatNumber(investment.amount).text} -> ${formatNumber(investment.payout_amount).text}, готов через ${left} сек.${investment.risky ? " Риск 50%." : ""}</p>`
    }).join("") || "<p>Активных инвестиций нет.</p>"
    return `
        <form id="investmentForm" class="endgame-card">
            <h3>Инвестиции</h3>
            <p>Обычная инвестиция вернет 120% через ${gameState.catalog.investmentDuration} сек. Рискованная: 50% шанс x2.</p>
            <input name="amount" type="number" min="1" placeholder="Сумма">
            <label class="inline-check"><input name="risky" type="checkbox"> рискованная</label>
            <button type="submit">Вложить</button>
        </form>
        <div class="endgame-card">${list}<button type="button" data-action="collect-investments">Забрать готовые</button></div>`
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

restoreSession()
