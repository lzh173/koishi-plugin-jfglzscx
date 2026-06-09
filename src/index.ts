import { Context, Schema } from 'koishi'
import axios from 'axios'
import * as cheerio from 'cheerio'
import * as iconv from 'iconv-lite'

export const name = 'jfglzscx'

export interface Config {
  timeout: number
  userAgent: string
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
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('jfglzscx')

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