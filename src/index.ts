import { Context, Schema } from 'koishi'

export const name = 'qq-group-manager'

export interface Config {
  //入群最低等级
  minLevel:number
  //入群关键字验证
  keywords:string[]
  //过滤功能开关
  levelFilterEnable:boolean
  keywordFilterEnable:boolean
  blacklistFilterEnable:boolean
  NotifyQuitCountEnable:boolean
  defaultGroupIdEnable:boolean
  //权限管理
  allowedUserIds:string[]
  //默认群号
  defaultGroupId:string
  defaultNotifyGroupId:string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    minLevel: Schema.number()
      .default(5)
      .min(0).step(1)
      .description('入群最低等级,低于设置等级的用户入群申请将被自动拒绝'),
    keywords: Schema.array(Schema.string())
      .default([])
      .description('入群申请关键字验证，如果设置了关键字，入群申请必须包含其中一个关键字就自动同意'),
  }).description('入群验证设置'),
  Schema.object({
    levelFilterEnable: Schema.boolean()
      .default(true)
    .description('是否启用入群等级过滤'),
  keywordFilterEnable: Schema.boolean()
    .default(true)
    .description('是否启用入群关键字过滤'),
  blacklistFilterEnable: Schema.boolean()
    .default(true)
    .description('是否启用黑名单过滤'),
  NotifyQuitCountEnable: Schema.boolean()
    .default(true)
    .description('是否启用退群记录通知功能，如果启用，如果申请入群的用户有两次及以上的退群记录，将会通知指定QQ群'),
  }).description('功能开关'),
  Schema.object({
    defaultGroupIdEnable: Schema.boolean()
      .default(true)
      .description('是否启用默认群号功能'),
    allowedUserIds: Schema.array(Schema.string())
      .default([])
      .description('允许使用插件命令的用户ID列表'),
    defaultGroupId: Schema.string()
      .description('默认增删查的目标群号'),
    defaultNotifyGroupId: Schema.string()
      .description('2次以上退群的人尝试加群时，通知的目标群号'),
  }).description('默认设置')
])

export const inject={
  required:['database'],
  optional:[],
}



declare module 'koishi' {
  interface Tables {
    member_quit_count: {
      id: number
      groupId: string
      userId: string
      quitTime: Date
      type:'leave'|'kick'|'unknown'
    }

    black_list:{
      id: number
      groupId: string
      userId: string
      reason?:string
      banTime:Date
      remark?:string
    }
  }
}

function isUserAllowed(userId: string, config: Config): boolean {
  return config.allowedUserIds.includes(userId)
}

export function apply(ctx: Context, config: Config) {

  ctx.model.extend('member_quit_count',{id:"integer",groupId:"string",userId:"string",quitTime:"timestamp",type:"string"},{autoInc:true})

  ctx.model.extend('black_list',{id:"integer",groupId:"string",userId:"string",reason:"string",banTime:"timestamp",remark:"string"},{autoInc:true})

  ctx.on('guild-member-request', async (session)=> {
      if(config.blacklistFilterEnable){
        const records = await ctx.database.get('black_list', {
          groupId: session.guildId,
          userId: session.userId,
        })

        if (records.length > 0) {
          // 命中黑名单，拒绝入群
          await session.bot.handleGuildMemberRequest(session.messageId!, false, '黑名单用户')
          return
        }
      }

      if(config.levelFilterEnable){
        let level:number=0;
          try {
            const res = await session.onebot._request('get_stranger_info', {
              user_id: session.userId,
              no_cache: false,
            })
            level = Number(res?.data?.level) || 0
          }catch (error) {
            ctx.logger.error('获取用户等级失败:', error)
          }

        if(level==0){
          ctx.logger(`用户 ${session.userId} 等级为0,可能是未公开等级或者获取失败。`)
        }
        if(level<=config.minLevel && level>0){
          await session.bot.handleGuildMemberRequest(session.messageId!, false);
          return
        }
      }

      if(config.keywordFilterEnable && config.keywords.length>0){
        const userKeywords = (session.event._data.comment ?? '').match(/答案[：:]\s*(.+)/)
        const raw=(userKeywords?userKeywords[1]:session.event._data.comment).trim().replace(/\s+/g, '').toLowerCase()

        if(config.keywords.some(keyword => raw==keyword.replace(/\s+/g, '').toLowerCase())){
          await session.bot.handleGuildMemberRequest(session.messageId!, true,);
          return
        }
      }

      const records = await ctx.database.get('member_quit_count', {
        groupId: session.guildId,
        userId: session.userId,
      })

      //如果用户有两次及以上的退群记录，发送消息到指定QQ群
      if (config.NotifyQuitCountEnable && records.length >= 2) {
        await session.bot.sendMessage(config.defaultNotifyGroupId, `申请入群的用户${session.userId}有退群记录${records.length}次`)
        return
      }
    })

  ctx.on('guild-member-removed', async (session) => {
      const rawType = session.event._data.sub_type;

      const type=(rawType==='leave' || rawType==='kick')?rawType:'unknown';

      await ctx.database.create('member_quit_count', {
        groupId: session.guildId!,
        userId: session.userId,
        quitTime: new Date(),
        type
      })
    })

  ctx.command('增加黑名单 [userId:string] [reason:string]')
    .option('groupid','-g <groupId:string> 指定群号,默认当前群')
    .option('remark','-r <remark:string> 备注这个人是谁，光看qq号看不出来')
    .action(async ({ session, options }, userId, reason) => {
      if (!isUserAllowed(session!.userId!, config)) return
      //阻止私聊中使用增加黑名单命令
      if(!session!.guildId){
        return
      }

      if (!userId) {
        await session!.send('请提供要设置为黑名单的用户ID。')
        return
      }

      const record=await ctx.database.get('black_list', { groupId: config.defaultGroupId??options!.groupid??session!.guildId!, userId })
      if(record.length>0){
        await session!.send(`用户 ${userId}(${record[0].remark}) 已经被添加过了。`)
        return
      }

      await ctx.database.create('black_list', {
        groupId: config.defaultGroupId??options!.groupid??session!.guildId!,
        userId: userId,
        reason: reason,
        banTime: new Date(),
        remark: options!.remark
      })

      const record2=await ctx.database.get('black_list', { groupId: config.defaultGroupId??options!.groupid??session!.guildId!, userId })
      if(record2.length==0){
        await session!.send(`用户 ${userId}(${options!.remark}) 添加黑名单失败，请检查数据库连接或权限。`)
        return
      }
      else {
        await session!.send(`用户 ${userId}(${options!.remark}) 已被添加到本群黑名单。`)
      }
  })

  ctx.command('查询黑名单')
    .option('groupid','-g <groupId:string> 指定群号,默认当前群')
    .action(async ({ session, options }) => {
      if (!isUserAllowed(session!.userId!, config)) return
      //阻止在私聊中使用查询黑名单命令
      if(!session!.guildId){
        return
      }

      const groupid = config.defaultGroupId??options!.groupid??session!.guildId!

      const blackList = await ctx.database.get('black_list', { groupId: groupid })
      if (blackList.length === 0) {
        await session!.send('本群没有黑名单用户。')
        return
      }

      const lines = blackList.map((entry, i) => {
      const time = entry.banTime instanceof Date
        ? entry.banTime.toLocaleString('zh-CN')
        : new Date(entry.banTime).toLocaleString('zh-CN')
      const reason = entry.reason?.trim() ? entry.reason : '未填写'
      return `${i + 1}. ${entry.userId} （${entry.remark}）· ${time} · ${reason} `
    })

    await session!.send(`本群黑名单（共 ${blackList.length} 条）：\n${lines.join('\n')}`)
    })

  ctx.command('删除黑名单 [userId:string]')
    .option('groupid','-g <groupId:string> 指定群号,默认当前群')
    .action(async ({ session, options }, userId) => {
      if (!isUserAllowed(session!.userId!, config)) return
      //阻止在私聊中使用删除黑名单命令
      if(!session!.guildId){
        return
      }

      if (!userId) {
        await session!.send('请提供要从黑名单中删除的用户ID。')
        return
      }
      const groupid = config.defaultGroupId??options!.groupid??session!.guildId!
      try{
        const result = await ctx.database.remove('black_list', { groupId: groupid, userId })
        if(result.removed==0){
          await session!.send(`用户 ${userId} 不在本群黑名单中。`)
        }
        else{
          await session!.send(`用户 ${userId} 已从本群黑名单中删除。`)
        }
      }catch(error){
        ctx.logger.error(`删除黑名单用户 ${userId} 时发生错误:`, error)
        await session!.send(`删除黑名单用户 ${userId} 时发生错误，请检查数据库连接或权限。`)
      }
    })

  ctx.command('查询退群记录 [userId:string]')
    .option('groupid','-g <groupId:string> 指定群号,默认当前群')
    .action(async ({ session, options }, userId) => {
      if (!isUserAllowed(session!.userId!, config)) return
      //阻止在私聊中使用查询退群记录命令
      if(!session!.guildId){
        await session!.send('本命令只能在群聊中使用。')
        return
      }

      if (!userId) {
        await session!.send('请提供要查询退群记录的用户qq账号。')
        return
      }

      const typeLabel={
        'leave':'主动退出',
        'kick':'被踢出',
        'unknown':'未知'
      }

      const groupid = config.defaultGroupId??options!.groupid??session!.guildId!
      const records = await ctx.database.get('member_quit_count', { groupId: groupid, userId })

      if(records.length===0){
        await session!.send(`用户 ${userId} 在本群没有退出记录。`)
        return
      }

      const lines = records.map((r, i) => {
        const time = r.quitTime instanceof Date
          ? r.quitTime.toLocaleString('zh-CN')
          : new Date(r.quitTime).toLocaleString('zh-CN')
        return `${i + 1}. ${time} · ${typeLabel[r.type] ?? r.type}`
      })
  
      await session!.send(`用户 ${userId} 在本群退出了 ${records.length} 次:\n${lines.join('\n')}`)
    })
}
