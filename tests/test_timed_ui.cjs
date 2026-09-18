// End-to-end browser checks against an isolated Flask process and test-only clock.
// PYTHON_EXE selects Python; PLAYWRIGHT_MODULE selects an installed Playwright.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')

async function availablePort() {
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}

;(async () => {
    const root = path.resolve(__dirname, '..')
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clicker-timed-ui-'))
    const port = await availablePort()
    const url = `http://127.0.0.1:${port}`
    // This clock endpoint exists only in the child test process, never in app.py.
    const serverCode = `
import app, timed_games, time
offset = 0
timed_games.now_ms = lambda: int(time.time() * 1000) + offset
@app.app.post('/__test__/advance')
def advance():
    global offset
    offset += app.request.get_json()['milliseconds']
    return {'ok': True}
@app.app.post('/__test__/fund')
def fund():
    with app.db_connection() as db:
        db.execute('UPDATE users SET balance = ? WHERE id = ?', (app.db_amount(int(app.request.get_json()['amount'])), app.session['user_id']))
    return {'ok': True}
@app.app.post('/__test__/mature-investments')
def mature_investments():
    with app.db_connection() as db:
        db.execute('UPDATE investments SET ready_at = 0 WHERE user_id = ?', (app.session['user_id'],))
    return {'ok': True}
app.app.run(host='127.0.0.1', port=${port}, debug=False)
`
    const child = spawn(process.env.PYTHON_EXE || 'python', ['-c', serverCode], {
        cwd: root, windowsHide: true,
        env: { ...process.env, CLICKER_DATABASE_PATH: path.join(temporary, 'test.db'), CLICKER_SECRET_KEY: 'test-only-secret', CLICKER_COOKIE_SECURE: 'false' },
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
        const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        // Avoid relying on an external font during a local application test.
        await page.route('https://fonts.googleapis.com/**', route => route.abort())
        const credentials = { nickname: '<img src=x> Игрок', email: 'ui@example.com', password: 'test-password' }
        assert.equal((await context.request.post(`${url}/api/register`, { data: credentials })).status(), 200)
        assert.equal((await context.request.post(`${url}/api/login`, { data: credentials })).status(), 200)
        await page.goto(url)
        await page.locator('#timedModes [data-timed-start="60"]').waitFor()
        assert.equal(await page.locator('#timedModes [data-timed-start]').count(), 3)
        assert.equal(await page.locator('#timedDialog').isVisible(), false)
        assert.ok((await page.locator('#timedGames').boundingBox()).height < 300, 'Desktop mini-games should be compact')
        assert.equal(await page.locator('#timedArena').isVisible(), false)
        await page.locator('#timedModes [data-timed-start="60"]').click()
        await page.locator('#timedArena').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#timedBalance').textContent(), '0')
        assert.equal(await page.locator('[data-timed-upgrade="click"]').isDisabled(), true)
        assert.equal(await page.locator('#timedModes [data-timed-start="180"]').isDisabled(), true)
        assert.equal(await page.locator('#timedDialog').evaluate(node => node.matches(':modal')), true)
        assert.equal(await page.locator('#timedCountdown').isVisible(), true)
        assert.equal(await page.locator('#timedClick').isDisabled(), true)
        for (const number of ['3', '2', '1']) {
            await page.waitForFunction(value => document.querySelector('#timedCountdownNumber').textContent === value, number)
        }
        await page.locator('#timedCountdown').waitFor({ state: 'hidden' })
        assert.equal(await page.locator('#timedRankingPanel').isVisible(), true)
        assert.equal(await page.locator('#timedScore').count(), 0, 'There must be just one balance')
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.querySelector('#timedDialog').open)
        await page.waitForTimeout(1200)
        assert.equal(await page.locator('#timedDialog').isVisible(), false, 'Polling must not reopen a dismissed dialog')
        await page.locator('#timedModes [data-timed-start="60"]').click()
        await page.locator('#timedArena').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#timedBalance').textContent(), '0', 'Return must not restart the run')
        // Simulate a slow response without delaying delivery to the server.
        // Three clicks above the server's 100 ms interval must all be submitted
        // while the first response is still outstanding.
        let rapidClickRequests = 0
        const slowResponse = async route => {
            rapidClickRequests++
            const response = await route.fetch()
            await new Promise(resolve => setTimeout(resolve, 1000))
            await route.fulfill({ response })
        }
        await page.route('**/api/timed/*/action', slowResponse)
        for (let i = 0; i < 3; i++) {
            await page.locator('#timedClick').click()
            await page.waitForTimeout(150)
        }
        assert.equal(rapidClickRequests, 3, 'Slow responses must not discard rapid clicks')
        await page.waitForFunction(() => document.querySelector('#timedBalance').textContent === '3')
        const rapidState = await (await context.request.get(`${url}/api/state`)).json()
        assert.equal(rapidState.timedGames.active.balance, 3, 'All three clicks must reach the server')
        await page.unroute('**/api/timed/*/action', slowResponse)
        await page.waitForTimeout(1100)
        for (let i = 4; i <= 15; i++) {
            await page.locator('#timedClick').click()
            await page.waitForFunction(score => document.querySelector('#timedBalance').textContent === String(score), i)
            await page.waitForTimeout(110)
        }
        await page.locator('[data-timed-upgrade="click"]').click()
        await page.waitForFunction(() => document.querySelector('#timedClick').textContent.includes('+2'))
        assert.equal(await page.locator('#timedBalance').textContent(), '0')
        for (let i = 1; i <= 15; i++) {
            await page.locator('#timedClick').click()
            await page.waitForFunction(score => document.querySelector('#timedBalance').textContent === String(score), i * 2)
            await page.waitForTimeout(110)
        }
        // A delayed click request must not toggle or move an already affordable robot.
        await page.evaluate(() => {
            window.robotDisabledChanges = 0
            const button = document.querySelector('[data-timed-upgrade="robot"]')
            window.robotBounds = button.getBoundingClientRect().toJSON()
            window.robotObserver = new MutationObserver(records => { window.robotDisabledChanges += records.length })
            window.robotObserver.observe(button, { attributes: true, attributeFilter: ['disabled'] })
        })
        const delayedAction = async route => { await new Promise(resolve => setTimeout(resolve, 200)); await route.continue() }
        await page.route('**/api/timed/*/action', delayedAction)
        await page.locator('#timedClick').click()
        await page.waitForFunction(() => document.querySelector('#timedBalance').textContent === '32')
        await page.unroute('**/api/timed/*/action', delayedAction)
        await page.evaluate(() => {
            window.robotObserver.disconnect()
            if (window.robotDisabledChanges) throw new Error('Robot button flickers during a click request')
            const rect = document.querySelector('[data-timed-upgrade="robot"]').getBoundingClientRect()
            for (const key of ['x', 'y', 'width', 'height']) {
                if (Math.abs(rect[key] - window.robotBounds[key]) > 0.5) throw new Error('Robot button moved during clicking')
            }
        })
        await page.locator('[data-timed-upgrade="robot"]').click()
        await page.waitForFunction(() => document.querySelector('#timedIncome').textContent === '2/сек')
        await page.evaluate(() => {
            const root = document.querySelector('#timedGames')
            const nodes = [...root.querySelectorAll('*')]
            const create = document.createElement
            let created = 0
            document.createElement = function (...args) { created++; return create.apply(this, args) }
            try {
                for (let i = 0; i < 5; i++) window.renderTimedGames(structuredClone(gameState.timedGames))
            } finally { document.createElement = create }
            if (created) throw new Error(`Polling created ${created} HTML elements`)
            window.timedNodes = nodes
            window.timedStructureChanges = 0
            window.timedObserver = new MutationObserver(records => {
                window.timedStructureChanges += records.filter(record => record.type === 'childList').length
            })
            window.timedObserver.observe(root, { subtree: true, childList: true })
            document.querySelector('#timedClick').focus()
            window.timedScoreBefore = Number(document.querySelector('#timedBalance').textContent)
            const animate = Element.prototype.animate
            window.incomeAnimations = 0
            Element.prototype.animate = function (...args) {
                if (this.id === 'timedIncomePop') window.incomeAnimations++
                return animate.apply(this, args)
            }
        })
        await page.waitForTimeout(3200)
        await page.evaluate(() => {
            window.timedObserver.disconnect()
            if (window.timedStructureChanges) throw new Error('Polling rebuilt mini-game HTML')
            const nodes = [...document.querySelectorAll('#timedGames *')]
            if (!window.timedNodes.every((node, i) => node === nodes[i])) throw new Error('Polling replaced a mini-game node')
            if (document.activeElement.id !== 'timedClick') throw new Error('Polling lost keyboard focus')
            if (Number(document.querySelector('#timedBalance').textContent) <= window.timedScoreBefore) throw new Error('Robot income display stopped updating')
            if (window.incomeAnimations < 2) throw new Error('Passive income animation did not play')
        })
        if (process.env.UI_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true })
            await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'timed-active-desktop.png') })
        }
        await page.reload()
        await page.locator('#timedArena').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#timedIncome').textContent(), '2/сек')
        assert.equal(await page.locator('#timedClick').textContent(), 'Заработать +2')
        await context.request.post(`${url}/__test__/advance`, { data: { milliseconds: 63_000 } })
        await page.locator('#timedResult').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#timedArena').isVisible(), false)
        assert.match(await page.locator('#timedResult').textContent(), /Результат засчитан/)
        assert.match(await page.locator('#timedReward').textContent(), /\+3\/сек/)
        assert.equal(await page.locator('#timedRankingPanel').isVisible(), true)
        assert.equal(await page.locator('#timedAround .is-current').count(), 1)
        assert.equal(await page.locator('#timedRanking img').count(), 0)
        assert.match(await page.locator('#timedRanking').textContent(), /<img src=x> Игрок/)
        await page.locator('#timedResult [data-timed-start]').click()
        await page.locator('#timedArena').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#timedBalance').textContent(), '0')
        assert.equal(await page.locator('#timedClick').textContent(), 'Заработать +1')
        await context.request.post(`${url}/__test__/advance`, { data: { milliseconds: 63_000 } })
        await page.locator('#timedResult').waitFor({ state: 'visible' })
        for (const duration of [180, 300]) {
            await page.locator('#timedClose').click()
            await page.locator(`#timedModes [data-timed-start="${duration}"]`).click()
            await page.locator('#timedArena').waitFor({ state: 'visible' })
            await context.request.post(`${url}/__test__/advance`, { data: { milliseconds: duration * 1000 + 3000 } })
            await page.locator('#timedResult').waitFor({ state: 'visible' })
            assert.match(await page.locator('#timedResult').textContent(), new RegExp(`на ${duration / 60} мин`))
            await page.locator(`[data-timed-rank="${duration}"]`).click()
            assert.match(await page.locator('#timedPosition').textContent(), /#1/)
        }
        assert.match(await page.locator('#timedReward').textContent(), /\+27\/сек/)
        assert.equal(await page.locator('#timedHistory p').count(), 4)
        await page.locator('#timedClose').click()
        if (process.env.UI_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true })
            await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'timed-desktop.png'), fullPage: true })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'timed-mobile-cards.png') })
        const mobileHeight = (await page.locator('#timedGames').boundingBox()).height
        assert.ok(mobileHeight < 470, `Mobile cards should be compact; height: ${mobileHeight}`)
        await page.locator('[data-timed-view="180"]').click()
        assert.equal(await page.locator('#timedDialog').isVisible(), true)
        assert.equal(await page.locator('#timedRankingPanel').isVisible(), true)
        await page.locator('#timedClose').click()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        assert.equal(await page.locator('#timedDialog').evaluate(node => node.scrollWidth <= node.clientWidth), true)
        await page.locator('#timedModes [data-timed-start="180"]').click()
        await page.locator('#timedArena').waitFor({ state: 'visible' })
        await page.locator('#timedCountdown').waitFor({ state: 'hidden' })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        assert.equal(await page.locator('#timedDialog').evaluate(node => node.scrollWidth <= node.clientWidth), true)
        const mobileRanking = await page.locator('#timedRankingPanel').boundingBox()
        assert.ok(mobileRanking.y >= 0 && mobileRanking.y + mobileRanking.height < 844, 'Ranking should be visible immediately on mobile')
        if (process.env.UI_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'timed-mobile.png') })
        }
        assert.deepEqual(errors, [])
        // A separate investor has no timed rewards, so every unit can be checked.
        const investorContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
        const investor = { nickname: 'Investor', email: 'investor-ui@example.com', password: 'test-password' }
        await investorContext.request.post(`${url}/api/register`, { data: investor })
        await investorContext.request.post(`${url}/api/login`, { data: investor })
        await investorContext.request.post(`${url}/__test__/fund`, { data: { amount: '20000000000000000007' } })
        const investmentPage = await investorContext.newPage()
        investmentPage.on('pageerror', error => errors.push(error.message))
        const notices = []
        investmentPage.on('dialog', async dialog => { notices.push(dialog.message()); await dialog.accept() })
        await investmentPage.route('https://fonts.googleapis.com/**', route => route.abort())
        await investmentPage.goto(url)
        await investmentPage.locator('[data-endgame-tab="investments"]').click()
        assert.equal(await investmentPage.locator('#investmentPlan option').count(), 5)
        await investmentPage.locator('#investmentAmount').fill('12.000000000000000001 Qi')
        await investmentPage.locator('#investmentPlan').selectOption('venture')
        await investmentPage.waitForTimeout(1200)
        assert.equal(await investmentPage.locator('#investmentAmount').inputValue(), '12.000000000000000001 Qi')
        assert.equal(await investmentPage.locator('#investmentPlan').inputValue(), 'venture')
        assert.match(await investmentPage.locator('#investmentPlanSummary').textContent(), /40%.*200%/)
        await investmentPage.locator('#investmentPlan').selectOption('guaranteed')
        const posted = investmentPage.waitForRequest(request => request.url().endsWith('/api/investments/create'))
        await investmentPage.locator('#investmentForm [type="submit"]').click()
        assert.deepEqual((await posted).postDataJSON(), { amount: '12.000000000000000001 Qi', plan: 'guaranteed' })
        await investmentPage.waitForFunction(() => gameState.investments.length === 1)
        assert.equal(await investmentPage.evaluate(() => gameState.userCountExact), '8000000000000000006')
        assert.match(await investmentPage.locator('#investmentList').textContent(), /12Qi -> 14.4Qi/)
        await investorContext.request.post(`${url}/__test__/mature-investments`)
        await investmentPage.locator('[data-action="collect-investments"]').click()
        await investmentPage.waitForFunction(() => gameState.investments.length === 0)
        assert.equal(await investmentPage.evaluate(() => gameState.userCountExact), '22400000000000000007')
        await investmentPage.locator('[data-action="invest-all"]').click()
        assert.equal(await investmentPage.locator('#investmentAmount').inputValue(), '22400000000000000007')
        await investmentPage.locator('#investmentAmount').fill('1,5qi')
        await investmentPage.locator('#investmentPlan').selectOption('growth')
        await investmentPage.locator('#investmentForm [type="submit"]').click()
        await investmentPage.waitForFunction(() => gameState.investments.length === 1)
        assert.equal(await investmentPage.evaluate(() => gameState.investments[0].success_chance), 60)
        assert.equal(await investmentPage.evaluate(() => gameState.investments[0].amount), '1500000000000000000')
        assert.ok(notices.some(message => message.includes('Успешных вкладов: 1')))
        await investmentPage.setViewportSize({ width: 390, height: 844 })
        assert.equal(await investmentPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        if (process.env.UI_SCREENSHOT_DIR) await investmentPage.locator('#investmentForm').screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'investments-mobile.png') })
        assert.deepEqual(errors, [])
        await investorContext.close()
        console.log('PASS: investment suffix input, exact Qi balances and payouts, all five plans, preserved form, all-balance button, decimal comma, and mobile layout.')
        console.log('PASS: 3-2-1 countdown, balance scoring, visible ranking, steady robot buttons, passive income animation, stable DOM/focus, replay, refresh, all modes and mobile layout.')
    } finally {
        if (browser) await browser.close()
        if (child.exitCode === null) {
            child.kill()
            await new Promise(resolve => child.once('exit', resolve))
        }
        // Only remove the exact freshly-created test directory under OS temp.
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(temporary).startsWith('clicker-timed-ui-'))
        fs.rmSync(temporary, { recursive: true, force: true })
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
