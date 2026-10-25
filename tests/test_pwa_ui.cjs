// Real-browser PWA checks; all accounts and worker upgrades use an isolated server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')

;(async () => {
    const root = path.resolve(__dirname, '..')
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clicker-pwa-'))
    const listener = net.createServer()
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const url = `http://127.0.0.1:${port}`
    const child = spawn(process.env.PYTHON_EXE || 'python', ['-c', `
import app
worker_version = 1
@app.app.post('/__test__/upgrade-worker')
def upgrade_worker():
    global worker_version
    worker_version = 2
    return {'ok': True}
@app.app.before_request
def versioned_worker():
    if app.request.path == '/service-worker.js' and worker_version == 2:
        source = (app.BASE_DIR / 'service-worker.js').read_text(encoding='utf-8')
        return app.Response(source.replace('clicker-pwa-v1', 'clicker-pwa-test-v2'),
                            mimetype='text/javascript', headers={'Cache-Control': 'no-cache'})
app.app.run(host='127.0.0.1', port=${port}, debug=False)
`], {
        cwd: root, windowsHide: true,
        env: { ...process.env, CLICKER_DATABASE_PATH: path.join(temporary, 'test.db'), CLICKER_SECRET_KEY: 'pwa-test-only', CLICKER_COOKIE_SECURE: 'false' },
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
            child.stderr.on('data', () => {
                if (logs.includes('Running on')) { clearTimeout(timeout); resolve() }
            })
        })
        browser = await chromium.launch({ headless: true, channel: 'msedge' })
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
        await context.addInitScript(() => {
            window.vibrationCalls = []
            Object.defineProperty(navigator, 'vibrate', { value: pattern => { window.vibrationCalls.push(pattern); return true } })
        })
        const page = await context.newPage()
        page.setDefaultTimeout(15000)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        const credentials = { nickname: 'PWA Player', email: 'pwa@example.com', password: 'test-password' }
        assert.equal((await context.request.post(`${url}/api/register`, { data: credentials })).status(), 200)
        assert.equal((await context.request.post(`${url}/api/login`, { data: credentials })).status(), 200)
        await page.goto(url)
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        await page.evaluate(async () => {
            await navigator.serviceWorker.ready
            if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
        })
        const cdp = await context.newCDPSession(page)
        const manifest = await cdp.send('Page.getAppManifest')
        assert.equal(manifest.errors.length, 0, 'Chromium must accept the web app manifest')
        assert.equal(JSON.parse(manifest.data).display, 'fullscreen')
        const cachedPaths = await page.evaluate(async () => {
            const cache = await caches.open('clicker-pwa-v1')
            return (await cache.keys()).map(request => new URL(request.url).pathname).sort()
        })
        assert.deepEqual(cachedPaths, ['/assets/icons/apple-touch-icon.png', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/assets/icons/icon-maskable-512.png', '/offline.html'])

        await page.locator('#clickMe').click()
        await page.waitForFunction(() => gameState.userCount === 1)
        assert.ok((await page.evaluate(() => window.vibrationCalls)).includes(12), 'A real game click should vibrate')
        await page.locator('#toggleHaptics').click()
        assert.equal(await page.locator('#toggleHaptics').getAttribute('aria-pressed'), 'false')
        await page.reload()
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#toggleHaptics').getAttribute('aria-pressed'), 'false', 'Preference should survive reopening')
        await page.locator('#clickMe').click()
        await page.waitForFunction(() => gameState.userCount === 2)
        assert.deepEqual(await page.evaluate(() => window.vibrationCalls), [], 'Disabled haptics must stay silent')
        await page.locator('#toggleHaptics').click()
        assert.equal(await page.locator('#toggleHaptics').getAttribute('aria-pressed'), 'true')

        // The browser owns the actual OS install dialog. Exercise its one-shot event contract.
        await page.evaluate(() => {
            window.installCalls = 0
            const event = new Event('beforeinstallprompt', { cancelable: true })
            event.prompt = async () => { window.installCalls++ }
            event.userChoice = Promise.resolve({ outcome: 'dismissed' })
            window.dispatchEvent(event)
        })
        await page.locator('#installApp').click()
        await page.waitForFunction(() => window.installCalls === 1)
        await page.locator('#installApp').click()
        await page.locator('#installDialog').waitFor({ state: 'visible' })
        assert.equal(await page.evaluate(() => window.installCalls), 1, 'A consumed install prompt must never be reused')
        await page.locator('#closeInstall').click()

        await page.locator('#toggleFullscreen').click()
        await page.waitForFunction(() => Boolean(document.fullscreenElement))
        assert.equal(await page.locator('#toggleFullscreen').getAttribute('aria-pressed'), 'true')
        await page.locator('#toggleFullscreen').click()
        await page.waitForFunction(() => !document.fullscreenElement)
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 })
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}px`)
        }
        if (process.env.UI_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true })
            await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'pwa-mobile.png') })
        }

        // Offline gameplay and private HTTP responses must never be synthesized from cache.
        await context.setOffline(true)
        await page.locator('#connectionNotice').waitFor({ state: 'visible' })
        assert.equal(await page.evaluate(async () => { try { await fetch('/api/state'); return false } catch { return true } }), true)
        await page.reload()
        await page.getByRole('heading', { name: 'Вернёмся к кликам, когда появится связь' }).waitFor()
        await page.waitForLoadState('load')
        if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'pwa-offline.png') })
        await context.setOffline(false)
        await page.locator('#gameLayout').waitFor({ state: 'visible' }).catch(async error => {
            console.error('Reconnect state:', await page.evaluate(async () => ({ url: location.href, online: navigator.onLine, reconnect: typeof reconnect, readyState: document.readyState, title: document.title, probe: await fetch('/', {method:'HEAD', cache:'no-store'}).then(response => response.status).catch(error => error.message) })), errors)
            console.error('Server requests:', logs.slice(-2500))
            throw error
        })
        await page.waitForFunction(() => gameState.userCount === 2)

        // Update a real service worker, checking that the active game waits for approval.
        await context.request.post(`${url}/__test__/upgrade-worker`)
        await page.evaluate(async () => {
            window.keptGameOpen = true
            await (await navigator.serviceWorker.getRegistration()).update()
        })
        await page.locator('#appUpdate').waitFor({ state: 'visible' })
        assert.equal(await page.evaluate(() => window.keptGameOpen), true, 'Update must not interrupt play')
        await page.locator('#applyAppUpdate').click()
        await page.waitForFunction(() => !window.keptGameOpen && document.querySelector('#gameLayout'))
        await page.locator('#gameLayout').waitFor({ state: 'visible' })
        assert.deepEqual(await page.evaluate(() => caches.keys()), ['clicker-pwa-test-v2'])
        await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
        assert.equal(await page.locator('#installApp').isVisible(), false)
        assert.deepEqual(errors, [], 'No uncaught errors in normal, offline or update flows')

        const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' })
        await ios.addInitScript(() => Object.defineProperty(navigator, 'vibrate', { value: undefined }))
        const iosPage = await ios.newPage()
        await iosPage.goto(url)
        assert.equal(await iosPage.locator('#toggleHaptics').isDisabled(), true)
        await iosPage.locator('#installApp').click()
        await iosPage.locator('#installDialog').waitFor({ state: 'visible' })
        assert.match(await iosPage.locator('#installInstructions').textContent(), /Поделиться.*На экран Домой/)
        await ios.close()

        const standalone = await browser.newContext()
        await standalone.addInitScript(() => {
            Object.defineProperty(navigator, 'standalone', { value: true })
            Object.defineProperty(Storage.prototype, 'getItem', { value: () => { throw new Error('Storage blocked') } })
            Object.defineProperty(Storage.prototype, 'setItem', { value: () => { throw new Error('Storage blocked') } })
            Object.defineProperty(navigator, 'vibrate', { value: () => { throw new Error('Haptics blocked') } })
        })
        const standalonePage = await standalone.newPage()
        const standaloneErrors = []
        standalonePage.on('pageerror', error => standaloneErrors.push(error.message))
        await standalonePage.goto(url)
        assert.equal(await standalonePage.locator('#installApp').isVisible(), false, 'Already installed launch should hide installation')
        await standalonePage.locator('#toggleHaptics').click()
        await standalonePage.locator('#toggleHaptics').click()
        assert.deepEqual(standaloneErrors, [], 'Blocked storage and vibration must not break the app')
        await standalone.close()
        console.log('PWA browser checks passed: manifest, install, fullscreen, haptics, mobile layout, offline recovery, safe updates and platform fallbacks.')
    } finally {
        if (browser) await browser.close()
        child.kill()
        await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
        fs.rmSync(temporary, { recursive: true, force: true })
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
