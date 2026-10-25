(() => {
    const installButton = document.querySelector("#installApp")
    const installDialog = document.querySelector("#installDialog")
    const confirmInstall = document.querySelector("#confirmInstall")
    const installStatus = document.querySelector("#installStatus")
    const fullscreenButton = document.querySelector("#toggleFullscreen")
    const hapticsButton = document.querySelector("#toggleHaptics")
    const displayModes = ["standalone", "fullscreen", "minimal-ui"].map(mode => matchMedia(`(display-mode: ${mode})`))
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    const hapticsSupported = typeof navigator.vibrate === "function"
    const hapticsKey = "clicker.haptics"
    let installPrompt = null
    let installed = false
    let hapticsEnabled = true
    let lastPulse = -Infinity
    let waitingWorker = null
    let applyingUpdate = false

    try {
        hapticsEnabled = localStorage.getItem(hapticsKey) !== "off"
    } catch (_) { /* The preference can still be changed when storage is unavailable. */ }

    function inApp() {
        return navigator.standalone === true || displayModes.some(mode => mode.matches)
    }

    function updateInstallUI() {
        installButton.hidden = !window.isSecureContext || installed || inApp()
        confirmInstall.hidden = !installPrompt
        document.querySelector("#installInstructions").textContent = !window.isSecureContext
            ? "Для установки откройте игру по защищённому адресу HTTPS."
            : isIOS
                ? "В Safari откройте меню «Поделиться» → «На экран Домой» → «Добавить». Если есть переключатель «Открывать как веб-приложение», включите его. Затем запускайте игру с новой иконки."
                : installPrompt
                    ? "Нажмите «Установить приложение» и подтвердите установку. Затем запускайте кликер с иконки на домашнем экране или из списка приложений."
                    : "Откройте меню браузера → «Установить приложение» или «Добавить на главный экран». На компьютере кнопка установки может быть в адресной строке. Если такого пункта нет, откройте игру в Chrome или Edge (на Android также подходит Samsung Internet)."
    }

    window.addEventListener("beforeinstallprompt", event => {
        event.preventDefault()
        installPrompt = event
        updateInstallUI()
    })
    window.addEventListener("appinstalled", () => {
        installed = true
        installPrompt = null
        if (installDialog.open) installDialog.close()
        updateInstallUI()
    })
    displayModes.forEach(mode => mode.addEventListener("change", updateInstallUI))

    async function promptInstall() {
        const prompt = installPrompt
        if (!prompt) return
        installPrompt = null
        confirmInstall.disabled = true
        installStatus.textContent = ""
        try {
            // Keep prompt() directly in the user's click event for browser activation.
            await prompt.prompt()
            const choice = await prompt.userChoice
            if (choice.outcome === "accepted") {
                installed = true
                if (installDialog.open) installDialog.close()
            } else {
                installStatus.textContent = "Установку можно повторить позже через меню браузера."
            }
        } catch (_) {
            installStatus.textContent = "Откройте меню браузера и выберите установку приложения."
        } finally {
            confirmInstall.disabled = false
            updateInstallUI()
        }
    }

    installButton.addEventListener("click", () => {
        if (installPrompt) promptInstall()
        else {
            updateInstallUI()
            installStatus.textContent = ""
            installDialog.showModal()
        }
    })
    confirmInstall.addEventListener("click", promptInstall)
    document.querySelector("#closeInstall").addEventListener("click", () => installDialog.close())
    updateInstallUI()

    function updateFullscreenUI() {
        fullscreenButton.hidden = !document.fullscreenEnabled
        fullscreenButton.setAttribute("aria-pressed", String(Boolean(document.fullscreenElement)))
        fullscreenButton.textContent = document.fullscreenElement ? "⛶ Свернуть экран" : "⛶ На весь экран"
    }

    fullscreenButton.addEventListener("click", async () => {
        try {
            if (document.fullscreenElement) await document.exitFullscreen()
            else await document.documentElement.requestFullscreen()
        } catch (_) {
            fullscreenButton.textContent = "⛶ Попробовать снова"
            fullscreenButton.title = "Браузер не разрешил полноэкранный режим. Можно установить игру с кнопки «Установить»."
        }
    })
    document.addEventListener("fullscreenchange", updateFullscreenUI)
    updateFullscreenUI()

    function vibrate(pattern) {
        if (!hapticsSupported) return
        try { navigator.vibrate(pattern) } catch (_) { /* Feedback must never interrupt a game action. */ }
    }

    function updateHapticsUI() {
        hapticsButton.hidden = false
        hapticsButton.disabled = !hapticsSupported
        hapticsButton.setAttribute("aria-pressed", String(hapticsSupported && hapticsEnabled))
        hapticsButton.textContent = hapticsSupported ? `Вибрация: ${hapticsEnabled ? "вкл." : "выкл."}` : "Вибрация недоступна"
        hapticsButton.title = hapticsSupported ? "Короткий виброотклик на нажатия. Настройка сохраняется на этом устройстве."
            : "Этот браузер не поддерживает вибрацию. На iPhone и iPad виброотклик веб-приложений недоступен."
    }

    hapticsButton.addEventListener("click", () => {
        hapticsEnabled = !hapticsEnabled
        try { localStorage.setItem(hapticsKey, hapticsEnabled ? "on" : "off") } catch (_) { /* Optional storage. */ }
        updateHapticsUI()
        vibrate(hapticsEnabled ? 18 : 0)
    })
    document.addEventListener("click", event => {
        const button = event.target.closest("button")
        if (!event.isTrusted || !button || button.disabled || button === hapticsButton || !hapticsEnabled || document.hidden) return
        const now = performance.now()
        if (now - lastPulse < 35) return
        lastPulse = now
        vibrate(button.matches("#clickMe, #timedClick") ? 12 : 8)
    })
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) vibrate(0)
    })
    updateHapticsUI()

    function updateConnectionUI() {
        document.querySelector("#connectionNotice").hidden = navigator.onLine
    }
    window.addEventListener("online", updateConnectionUI)
    window.addEventListener("offline", updateConnectionUI)
    updateConnectionUI()

    if ("serviceWorker" in navigator && window.isSecureContext) {
        const updateNotice = document.querySelector("#appUpdate")
        const updateButton = document.querySelector("#applyAppUpdate")
        function offerUpdate(worker) {
            if (!worker || !navigator.serviceWorker.controller) return
            waitingWorker = worker
            updateNotice.hidden = false
        }
        updateButton.addEventListener("click", () => {
            if (!waitingWorker) return
            applyingUpdate = true
            updateButton.disabled = true
            updateButton.textContent = "Обновляем…"
            waitingWorker.postMessage({ type: "SKIP_WAITING" })
        })
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (applyingUpdate) window.location.reload()
        })
        navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" }).then(registration => {
            offerUpdate(registration.waiting)
            registration.addEventListener("updatefound", () => {
                const worker = registration.installing
                worker?.addEventListener("statechange", () => {
                    if (worker.state === "installed") offerUpdate(registration.waiting)
                })
            })
            document.addEventListener("visibilitychange", () => {
                if (!document.hidden) registration.update().catch(() => {})
            })
        }).catch(error => console.warn("Не удалось подготовить установку кликера:", error))
    }
})()
