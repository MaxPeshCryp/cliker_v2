(() => {
    const root = document.querySelector("#timedGames")
    const elements = Object.fromEntries([...root.querySelectorAll("[id]")].map(node => [node.id, node]))
    const find = (id) => elements[id]
    const dialog = find("timedDialog")
    const exact = (value) => Number(value).toLocaleString("ru-RU")
    const modes = new Map()
    const upgrades = [...root.querySelectorAll("[data-upgrade-card]")].map(card => ({
        key: card.dataset.upgradeCard,
        description: card.querySelector("[data-upgrade-description]"),
        level: card.querySelector("[data-upgrade-level]"),
        button: card.querySelector("button")
    }))
    const rankTabs = [...root.querySelectorAll("[data-timed-rank]")]
    let state = null
    let selectedDuration = 60
    let busy = false
    let deadline = 0
    let startsAt = 0
    let incomeAnimation = null
    let countdownTimer = null
    let rankingSignature = ""
    let historySignature = ""
    let opener = null

    // Polling updates existing text nodes, never recreating cards or controls.
    function text(node, value) {
        value = String(value)
        if (node.textContent === value) return
        if (node.firstChild?.nodeType === Node.TEXT_NODE) node.firstChild.nodeValue = value
        else node.append(document.createTextNode(value))
    }

    function property(node, key, value) {
        if (node[key] !== value) node[key] = value
    }

    function openDialog() {
        if (dialog.open) return
        dialog.showModal()
        document.body.classList.add("timed-modal-open")
        if (state?.active) find("timedClick").focus({ preventScroll: true })
    }

    dialog.addEventListener("close", () => {
        document.body.classList.remove("timed-modal-open")
        if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true })
    })
    find("timedClose").addEventListener("click", () => dialog.close())
    dialog.addEventListener("click", event => {
        if (event.target !== dialog) return
        const rect = dialog.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close()
    })

    function renderClock() {
        if (!state?.active) return
        const beforeStart = Math.max(0, startsAt - performance.now())
        const remaining = Math.min(state.active.duration * 1000, Math.max(0, deadline - performance.now()))
        property(find("timedCountdown"), "hidden", beforeStart === 0)
        if (beforeStart > 0) text(find("timedCountdownNumber"), Math.ceil(beforeStart / 1000))
        const seconds = Math.ceil(remaining / 1000)
        text(find("timedClock"), remaining === 0 ? "Финиш · сохраняем…"
            : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`)
        const clock = find("timedClock")
        if (clock.classList.contains("is-ending") !== (seconds <= 10)) clock.classList.toggle("is-ending", seconds <= 10)
        property(find("timedProgress"), "value", remaining / (state.active.duration * 1000))
        property(find("timedClick"), "disabled", beforeStart > 0 || remaining === 0)
        upgrades.forEach(({ key, button }) => {
            const item = state.active.upgrades[key]
            property(button, "disabled", beforeStart > 0 || remaining === 0 || item.level >= item.maxLevel || state.active.balance < item.cost)
        })
    }

    function renderModes() {
        state.modes.forEach(mode => {
            let refs = modes.get(mode.duration)
            if (!refs) {
                const card = document.createElement("article")
                card.className = "timed-mode"
                // Created once per mode, never on the income timer.
                card.innerHTML = `<div class="timed-mode-heading"><h3></h3><span class="timed-eyebrow"></span></div>
                    <p>Рекорд: <strong data-best></strong></p><p class="timed-prizes"></p>
                    <div class="timed-mode-actions"><button type="button" data-timed-start="${mode.duration}"></button>
                    <button type="button" data-timed-view="${mode.duration}" class="timed-secondary">Рейтинг</button></div>`
                refs = { title: card.querySelector("h3"), name: card.querySelector(".timed-eyebrow"),
                    best: card.querySelector("[data-best]"), prizes: card.querySelector(".timed-prizes"), button: card.querySelector("[data-timed-start]") }
                modes.set(mode.duration, refs)
                find("timedModes").append(card)
            }
            text(refs.title, `${mode.duration / 60} мин`)
            text(refs.name, mode.name)
            text(refs.best, mode.current ? exact(mode.current.score) : "—")
            text(refs.prizes, `🥇 ${mode.rewards[0]} · 🥈 ${mode.rewards[1]} · 🥉 ${mode.rewards[2]} /сек`)
            const active = state.active?.duration === mode.duration
            text(refs.button, active ? "Вернуться" : "Играть")
            property(refs.button, "disabled", (busy && !state.active) || Boolean(state.active && !active))
        })
    }

    function renderRanking() {
        const mode = state.modes.find(item => item.duration === selectedDuration)
        const signature = JSON.stringify(mode)
        if (signature === rankingSignature) return
        rankingSignature = signature
        rankTabs.forEach(button => {
            const active = Number(button.dataset.timedRank) === selectedDuration
            if (button.classList.contains("is-active") !== active) button.classList.toggle("is-active", active)
            if (button.getAttribute("aria-pressed") !== String(active)) button.setAttribute("aria-pressed", String(active))
        })
        text(find("timedPosition"), mode.current
            ? `Ваше место: #${mode.current.rank} из ${mode.totalPlayers}. Рекорд счёта: ${exact(mode.current.score)}.`
            : "Завершите игру, чтобы попасть в этот рейтинг.")
        const rows = mode.top.map(player => {
            const row = createLeaderboardRow(player)
            text(row.querySelector(".leaderboard-score"), exact(player.score))
            return row
        })
        if (!rows.length) {
            const empty = document.createElement("p")
            empty.className = "timed-help"
            text(empty, "Рейтинг пока пуст. Станьте первым участником!")
            rows.push(empty)
        }
        updateChildren(find("timedRanking"), rows)
        updateChildren(find("timedAround"), (mode.around || []).map(player => {
            const row = createLeaderboardRow(player)
            text(row.querySelector(".leaderboard-score"), exact(player.score))
            return row
        }))
    }

    function renderRun() {
        const run = state.active
        const latest = state.history[0]
        property(find("timedArena"), "hidden", !run)
        property(find("timedResult"), "hidden", Boolean(run) || !latest)
        if (!run && latest) {
            const current = state.modes.find(mode => mode.duration === latest.duration).current
            text(find("timedResultTitle"), `Игра на ${latest.duration / 60} мин завершена!`)
            text(find("timedResultScore"), `Ваш результат: ${exact(latest.score)}`)
            text(find("timedResultDetail"), `Результат засчитан. Ваш рекорд: ${exact(current.score)} · место в рейтинге: #${current.rank}. ${current.rank <= 3 ? "Вы в тройке и получаете автодоход!" : "Сыграйте ещё раз и поборитесь за тройку."}`)
            if (find("timedReplay").dataset.timedStart !== String(latest.duration)) find("timedReplay").dataset.timedStart = String(latest.duration)
            property(find("timedReplay"), "disabled", busy)
        }
        if (!run) return
        text(find("timedRunTitle"), `Забег на ${run.duration / 60} мин`)
        text(find("timedBalance"), exact(run.balance))
        text(find("timedIncome"), `${exact(run.incomeRate)}/сек`)
        text(find("timedClick"), `Заработать +${run.clickPower}`)
        upgrades.forEach(({ key, description, level, button }) => {
            const item = run.upgrades[key]
            if (key === "robot") text(description, `+${2 + run.upgrades.engine.level}/сек · до финиша`)
            text(level, `Уровень ${item.level}/${item.maxLevel}`)
            text(button, item.level >= item.maxLevel ? "Максимум" : `Купить за ${exact(item.cost)}`)
        })
        renderClock()
    }

    window.renderTimedGames = next => {
        if (!next || (state && next.serverNow < state.serverNow)) return
        const newRun = next.active && next.active.id !== state?.active?.id
        const justFinished = Boolean(state?.active) && !next.active
        const autoIncome = next.active && !newRun ? Math.max(0, next.active.passiveEarned - state.active.passiveEarned) : 0
        state = next
        if (next.active) {
            if (newRun) selectedDuration = next.active.duration
            startsAt = performance.now() + next.active.startsInMs
            deadline = performance.now() + next.active.remainingMs + next.active.startsInMs
            if (!countdownTimer) countdownTimer = setInterval(renderClock, 100)
        } else if (countdownTimer) {
            clearInterval(countdownTimer)
            countdownTimer = null
        }
        text(find("timedReward"), `Доход за места: +${exact(next.rewardRate)}/сек`)
        renderModes()
        renderRun()
        if (autoIncome > 0 && dialog.open && document.visibilityState === "visible") {
            text(find("timedIncomePop"), `+${exact(autoIncome)}`)
            incomeAnimation?.cancel()
            const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            incomeAnimation = find("timedIncomePop").animate([
                { opacity: 1, transform: "translateY(0)" },
                { opacity: 0, transform: reducedMotion ? "translateY(0)" : "translateY(-28px)" }
            ], { duration: 900, easing: "ease-out" })
        }
        renderRanking()
        const signature = JSON.stringify(next.history.map(run => [run.id, run.endsAt, run.duration, run.score]))
        if (signature !== historySignature) {
            historySignature = signature
            const history = next.history.map(run => {
                const row = document.createElement("p")
                text(row, `${new Date(run.endsAt).toLocaleString("ru-RU")} · ${run.duration / 60} мин · ${exact(run.score)} монет`)
                return row
            })
            if (!history.length) {
                const empty = document.createElement("p")
                text(empty, "Завершённых игр пока нет.")
                history.push(empty)
            }
            updateChildren(find("timedHistory"), history)
        }
        if (newRun || justFinished) {
            openDialog()
            dialog.scrollTop = 0
        }
    }

    async function act(url, body) {
        // Only starts and purchases are exclusive. Waiting for a click response
        // must not discard further clicks or let a click unlock a pending purchase.
        const exclusive = body.action !== "click"
        if (exclusive && busy) return
        if (exclusive) busy = true
        property(find("timedError"), "hidden", true)
        if (exclusive) {
            renderModes()
            renderRun()
        }
        try {
            applyGameState(await apiRequest(url, { method: "POST", body: JSON.stringify(body) }))
        } catch (error) {
            text(find("timedError"), `${error.message}. Если связь прервалась, дождитесь обновления состояния: таймер продолжает идти.`)
            property(find("timedError"), "hidden", false)
            openDialog()
        } finally {
            if (exclusive) {
                busy = false
                renderModes()
                renderRun()
            }
        }
        if (url === "/api/timed/start" && state.active && dialog.open) find("timedClick").focus({ preventScroll: true })
    }

    root.addEventListener("click", event => {
        const button = event.target.closest("button")
        if (!button || button.disabled || !state) return
        if (!dialog.contains(button)) opener = button
        if (button.dataset.timedRank || button.dataset.timedView) {
            selectedDuration = Number(button.dataset.timedRank || button.dataset.timedView)
            renderRanking()
            if (button.dataset.timedView) {
                openDialog()
                find("timedRankingPanel").scrollIntoView({ block: "nearest" })
            }
        } else if (button.dataset.timedStart) {
            if (state.active) openDialog()
            else act("/api/timed/start", { duration: Number(button.dataset.timedStart) })
        } else if (state.active && (button.id === "timedClick" || button.dataset.timedUpgrade)) {
            act(`/api/timed/${state.active.id}/action`, button.id === "timedClick"
                ? { action: "click" } : { action: "upgrade", upgrade: button.dataset.timedUpgrade })
        }
    })

    if (gameState?.timedGames) window.renderTimedGames(gameState.timedGames)
})()
