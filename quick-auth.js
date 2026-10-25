(() => {
    const find = id => document.getElementById(id)
    const dialog = find("quickAuthDialog")
    const setupForm = find("quickAuthSetupForm")
    const loginStatus = find("quickLoginStatus")
    const setupStatus = find("quickSetupStatus")
    let info = null
    let busy = false
    let platformAvailable = false

    function render() {
        const pin = Boolean(info?.pinEnabled)
        const passkey = Boolean(info?.passkeyEnabled)
        find("quickLoginPanel").hidden = !pin && !passkey
        find("pinLoginArea").hidden = !pin
        find("biometricLogin").hidden = !passkey || !platformAvailable
        find("quickLoginName").textContent = info?.nickname ? `С возвращением, ${info.nickname}` : "Быстрый вход"
        find("quickAuthDevice").textContent = [pin && "PIN включён", passkey && "Ключ доступа подключён"].filter(Boolean).join(" · ") || "Быстрый вход ещё не настроен"
        find("forgetQuickAuth").hidden = !pin && !passkey
        find("saveQuickPin").textContent = pin ? "Изменить PIN" : "Включить вход по PIN"
        for (const id of ["saveQuickPin", "setupBiometric", "forgetQuickAuth", "pinLogin", "biometricLogin"]) find(id).disabled = busy
        find("setupBiometric").disabled = busy || !platformAvailable
        if (passkey && !platformAvailable && !pin) find("quickLoginName").textContent += ". В этом браузере ключ доступа недоступен — используй пароль."
    }

    async function refresh() {
        const response = await fetch("/api/quick-auth/status", { cache: "no-store" })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || "Не удалось загрузить настройки входа")
        info = data
        render()
        if (!gameState && (info.pinEnabled || info.passkeyEnabled)) {
            find("form-register").style.display = "none"
            find("form-login").style.display = "block"
        }
    }

    async function send(path, data = {}) {
        if (!info) await refresh()
        const response = await fetch(`/api/quick-auth/${path}`, {
            method: "POST", cache: "no-store",
            headers: { "Content-Type": "application/json", "X-Quick-CSRF": info.csrfToken },
            body: JSON.stringify(data)
        })
        const result = await response.json()
        if (!response.ok) {
            const error = new Error(result.error || "Не удалось выполнить вход")
            error.code = result.code
            throw error
        }
        return result
    }

    async function run(status, action) {
        if (busy) return
        busy = true
        status.textContent = "Подождите…"
        render()
        try { await action() }
        catch (error) {
            status.textContent = error.name === "NotAllowedError" ? "Системная проверка отменена или не завершена. Можно повторить или войти паролем."
                : error.name === "InvalidStateError" ? "Для аккаунта уже есть ключ доступа на устройстве. Используй существующий ключ или вход по PIN."
                : error instanceof TypeError ? "Не удалось подключиться. Проверь интернет и попробуй снова."
                : error.message
            if (error.code === "PIN_DISABLED") await refresh().catch(() => {})
        } finally {
            busy = false
            render()
        }
    }

    function decode(value) {
        const text = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="))
        return Uint8Array.from(text, character => character.charCodeAt(0))
    }

    function encode(value) {
        return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    }

    function credentialJSON(credential) {
        if (credential.toJSON) return credential.toJSON()
        const response = { clientDataJSON: encode(credential.response.clientDataJSON) }
        for (const key of ["attestationObject", "authenticatorData", "signature", "userHandle"]) {
            if (credential.response[key]) response[key] = encode(credential.response[key])
        }
        if (credential.response.getTransports) response.transports = credential.response.getTransports()
        return { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
            response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment }
    }

    find("openQuickAuth").addEventListener("click", () => {
        setupForm.reset()
        setupStatus.textContent = ""
        dialog.showModal()
        refresh().catch(error => { setupStatus.textContent = error.message })
    })
    find("closeQuickAuth").addEventListener("click", () => dialog.close())
    dialog.addEventListener("close", () => setupForm.reset())
    setupForm.addEventListener("submit", event => {
        event.preventDefault()
        const pin = find("setupPin").value
        if (!/^[0-9]{6}$/.test(pin)) { setupStatus.textContent = "Придумай PIN ровно из 6 цифр"; find("setupPin").focus(); return }
        if (pin !== find("confirmPin").value) { setupStatus.textContent = "PIN-коды не совпадают"; find("confirmPin").focus(); return }
        run(setupStatus, async () => {
            const result = await send("pin", { password: find("quickAuthPassword").value, pin })
            setupForm.reset()
            await refresh()
            setupStatus.textContent = result.message
        })
    })
    find("setupBiometric").addEventListener("click", () => {
        if (!find("quickAuthPassword").reportValidity() || !platformAvailable) return
        run(setupStatus, async () => {
            const options = await send("passkey/register/options", { password: find("quickAuthPassword").value })
            options.challenge = decode(options.challenge)
            options.user.id = decode(options.user.id)
            options.excludeCredentials = (options.excludeCredentials || []).map(item => ({ ...item, id: decode(item.id) }))
            setupStatus.textContent = "Подтверди создание ключа в системном окне устройства…"
            const credential = await navigator.credentials.create({ publicKey: options })
            if (!credential) throw new Error("Создание ключа отменено")
            const result = await send("passkey/register/verify", { credential: credentialJSON(credential) })
            setupForm.reset()
            await refresh()
            setupStatus.textContent = result.message
        })
    })
    find("pinLogin").addEventListener("click", () => {
        const pin = find("loginPin").value
        if (!/^[0-9]{6}$/.test(pin)) { loginStatus.textContent = "Введите PIN из 6 цифр"; find("loginPin").focus(); return }
        run(loginStatus, async () => {
            const state = await send("pin/login", { pin })
            find("loginPin").value = ""
            loginStatus.textContent = ""
            openGame(state)
        })
    })
    find("loginPin").addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); find("pinLogin").click() }
    })
    find("biometricLogin").addEventListener("click", () => {
        run(loginStatus, async () => {
            const options = await send("passkey/login/options")
            options.challenge = decode(options.challenge)
            options.allowCredentials = options.allowCredentials.map(item => ({ ...item, id: decode(item.id) }))
            loginStatus.textContent = "Подтверди вход в системном окне устройства…"
            const credential = await navigator.credentials.get({ publicKey: options })
            if (!credential) throw new Error("Вход отменён")
            const state = await send("passkey/login/verify", { credential: credentialJSON(credential) })
            loginStatus.textContent = ""
            openGame(state)
        })
    })
    find("forgetQuickAuth").addEventListener("click", () => {
        run(setupStatus, async () => {
            const result = await send("disable")
            setupForm.reset()
            await refresh()
            setupStatus.textContent = result.message
        })
    })
    window.addEventListener("clicker:login", () => refresh().catch(() => {}))
    window.addEventListener("clicker:logout", () => refresh().catch(() => {}))
    if (!window.isSecureContext) {
        find("openQuickAuth").disabled = true
        find("openQuickAuth").title = "Быстрый вход доступен по HTTPS или на localhost"
        return
    }
    if (window.PublicKeyCredential && navigator.credentials && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(available => {
            platformAvailable = available
            if (!available) find("biometricHelp").textContent = "Системный ключ доступа недоступен. Настрой блокировку экрана и биометрию устройства или используй PIN из шести цифр."
            render()
        }).catch(() => { platformAvailable = false; render() })
    } else find("biometricHelp").textContent = "Этот браузер не поддерживает системный ключ доступа. Используй вход по PIN."
    render()
    refresh().catch(error => { loginStatus.textContent = error.message })
})()
