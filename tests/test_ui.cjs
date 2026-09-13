// Run with Node and Playwright installed (or PLAYWRIGHT_MODULE pointing to it).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const fs = require('node:fs')
const path = require('node:path')

;(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge' })
    try {
        const page = await browser.newPage()
        const root = path.resolve(__dirname, '..')
        await page.setContent(fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/, ''))
        await page.evaluate(() => {
            window.fetch = () => new Promise(() => {})
            window.setInterval = (callback) => { window.incomeTick = callback; return 1 }
        })
        await page.addScriptTag({ path: path.join(root, 'script.js') })
        const result = await page.evaluate(async () => {
            const check = (condition, message) => { if (!condition) throw new Error(message) }
            const item = {name: 'Test', description: 'Description', baseCost: 10, maxLevel: 5, cost: 10, bonus: 0.1}
            const player = {rank: 1, nickname: '<Test>', score: 100, isCurrentUser: true}
            const state = {
                userNik: 'Tester', userCount: 100, clickForce: 1, baseClickForce: 1,
                forceUpgradeCost: 10, activeTheme: 'classic', robotsIncome: 1,
                maintenanceCost: 0, robotMaxLevel: 2, prestigePoints: 0, prestigeMultiplier: 1,
                robots: {r: {level: 1}}, research: {}, boosts: {b: 20}, cosmetics: {},
                collections: {}, achievements: {}, investments: [],
                catalog: {robots: {r: {name: 'Robot', className: 'Test', requiresPrestige: 0, powers: [1, 2], buyCost: 10, upgradeCosts: [20]}},
                    research: {r: item}, boosts: {b: item}, cosmetics: {c: item},
                    collections: {c: item}, achievements: {a: item}, prestigeMinBalance: 105, investmentDuration: 60},
                leaderboard: {sortBy: 'total_earned', label: 'Score', top: [player], around: [player], currentRank: 1, totalPlayers: 1}
            }
            openGame(structuredClone(state))
            window.fetch = async () => ({ok: true, json: async () => structuredClone(state)})
            const selectors = '#robotsList *, #prestigePanel *, #leaderboardTop *, #leaderboardAround *, #endgameContent *'
            for (const tab of ['research', 'boosts', 'cosmetics', 'collections', 'achievements', 'investments']) {
                document.querySelector(`[data-endgame-tab="${tab}"]`).click()
                const nodes = [...document.querySelectorAll(selectors)]
                const button = document.querySelector('#endgameContent button:not(:disabled)') || document.querySelector(`[data-endgame-tab="${tab}"]`)
                button.focus()
                for (let i = 0; i < 3; i++) {
                    state.userCount++
                    state.boosts.b--
                    state.leaderboard.top[0].score++
                    await window.incomeTick()
                    check(nodes.every((node, index) => document.querySelectorAll(selectors)[index] === node), `${tab}: DOM recreated`)
                    check(document.activeElement === button, `${tab}: focus lost`)
                }
                if (tab === 'boosts') check(endgameContent.textContent.includes(`${state.boosts.b} сек.`), 'Boost timer stale')
            }
            check(!document.querySelector('[data-action="prestige"]').disabled, 'Prestige eligibility stale')
            check(document.querySelector('.leaderboard-score').textContent === String(state.leaderboard.top[0].score), 'Leaderboard stale')
            const input = document.querySelector('[name="amount"]')
            input.value = '12345'
            input.focus()
            document.querySelector('[name="risky"]').checked = true
            state.investments = [{amount: 10, payout_amount: 12, ready_at: 0, risky: false}]
            await window.incomeTick()
            check(input.value === '12345' && document.activeElement === input && document.querySelector('[name="risky"]').checked, 'Investment form reset')
            check(document.querySelector('#investmentList').textContent.includes('10 -> 12'), 'Investment not added')
            state.investments = []
            state.robots.r.level = 2
            await window.incomeTick()
            check(document.querySelector('#investmentList').textContent.includes('Активных инвестиций нет'), 'Investment not removed')
            check(document.querySelector('[data-robot-id="r"]').disabled, 'Robot upgrade stale')
            return 'PASS: all six tabs preserve DOM and focus across income ticks; timers, rating, prestige, robots and investments update.'
        })
        console.log(result)
    } finally {
        await browser.close()
    }
})().catch(error => { console.error(error); process.exitCode = 1 })
