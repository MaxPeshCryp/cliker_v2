// End-to-end appearance checks with an isolated database and real API.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')

;(async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clicker-appearance-'))
    const listener = net.createServer()
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const url = `http://127.0.0.1:${port}`
    const serverCode = `
import app
@app.app.post('/__test__/fund')
def fund():
    with app.db_connection() as db:
        db.execute('UPDATE users SET balance = 4350010 WHERE id = ?', (app.session['user_id'],))
    return {'ok': True}
@app.app.post('/__test__/level-near-reward')
def level_near_reward():
    from progression import REWARDS
    with app.db_connection() as db:
        db.execute('UPDATE users SET total_earned = ? WHERE id = ?', (int(REWARDS[0]['requiredEarnedExact']) - 1, app.session['user_id']))
    return {'ok': True}
app.app.run(port=${port}, debug=False)
`
    const child = spawn(process.env.PYTHON_EXE || 'python', ['-c', serverCode], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true,
        env: {...process.env, CLICKER_DATABASE_PATH: path.join(temporary, 'test.db'), CLICKER_SECRET_KEY: 'test-only', CLICKER_COOKIE_SECURE: 'false'},
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let logs = '', browser
    child.stdout.on('data', data => { logs += data })
    child.stderr.on('data', data => { logs += data })
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(logs)), 15000)
            child.on('error', error => { clearTimeout(timer); reject(error) })
            child.stderr.on('data', () => { if (logs.includes('Running on')) { clearTimeout(timer); resolve() } })
        })
        browser = await chromium.launch({headless:true, channel:'msedge'})
        const page = await browser.newPage({viewport:{width:1440, height:1100}})
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.request.post(`${url}/api/register`, {data:{nickname:'Создатель', email:'style@example.com', password:'password'}})
        await page.request.post(`${url}/api/login`, {data:{email:'style@example.com', password:'password'}})
        await page.goto(url)
        await page.locator('#gameLayout').waitFor({state:'visible'})
        assert.equal(await page.locator('#accountLevel').textContent(), '1')
        await page.locator('#levelRewards summary').click()
        assert.equal(await page.locator('.level-reward').count(), 7)
        assert.equal(await page.locator('.level-reward.is-earned').count(), 0)
        await page.request.post(`${url}/__test__/level-near-reward`)
        await page.evaluate(async () => applyGameState(await apiRequest('/api/state')))
        assert.equal(await page.locator('#accountLevel').textContent(), '9')
        await page.locator('#clickMe').click()
        await page.waitForFunction(() => gameState.progression.level === 10)
        assert((await page.locator('#levelUpNotice').innerText()).includes('Искра'))
        assert.equal(await page.locator('.level-reward.is-earned').count(), 1)
        assert((await page.locator('#leaderboardTop .level-badge').innerText()).includes('Искра'))
        // Polling keeps the reward collection open and does not recreate its cards.
        await page.evaluate(async () => {
            const card = document.querySelector('.level-reward')
            await actionQueue
            applyGameState(await apiRequest('/api/state'))
            if (card !== document.querySelector('.level-reward') || !document.querySelector('#levelRewards').open) throw new Error('Polling reset reward collection')
        })
        await page.reload()
        await page.waitForFunction(() => gameState?.progression.level === 10)
        assert(await page.locator('#levelUpNotice').isHidden(), 'Reload should not replay old rewards')
        const viewer = await browser.newContext()
        await viewer.request.post(`${url}/api/register`, {data:{nickname:'Наблюдатель', email:'viewer@example.com', password:'password'}})
        await viewer.request.post(`${url}/api/login`, {data:{email:'viewer@example.com', password:'password'}})
        const ranking = await (await viewer.request.get(`${url}/api/leaderboard`)).json()
        assert.equal(ranking.top[0].progression.badge.id, 'spark', 'Other players must see earned badge')
        await viewer.close()
        await page.locator('#openAppearance').click()
        assert.equal(await page.locator('.theme-choice').count(), 9)
        assert(await page.locator('[data-theme="ocean_theme"]').isDisabled(), 'Cannot buy without funds')
        assert((await page.locator('[data-theme="ocean_theme"]').innerText()).includes('100K'))
        await page.request.post(`${url}/__test__/fund`)
        await page.evaluate(async () => applyGameState(await apiRequest('/api/state')))
        for (const theme of ['ocean', 'sakura', 'forest', 'sunset', 'cosmos']) {
            await page.locator(`[data-theme="${theme}_theme"]`).click()
            await page.waitForFunction(theme => document.body.classList.contains(`theme-${theme}_theme`) && !appearanceBusy, theme)
            assert.equal(await page.locator('[data-theme][aria-pressed="true"]').count(), 1)
        }
        assert.equal((await (await page.request.get(`${url}/api/state`)).json()).userCount, 10)
        await page.locator('[data-theme="ocean_theme"]').click()
        await page.waitForFunction(() => !appearanceBusy)
        assert.equal((await (await page.request.get(`${url}/api/state`)).json()).userCount, 10, 'Owned themes are free to switch')
        await page.locator('[data-theme="cosmos_theme"]').click()
        await page.waitForFunction(() => !appearanceBusy)
        await page.keyboard.press('Escape')
        await page.locator('#editAvatar').click()
        await page.locator('[data-avatar-part="character"][data-value="cat"]').click()
        await page.locator('[data-avatar-part="accessory"][data-value="crown"]').click()
        const draft = await page.locator('#avatarPreview').innerHTML()
        await page.evaluate(async () => applyGameState(await apiRequest('/api/state')))
        assert.equal(await page.locator('#avatarPreview').innerHTML(), draft, 'Polling must preserve draft')
        await page.locator('#saveAvatar').click()
        await page.waitForFunction(() => !appearanceBusy && document.querySelector('#appearanceStatus').textContent.includes('сохранена'))
        let state = await (await page.request.get(`${url}/api/state`)).json()
        assert.equal(state.avatar.character, 'cat')
        assert.equal(state.leaderboard.top[0].avatar.accessory, 'crown')
        await page.locator('[data-avatar-part="character"][data-value="alien"]').click()
        await page.locator('#resetAvatar').click()
        assert.equal(await page.locator('[data-avatar-part="character"][data-value="cat"]').getAttribute('aria-pressed'), 'true')
        await page.locator('[data-avatar-part="character"][data-value="bear"]').click()
        await page.keyboard.press('Escape')
        await page.locator('#editAvatar').click()
        assert.equal(await page.locator('[data-avatar-part="character"][data-value="cat"]').getAttribute('aria-pressed'), 'true', 'Closing discards unsaved draft')
        assert.equal(await page.locator('[data-avatar-part="accessory"][data-value="crown"]').getAttribute('aria-pressed'), 'true')
        await page.reload()
        await page.waitForFunction(() => document.body.classList.contains('theme-cosmos_theme'))
        assert(await page.evaluate(draft => {
            const template = document.createElement('template')
            template.innerHTML = draft
            return document.querySelector('#editAvatar svg').isEqualNode(template.content.firstChild)
        }, draft), 'Saved avatar restores')
        await page.locator('#editAvatar').click()
        const png = await page.evaluate(() => {
            const canvas = document.createElement('canvas')
            canvas.width = 400; canvas.height = 200
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = '#43bba0'; ctx.fillRect(0, 0, 400, 200)
            ctx.fillStyle = '#ffd578'; ctx.beginPath(); ctx.arc(200, 100, 70, 0, Math.PI * 2); ctx.fill()
            return canvas.toDataURL('image/png').split(',')[1]
        })
        await page.locator('#avatarFile').setInputFiles({name:'avatar.png', mimeType:'image/png', buffer:Buffer.from(png, 'base64')})
        await page.waitForFunction(() => avatarUpload && !avatarLoading)
        assert(await page.locator('#avatarPreview img').isVisible())
        assert(!(await (await page.request.get(`${url}/api/state`)).json()).avatar.imageUrl, 'Preview does not save')
        await page.locator('#resetAvatar').click()
        assert(await page.locator('#avatarPreview svg').isVisible())
        await page.locator('#avatarFile').setInputFiles({name:'avatar.png', mimeType:'image/png', buffer:Buffer.from(png, 'base64')})
        await page.waitForFunction(() => avatarUpload && !avatarLoading)
        await page.locator('#saveAvatar').click()
        await page.waitForFunction(() => !appearanceBusy && gameState.avatar.imageUrl)
        const imageUrl = (await (await page.request.get(`${url}/api/state`)).json()).avatar.imageUrl
        assert.equal((await page.request.get(url + imageUrl)).status(), 200)
        await page.reload()
        await page.locator('#editAvatar img').waitFor()
        await page.waitForFunction(() => document.querySelector('#editAvatar img').naturalWidth === 256)
        assert.equal(await page.locator('#leaderboardTop img').getAttribute('src'), imageUrl)
        await page.locator('#editAvatar').click()
        await page.locator('#avatarFile').setInputFiles({name:'bad.png', mimeType:'image/png', buffer:Buffer.from('invalid')})
        await page.waitForFunction(() => !avatarLoading && document.querySelector('#appearanceStatus').textContent.includes('Не удалось'))
        assert.equal((await (await page.request.get(`${url}/api/state`)).json()).avatar.imageUrl, imageUrl)
        await page.locator('#buildAvatar').click()
        assert(await page.locator('#avatarChoices').isVisible())
        await page.locator('#resetAvatar').click()
        assert(await page.locator('#avatarPreview img').isVisible())
        await page.keyboard.press('Escape')
        await page.locator('#clickMe').click()
        await page.waitForFunction(() => gameState.userCount > 0)
        if (process.env.UI_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, {recursive:true})
            await page.waitForFunction(() => !document.querySelector('.ruble-fly'))
            await page.locator('#levelRewards').evaluate(el => { el.open = true })
            await page.locator('#playerProgression').screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'progression-desktop.png'), animations:'disabled'})
            await page.evaluate(() => window.scrollTo(0, 0))
            await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'game-desktop.png'), animations:'disabled'})
        }
        await page.locator('#editAvatar').click()
        if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'avatar-desktop.png')})
        await page.locator('[data-appearance-tab="themes"]').click()
        if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'themes-desktop.png'), animations:'disabled'})
        await page.keyboard.press('Escape')
        for (const width of [360, 390, 768]) {
            await page.setViewportSize({width, height:844})
            await page.locator('#levelRewards').evaluate(el => { el.open = true })
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Game overflows at ${width}px`)
            await page.locator('#editAvatar').click()
            assert(await page.locator('#appearanceDialog').evaluate(el => el.scrollWidth <= el.clientWidth), `Editor overflows at ${width}px`)
            await page.keyboard.press('Escape')
        }
        await page.setViewportSize({width:390, height:844})
        if (process.env.UI_SCREENSHOT_DIR) await page.locator('#playerProgression').screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'progression-mobile.png'), animations:'disabled'})
        if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR, 'game-mobile.png'), fullPage:true})
        // Logout must revoke the session and preserve saved progress on re-login.
        const beforeLogout = (await (await page.request.get(`${url}/api/state`)).json()).userCount
        page.on('dialog', dialog => dialog.accept())
        await page.route('**/api/logout', route => route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:'Тест недоступности'})}))
        await page.locator('#logoutButton').click()
        await page.waitForFunction(() => !document.querySelector('#logoutButton').disabled)
        assert(await page.locator('#gameLayout').isVisible(), 'Failed logout should keep the game open')
        assert.equal((await page.request.get(`${url}/api/state`)).status(), 200)
        await page.unroute('**/api/logout')
        await page.locator('#logoutButton').click()
        await page.locator('#form-login').waitFor({state:'visible'})
        assert.equal((await page.request.get(`${url}/api/state`)).status(), 401)
        assert(await page.locator('#gameLayout').isHidden())
        await page.locator('#email-login').fill('style@example.com')
        await page.locator('#password-login').fill('password')
        await page.locator('#form-login button[type="submit"]').click()
        await page.locator('#gameLayout').waitFor({state:'visible'})
        assert.equal((await (await page.request.get(`${url}/api/state`)).json()).userCount, beforeLogout)
        assert.deepEqual(errors, [])
        console.log('PASS: paid themes, purchase once, uploads, invalid images, preview/cancel, persistence, avatars, leaderboards and responsive layouts.')
    } finally {
        if (browser) await browser.close()
        child.kill()
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
