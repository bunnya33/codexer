import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { X } from 'lucide-react-native';
import type { WeixinLogin, WeixinStatus } from '../../../packages/protocol/src/weixin';
import { relay } from './relay';
import { c, s } from './styles';
import { confirmAction } from './runtime';

const errorLabels: Record<string,string> = {
  'weixin-disabled':'服务器未开启微信接入。',
  'weixin-network-error':'暂时无法连接微信，请稍后重试。',
  'weixin-http-error':'微信服务暂不可用，请稍后重试。',
  'weixin-api-error':'微信暂未接受发送请求，请先给机器人发一条消息，再稍后重试。',
  'weixin-unavailable':'微信连接暂不可用，请稍后重试。',
  'weixin-bot-already-bound':'这个微信 Bot 已绑定其他账号，请使用自己的微信绑定。',
  'weixin-not-activated':'请先在微信里给 ClawBot 发一条“你好”，再发送测试通知。',
  'weixin-not-bound':'请先扫码绑定微信 Bot。',
  'weixin-session-expired':'微信授权已过期，请重新扫码绑定。',
  'weixin-login-expired':'二维码已过期，请重新扫码。',
  'weixin-login-not-found':'绑定流程已结束，请重新获取二维码。',
  'weixin-already-connected':'这个 Bot 已有连接，请在微信中解除旧连接后重新扫码。',
  'weixin-queue-full':'待发送通知较多，请检查微信连接。',
  'weixin-notification-expired':'部分通知超过一天仍未发送，请检查微信连接。',
};
function errorText(error:unknown) {const message=error instanceof Error?error.message:String(error);return errorLabels[message]??'操作未完成，请检查连接后重试。';}

export function WeixinSettings({onClose}:{onClose:()=>void}) {
  const [status,setStatus]=useState<WeixinStatus|null>(null);
  const [login,setLogin]=useState<WeixinLogin|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [verifyCode,setVerifyCode]=useState('');
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let active=true;
    const refresh=()=>{void relay.weixinStatus().then(value=>{if(active)setStatus(value);}).catch(value=>{if(active)setError(errorText(value));});};
    refresh();const timer=setInterval(refresh,5000);return()=>{active=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{
    if(!login||['confirmed','expired','need_verifycode','verify_code_blocked'].includes(login.status))return;
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const value=await relay.weixinPoll(login.loginId);
        if(!active)return;
        setLogin(value);setError('');
        if(value.status==='confirmed') {setStatus(await relay.weixinStatus());setNotice('绑定成功。请在微信里给 ClawBot 发一条“你好”来激活消息。');return;}
        if(!['expired','need_verifycode','verify_code_blocked'].includes(value.status))timer=setTimeout(()=>void poll(),1500);
      }catch(value){if(active){setError(errorText(value));timer=setTimeout(()=>void poll(),5000);}}
    };
    void poll();return()=>{active=false;clearTimeout(timer);};
  },[login?.loginId,login?.status]);
  const run=async(action:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{await action();}catch(value){if(mounted.current)setError(errorText(value));}finally{if(mounted.current)setBusy(false);}
  };
  const bind=()=>void run(async()=>{const value=await relay.weixinLogin();if(mounted.current){setLogin(value);setVerifyCode('');}});
  const verify=()=>void run(async()=>{const value=await relay.weixinPoll(login!.loginId,verifyCode.trim());if(mounted.current){setLogin(value);if(value.status==='confirmed'){setStatus(await relay.weixinStatus());setNotice('绑定成功，请在微信里发送“你好”激活。');}}});
  const update=(notifications:boolean,replies:boolean)=>void run(async()=>{const value=await relay.weixinSettings(notifications,replies);if(mounted.current)setStatus(value);});
  const unbind=()=>void confirmAction('解除微信绑定','解除后，这个账号将停止接收微信通知和微信指令。').then(confirmed=>{if(confirmed)void run(async()=>{await relay.weixinUnbind();if(mounted.current){setLogin(null);setStatus(await relay.weixinStatus());setNotice('已解除绑定。');}});});
  const test=()=>void run(async()=>{await relay.weixinTest();if(mounted.current){setNotice('测试通知已加入发送队列，请到微信检查是否收到。');setStatus(await relay.weixinStatus());}});
  const label=!status?.bound?'未绑定':!status.activated?'已绑定 · 等待微信消息激活':status.connected?'已连接':'正在恢复连接';
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={s.backdrop} onPress={onClose}>
      <Pressable style={[s.sheet,{maxHeight:'90%',maxWidth:520,width:'100%',alignSelf:'center'}]} onPress={event=>event.stopPropagation()}>
        <View style={s.modalHeader}><Text style={s.modalTitle}>微信 ClawBot</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭微信设置" style={s.iconButton} onPress={onClose}><X size={20} color={c.text}/></Pressable></View>
        <ScrollView contentContainerStyle={{gap:16,paddingBottom:20}}>
          <Text style={s.sub}>一个账号绑定一个 Bot，汇总本账号所有电脑的通知。你可以在微信里与它一对一聊天并继续指定会话。</Text>
          {!status?<ActivityIndicator color={c.accent}/>:!status.available?<Text style={s.sub}>当前服务器未开启微信接入。</Text>:<>
            <Text style={s.menuText}>{label}</Text>
            {!!status.lastError&&<Text style={s.error}>{errorLabels[status.lastError]??'微信连接暂不可用，请稍后重试。'}</Text>}
            {status.bound&&<>
              <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}><Text style={s.menuText}>任务完成通知</Text><Switch accessibilityLabel="任务完成通知" value={status.notifications} disabled={busy} onValueChange={value=>update(value,status.replies)}/></View>
              <Text style={s.sub}>开启时通知全部会话；关闭时只通知在会话顶部开启“微信通知”的会话。设置随账号同步。</Text>
              <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}><Text style={s.menuText}>微信回复续做</Text><Switch accessibilityLabel="微信回复续做" value={status.replies} disabled={busy} onValueChange={value=>update(status.notifications,value)}/></View>
              {!!status.pendingNotifications&&<Text style={s.sub}>{status.pendingNotifications} 条消息待发送</Text>}
              <Pressable accessibilityRole="button" style={[s.primary,(busy||!status.activated)&&s.disabled]} disabled={busy||!status.activated} onPress={test}><Text style={s.primaryText}>发送测试通知</Text></Pressable>
            </>}
            {login&&login.status!=='confirmed'&&<View style={{gap:10,alignItems:'center'}}>
              {!!login.qrImage&&<Image accessibilityLabel="微信绑定二维码" source={{uri:login.qrImage}} style={{width:224,height:224}}/>}
              <Text style={s.sub}>{login.status==='expired'?'二维码已过期，请重新获取。':login.status==='verify_code_blocked'?'验证码尝试过多，请重新获取二维码。':login.status==='need_verifycode'?'请输入微信手机上显示的验证码。':login.status==='scaned'?'已扫码，请在微信里确认授权。':'用微信扫一扫，确认连接到你的账号。'}</Text>
              {login.status==='need_verifycode'&&<View style={{alignSelf:'stretch',gap:8}}><TextInput accessibilityLabel="微信验证码" style={s.field} value={verifyCode} onChangeText={setVerifyCode} autoCapitalize="none" autoCorrect={false} maxLength={16}/><Pressable accessibilityRole="button" style={[s.primary,(busy||!verifyCode.trim())&&s.disabled]} disabled={busy||!verifyCode.trim()} onPress={verify}><Text style={s.primaryText}>确认验证码</Text></Pressable></View>}
            </View>}
            <Pressable accessibilityRole="button" style={[s.menuOption,busy&&s.disabled]} disabled={busy} onPress={bind}><Text style={s.menuText}>{status.bound?'重新扫码绑定':login?'重新获取二维码':'扫码绑定微信'}</Text>{busy&&<ActivityIndicator size="small" color={c.accent}/>}</Pressable>
            {status.bound&&<Pressable accessibilityRole="button" style={[s.menuOption,busy&&s.disabled]} disabled={busy} onPress={unbind}><Text style={s.dangerText}>解除绑定</Text></Pressable>}
            <Text style={s.sub}>绑定后先给机器人发送“你好”。直接回复下一步要求，继续最近收到通知的会话；发送“会话”获取编号，可用“继续 编号 下一步要求”切换。PC 需要在线；审批和提问仍在 Codexer 中处理。</Text>
            <Text style={s.sub}>微信可能限制主动通知的次数和有效时间。收不到通知时，先给机器人发一条消息刷新会话。</Text>
          </>}
          {!!notice&&<Text style={s.sub}>{notice}</Text>}{!!error&&<Text style={s.error}>{error}</Text>}
        </ScrollView>
      </Pressable>
    </Pressable>
  </Modal>;
}
