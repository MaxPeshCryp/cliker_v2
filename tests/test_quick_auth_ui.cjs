// Real WebAuthn signatures via Chromium's virtual platform authenticator, with an isolated DB.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')

;(async () => {
    const root = path.resolve(__dirname, '..')
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clicker-quick-ui-'))
    const listener = net.createServer()
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const url = `http://localhost:${port}`
    const child = spawn(process.env.PYTHON_EXE || 'python', ['-c', `import app; app.app.run(host='127.0.0.1', port=${port}, debug=False)`], {
        cwd: root, windowsHide: true,
        env: { ...process.env, CLICKER_DATABASE_PATH: path.join(temporary, 'test.db'), CLICKER_SECRET_KEY: 'quick-ui-test-only', CLICKER_COOKIE_SECURE: 'false' },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let logs = ''
    child.stdout.on('data', data => { logs += data })
    child.stderr.on('data', data => { logs += data })
    let browser
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Flask did not start: ${logs}`)), 15000)
            child.on('error', error => { clearTimeout(timeout); reject(error) })
            child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Flask exited (${code}): ${logs}`)) })
            child.stderr.on('data', () => { if (logs.includes('Running on')) { clearTimeout(timeout); resolve() } })
        })
        browser = await chromium.launch({ headless: true, channel: 'msedge' })
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
        const page = await context.newPage()
        page.setDefaultTimeout(15000)
        page.on('dialog', dialog => dialog.dismiss())
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        const cdp = await context.newCDPSession(page)
        await cdp.send('WebAuthn.enable')
        await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
            protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
            hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
        } })
        const credentials = { nickname: 'Быстрый игрок', email: 'quick-ui@example.com', password: 'test-password' }
        assert.equal((await context.request.post(`${url}/api/register`, { data: credentials })).status(), 200)
        assert.equal((await context.request.post(`${url}/api/login`, { data: credentials })).status(), 200)
        await page.goto(url)
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        await page.locator('#openQuickAuth').click()
        await page.locator('#quickAuthDialog').waitFor({ state: 'visible' })
        await page.locator('#quickAuthPassword').fill(credentials.password)
        await page.locator('#setupPin').fill('012345')
        await page.locator('#confirmPin').fill('012346')
        await page.locator('#saveQuickPin').click()
        await page.getByText('PIN-коды не совпадают', { exact: true }).waitFor()
        await page.locator('#confirmPin').fill('012345')
        await page.locator('#saveQuickPin').click()
        await page.getByText('Вход по PIN включён на этом устройстве', { exact: true }).waitFor()
        assert.equal(await page.locator('#quickAuthPassword').inputValue(), '', 'Clear the password after setup')
        await page.locator('#quickAuthPassword').fill(credentials.password)
        await page.waitForFunction(() => !document.querySelector('#setupBiometric').disabled)
        await page.locator('#setupBiometric').click()
        await page.getByText('Вход по биометрии или защите устройства включён', { exact: true }).waitFor()
        assert.match(await page.locator('#quickAuthDevice').textContent(), /PIN включён.*Ключ доступа подключён/)
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 })
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Dialog must fit at ${width}px`)
            const dialog = await page.locator('#quickAuthDialog').boundingBox()
            assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width)
        }
        if (process.env.UI_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true })
            await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'quick-auth-setup.png') })
        }
        await page.locator('#closeQuickAuth').click()
        await page.locator('#logoutButton').click()
        await page.locator('#pinLogin').waitFor({ state: 'visible' })
        await page.locator('#loginPin').fill('012345')
        await page.locator('#loginPin').press('Enter')
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        assert.match(await page.locator('#welcomeName').textContent(), /Быстрый игрок/)
        await page.locator('#logoutButton').click()
        await page.locator('#biometricLogin').waitFor({ state: 'visible' })

        // Native cancellation leaves password and PIN alternatives usable.
        await page.evaluate(() => {
            window.realCredentialGet = navigator.credentials.get.bind(navigator.credentials)
            navigator.credentials.get = async () => { throw new DOMException('Cancelled', 'NotAllowedError') }
        })
        await page.locator('#biometricLogin').click()
        await page.waitForFunction(() => document.querySelector('#quickLoginStatus').textContent.includes('отменена'))
        await page.evaluate(() => { navigator.credentials.get = window.realCredentialGet })
        await page.locator('#biometricLogin').click()
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        await page.locator('#logoutButton').click()
        await page.locator('#pinLogin').waitFor({ state: 'visible' })

        // Exhausted PIN attempts cannot block the independent passkey.
        for (let attempt = 1; attempt <= 5; attempt++) {
            await page.locator('#loginPin').fill('999999')
            await page.locator('#pinLogin').click()
            await page.waitForFunction(attempt => document.querySelector('#quickLoginStatus').textContent.includes(attempt === 5 ? 'отключён' : `Осталось попыток: ${5 - attempt}`), attempt)
        }
        await page.locator('#pinLoginArea').waitFor({ state: 'hidden' })
        await page.locator('#biometricLogin').click()
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        await page.locator('#logoutButton').click()
        await page.locator('#biometricLogin').waitFor({ state: 'visible' })

        // Obtain real signed assertions and prove wrong challenges and signatures cannot log in.
        async function assertion(wrongChallenge = false) {
            return page.evaluate(async wrongChallenge => {
                const status = await (await fetch('/api/quick-auth/status')).json()
                const headers = { 'Content-Type': 'application/json', 'X-Quick-CSRF': status.csrfToken }
                const options = await (await fetch('/api/quick-auth/passkey/login/options', { method: 'POST', headers, body: '{}' })).json()
                const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0))
                options.challenge = decode(options.challenge)
                if (wrongChallenge) options.challenge[0] ^= 1
                options.allowCredentials = options.allowCredentials.map(item => ({ ...item, id: decode(item.id) }))
                const credential = await navigator.credentials.get({ publicKey: options })
                return { credential: credential.toJSON(), csrf: status.csrfToken }
            }, wrongChallenge)
        }
        async function verify(value) {
            return context.request.post(`${url}/api/quick-auth/passkey/login/verify`, { headers: { 'X-Quick-CSRF': value.csrf }, data: { credential: value.credential } })
        }
        const wrongChallenge = await assertion(true)
        assert.equal((await verify(wrongChallenge)).status(), 401)
        assert.equal((await verify(wrongChallenge)).status(), 400, 'A rejected assertion must consume its challenge')
        const tampered = await assertion()
        const signature = Buffer.from(tampered.credential.response.signature, 'base64url')
        signature[signature.length - 1] ^= 1
        tampered.credential.response.signature = signature.toString('base64url')
        assert.equal((await verify(tampered)).status(), 401)
        const signed = await assertion()
        assert.equal((await verify(signed)).status(), 200, 'Valid cryptographic assertion should authenticate')
        await context.request.post(`${url}/api/logout`)
        assert.equal((await verify(signed)).status(), 400, 'A successful assertion must never be replayable')
        assert.equal((await context.request.get(`${url}/api/state`)).status(), 401)
        await page.reload()
        await page.locator('#biometricLogin').waitFor({ state: 'visible' })
        await page.locator('#biometricLogin').click()
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        await page.locator('#openQuickAuth').click()
        await page.locator('#forgetQuickAuth').click()
        await page.getByText('Быстрый вход на этом устройстве отключён', { exact: true }).waitFor()
        await page.locator('#closeQuickAuth').click()
        await page.locator('#logoutButton').click()
        await page.locator('#form-login').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#quickLoginPanel').isVisible(), false)
        await page.locator('#email-login').fill(credentials.email)
        await page.locator('#password-login').fill(credentials.password)
        await page.locator('#form-login button[type="submit"]').click()
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        assert.deepEqual(errors, [], 'No browser errors across setup, login, cancellation, lockout and revocation')
        console.log('Quick-login browser checks passed: device PIN, real WebAuthn registration/signatures, PIN lockout, cancellation, replay/tampering rejection, revocation and responsive dialogs.')
    } finally {
        if (browser) await browser.close()
        child.kill()
        await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
        fs.rmSync(temporary, { recursive: true, force: true })
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
