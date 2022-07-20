import fetch from 'node-fetch'
import { Command } from 'commander'
import ppt from 'puppeteer'
import progress from 'cli-progress'
import fs from 'node:fs/promises'
import { URLSearchParams } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64; rv:102.0) Gecko/20100101 Firefox/102.0'
const RES_DIR =
    process.env.CGD_DATA ||
    (process.env.HOME || process.env.USERPROFILE) + '/cgd'
const P_TYXYM = path.resolve(RES_DIR, 'tyxxm-cache.json')

const getTyxxmCache = async () => {
    try {
        return JSON.parse(await fs.readFile(P_TYXYM, 'utf-8'))
    } catch (err) {
        if (err?.code !== 'ENOENT' && !err?.message?.startsWith('JSON.parse')) {
            console.error('读取缓存文件错误：%s', err)
            process.exit(1)
        }
        return {}
    }
}

try {
    const stat = await fs.stat(RES_DIR)
    if (!stat.isDirectory()) {
        console.error('数据目录不是目录：%s', RES_DIR)
        process.exit(1)
    }
} catch (err) {
    if (err?.code === 'ENOENT') {
        console.error(
            '数据目录不存在：%s，配置环境变量 CGD_DATA 来指定数据目录',
            RES_DIR
        )
    } else console.error('打开数据目录出错：%s，错误：%s', RES_DIR, err)
    process.exit(1)
}

const program = new Command()

program.name('cgd').version('0.1.0')

program
    .command('tyxym [names]')
    .option('-f, --file <file>', '查询一个文本文件中全部公司')
    .option('-s, --sep <sep>', '公司名称分隔符', '\n')
    .option('-n, --strict-name', '要求公司名称和查询到最佳结果严格一致', false)
    .option('-R, --no-read-cache', '不读取文件缓存', true)
    .option('-W, --no-write-cache', '不写入文件缓存', true)
    .description('查询公司的统一信用码')
    .action(async (names, options) => {
        if (options.file) {
            try {
                names = await fs.readFile(options.file, 'utf-8')
            } catch {
                console.error('打开文件时发生错误')
            }
        }

        let cache,
            cacheNum = 0,
            errorNum = 0
        if (options.readCache || options.writeCache)
            cache = await getTyxxmCache()

        const nameList = names.trim().split(options.sep)
        console.log('开始查询，共有 %d 个公司需要查询', nameList.length)

        const bar = new progress.SingleBar({}, progress.Presets.shades_classic)
        bar.start(nameList.length, 0)

        const requests = nameList
            .map(async (name) => {
                if (options.readCache && cache[name]) {
                    cacheNum++
                    return cache[name]
                }

                const res = await fetch(
                    'https://public.creditchina.gov.cn/private-api/catalogSearch?' +
                        new URLSearchParams({
                            keyword: name,
                            scenes: 'defaultscenario',
                            tableName: 'credit_xyzx_tyshxydm',
                            searchState: 2,
                            entityType: '1,2,4,5,6,7,8',
                            page: 1,
                            pageSize: 1
                        }),
                    {
                        headers: {
                            'User-Agent': USER_AGENT
                        },
                        referrer: 'https://www.creditchina.gov.cn/',
                        method: 'GET'
                    }
                )

                const { status, data } = await res.json()
                if (status !== 1)
                    return Error(`查询失败，状态码异常：${status}`)

                if (!data.list[0]) return Error(`没查到`)
                const { jgmc, tyshxydm } = data.list[0]
                if (options.strictName && jgmc !== name)
                    return Error(`公司名不完全一致，查询到公司名为：${jgmc}`)

                return tyshxydm
            })
            .map((req) =>
                req.then((res) => {
                    bar.increment()
                    return res
                })
            )

        const results = await Promise.all(requests)
        bar.stop()

        for (const [i, res] of results.entries()) {
            const name = nameList[i]
            if (res instanceof Error) {
                console.log(`错误：${res.message}，公司：${name}`)
                errorNum++
            } else {
                console.log(res)
                if (options.writeCache) {
                    cache[name] = res
                    try {
                        await fs.writeFile(P_TYXYM, JSON.stringify(cache))
                    } catch (err) {
                        console.err('写入缓存文件错误：%s', err)
                        process.exit(1)
                    }
                }
            }
        }

        console.log('查询结束，错误 %d 个，命中缓存 %d 个', errorNum, cacheNum)
    })

program
    .command('cninfo [names]')
    .description('查询公司在 cninfo 上的信息，上市公司还查询十大股东')
    .option('-f, --file <file>', '查询一个文本文件中全部公司')
    .option('-s, --sep <sep>', '公司名称分隔符', '\n')
    .option('-n, --result-num', '返回的结果数量', 3)
    .option('-a, --a-share-only', '只要 A 股结果', true)
    .action(async (names, options) => {
        if (options.file) {
            try {
                names = await fs.readFile(options.file, 'utf-8')
            } catch {
                console.error('打开文件时发生错误')
            }
        }

        const nameList = names.trim().split(options.sep)
        console.log('开始查询，共有 %d 个公司需要查询', nameList.length)

        const bar = new progress.SingleBar({}, progress.Presets.shades_classic)
        bar.start(nameList.length, 0)

        const requests = nameList
            .map(async (name) => {
                let results
                try {
                    results = await (
                        await fetch(
                            'http://www.cninfo.com.cn/new/information/topSearch/query?' +
                                new URLSearchParams({
                                    keyWord: name,
                                    maxNum: +options.resultNum
                                }),
                            {
                                headers: {
                                    'User-Agent': USER_AGENT
                                },
                                referrer: 'http://www.cninfo.com.cn/',
                                method: 'POST'
                            }
                        )
                    ).json()
                } catch (err) {
                    return Error(`请求错误：${err}`)
                }

                if (options.aShareOnly)
                    results = results.filter((it) => it.category === 'A股')

                if (!results[0]) return undefined
                const { code } = results[0]

                let shareholders
                try {
                    shareholders = (
                        await (
                            await fetch(
                                'http://www.cninfo.com.cn/data20/stockholderCapital/getTopTenStockholders?' +
                                    new URLSearchParams({
                                        scode: code
                                    }),
                                {
                                    headers: {
                                        'User-Agent': USER_AGENT
                                    },
                                    referrer: `http://www.cninfo.com.cn/new/disclosure/stock?stockCode=${code}`,
                                    method: 'GET'
                                }
                            )
                        ).json()
                    ).data.records
                } catch (err) {
                    return Error(`请求错误：${err}`)
                }

                const ten = []
                const time = shareholders[0].F001D
                for (const it of shareholders) {
                    if (it.F001D !== time) break
                    ten.push(it.F002V)
                }

                return { code, ten }
            })
            .map((req) =>
                req.then((res) => {
                    bar.increment()
                    return res
                })
            )

        const results = await Promise.all(requests)
        bar.stop()

        for (const [i, res] of Object.entries(results)) {
            const name = nameList[i]
            console.log('%s：', name)
            if (!res) console.log('不是上市公司')
            else if (res instanceof Error) {
                console.log(`错误：${res.message}，公司：${name}`)
            } else {
                console.log('股票代码：%d', res.code)
                console.log(`十大股东：${os.EOL}%s`, res.ten.join(os.EOL))
            }
            console.log()
        }
    })

program
    .command('gsxt [names]')
    .description('查企业信息公示网')
    .action(async (names) => {
        const browser = await ppt.launch({ headless: false })
        const page = await browser.newPage()
        await page.goto()
    })

program.parse(process.argv)
