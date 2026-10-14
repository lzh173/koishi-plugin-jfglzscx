import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import * as iconv from 'iconv-lite'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, readFile as readTextFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export const name = 'jfglzscx'
export const inject = ['puppeteer']

export interface Config {
  timeout: number
  userAgent: string
  maxDownloadSize: number
}

export const Config: Schema<Config> = Schema.object({
  timeout: Schema.number()
    .description('请求超时时间（毫秒）')
    .default(10000)
    .min(1000)
    .max(60000),
  userAgent: Schema.string()
    .description('自定义 User-Agent')
    .default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'),
  maxDownloadSize: Schema.number()
    .description('单次下载上限（MB）')
    .default(512)
    .min(1)
    .max(4096),
})

interface BrowserPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  type(selector: string, text: string): Promise<void>
  click(selector: string): Promise<void>
  waitForFunction(pageFunction: string | (() => unknown), options?: Record<string, unknown>): Promise<unknown>
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>
  $eval<T>(selector: string, pageFunction: (element: any) => T): Promise<T>
  $$eval<T>(selector: string, pageFunction: (elements: any[]) => T): Promise<T>
  target(): { createCDPSession(): Promise<{ send(method: string, params: Record<string, unknown>): Promise<unknown> }> }
  frames(): Array<{ url(): string; click(selector: string): Promise<void> }>
  url(): string
  close(): Promise<void>
}

interface BrowserService {
  page(): Promise<BrowserPage>
}

interface LanzouFile {
  id: string
  name: string
  size: string
}

function dateTag() {
  const now = new Date()
  const year = String(now.getFullYear()).slice(-2)
  return `${year}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

function splitFileName(name: string) {
  const match = name.match(/^(.*?)(\.[^.]+)?$/)
  return { base: match?.[1] || name, ext: match?.[2] || '' }
}

function safeFileName(name: string, version?: string, hash?: string) {
  const { base, ext } = splitFileName(name)
  const cleanBase = base.replace(/[\\/:*?"<>|]/g, '_').trim() || '下载文件'
  const suffix = version ? `机房管理助手-${version}` : cleanBase
  return `${suffix}-${dateTag()}-${hash?.slice(-6) || 'unknown'}${ext}`
}

async function resolveLanzouDownload(
  browser: BrowserService,
  shareUrl: string,
  password: string,
  filePattern: RegExp,
  logger: { info(message: string): void },
): Promise<{ file: LanzouFile; page: BrowserPage }> {
  const startedAt = Date.now()
  logger.info(`[解析] 创建浏览器页面，分享地址: ${shareUrl}`)
  const page = await browser.page()
  try {
    logger.info('[解析] 正在打开蓝奏云分享页')
    await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    logger.info(`[解析] 分享页加载完成，当前地址: ${page.url()}`)
    await page.type('#pwd', password)
    await page.click('#sub')
    logger.info('[解析] 已提交分享密码，等待文件列表')
    await page.waitForFunction(
      () => Boolean(document.querySelector('#infos a')),
      { timeout: 30000 },
    )

    const files = await page.$$eval('#infos a', (links) => links.map((link) => ({
      id: link.getAttribute('href') || '',
      name: (link.textContent || '').trim(),
      size: link.parentElement?.parentElement?.querySelector('#size')?.textContent?.trim() || '',
    })))
    logger.info(`[解析] 文件列表获取成功，共 ${files.length} 个文件: ${files.map((item) => item.name).join(', ')}`)
    const file = files.find((item) => filePattern.test(item.name))
    if (!file?.id) throw new Error('网盘中没有匹配的安装包')
    logger.info(`[解析] 已匹配安装包: ${file.name}，标识: ${file.id}，页面显示大小: ${file.size || '未知'}`)

    const detailUrl = new URL(file.id, page.url()).href
    logger.info(`[解析] 正在打开文件详情页: ${detailUrl}`)
    await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    await page.waitForSelector('iframe.ifr2', { timeout: 30000 })
    logger.info(`[解析] 详情页加载完成，当前地址: ${page.url()}，等待下载 iframe`)
    await page.waitForFunction(
      () => Boolean(
        (document.querySelector('iframe.ifr2') as HTMLIFrameElement | null)
          ?.contentDocument?.querySelector('a.txt[href*="/file/"]'),
      ),
      { timeout: 30000, polling: 250 },
    )
    logger.info(`[解析] 已找到下载入口，总耗时 ${Date.now() - startedAt} ms`)

    return { file, page }
  } catch (error) {
    logger.info(`[解析] 失败，耗时 ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : String(error)}`)
    await page.close()
    throw error
  }
}

async function downloadAndHash(
  page: BrowserPage,
  maxBytes: number,
  logger: { info(message: string): void },
) {
  const dir = join(tmpdir(), 'koishi-jfglzscx')
  const startedAt = Date.now()
  logger.info(`[下载] 准备临时目录: ${dir}，大小上限: ${Math.round(maxBytes / 1024 / 1024)} MB`)
  await mkdir(dir, { recursive: true })
  const client = await page.target().createCDPSession()
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir })
  const frame = page.frames().find((item) => item.url().includes('/fn?'))
  if (!frame) throw new Error('未找到蓝奏云下载窗口')
  logger.info(`[下载] 已找到下载 iframe: ${frame.url()}`)
  await frame.click('a.txt[href*="/file/"]')
  logger.info('[下载] 已点击真实下载链接，等待浏览器写入文件')
  let filePath = ''
  let lastReportedBytes = -1
  try {
    for (let i = 0; i < 180; i++) {
      const files = await readdir(dir)
      const candidate = files.find((name) => !name.endsWith('.crdownload'))
      if (candidate) {
        filePath = join(dir, candidate)
        logger.info(`[下载] 文件下载完成: ${candidate}，等待读取和校验`)
        break
      }
      const partial = files.find((name) => name.endsWith('.crdownload'))
      if (partial) {
        const partialBytes = (await stat(join(dir, partial))).size
        if (partialBytes - lastReportedBytes >= 5 * 1024 * 1024) {
          logger.info(`[下载] 进行中: ${partial}，已接收 ${(partialBytes / 1024 / 1024).toFixed(2)} MB`)
          lastReportedBytes = partialBytes
        }
        if (partialBytes > maxBytes) {
          throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!filePath) throw new Error('下载超时')
    const data = await readFile(filePath)
    logger.info(`[下载] 已读取文件 ${(data.length / 1024 / 1024).toFixed(2)} MB，耗时 ${Date.now() - startedAt} ms`)
    if (data.length > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`)
    const result = {
      data,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      md5: createHash('md5').update(data).digest('hex'),
    }
    logger.info(`[校验] SHA-256: ${result.sha256}`)
    logger.info(`[校验] MD5: ${result.md5}`)
    await rm(dir, { recursive: true, force: true })
    logger.info(`[下载] 临时文件已清理，总耗时 ${Date.now() - startedAt} ms`)
    return result
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    logger.info(`[下载] 失败后已清理临时目录: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('jfglzscx')

  const downloadLatest = async ({ session }: { session?: { send(message: any): Promise<unknown> } }) => {
    const browser = (ctx as Context & { puppeteer?: BrowserService }).puppeteer
    if (!browser) return '下载功能需要启用 koishi-plugin-puppeteer'
    if (!session) return '此命令只能在会话中使用'

    const shareUrl = 'https://wwbun.lanzoum.com/b01884al5e'
    logger.info(`[命令] 收到下载安装包请求，命令来源: ${session ? '会话' : '未知'}，最大下载大小: ${config.maxDownloadSize} MB`)
    await session.send('正在解析网盘并下载最新安装包，请稍候...')
    let downloadPage: BrowserPage | undefined
    try {
      const resolved = await resolveLanzouDownload(
        browser,
        shareUrl,
        '123',
        /学生机房管理助手.*\.(zip|rar|7z)$/i,
        logger,
      )
      downloadPage = resolved.page
      logger.info(`[命令] 开始下载匹配文件: ${resolved.file.name}`)
      const result = await downloadAndHash(resolved.page, config.maxDownloadSize * 1024 * 1024, logger)
      const hashFile = join(process.cwd(), 'data', 'jfglzscx-last-hash.json')
      let lastHash = ''
      try {
        const saved = JSON.parse(await readTextFile(hashFile, 'utf8')) as { sha256?: string }
        lastHash = saved.sha256 || ''
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.info(`[比对] 读取上次哈希失败，将按新文件处理: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const changed = result.sha256 !== lastHash
      logger.info(`[命令] 下载并校验成功: ${resolved.file.name}，${result.bytes} 字节，${changed ? '哈希有变化' : '哈希未变化'}`)
      const summary = [
        `文件：${resolved.file.name}`,
        `大小：${(result.bytes / 1024 / 1024).toFixed(2)} MB`,
        `SHA-256：${result.sha256}`,
        `MD5：${result.md5}`,
        `解压密码：123`,
      ].join('\n')
      if (!changed) return `${summary}\n\n文件内容与上次已发送版本一致，本次不重复发送。`

      logger.info('[发送] 检测到新哈希，发送安装包文件')
      await session.send(summary)
      const version = resolved.file.name.match(/(V[\d.]+)/i)?.[1] || undefined
      const outputName = safeFileName(resolved.file.name, version, result.sha256)
      const mime = resolved.file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/octet-stream'
      logger.info(`[发送] 文件名: ${outputName}`)
      await session.send(h('file', {
        src: `data:${mime};base64,${result.data.toString('base64')}`,
        filename: outputName,
      }))
      await mkdir(join(process.cwd(), 'data'), { recursive: true })
      let savedHashes: Record<string, string> = {}
      try {
        const saved = JSON.parse(await readTextFile(hashFile, 'utf8')) as Record<string, unknown>
        savedHashes = Object.entries(saved).reduce<Record<string, string>>((result, [key, value]) => {
          if (typeof value === 'string') result[key] = value
          return result
        }, {})
      } catch {}
      await writeFile(hashFile, JSON.stringify({ ...savedHashes, sha256: result.sha256, file: resolved.file.name }, null, 2), 'utf8')
      logger.info(`[发送] 文件发送成功，已保存本次哈希: ${hashFile}`)
      return
    } catch (error) {
      logger.error('下载或哈希计算失败:', error)
      return `下载失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      await downloadPage?.close()
    }
  }

  ctx.command('jfglzscx.download', '下载最新安装包并计算哈希')
    .action(downloadLatest)

  const downloadShared = async ({ session }: { session?: { send(message: any): Promise<unknown> } }, url: string, password = '123') => {
    if (!url) return '用法：蓝奏云下载 <蓝奏云链接> [密码]'
    const browser = (ctx as Context & { puppeteer?: BrowserService }).puppeteer
    if (!browser) return '下载功能需要启用 koishi-plugin-puppeteer'
    if (!session) return '此命令只能在会话中使用'
    await session.send('正在解析指定蓝奏云链接并下载文件，请稍候...')
    let downloadPage: BrowserPage | undefined
    try {
      const resolved = await resolveLanzouDownload(browser, url, password, /.+/, logger)
      downloadPage = resolved.page
      const result = await downloadAndHash(resolved.page, config.maxDownloadSize * 1024 * 1024, logger)
      const { base, ext } = splitFileName(resolved.file.name)
      const outputName = safeFileName(resolved.file.name, undefined, result.sha256)
      const hashFile = join(process.cwd(), 'data', 'jfglzscx-last-hash.json')
      let lastHash = ''
      try {
        const saved = JSON.parse(await readTextFile(hashFile, 'utf8')) as Record<string, string>
        lastHash = saved[url] || ''
      } catch {}
      if (lastHash === result.sha256) return `文件：${base}${ext}\nSHA-256：${result.sha256}\n文件内容未变化，本次不重复发送。`
      await session.send(`文件：${resolved.file.name}\n大小：${(result.bytes / 1024 / 1024).toFixed(2)} MB\nSHA-256：${result.sha256}\nMD5：${result.md5}`)
      await session.send(h('file', { src: `data:application/octet-stream;base64,${result.data.toString('base64')}`, filename: outputName }))
      await mkdir(join(process.cwd(), 'data'), { recursive: true })
      let savedHashes: Record<string, string> = {}
      try {
        const saved = JSON.parse(await readTextFile(hashFile, 'utf8')) as Record<string, unknown>
        savedHashes = Object.entries(saved).reduce<Record<string, string>>((result, [key, value]) => {
          if (typeof value === 'string') result[key] = value
          return result
        }, {})
      } catch {}
      await writeFile(hashFile, JSON.stringify({ ...savedHashes, [url]: result.sha256 }, null, 2), 'utf8')
      logger.info(`[发送] 指定文件发送成功: ${outputName}`)
    } catch (error) {
      logger.error('指定蓝奏云下载失败:', error)
      return `下载失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      await downloadPage?.close()
    }
  }

  ctx.command('蓝奏云下载 <url:text> [password:text]', '解析指定蓝奏云链接并下载文件')
    .action(downloadShared)

  ctx.command('jfglzscx', '获取机房管理助手最新版本信息')
    .action(async ({ session }) => {
      const url = 'https://www.jfglzs.com/c1.html'
      
      await session.send('🔍 正在查询机房管理助手最新信息...')
      
      try {
        const response = await axios.get(url, {
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
          responseType: 'arraybuffer',
        })

        let html = ''
        const buffer = Buffer.from(response.data)
        
        const encodings = ['gbk', 'gb2312', 'utf-8', 'gb18030']
        for (const encoding of encodings) {
          try {
            const decoded = iconv.decode(buffer, encoding)
            if (decoded.includes('机房') || decoded.includes('管理')) {
              html = decoded
              logger.info(`使用编码 ${encoding} 成功解码`)
              break
            }
          } catch (e) {
            continue
          }
        }
        
        if (!html) {
          html = iconv.decode(buffer, 'utf-8')
        }
        
        const $ = cheerio.load(html)
        
        // 提取版本号
        let version = '未知版本'
        const titleText = $('h2').first().text()
        const versionMatch = titleText.match(/学生机房管理助手(V[\d\.]+)/)
        if (versionMatch) {
          version = versionMatch[1]
        }
        
        // 提取更新日志
        let updateLog = ''
        let shuomingElem = $('p.shuoming')
        if (shuomingElem.length) {
          updateLog = shuomingElem.text().trim()
        } else {
          const bodyText = $('body').text()
          const updateIndex = bodyText.indexOf('更新：')
          if (updateIndex !== -1) {
            let endIndex = bodyText.indexOf('云盘下载', updateIndex)
            if (endIndex === -1) endIndex = updateIndex + 300
            updateLog = bodyText.substring(updateIndex, endIndex).trim()
          }
        }
        
        if (updateLog) {
          updateLog = updateLog.replace(/\s+/g, ' ').trim()
          updateLog = updateLog.replace(/(\d+、)/g, '\n$1')
        }
        
        // 提取下载链接
        let downloadUrl = ''
        let downloadPwd = '123'
        const linkElem = $('a[href*="lanzoum.com"], a[href*="lanzou"]')
        if (linkElem.length) {
          downloadUrl = linkElem.attr('href') || ''
          const parentText = linkElem.parent().text()
          const pwdMatch = parentText.match(/下载密码[：:]?\s*(\d+)/)
          if (pwdMatch) downloadPwd = pwdMatch[1]
        }
        
        // 构建纯文本回复（无 Markdown 标记）
        let reply = '📋 机房管理助手信息\n\n'
        reply += `🔖 版本：${version}\n\n`
        
        if (updateLog && updateLog.length > 10) {
          reply += `📝 更新日志：\n${updateLog}\n\n`
        } else {
          reply += '📝 更新日志：\n'
          reply += '1、解决信息科技考试软件、人机对话考试运行错误的问题\n'
          reply += '2、监测IP地址修改\n'
          reply += '3、解决误判U盘、拔网线检测不到、文件总是缺失等问题\n'
          reply += '4、允许或禁止浏览器下载软件，禁止登录网盘网站\n'
          reply += '5、大幅减少锁屏，加强密码保护\n\n'
        }
        
        if (downloadUrl) {
          reply += `📥 云盘下载：${downloadUrl}\n`
          reply += `🔐 下载密码：${downloadPwd}\n`
          reply += `⚠️ 注：所有文件解压密码均为 ${downloadPwd}，软件可能误报毒\n\n`
        }
        
        reply += `💡 详细说明请访问：${url}`
        
        if (reply.length > 4500) {
          reply = reply.substring(0, 4500) + '\n\n... (内容过长已截断)'
        }
        
        await session.send(reply)
        logger.info(`成功获取版本信息: ${version}`)
        
      } catch (error) {
        logger.error('请求失败:', error)
        
        // 失败时的备用回复（也无 Markdown）
        let fallbackReply = '📋 机房管理助手信息\n\n'
        fallbackReply += '🔖 版本：V13.1\n\n'
        fallbackReply += '📝 更新日志：\n'
        fallbackReply += '1、解决信息科技考试软件、人机对话考试运行错误的问题\n'
        fallbackReply += '2、监测IP地址修改\n'
        fallbackReply += '3、解决误判U盘、拔网线检测不到、文件总是缺失等问题\n'
        fallbackReply += '4、允许或禁止浏览器下载软件，禁止登录网盘网站\n'
        fallbackReply += '5、大幅减少锁屏，加强密码保护\n\n'
        fallbackReply += '📥 云盘下载：https://wwbun.lanzoum.com/b01884al5e\n'
        fallbackReply += '🔐 下载密码：123\n'
        fallbackReply += '⚠️ 注：所有文件解压密码均为 123，软件可能误报毒\n\n'
        fallbackReply += `💡 详细说明请访问：${url}`
        
        await session.send(fallbackReply)
      }
    })
}
