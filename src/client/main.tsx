import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import { Room, RoomEvent, Track, type RemoteTrack, type LocalTrack } from 'livekit-client';
import { Hash, MonitorUp, Plus, LogOut, Send, Users, Copy, Radio, Wifi, WifiOff, ShieldCheck, Eye, EyeOff, KeyRound } from 'lucide-react';
import './styles.css';

type User = { id:string; email:string; username:string; display_name:string; created_at:string; last_seen:string };
type Channel = { id:string; community_id:string; name:string; type:'text'|'screen'; position:number };
type Community = { id:string; name:string; owner_id:string; invite_code:string; role:'owner'|'admin'|'member'; channels:Channel[] };
type Message = { id:string; channel_id:string; author_id:string; username:string; display_name:string; content:string; created_at:string; edited_at?:string|null };
type Member = { id:string; username:string; display_name:string; last_seen:string; role:string; online?:boolean };

async function api<T>(path:string, options:RequestInit = {}):Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(()=>({}));
    throw new Error(body.error || 'Não foi possível concluir a operação.');
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function initials(name:string){ return name.split(/\s+/).slice(0,2).map(p=>p[0]).join('').toUpperCase(); }
function time(value:string){ return new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(value)); }
function dateLabel(value:string){ const d=new Date(value); const today=new Date(); return d.toDateString()===today.toDateString()?'Hoje':new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'long'}).format(d); }

function Auth({onAuthenticated}:{onAuthenticated:(user:User)=>void}){
  const [mode,setMode]=useState<'login'|'register'|'recover'>('login');
  const [form,setForm]=useState({email:'',password:'',username:'',displayName:'',recoveryCode:'',newPassword:''});
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [showPassword,setShowPassword]=useState(false);
  const [newRecovery,setNewRecovery]=useState('');
  async function submit(e:React.FormEvent){
    e.preventDefault(); setError(''); setLoading(true);
    try{
      if(mode==='login'){
        const r=await api<{user:User}>('/api/auth/login',{method:'POST',body:JSON.stringify({email:form.email,password:form.password})}); onAuthenticated(r.user);
      }else if(mode==='register'){
        const r=await api<{user:User;recoveryCode:string}>('/api/auth/register',{method:'POST',body:JSON.stringify(form)}); setNewRecovery(r.recoveryCode); onAuthenticated(r.user);
      }else{
        const r=await api<{recoveryCode:string}>('/api/auth/recover',{method:'POST',body:JSON.stringify({email:form.email,recoveryCode:form.recoveryCode,newPassword:form.newPassword})});
        setNewRecovery(r.recoveryCode); setMode('login'); setForm({...form,password:'',newPassword:'',recoveryCode:''});
      }
    }catch(err:any){setError(err.message);}finally{setLoading(false);}
  }
  return <div className="auth-shell">
    <div className="auth-orb orb-a"/><div className="auth-orb orb-b"/>
    <section className="auth-hero">
      <div className="brand large"><span className="brand-mark"><MonitorUp size={25}/></span><span>TelaHub</span></div>
      <h1>Converse.<br/><span>Mostre. Resolva.</span></h1>
      <p>Um espaço direto para equipes que precisam conversar por texto e compartilhar a tela sem distrações.</p>
      <div className="trust-row"><span><ShieldCheck size={17}/> Acesso protegido</span><span><Radio size={17}/> Tempo real</span></div>
    </section>
    <section className="auth-card">
      <div className="mobile-brand brand"><span className="brand-mark"><MonitorUp size={20}/></span><span>TelaHub</span></div>
      <p className="eyebrow">BEM-VINDO</p>
      <h2>{mode==='login'?'Entre no seu espaço':mode==='register'?'Crie sua conta':'Recupere o acesso'}</h2>
      <p className="muted">{mode==='login'?'Continue de onde sua equipe parou.':mode==='register'?'Seu primeiro espaço será criado automaticamente.':'Use o código entregue no seu cadastro.'}</p>
      <form onSubmit={submit}>
        {mode==='register'&&<><label>Nome de exibição<input required maxLength={40} value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})} placeholder="Como devemos chamar você?"/></label><label>Nome de usuário<input required minLength={3} maxLength={24} value={form.username} onChange={e=>setForm({...form,username:e.target.value})} placeholder="usuario"/></label></>}
        <label>E-mail<input required type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="voce@empresa.com"/></label>
        {mode==='recover'&&<label>Código de recuperação<input required value={form.recoveryCode} onChange={e=>setForm({...form,recoveryCode:e.target.value.toUpperCase()})} placeholder="CÓDIGO SALVO"/></label>}
        <label>{mode==='recover'?'Nova senha':'Senha'}<span className="password-wrap"><input required minLength={10} type={showPassword?'text':'password'} value={mode==='recover'?form.newPassword:form.password} onChange={e=>mode==='recover'?setForm({...form,newPassword:e.target.value}):setForm({...form,password:e.target.value})} placeholder="Mínimo de 10 caracteres"/><button type="button" className="eye" onClick={()=>setShowPassword(!showPassword)}>{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</button></span></label>
        {error&&<div className="error-box">{error}</div>}
        <button className="primary wide" disabled={loading}>{loading?'Aguarde…':mode==='login'?'Entrar':mode==='register'?'Criar conta':'Redefinir senha'}</button>
      </form>
      <div className="auth-links">
        {mode!=='login'&&<button onClick={()=>setMode('login')}>Já tenho conta</button>}
        {mode!=='register'&&<button onClick={()=>setMode('register')}>Criar uma conta</button>}
        {mode!=='recover'&&<button onClick={()=>setMode('recover')}>Esqueci minha senha</button>}
      </div>
    </section>
    {newRecovery&&<div className="modal-backdrop"><div className="recovery-modal"><span className="modal-icon"><KeyRound/></span><h3>Guarde seu novo código</h3><p>Este código é a única forma de recuperar sua conta sem e-mail. Armazene-o em um local seguro.</p><code>{newRecovery}</code><button className="primary wide" onClick={()=>setNewRecovery('')}>Já salvei o código</button></div></div>}
  </div>
}

function ScreenTile({track,label}:{track:RemoteTrack|LocalTrack;label:string}){
  const ref=useRef<HTMLVideoElement>(null);
  useEffect(()=>{const el=ref.current;if(el)track.attach(el);return()=>{if(el)track.detach(el);};},[track]);
  return <div className="screen-tile"><video ref={ref} autoPlay playsInline/><span>{label}</span></div>;
}

function ScreenRoom({channel,user,socket}:{channel:Channel;user:User;socket:Socket}){
  const [room,setRoom]=useState<Room|null>(null); const [version,setVersion]=useState(0); const [status,setStatus]=useState('Conectando…'); const [sharing,setSharing]=useState(false); const [error,setError]=useState('');
  useEffect(()=>{
    let active=true; const r=new Room({adaptiveStream:true,dynacast:true});
    const refresh=()=>active&&setVersion(v=>v+1);
    r.on(RoomEvent.TrackSubscribed,refresh).on(RoomEvent.TrackUnsubscribed,refresh).on(RoomEvent.ParticipantConnected,refresh).on(RoomEvent.ParticipantDisconnected,refresh).on(RoomEvent.LocalTrackPublished,refresh).on(RoomEvent.LocalTrackUnpublished,()=>{refresh();setSharing(false);socket.emit('screen:status',{channelId:channel.id,active:false});});
    api<{token:string;url:string}>('/api/livekit/token?channelId='+encodeURIComponent(channel.id)).then(async data=>{await r.connect(data.url,data.token);if(active){setRoom(r);setStatus('Conectado');refresh();}}).catch((e)=>active&&(setError(e.message),setStatus('Falha na conexão')));
    return()=>{active=false;r.disconnect();};
  },[channel.id,socket]);
  async function toggleShare(){if(!room)return;setError('');try{await room.localParticipant.setScreenShareEnabled(!sharing);setSharing(!sharing);socket.emit('screen:status',{channelId:channel.id,active:!sharing});setVersion(v=>v+1);}catch(e:any){setError(e.message||'O navegador bloqueou o compartilhamento.');}}
  const tracks=useMemo(()=>{if(!room)return[] as {track:RemoteTrack|LocalTrack;label:string;id:string}[];const all=[room.localParticipant,...Array.from(room.remoteParticipants.values())];return all.flatMap(p=>{const pub=p.getTrackPublication(Track.Source.ScreenShare);return pub?.track?[{track:pub.track,label:p.identity===user.id?'Sua tela':p.name||p.identity,id:p.identity}]:[];});},[room,version,user.id]);
  return <div className="screen-room">
    <div className="screen-toolbar"><div><span className={'status-dot '+(room?'online':'')}/><strong>{status}</strong><small>{tracks.length?`${tracks.length} tela${tracks.length>1?'s':''} ativa${tracks.length>1?'s':''}`:'Nenhuma tela sendo compartilhada'}</small></div><button className={sharing?'danger':'primary'} disabled={!room} onClick={toggleShare}><MonitorUp size={18}/>{sharing?'Parar transmissão':'Compartilhar minha tela'}</button></div>
    {error&&<div className="error-box room-error">{error}</div>}
    <div className={'screen-grid '+(tracks.length===1?'single':'')}>{tracks.length?tracks.map(item=><ScreenTile key={item.id} {...item}/>):<div className="screen-empty"><span><MonitorUp size={42}/></span><h3>A sala está pronta</h3><p>Inicie o compartilhamento para apresentar uma janela, aba ou tela inteira.</p></div>}</div>
  </div>
}

function Chat({channel,user,socket}:{channel:Channel;user:User;socket:Socket}){
  const [messages,setMessages]=useState<Message[]>([]); const [content,setContent]=useState(''); const [typing,setTyping]=useState<string[]>([]); const endRef=useRef<HTMLDivElement>(null); const typingTimer=useRef<number|undefined>(undefined);
  useEffect(()=>{setMessages([]);api<{messages:Message[]}>('/api/channels/'+channel.id+'/messages').then(r=>setMessages(r.messages));socket.emit('channel:join',channel.id);const onMessage=(m:Message)=>{if(m.channel_id===channel.id)setMessages(prev=>prev.some(x=>x.id===m.id)?prev:[...prev,m]);};const onTyping=(d:any)=>{if(d.userId===user.id)return;setTyping(prev=>d.active?Array.from(new Set([...prev,d.displayName])):prev.filter(n=>n!==d.displayName));};socket.on('message:new',onMessage);socket.on('typing',onTyping);return()=>{socket.off('message:new',onMessage);socket.off('typing',onTyping);};},[channel.id,socket,user.id]);
  useEffect(()=>endRef.current?.scrollIntoView({behavior:'smooth'}),[messages.length]);
  function update(value:string){setContent(value);socket.emit('typing',{channelId:channel.id,active:true});window.clearTimeout(typingTimer.current);typingTimer.current=window.setTimeout(()=>socket.emit('typing',{channelId:channel.id,active:false}),1200);}
  function send(e:React.FormEvent){e.preventDefault();const text=content.trim();if(!text)return;socket.emit('message:send',{channelId:channel.id,content:text},(r:any)=>{if(!r?.ok)return;setContent('');socket.emit('typing',{channelId:channel.id,active:false});});}
  let previousDay='';
  return <div className="chat-area"><div className="messages">{messages.length===0&&<div className="channel-intro"><span><Hash size={30}/></span><h2>Bem-vindo a #{channel.name}</h2><p>Este é o começo deste canal. Envie a primeira mensagem.</p></div>}{messages.map(m=>{const day=dateLabel(m.created_at);const showDay=day!==previousDay;previousDay=day;return <React.Fragment key={m.id}>{showDay&&<div className="day-divider"><span>{day}</span></div>}<article className="message"><div className="avatar small">{initials(m.display_name)}</div><div><header><strong>{m.display_name}</strong><time>{time(m.created_at)}</time></header><p>{m.content}</p></div></article></React.Fragment>;})}<div ref={endRef}/></div><div className="typing-line">{typing.length?`${typing.join(', ')} está digitando…`:'\u00a0'}</div><form className="composer" onSubmit={send}><textarea rows={1} maxLength={4000} value={content} onChange={e=>update(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(e);}}} placeholder={`Mensagem em #${channel.name}`}/><button className="send" disabled={!content.trim()}><Send size={18}/></button></form></div>;
}

function App(){
  const [user,setUser]=useState<User|null>(null); const [loading,setLoading]=useState(true); const [communities,setCommunities]=useState<Community[]>([]); const [activeCommunityId,setActiveCommunityId]=useState(''); const [activeChannelId,setActiveChannelId]=useState(''); const [members,setMembers]=useState<Member[]>([]); const [mobilePanel,setMobilePanel]=useState(false);
  const socket=useMemo(()=>user?io({withCredentials:true,autoConnect:true}):null,[user]);
  async function loadCommunities(preferredCommunity?:string){const r=await api<{communities:Community[]}>('/api/communities');setCommunities(r.communities);const community=r.communities.find(c=>c.id===(preferredCommunity||activeCommunityId))||r.communities[0];if(community){setActiveCommunityId(community.id);const channel=community.channels.find(c=>c.id===activeChannelId)||community.channels[0];if(channel)setActiveChannelId(channel.id);}}
  useEffect(()=>{api<{user:User}>('/api/auth/me').then(r=>setUser(r.user)).catch(()=>setUser(null)).finally(()=>setLoading(false));},[]);
  useEffect(()=>{if(user)loadCommunities();},[user]);
  useEffect(()=>{if(!activeCommunityId)return;api<{members:Member[]}>('/api/communities/'+activeCommunityId+'/members').then(r=>setMembers(r.members));},[activeCommunityId]);
  useEffect(()=>{if(!socket)return;const presence=(d:any)=>setMembers(prev=>prev.map(m=>m.id===d.userId?{...m,online:d.online}:m));socket.on('presence:update',presence);return()=>{socket.off('presence:update',presence);socket.disconnect();};},[socket]);
  const community=communities.find(c=>c.id===activeCommunityId); const channel=community?.channels.find(c=>c.id===activeChannelId);
  async function createCommunity(){const name=prompt('Nome da nova comunidade:')?.trim();if(!name)return;const r=await api<{id:string}>('/api/communities',{method:'POST',body:JSON.stringify({name})});await loadCommunities(r.id);}
  async function joinCommunity(){const code=prompt('Código de convite:')?.trim();if(!code)return;try{const r=await api<{id:string}>('/api/communities/join',{method:'POST',body:JSON.stringify({inviteCode:code})});await loadCommunities(r.id);}catch(e:any){alert(e.message);}}
  async function createChannel(){if(!community)return;const name=prompt('Nome do canal:')?.trim();if(!name)return;const type=confirm('OK para canal de compartilhamento de tela.\nCancelar para canal de texto.')?'screen':'text';try{await api(`/api/communities/${community.id}/channels`,{method:'POST',body:JSON.stringify({name,type})});await loadCommunities(community.id);}catch(e:any){alert(e.message);}}
  async function logout(){await api('/api/auth/logout',{method:'POST'});setUser(null);setCommunities([]);}
  if(loading)return <div className="splash"><span className="brand-mark"><MonitorUp/></span><p>Preparando seu espaço…</p></div>;
  if(!user)return <Auth onAuthenticated={setUser}/>;
  return <div className="app-shell">
    <aside className="server-rail"><div className="rail-logo"><MonitorUp size={22}/></div><div className="rail-line"/>{communities.map(c=><button key={c.id} onClick={()=>{setActiveCommunityId(c.id);setActiveChannelId(c.channels[0]?.id||'');}} className={'server-bubble '+(c.id===activeCommunityId?'active':'')} title={c.name}>{initials(c.name)}</button>)}<button className="server-bubble add" onClick={createCommunity} title="Criar comunidade"><Plus size={20}/></button><button className="server-bubble join" onClick={joinCommunity} title="Entrar por convite">+</button></aside>
    <aside className={'channel-panel '+(mobilePanel?'open':'')}><header><div><span>COMUNIDADE</span><strong>{community?.name||'TelaHub'}</strong></div>{community&&<button title="Copiar convite" onClick={()=>navigator.clipboard.writeText(community.invite_code)}><Copy size={16}/></button>}</header><div className="channel-list"><div className="channel-section"><span>CANAIS DE TEXTO</span>{community&&['owner','admin'].includes(community.role)&&<button onClick={createChannel}><Plus size={15}/></button>}</div>{community?.channels.filter(c=>c.type==='text').map(c=><button key={c.id} className={c.id===activeChannelId?'active':''} onClick={()=>{setActiveChannelId(c.id);setMobilePanel(false);}}><Hash size={18}/><span>{c.name}</span></button>)}<div className="channel-section top-gap"><span>SALAS DE TELA</span></div>{community?.channels.filter(c=>c.type==='screen').map(c=><button key={c.id} className={c.id===activeChannelId?'active':''} onClick={()=>{setActiveChannelId(c.id);setMobilePanel(false);}}><MonitorUp size={18}/><span>{c.name}</span></button>)}</div><footer><div className="avatar">{initials(user.display_name)}</div><div><strong>{user.display_name}</strong><span>@{user.username}</span></div><button onClick={logout} title="Sair"><LogOut size={18}/></button></footer></aside>
    <main><header className="topbar"><button className="mobile-menu" onClick={()=>setMobilePanel(!mobilePanel)}>☰</button>{channel?.type==='text'?<Hash size={20}/>:<MonitorUp size={20}/>}<strong>{channel?.name||'selecione-um-canal'}</strong><span>{channel?.type==='text'?'Conversa em tempo real':'Sala de compartilhamento de tela'}</span><div className="connection"><Wifi size={16}/> Online</div></header>{channel&&socket?(channel.type==='text'?<Chat channel={channel} user={user} socket={socket}/>:<ScreenRoom channel={channel} user={user} socket={socket}/>):<div className="empty-main">Selecione um canal.</div>}</main>
    <aside className="members-panel"><header><Users size={17}/><span>MEMBROS — {members.length}</span></header><div className="members"><p className="member-group">ONLINE</p>{members.filter(m=>m.online||m.id===user.id).map(m=><div className="member" key={m.id}><div className="avatar small">{initials(m.display_name)}<i/></div><div><strong>{m.display_name}</strong><span>{m.role==='owner'?'Proprietário':m.role==='admin'?'Administrador':'Membro'}</span></div></div>)}<p className="member-group">OFFLINE</p>{members.filter(m=>!m.online&&m.id!==user.id).map(m=><div className="member offline" key={m.id}><div className="avatar small">{initials(m.display_name)}</div><div><strong>{m.display_name}</strong><span>Visto recentemente</span></div></div>)}</div></aside>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
